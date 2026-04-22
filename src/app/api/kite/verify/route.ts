// ════════════════════════════════════════════════════════════════
//  GET /api/kite/verify
//  GET /api/kite/verify?symbols=RELIANCE,TCS,INFY
//
//  Compares the in-memory Kite tick cache against Yahoo Finance
//  for a handful of symbols. Intended for a quick sanity check
//  of "is the live feed actually real data?" without poking the
//  UI or opening Zerodha.
//
//  Response shape:
//    {
//      summary: { ok, mismatch, kiteMissing, yahooMissing, checked },
//      rows: [
//        { symbol, kite, yahoo, diff, diffPct, ageMs, verdict }
//      ]
//    }
//
//  Verdict codes:
//    OK              — within tolerance
//    MISMATCH        — diffPct > tolerance
//    NO_KITE_TICK    — nothing in cache
//    YAHOO_FAIL      — Yahoo REST failed
//    STALE           — Kite tick older than MAX_KITE_AGE_MS
//
//  Default tolerance: 0.5% (Yahoo feeds are ~15min delayed for
//  Indian equities, so during active trading a small diff is
//  normal — anything >2% is almost certainly a feed problem).
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getTicker, isFresh } from '@/lib/marketData/kiteTicker';
import { fetchFromYahoo } from '@/lib/marketData/yahoo';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

const DEFAULT_SYMBOLS = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK',
  'SBIN', 'BHARTIARTL', 'ITC', 'LT', 'HINDUNILVR',
];

const TOLERANCE_PCT = Number(process.env.VERIFY_TOLERANCE_PCT) || 0.5;

interface VerifyRow {
  symbol:  string;
  kite:    number | null;
  yahoo:   number | null;
  diff:    number | null;
  diffPct: number | null;
  ageMs:   number | null;
  fresh:   boolean;
  verdict: 'OK' | 'MISMATCH' | 'NO_KITE_TICK' | 'YAHOO_FAIL' | 'STALE';
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sp = req.nextUrl.searchParams;
  const raw = sp.get('symbols')?.trim();
  const symbols = raw
    ? raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
    : DEFAULT_SYMBOLS;

  const ticker = getTicker();
  const status = ticker.getStatus();
  const now = Date.now();

  const rows: VerifyRow[] = await Promise.all(
    symbols.map(async (symbol): Promise<VerifyRow> => {
      const tick = ticker.getTickBySymbolSync(symbol);
      const kitePrice = tick?.lastPrice ?? null;
      const ageMs = tick?.ts ? now - tick.ts : null;
      const fresh = !!tick && isFresh(tick);

      // Always pull Yahoo for comparison, even when Kite has no tick.
      const yahooRes = await fetchFromYahoo(symbol);
      const yahooPrice = yahooRes.price;

      let verdict: VerifyRow['verdict'];
      let diff: number | null = null;
      let diffPct: number | null = null;

      if (kitePrice == null) {
        verdict = 'NO_KITE_TICK';
      } else if (!fresh) {
        verdict = 'STALE';
      } else if (yahooPrice == null) {
        verdict = 'YAHOO_FAIL';
      } else {
        diff    = kitePrice - yahooPrice;
        diffPct = (diff / yahooPrice) * 100;
        verdict = Math.abs(diffPct) > TOLERANCE_PCT ? 'MISMATCH' : 'OK';
      }

      return {
        symbol,
        kite:    kitePrice,
        yahoo:   yahooPrice,
        diff:    diff    != null ? Number(diff.toFixed(2))    : null,
        diffPct: diffPct != null ? Number(diffPct.toFixed(3)) : null,
        ageMs,
        fresh,
        verdict,
      };
    }),
  );

  const summary = {
    state:         status.state,
    subscribed:    status.subscribed,
    ticksCached:   status.ticksCached,
    checked:       rows.length,
    ok:            rows.filter((r) => r.verdict === 'OK').length,
    mismatch:      rows.filter((r) => r.verdict === 'MISMATCH').length,
    kiteMissing:   rows.filter((r) => r.verdict === 'NO_KITE_TICK').length,
    stale:         rows.filter((r) => r.verdict === 'STALE').length,
    yahooFailed:   rows.filter((r) => r.verdict === 'YAHOO_FAIL').length,
    tolerancePct:  TOLERANCE_PCT,
  };

  return NextResponse.json(
    { summary, rows },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
