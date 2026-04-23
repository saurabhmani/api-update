// ════════════════════════════════════════════════════════════════
//  GET /api/market-data/validate
//
//  Diagnostic endpoint that cross-checks Yahoo Finance's live quote
//  against the frozen LTP recorded in the latest q365_signals row
//  for each symbol. Kite has been removed from the system, so the
//  kitePrice / kiteAgeMs fields are retained for response-shape
//  compatibility but always null.
//
//  Status classification:
//    VALID     — Yahoo price is available
//    STALE     — no Yahoo data; UI would fall back to signals.ltp
//    MISSING   — no Yahoo AND no signals.ltp
//
//  Usage:
//    GET /api/market-data/validate?symbols=RELIANCE,TCS
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { fetchYahooQuotesBatch } from '@/lib/marketData/yahooBatch';
import { isMarketOpen } from '@/lib/marketData/marketHours';
import { db } from '@/lib/db';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export type ValidationStatus = 'VALID' | 'MISMATCH' | 'STALE' | 'MISSING';

export interface ValidationEntry {
  symbol:        string;
  kitePrice:     number | null;    // retained for response-shape compat; always null
  kiteAgeMs:     number | null;
  yahooPrice:    number | null;
  yahooAgeMs:    number | null;
  ltp:           number | null;
  ltpGeneratedAt: string | null;

  correctPrice:  number | null;
  source:        'yahoo' | 'ltp' | 'none';
  status:        ValidationStatus;
  reason:        string;

  mismatchBps:   number | null;
}

async function getLtpFromSignals(symbols: string[]): Promise<Map<string, {
  ltp: number | null; generatedAt: string | null;
}>> {
  const out = new Map<string, { ltp: number | null; generatedAt: string | null }>();
  if (symbols.length === 0) return out;
  const placeholders = symbols.map(() => '?').join(',');
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
  sym: string,
  yah: { price: number | null; marketTime: number | null } | undefined,
  ltpRow: { ltp: number | null; generatedAt: string | null } | undefined,
): ValidationEntry {
  const now = Date.now();
  const yahooPrice = yah?.price ?? null;
  const yahooAgeMs = yah?.marketTime ? now - yah.marketTime : null;
  const ltp = ltpRow?.ltp ?? null;
  const ltpGeneratedAt = ltpRow?.generatedAt ?? null;

  if (yahooPrice != null && yahooPrice > 0) {
    return {
      symbol: sym,
      kitePrice: null, kiteAgeMs: null,
      yahooPrice, yahooAgeMs, ltp, ltpGeneratedAt,
      correctPrice: yahooPrice, source: 'yahoo', status: 'VALID',
      reason: yahooAgeMs != null
        ? `Yahoo snapshot (age=${Math.round(yahooAgeMs / 1000)}s)`
        : 'Yahoo snapshot',
      mismatchBps: null,
    };
  }

  if (ltp != null && ltp > 0) {
    return {
      symbol: sym,
      kitePrice: null, kiteAgeMs: null,
      yahooPrice: null, yahooAgeMs: null,
      ltp, ltpGeneratedAt,
      correctPrice: ltp, source: 'ltp', status: 'STALE',
      reason:
        `No Yahoo data. UI would render the frozen signal entry ltp=${ltp} ` +
        `from ${ltpGeneratedAt ?? 'unknown'} — this is NOT the current price.`,
      mismatchBps: null,
    };
  }

  return {
    symbol: sym,
    kitePrice: null, kiteAgeMs: null,
    yahooPrice: null, yahooAgeMs: null,
    ltp: null, ltpGeneratedAt: null,
    correctPrice: null, source: 'none', status: 'MISSING',
    reason: 'No data for this symbol in Yahoo or q365_signals.',
    mismatchBps: null,
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const raw = sp.get('symbols');
  const toleranceBps = Math.max(1, Number(sp.get('tolerance')) || 100);

  let symbols: string[] = [];
  if (raw) {
    symbols = raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  if (symbols.length === 0) {
    return NextResponse.json(
      { error: 'symbols required (?symbols=A,B,C)' },
      { status: 400 },
    );
  }
  symbols = [...new Set(symbols)].slice(0, 100);

  const marketOpen = isMarketOpen();
  const started = Date.now();

  const [yahooMap, ltpMap] = await Promise.all([
    fetchYahooQuotesBatch(symbols),
    getLtpFromSignals(symbols),
  ]);

  const entries: ValidationEntry[] = symbols.map((sym) =>
    classify(sym, yahooMap.get(sym), ltpMap.get(sym)),
  );

  const summary = {
    VALID:    entries.filter((e) => e.status === 'VALID').length,
    MISMATCH: 0,
    STALE:    entries.filter((e) => e.status === 'STALE').length,
    MISSING:  entries.filter((e) => e.status === 'MISSING').length,
  };

  return NextResponse.json(
    {
      marketOpen,
      toleranceBps,
      summary,
      elapsedMs: Date.now() - started,
      kiteCached:  0,
      yahooHits:   entries.filter((e) => e.yahooPrice != null).length,
      ltpHits:     entries.filter((e) => e.ltp        != null).length,
      entries,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
