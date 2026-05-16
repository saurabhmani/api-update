// ════════════════════════════════════════════════════════════════
//  GET /api/market-data/reseed
//
//  Manual trigger for streamServer.seedKiteMapFromDaily(). Use this // @deprecated marker
//  to refresh the UI-visible prices from market_data_daily without
//  restarting the dev server. Also returns the first N entries of
//  kiteMap so you can verify a specific symbol's value in the cache. // @deprecated marker
//
//  Usage:
//    curl http://localhost:3000/api/market-data/reseed
//    curl http://localhost:3000/api/market-data/reseed?symbol=LUPIN
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { seedKiteMapFromDaily } from '@/lib/ws/streamServer'; // @deprecated marker
import { db } from '@/lib/db';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const wantSym = sp.get('symbol')?.trim().toUpperCase() ?? null;

  // 1. Run the seed — overwrites stale (>90s old) entries in kiteMap // @deprecated marker
  //    with the latest close + previous close from market_data_daily.
  //    The streamServer broadcasts a FULL_UPDATE after seeding.
  const t0 = Date.now();
  const seeded = await seedKiteMapFromDaily(); // @deprecated marker
  const durationMs = Date.now() - t0;

  // 2. If a symbol was requested, pull its row from the DB so the
  //    caller can cross-check "what market_data_daily actually has"
  //    against "what Google shows".
  let dbRow: any = null;
  if (wantSym) {
    try {
      const { rows } = await db.query(
        `SELECT t.symbol, t.ts, t.open, t.high, t.low, t.close, t.volume,
           (SELECT close FROM market_data_daily
             WHERE symbol = t.symbol AND ts < t.ts
             ORDER BY ts DESC LIMIT 1) AS prev_close
         FROM market_data_daily t
         WHERE t.symbol = ?
         ORDER BY t.ts DESC
         LIMIT 1`,
        [wantSym],
      );
      dbRow = (rows as any[])[0] ?? null;
      if (dbRow) {
        const close = Number(dbRow.close);
        const prev  = dbRow.prev_close != null ? Number(dbRow.prev_close) : null;
        dbRow.computed_pChange = prev != null && prev > 0
          ? Number((((close - prev) / prev) * 100).toFixed(4))
          : null;
      }
    } catch (err: any) {
      dbRow = { error: err?.message ?? 'db query failed' };
    }
  }

  return NextResponse.json({
    ok: true,
    seeded,
    durationMs,
    ...(wantSym ? { symbol: wantSym, market_data_daily: dbRow } : {}),
    hint: 'Reload /signals after this call. If the UI still shows stale prices, check [streamServer] logs in the terminal.',
  });
}
