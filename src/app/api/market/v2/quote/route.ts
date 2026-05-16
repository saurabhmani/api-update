// ════════════════════════════════════════════════════════════════
//  GET /api/market/v2/quote?symbol=RELIANCE
//
//  Phase-3 gateway route. Unlike the v1 route at
//  /api/market/quote (which calls MarketDataProvider directly,
//  in-process), this one proxies to the market-ingestion SERVICE
//  over HTTP via @rpc/client.
//
//  Why both exist side-by-side:
//    • v1 stays live — UI keeps working during the split.
//    • v2 proves the gateway ↔ service contract.
//    • Once every v1 caller is migrated to v2, delete v1.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { marketIngestion } from '@rpc/client';
import { ensureCorrelationId, CORRELATION_HEADER } from '@contracts/correlation';
import { RpcError } from '@rpc/client';
import { logger } from '@/lib/logger';

const log = logger.child({ route: '/api/market/v2/quote' });

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const correlationId = ensureCorrelationId(req.headers);
  const symbol = req.nextUrl.searchParams.get('symbol');

  if (!symbol) {
    return NextResponse.json(
      { ok: false, error: 'symbol required', correlation_id: correlationId },
      { status: 400, headers: { [CORRELATION_HEADER]: correlationId } },
    );
  }

  try {
    const resp = await marketIngestion.snapshot(symbol, {
      correlationId,
      serviceAuthToken: process.env.SERVICE_AUTH_TOKEN,
    });
    const status = resp.ok ? 200 : 502;
    return NextResponse.json(resp, {
      status,
      headers: {
        [CORRELATION_HEADER]: correlationId,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    if (err instanceof RpcError) {
      // 4xx from the service pass through; 5xx and timeouts surface as 502.
      const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 502;
      log.warn('rpc failure', { correlation_id: correlationId, status, message: err.message });
      return NextResponse.json(
        { ok: false, error: err.message, correlation_id: correlationId },
        { status, headers: { [CORRELATION_HEADER]: correlationId } },
      );
    }
    log.error('gateway unexpected', {
      correlation_id: correlationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { ok: false, error: 'gateway error', correlation_id: correlationId },
      { status: 500, headers: { [CORRELATION_HEADER]: correlationId } },
    );
  }
}
