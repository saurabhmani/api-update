// ════════════════════════════════════════════════════════════════
//  GET /api/market-data/validate
//
//  Cross-source data-quality validator. For each requested symbol:
//
//    ┌──────────────────┬──────────────────────────────────────┐
//    │ kitePrice        │ ticker.getTickBySymbolSync (in-mem)  │
//    │ yahooPrice       │ fetchYahooQuotesBatch (BATCHED)      │
//    │ ltp              │ latest q365_signals.ltp (frozen      │
//    │                  │   entry at signal generation)        │
//    │ correctPrice     │ Kite if usable, else Yahoo, else ltp │
//    └──────────────────┴──────────────────────────────────────┘
//
//  Status classification:
//    VALID     — canonical source (kite) available, Yahoo agrees
//                within MISMATCH_BPS tolerance (default 100 bps = 1%)
//    MISMATCH  — kite and yahoo both available but diverge > tolerance
//    STALE     — no usable Kite tick (age > STALE_KITE_MS) AND no Yahoo,
//                rendering would be served from ltp (entry snapshot)
//    MISSING   — no data anywhere
//
//  Usage (public, no auth — diagnostic only):
//    GET /api/market-data/validate?symbols=RELIANCE,TCS
//    GET /api/market-data/validate?symbols=RELIANCE&tolerance=50
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { getTicker } from '@/lib/marketData/kiteTicker';
import { fetchYahooQuotesBatch } from '@/lib/marketData/yahooBatch';
import { isMarketOpen } from '@/lib/marketData/marketHours';
import { db } from '@/lib/db';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

const FRESH_MS       = Number(process.env.MAX_KITE_AGE_MS)  || 3_000;
const STALE_KITE_MS  = Number(process.env.STALE_KITE_MS)    || 3 * 24 * 60 * 60 * 1000;

export type ValidationStatus = 'VALID' | 'MISMATCH' | 'STALE' | 'MISSING';

export interface ValidationEntry {
  symbol:        string;

  // Raw per-source values —
  kitePrice:     number | null;
  kiteAgeMs:     number | null;
  yahooPrice:    number | null;
  yahooAgeMs:    number | null;
  ltp:           number | null;          // signal-generation snapshot
  ltpGeneratedAt: string | null;

  // Verdict —
  correctPrice:  number | null;
  source:        'kite' | 'yahoo' | 'ltp' | 'none';
  status:        ValidationStatus;
  reason:        string;

  // Cross-source mismatch magnitude in basis points (|a-b|/mid * 10000)
  mismatchBps:   number | null;
}

function bpsDiff(a: number | null, b: number | null): number | null {
  if (a == null || b == null) return null;
  const mid = (a + b) / 2;
  if (!Number.isFinite(mid) || mid <= 0) return null;
  return Math.round(Math.abs(a - b) / mid * 10_000);
}

async function getLtpFromSignals(symbols: string[]): Promise<Map<string, {
  ltp: number | null; generatedAt: string | null;
}>> {
  const out = new Map<string, { ltp: number | null; generatedAt: string | null }>();
  if (symbols.length === 0) return out;
  const placeholders = symbols.map(() => '?').join(',');
  // Latest q365_signals row per symbol — ltp is the frozen entry.
  // Uses a window function (MySQL 8+) to avoid a correlated subquery.
  try {
    const { rows } = await db.query<{
      symbol: string; ltp: number | string | null; generated_at: Date | string | null;
    }>(
      `SELECT symbol, ltp, generated_at FROM (
         SELECT symbol, ltp, generated_at,
           ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY generated_at DESC) AS rn
         FROM q365_signals
         WHERE symbol IN (${placeholders})
       ) r
       WHERE r.rn = 1`,
      symbols,
    );
    for (const r of rows as any[]) {
      const sym = String(r.symbol ?? '').toUpperCase();
      const ltp = r.ltp != null ? Number(r.ltp) : null;
      const gen =
        r.generated_at instanceof Date ? r.generated_at.toISOString()
        : r.generated_at != null        ? String(r.generated_at)
        : null;
      out.set(sym, {
        ltp: Number.isFinite(ltp as number) ? (ltp as number) : null,
        generatedAt: gen,
      });
    }
  } catch (err) {
    console.warn('[validate] ltp lookup failed:', (err as Error).message);
  }
  return out;
}

function classify(
  sym:        string,
  marketOpen: boolean,
  tick:       ReturnType<ReturnType<typeof getTicker>['getTickBySymbolSync']>,
  yah:        { price: number | null; marketTime: number | null } | undefined,
  ltpRow:     { ltp: number | null; generatedAt: string | null } | undefined,
  toleranceBps: number,
): ValidationEntry {
  const now = Date.now();
  const kitePrice = tick?.lastPrice ?? null;
  const kiteAgeMs = tick?.ts ? now - tick.ts : null;
  const yahooPrice = yah?.price ?? null;
  const yahooAgeMs = yah?.marketTime ? now - yah.marketTime : null;
  const ltp = ltpRow?.ltp ?? null;
  const ltpGeneratedAt = ltpRow?.generatedAt ?? null;
  const mismatchBps = bpsDiff(kitePrice, yahooPrice);

  // Decide correct price + source + status.
  const kiteUsable =
    kitePrice != null && kitePrice > 0 && kiteAgeMs != null &&
    (marketOpen ? kiteAgeMs < FRESH_MS : kiteAgeMs < STALE_KITE_MS);

  // Market OPEN + fresh Kite tick wins outright (Yahoo is advisory).
  if (kiteUsable) {
    if (yahooPrice != null && mismatchBps != null && mismatchBps > toleranceBps) {
      return {
        symbol: sym, kitePrice, kiteAgeMs, yahooPrice, yahooAgeMs, ltp, ltpGeneratedAt,
        correctPrice: kitePrice, source: 'kite', status: 'MISMATCH',
        reason:
          `Kite fresh (age=${kiteAgeMs}ms) but disagrees with Yahoo by ` +
          `${mismatchBps} bps (> ${toleranceBps} tolerance). Using Kite; ` +
          `Yahoo may be lagging or a corporate-action / symbol-map issue.`,
        mismatchBps,
      };
    }
    return {
      symbol: sym, kitePrice, kiteAgeMs, yahooPrice, yahooAgeMs, ltp, ltpGeneratedAt,
      correctPrice: kitePrice, source: 'kite', status: 'VALID',
      reason: marketOpen
        ? `Kite live (age=${kiteAgeMs}ms, within ${FRESH_MS}ms)` +
          (mismatchBps != null ? `, Yahoo within ${mismatchBps}bps` : '')
        : `Kite cached close (age=${Math.round((kiteAgeMs ?? 0) / 86400000)}d)` +
          (mismatchBps != null ? `, Yahoo within ${mismatchBps}bps` : ''),
      mismatchBps,
    };
  }

  // Kite not usable → use Yahoo if available.
  if (yahooPrice != null && yahooPrice > 0) {
    return {
      symbol: sym, kitePrice, kiteAgeMs, yahooPrice, yahooAgeMs, ltp, ltpGeneratedAt,
      correctPrice: yahooPrice, source: 'yahoo', status: 'VALID',
      reason:
        kitePrice == null
          ? 'No Kite tick cached; Yahoo snapshot used'
          : `Kite cache age=${Math.round((kiteAgeMs ?? 0) / 86400000)}d > STALE_KITE_MS; ` +
            `Yahoo snapshot used (~15 min delayed)`,
      mismatchBps,
    };
  }

  // No live/fallback sources. The UI would fall back to ltp (frozen entry).
  if (ltp != null && ltp > 0) {
    return {
      symbol: sym, kitePrice, kiteAgeMs, yahooPrice, yahooAgeMs, ltp, ltpGeneratedAt,
      correctPrice: ltp, source: 'ltp', status: 'STALE',
      reason:
        `No Kite or Yahoo data. UI would render the frozen signal entry ltp=${ltp} ` +
        `from ${ltpGeneratedAt ?? 'unknown'} — this is NOT the current price.`,
      mismatchBps,
    };
  }

  return {
    symbol: sym, kitePrice, kiteAgeMs, yahooPrice, yahooAgeMs, ltp, ltpGeneratedAt,
    correctPrice: null, source: 'none', status: 'MISSING',
    reason: 'No data for this symbol in any source (Kite, Yahoo, q365_signals).',
    mismatchBps,
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const raw = sp.get('symbols');
  const all = sp.get('all') === '1';
  const toleranceBps = Math.max(1, Number(sp.get('tolerance')) || 100);

  let symbols: string[] = [];
  if (raw) {
    symbols = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  } else if (all) {
    symbols = await getTicker().listSubscribedSymbols();
  }
  if (symbols.length === 0) {
    return NextResponse.json(
      { error: 'symbols required (?symbols=A,B,C) or ?all=1' },
      { status: 400 },
    );
  }
  symbols = [...new Set(symbols)].slice(0, 100);

  const marketOpen = isMarketOpen();
  const ticker = getTicker();
  const started = Date.now();

  // Fetch Yahoo + ltp in parallel — one batched HTTP call + one SQL.
  const [yahooMap, ltpMap] = await Promise.all([
    fetchYahooQuotesBatch(symbols),
    getLtpFromSignals(symbols),
  ]);

  const entries: ValidationEntry[] = symbols.map((sym) => {
    const tick = ticker.getTickBySymbolSync(sym);
    return classify(sym, marketOpen, tick, yahooMap.get(sym), ltpMap.get(sym), toleranceBps);
  });

  const summary = {
    VALID:    entries.filter((e) => e.status === 'VALID').length,
    MISMATCH: entries.filter((e) => e.status === 'MISMATCH').length,
    STALE:    entries.filter((e) => e.status === 'STALE').length,
    MISSING:  entries.filter((e) => e.status === 'MISSING').length,
  };

  return NextResponse.json(
    {
      marketOpen,
      toleranceBps,
      summary,
      elapsedMs: Date.now() - started,
      kiteCached:  entries.filter((e) => e.kitePrice  != null).length,
      yahooHits:   entries.filter((e) => e.yahooPrice != null).length,
      ltpHits:     entries.filter((e) => e.ltp        != null).length,
      entries,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
