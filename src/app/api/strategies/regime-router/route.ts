// ════════════════════════════════════════════════════════════════
//  GET /api/strategies/regime-router
//
//  Phase 3 — Regime-Based Strategy Router.
//
//  Detects the current market regime from NIFTY 50 daily candles and
//  returns a per-strategy routing decision tilted by Phase-2
//  performance. Always 200 — insufficient data flips every strategy
//  to WATCHLIST_ONLY with a clear reason.
//
//  Query params:
//    ?window=7D|30D|90D|180D|1Y|ALL   (performance lookback; default 90D)
//    ?include=strategies,performance,warnings   (advisory — full payload always returned)
//    ?symbol=optional                  (forward-compat — currently ignored)
//    ?strategyId=optional              (filter routingMatrix to one strategy)
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import { db }                        from '@/lib/db';
import { detectMarketRegime, detectEnhancedRegime } from '@/lib/signal-engine/regime/detectMarketRegime';
import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';
import {
  buildRegimeRouter,
  type RegimeRouterReport,
} from '@/lib/strategies/regimeRouter';
import {
  loadObservedOutcomes,
  loadBacktestOutcomes,
  buildPerformanceReport,
  VALID_WINDOWS,
  type PerformanceWindow,
} from '@/lib/strategies/strategyPerformance';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

function parseWindow(raw: string | null): PerformanceWindow {
  const v = String(raw ?? '90D').toUpperCase() as PerformanceWindow;
  return VALID_WINDOWS.has(v) ? v : '90D';
}

/** Load enough daily NIFTY 50 candles for the regime detector
 *  (needs ≥ 200 bars for EMA200). Soft-fails on a fresh DB. */
async function loadBenchmarkCandles(): Promise<Candle[]> {
  try {
    const { rows } = await db.query<{
      ts: string | Date; open: number; high: number; low: number; close: number; volume: number;
    }>(
      `SELECT ts, open, high, low, close, volume
         FROM candles
        WHERE instrument_key = ?
          AND candle_type='eod' AND interval_unit='1day'
        ORDER BY ts DESC
        LIMIT 260`,
      ['NSE_INDEX|NIFTY 50'],
    );
    return (rows ?? [])
      .map((r) => ({
        ts:     typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString().split('T')[0],
        open:   Number(r.open),
        high:   Number(r.high),
        low:    Number(r.low),
        close:  Number(r.close),
        volume: Number(r.volume),
      }))
      // The detector expects chronological ASC order.
      .reverse();
  } catch {
    return [];
  }
}

function ageMinutesFrom(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 60_000));
}

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 }); }

  const url        = new URL(req.url);
  const window     = parseWindow(url.searchParams.get('window'));
  const strategyId = url.searchParams.get('strategyId')?.trim() || null;

  // ── 1. Load benchmark candles + Phase-2 performance in parallel.
  const [candles, observed, backtests] = await Promise.all([
    loadBenchmarkCandles(),
    loadObservedOutcomes(window).catch(() => []),
    loadBacktestOutcomes(window).catch(() => []),
  ]);

  // ── 2. Detect regime — defensively. Need at least ~30 bars for the
  //    moving averages to be meaningful.
  let detectedLabel: ReturnType<typeof detectMarketRegime>['label'] | null = null;
  let regimeStrength: number | null = null;
  let benchmarkAgeMinutes: number | null = null;
  if (candles.length >= 30) {
    try {
      const enhanced = detectEnhancedRegime(candles);
      detectedLabel  = enhanced.label;
      regimeStrength = enhanced.confidence;
    } catch {
      // Detector blew up on malformed data — fall through to
      // INSUFFICIENT_DATA, never throw.
      detectedLabel = null;
    }
    benchmarkAgeMinutes = ageMinutesFrom(candles[candles.length - 1].ts);
  }

  // ── 3. Build Phase-2 performance report for the tilt input.
  const { report: perfReport } = buildPerformanceReport([...observed, ...backtests], window);

  // ── 4. Compose the regime router report.
  const router: RegimeRouterReport = buildRegimeRouter({
    detectedRegime:        detectedLabel,
    regimeStrength,
    benchmarkAgeMinutes,
    performances:          perfReport.strategies,
    performanceWindow:     window,
    staleDataFlag:         false,
  });

  // ── 5. Optional strategyId filter.
  if (strategyId) {
    router.routingMatrix = router.routingMatrix.filter((r) => r.strategyId === strategyId);
  }

  return NextResponse.json(router, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
