// ════════════════════════════════════════════════════════════════
//  GET /api/signals/explain
//
//  Phase 6 — Institutional Explanation API.
//
//  Composes a structured explanation for a signal by stitching
//  together every intelligence layer the platform has produced for
//  it: strategy metadata (Phase 1), regime routing (Phase 3),
//  confirmation aggregate (Phase 5), conflict resolution (Phase 6),
//  and Phase 2 performance for the strategy in the selected window.
//
//  Query params:
//    ?signalId=<id>            (preferred — looks up q365_signals)
//    ?symbol=<sym>             (required if no signalId)
//    ?strategyId=<snake_case>  (required if no signalId)
//    ?window=90D|180D|…        (Phase 2 performance window; default 90D)
//
//  Always 200. When the signal can't be resolved, an explanation is
//  still composed using strategy registry metadata only.
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import { db }                        from '@/lib/db';
import { getStrategyMeta }           from '@/lib/signal-engine/strategies/strategyRegistry';
import { explainSignal }             from '@/lib/explainability/signalExplanation';
import { detectMarketRegime, detectEnhancedRegime } from '@/lib/signal-engine/regime/detectMarketRegime';
import type { Candle } from '@/lib/signal-engine/types/signalEngine.types';
import {
  buildRegimeRouter,
  routeStrategy,
  normaliseRegime,
} from '@/lib/strategies/regimeRouter';
import {
  loadObservedOutcomes,
  loadBacktestOutcomes,
  loadDirectSignalOutcomes,
  buildPerformanceReport,
  VALID_WINDOWS,
  type PerformanceWindow,
} from '@/lib/strategies/strategyPerformance';
import {
  aggregateConfirmation,
  buildSectorConfirmation,
  buildOptionsConfirmation,
  buildNewsConfirmation,
  buildManipulationConfirmation,
  buildExecutionConfirmation,
} from '@/lib/confirmation/confirmationAggregator';
import { resolveConflicts } from '@/lib/strategies/conflictResolver';
import { getSector } from '@/lib/signal-engine/constants/phase3.constants';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

function parseWindow(raw: string | null): PerformanceWindow {
  const v = String(raw ?? '90D').toUpperCase() as PerformanceWindow;
  return VALID_WINDOWS.has(v) ? v : '90D';
}

/** Load enough NIFTY 50 EOD candles for the regime detector. Soft-fails. */
async function loadBenchmarkCandles(): Promise<Candle[]> {
  try {
    const { rows } = await db.query<any>(
      `SELECT ts, open, high, low, close, volume
         FROM candles
        WHERE instrument_key='NSE_INDEX|NIFTY 50' AND candle_type='eod' AND interval_unit='1day'
        ORDER BY ts DESC LIMIT 260`,
    );
    return (rows ?? []).map((r) => ({
      ts:     typeof r.ts === 'string' ? r.ts : new Date(r.ts).toISOString().split('T')[0],
      open:   Number(r.open), high: Number(r.high), low: Number(r.low),
      close:  Number(r.close), volume: Number(r.volume),
    })).reverse();
  } catch { return []; }
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
  const signalId   = url.searchParams.get('signalId');
  const symbolRaw  = url.searchParams.get('symbol')?.trim().toUpperCase() || null;
  const strategyIdQ = url.searchParams.get('strategyId')?.trim() || null;
  const window     = parseWindow(url.searchParams.get('window'));

  // ── 1. Resolve the signal row (best-effort). ──
  let row: any = null;
  if (signalId) {
    const id = Number(signalId);
    if (Number.isFinite(id)) {
      try {
        const r = await db.query<any>(
          `SELECT id, symbol, direction, signal_type, confidence_score, risk_reward,
                  market_regime, signal_status, decay_state,
                  entry_price, stop_loss, sector, rejection_reasons_json
             FROM q365_signals
            WHERE id = ?
            LIMIT 1`,
          [id],
        );
        row = r.rows?.[0] ?? null;
      } catch { /* table missing */ }
    }
  }

  const symbol     = row?.symbol ?? symbolRaw;
  const strategyId = (row?.signal_type ?? strategyIdQ ?? 'unclassified').toString();
  if (!symbol) {
    return NextResponse.json({
      ok: false,
      error: 'signalId or symbol is required.',
    }, { status: 400 });
  }

  const meta = getStrategyMeta(strategyId);
  const direction: 'BUY' | 'SELL' =
    (row?.direction as 'BUY' | 'SELL' | undefined) ?? meta.direction;
  const action: 'APPROVED' | 'WATCHLIST' | 'REJECTED' | null =
    row?.signal_status === 'APPROVED_SIGNAL' ? 'APPROVED'
    : row?.signal_status === 'DEVELOPING_SETUP' ? 'WATCHLIST'
    : row?.signal_status === 'NO_TRADE' ? 'REJECTED'
    : null;

  let rejectionReasons: string[] = [];
  if (row?.rejection_reasons_json) {
    try {
      const parsed = typeof row.rejection_reasons_json === 'string'
        ? JSON.parse(row.rejection_reasons_json)
        : row.rejection_reasons_json;
      if (Array.isArray(parsed)) rejectionReasons = parsed.filter((s) => typeof s === 'string');
    } catch { /* leave empty */ }
  }

  // ── 2. Load full context in parallel. Every block tolerant of
  //    missing data — explain composer reads what's available. ──
  const [candles, direct, observed, backtests] = await Promise.all([
    loadBenchmarkCandles(),
    loadDirectSignalOutcomes(window).catch(() => []),
    loadObservedOutcomes(window).catch(() => []),
    loadBacktestOutcomes(window).catch(() => []),
  ]);

  // ── 3. Regime + per-strategy routing. ──
  let detectedLabel: ReturnType<typeof detectMarketRegime>['label'] | null = null;
  let regimeStrength: number | null = null;
  let benchmarkAgeMinutes: number | null = null;
  if (candles.length >= 30) {
    try {
      const e = detectEnhancedRegime(candles);
      detectedLabel = e.label; regimeStrength = e.confidence;
    } catch { detectedLabel = null; }
    benchmarkAgeMinutes = ageMinutesFrom(candles[candles.length - 1].ts);
  }
  const staleDataFlag =
    candles.length === 0 || detectedLabel === null ||
    (typeof benchmarkAgeMinutes === 'number' && benchmarkAgeMinutes > 36 * 60);

  // ── 4. Phase-2 performance for the strategy. ──
  const { report: perfReport } = buildPerformanceReport([...direct, ...observed, ...backtests], window);
  const performance = perfReport.strategies.find((s) => s.strategyId === strategyId) ?? null;

  const router = buildRegimeRouter({
    detectedRegime:        detectedLabel,
    regimeStrength,
    benchmarkAgeMinutes,
    performances:          perfReport.strategies,
    performanceWindow:     window,
    staleDataFlag,
  });
  const currentRegime = router.currentRegime;
  const routing = routeStrategy({
    strategyId,
    regime:       currentRegime,
    regimeStatus: router.regimeStatus,
    performance,
  });

  // ── 5. Confirmation aggregate (lightweight modules over loaded row). ──
  let manipulationRisk: import('@/lib/manipulation-engine/manipulationSignalRisk').ManipulationRisk | null = null;
  try {
    const { rows } = await db.query<any>(
      `SELECT suspicion_band AS band, suspicion_score AS score, snapshot_date AS latestEventDate
         FROM q365_manipulation_snapshots
        WHERE symbol = ? ORDER BY snapshot_date DESC LIMIT 1`,
      [symbol],
    );
    const r = rows?.[0];
    if (r && r.band) {
      manipulationRisk = {
        symbol,
        band: String(r.band).toUpperCase() as any,
        score: Number(r.score ?? 0),
        latestEventDate: r.latestEventDate ? String(r.latestEventDate).slice(0, 10) : null,
        freshnessStatus: 'FRESH',
        canAffectApproval: true,
        recommendedAction: 'WARNING_ONLY' as any,
      } as any;
    }
  } catch { /* table missing */ }

  const sectorName = row?.sector ?? safeSector(symbol);
  const stopDistancePct = row?.entry_price && row?.stop_loss && row.entry_price > 0
    ? Math.abs((row.entry_price - row.stop_loss) / row.entry_price) * 100
    : null;

  const confirmation = aggregateConfirmation({
    signalId: signalId ?? (row?.id ? String(row.id) : null),
    symbol,
    strategyId: meta.strategyId,
    direction,
    currentAction: action,
    modules: {
      sector: buildSectorConfirmation({
        sector: sectorName,
        sectorScore: sectorName ? 50 : null,
        sectorTrend: sectorName ? 'Neutral' : null,
        relativeStrength: null,
        direction,
      }),
      options: buildOptionsConfirmation({
        available: false, source: 'unavailable',
        optionsBias: null, pcr: null, ivState: null,
        keySupport: null, keyResistance: null, direction,
      }),
      news: buildNewsConfirmation({
        available: false, sentiment: null, catalystType: null,
        impactScore: null, freshness: null, direction, highEventRisk: false,
      }),
      manipulation: buildManipulationConfirmation({
        available: !!manipulationRisk, risk: manipulationRisk,
      }),
      execution: buildExecutionConfirmation({
        liquidityScore: null, spreadBps: null,
        stopDistancePct, riskReward: row?.risk_reward ?? null,
        avgVolume: null, slippageEstimateBps: null,
      }),
    },
  });

  // ── 6. Conflict resolver (over the single candidate we have). ──
  const conflict = resolveConflicts({
    symbol,
    candidates: [{
      strategyId, direction,
      confidenceScore: typeof row?.confidence_score === 'number' ? row.confidence_score : null,
    }],
    manipulationRiskBand: confirmation.modules.manipulation.riskBand ?? null,
    marketRegime: row?.market_regime ?? null,
  });

  // ── 7. Compose the explanation with the full stitched context. ──
  const explanation = explainSignal({
    signalId:        signalId ?? (row?.id ? String(row.id) : null),
    symbol,
    strategyId:      meta.strategyId,
    direction,
    action,
    confidenceScore: typeof row?.confidence_score === 'number' ? row.confidence_score : null,
    riskReward:      typeof row?.risk_reward === 'number' ? row.risk_reward : null,
    marketRegime:    row?.market_regime ?? null,
    freshnessState:  row?.decay_state ?? null,
    routing,
    currentRegime:   normaliseRegime(detectedLabel),
    confirmation,
    conflict,
    performance,
    rejectionReasons,
  });

  return NextResponse.json(explanation, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}

function safeSector(symbol: string): string | null {
  try {
    const s = getSector(symbol);
    return s && s !== 'Other' ? s : null;
  } catch { return null; }
}
