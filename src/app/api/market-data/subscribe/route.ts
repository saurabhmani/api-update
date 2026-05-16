// ════════════════════════════════════════════════════════════════
//  POST /api/market-data/subscribe — compatibility no-op
//
//  Pre-Kite-removal this endpoint registered symbols with the Kite // @deprecated marker
//  WebSocket ticker. The WebSocket path has been removed; live
//  prices now come from Yahoo Finance polled per-request by the // @deprecated marker
//  components that need them (see useLivePrice, /market page). There
//  is nothing to subscribe to anymore, so this endpoint returns a
//  success envelope with the input symbols marked resolved. The
//  client-side hook will keep polling Yahoo on its own cadence and // @deprecated marker
//  doesn't need a server-side subscription to do so.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: NextRequest) {
  let body: { symbols?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }

  const raw = Array.isArray(body?.symbols) ? body.symbols : [];
  const symbols: string[] = [];
  for (const s of raw) {
    const up = String(s ?? '').trim().toUpperCase();
    if (up && !symbols.includes(up)) symbols.push(up);
  }
  if (symbols.length === 0) {
    return NextResponse.json({ ok: false, error: 'no symbols' }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    resolved: symbols,
    unknown: [],
    subscribed: symbols.length,
    tickSnapshot: {},
    source: 'yahoo-poll', // @deprecated marker
  });
}
