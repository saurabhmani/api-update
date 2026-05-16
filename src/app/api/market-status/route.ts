// ════════════════════════════════════════════════════════════════
//  GET /api/market-status — single source of truth for market mode
//
//  Spec MARKET-AWARENESS — every dashboard view that wants to label
//  data freshness reads from THIS endpoint. /api/ticker, /api/rankings,
//  and /api/signals also embed the same envelope in their own payloads
//  so callers don't have to make a second round-trip, but the canonical
//  shape is defined here.
//
//  The endpoint is read-only, never hits an upstream provider, and is
//  safe to poll at high cadence (sub-second recompute, no I/O).
//
//  Bypass behaviour: env vars FORCE_MARKET_OPEN / MOCK_MARKET_OPEN /
//  BYPASS_MARKET_HOURS DO NOT flip the `mode` field — the wall-clock
//  truth always wins. Operators who set a bypass see it surfaced in
//  `bypass.active` so the dashboard can render a warning.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { getMarketEnvelope } from '@/lib/marketData/marketHours';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const env = getMarketEnvelope();
  return NextResponse.json(env, {
    status: 200,
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
