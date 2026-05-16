// ════════════════════════════════════════════════════════════════
//  Global API Handler — Structured error handling + logging
//
//  Wraps Next.js route handlers with:
//    - Request ID generation for correlation
//    - Structured JSON logging (no console.log)
//    - Typed error hierarchy (AppError subclasses)
//    - Consistent response envelope
//    - apiMonitor + trace integration (per-day usage, latency,
//      provider attribution, fallbacks). The monitor is the data
//      source for /api/debug/system-health and /debug/system-health.
//
//  Usage:
//    import { withApiHandler } from '@/lib/apiHandler';
//    export const GET = withApiHandler(async (req) => {
//      return { data: ... };
//    });
//
//  Response format:
//    Success: { success: true, requestId: string, ...data }
//    Error:   { success: false, error: string, code: string, statusCode: number, requestId: string }
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import {
  AppError,
  AuthenticationError,
  ForbiddenError,
  isOperationalError,
} from '@/lib/errors';
import { recordApiCall, type MonitorProvider } from '@/lib/monitor/apiMonitor';
import { startTrace, finishTrace, addTraceStep } from '@/lib/monitor/trace';

// Re-export for backward compat if anything imports ApiError from here
export { AppError as ApiError } from '@/lib/errors';

let _counter = 0;

function generateRequestId(): string {
  _counter = (_counter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${_counter.toString(36)}`;
}

type HandlerFn = (req: NextRequest, ctx?: any) => Promise<any>;

const log = logger.child({ component: 'api' });

/** Pull provider / fallback hints out of a handler's response payload
 *  so per-route attribution lands in the monitor without each route
 *  having to call recordApiCall by hand. The resolver already attaches
 *  these via buildSmartFallbackEnvelope, and most handlers just spread
 *  that into their JSON, so this lookup covers the common cases. */
function pickProviderFromResult(result: any): {
  provider: MonitorProvider | null;
  fallback: boolean;
  symbols:  number | undefined;
} {
  if (!result || typeof result !== 'object') {
    return { provider: null, fallback: false, symbols: undefined };
  }
  const env = result.envelope ?? result.smartFallback ?? result;
  const raw = (env?.provider_used ?? env?.provider ?? null) as string | null;
  let provider: MonitorProvider | null = null;
  if (raw === 'indianapi' || raw === 'nse' || raw === 'yahoo' ||
      raw === 'snapshot'  || raw === 'cache' || raw === 'db') {
    provider = raw;
  } else if (raw === 'nse_direct')      provider = 'nse';
  else if (raw === 'yahoo_emergency')   provider = 'yahoo';

  const fallback = !!(env?.fallback_used ?? env?.fallbackUsed);
  const symbols = typeof env?.symbols_processed === 'number'
    ? env.symbols_processed
    : (typeof result?.symbols_count === 'number' ? result.symbols_count : undefined);
  return { provider, fallback, symbols };
}

export function withApiHandler(handler: HandlerFn) {
  return async function wrappedHandler(req: NextRequest, ctx?: any) {
    const requestId = generateRequestId();
    const method = req.method;
    const path = req.nextUrl.pathname;
    const startMs = Date.now();
    const traceId = startTrace(path);
    addTraceStep(traceId, { label: 'Route', detail: `${method} ${path}` });

    const finalize = (
      status: number,
      success: boolean,
      errorCode: string | null,
      providerHint?: { provider: MonitorProvider | null; fallback: boolean; symbols?: number },
    ) => {
      const durationMs = Date.now() - startMs;
      const provider = providerHint?.provider ?? null;
      const fallback = providerHint?.fallback ?? false;
      addTraceStep(traceId, {
        label: 'Response',
        detail: success ? `${status}` : `${status} ${errorCode ?? 'ERR'}`,
        durationMs,
      });
      finishTrace(traceId);
      recordApiCall({
        route:        path,
        method,
        provider,
        symbolsCount: providerHint?.symbols,
        durationMs,
        success,
        errorCode,
        fallbackUsed: fallback,
        traceId,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[API CALL] route=${path} duration=${durationMs}ms` +
        (provider ? ` provider=${provider}` : '') +
        ` fallback=${fallback}` +
        (success ? '' : ` error=${errorCode ?? 'UNKNOWN'}`),
      );
    };

    try {
      const result = await handler(req, ctx);

      // If handler already returns NextResponse, pass through
      if (result instanceof NextResponse) {
        log.info('Request completed', {
          requestId, method, path, durationMs: Date.now() - startMs, traceId,
        });
        finalize(result.status ?? 200, result.status < 400, null);
        return result;
      }

      const hint = pickProviderFromResult(result);
      log.info('Request completed', {
        requestId, method, path, status: 200,
        durationMs: Date.now() - startMs, traceId,
        provider: hint.provider, fallback: hint.fallback,
      });
      const json = NextResponse.json({ success: true, requestId, ...result });
      finalize(200, true, null, hint);
      return json;

    } catch (err) {
      const durationMs = Date.now() - startMs;

      // Known operational errors (our error hierarchy)
      if (isOperationalError(err)) {
        log.warn('Request failed (operational)', {
          requestId, method, path, status: err.statusCode,
          code: err.code, error_message: err.message, durationMs, traceId,
        });
        finalize(err.statusCode, false, err.code);
        return NextResponse.json(
          { success: false, requestId, ...err.toJSON() },
          { status: err.statusCode },
        );
      }

      // Legacy auth errors (thrown by requireSession / requireAdmin)
      if (err instanceof Error) {
        if (err.message.includes('Unauthorized') || err.message.includes('401')) {
          const authErr = new AuthenticationError();
          log.warn('Request failed (auth)', {
            requestId, method, path, status: 401, durationMs, traceId,
          });
          finalize(401, false, authErr.code);
          return NextResponse.json(
            { success: false, requestId, ...authErr.toJSON() },
            { status: 401 },
          );
        }
        if (err.message.includes('Forbidden') || err.message.includes('403')) {
          const forbidErr = new ForbiddenError();
          log.warn('Request failed (forbidden)', {
            requestId, method, path, status: 403, durationMs, traceId,
          });
          finalize(403, false, forbidErr.code);
          return NextResponse.json(
            { success: false, requestId, ...forbidErr.toJSON() },
            { status: 403 },
          );
        }
      }

      // Unexpected errors — log full stack
      log.error('Request failed (unexpected)', err instanceof Error ? err : new Error(String(err)), {
        requestId, method, path, status: 500, durationMs, traceId,
      });

      const message = err instanceof Error ? err.message : 'Internal server error';
      finalize(500, false, 'INTERNAL_ERROR');
      return NextResponse.json(
        {
          success: false,
          requestId,
          error: message,
          code: 'INTERNAL_ERROR',
          statusCode: 500,
        },
        { status: 500 },
      );
    }
  };
}
