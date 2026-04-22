// ════════════════════════════════════════════════════════════════
//  Global API Handler — Structured error handling + logging
//
//  Wraps Next.js route handlers with:
//    - Request ID generation for correlation
//    - Structured JSON logging (no console.log)
//    - Typed error hierarchy (AppError subclasses)
//    - Consistent response envelope
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

// Re-export for backward compat if anything imports ApiError from here
export { AppError as ApiError } from '@/lib/errors';

let _counter = 0;

function generateRequestId(): string {
  _counter = (_counter + 1) % 1_000_000;
  return `${Date.now().toString(36)}-${_counter.toString(36)}`;
}

type HandlerFn = (req: NextRequest, ctx?: any) => Promise<any>;

const log = logger.child({ component: 'api' });

export function withApiHandler(handler: HandlerFn) {
  return async function wrappedHandler(req: NextRequest, ctx?: any) {
    const requestId = generateRequestId();
    const method = req.method;
    const path = req.nextUrl.pathname;
    const startMs = Date.now();

    try {
      const result = await handler(req, ctx);

      // If handler already returns NextResponse, pass through
      if (result instanceof NextResponse) {
        log.info('Request completed', {
          requestId, method, path, durationMs: Date.now() - startMs,
        });
        return result;
      }

      // Wrap raw data in standard success format
      log.info('Request completed', {
        requestId, method, path, status: 200, durationMs: Date.now() - startMs,
      });
      return NextResponse.json({ success: true, requestId, ...result });

    } catch (err) {
      const durationMs = Date.now() - startMs;

      // Known operational errors (our error hierarchy)
      if (isOperationalError(err)) {
        log.warn('Request failed (operational)', {
          requestId, method, path, status: err.statusCode,
          code: err.code, error_message: err.message, durationMs,
        });
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
            requestId, method, path, status: 401, durationMs,
          });
          return NextResponse.json(
            { success: false, requestId, ...authErr.toJSON() },
            { status: 401 },
          );
        }
        if (err.message.includes('Forbidden') || err.message.includes('403')) {
          const forbidErr = new ForbiddenError();
          log.warn('Request failed (forbidden)', {
            requestId, method, path, status: 403, durationMs,
          });
          return NextResponse.json(
            { success: false, requestId, ...forbidErr.toJSON() },
            { status: 403 },
          );
        }
      }

      // Unexpected errors — log full stack
      log.error('Request failed (unexpected)', err instanceof Error ? err : new Error(String(err)), {
        requestId, method, path, status: 500, durationMs,
      });

      const message = err instanceof Error ? err.message : 'Internal server error';
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
