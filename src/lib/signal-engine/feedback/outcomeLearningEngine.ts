// ════════════════════════════════════════════════════════════════
//  Signal Outcome Learning — Phase NEXT
//
//  Aggregates the historical SignalOutcome records produced by
//  feedback/outcomeTracker.ts and turns them into per-strategy
//  performance views. Used to dynamically:
//    • adjust confidence per strategy
//    • reduce weighting of strategies that don't perform
//    • boost strategies with sustained edge
//
//  Tracks (per strategy / per regime / per volatility state):
//    • win rate
//    • average R:R achieved (avgPnlR)
//    • false-breakout frequency (entry triggered but stopped no T1)
//    • stop-loss frequency (stopped_out)
//    • average hold time (barsToEntry as proxy until TP/SL bar wired)
//    • volatility failure rate (stopped under high MAE relative to MFE)
//
//  Feeds back into the confidence pipeline as a bounded modifier.
//
//  Pure, synchronous, IO-free.
// ════════════════════════════════════════════════════════════════

import type { SignalOutcome } from '../types/phase4.types';

// ── Inputs / Outputs ────────────────────────────────────────────

export interface OutcomeLearningKey {
  strategy:        string;
  regime?:         string;
  volatilityState?: string;
}

export interface StrategyOutcomeStats {
  strategy:               string;
  regime:                 string | null;
  volatilityState:        string | null;
  sampleSize:             number;
  winRate:                number;     // 0..1, fraction of T1 hits
  avgRRAchieved:          number;     // average pnlR
  falseBreakoutRate:      number;     // 0..1
  stopLossRate:           number;     // 0..1
  avgHoldBars:            number;     // average barsToEntry / total bars
  volatilityFailureRate:  number;     // 0..1, stopped trades with adv > fav
  /** Quality grade derived from the metrics above. */
  grade:                  'excellent' | 'good' | 'moderate' | 'poor' | 'insufficient_data';
  /** Confidence modifier suggested for this strategy/regime/vol triple,
   *  bounded to ±10 points. */
  recommendedConfidenceModifier: number;
  /** Strategy weight modifier (multiplicative) suggested for the
   *  strategy weight model. 1.0 = no change. Bounded to [0.5, 1.5]. */
  recommendedWeightMultiplier:   number;
  /** Audit reason. */
  reason:                 string;
}

export interface OutcomeLearningSnapshot {
  /** Per (strategy, regime, vol) breakdown. */
  perKey:           StrategyOutcomeStats[];
  /** Per-strategy aggregate (regime/vol pooled). */
  perStrategy:      StrategyOutcomeStats[];
  /** Overall stats across the entire history. */
  overall:          StrategyOutcomeStats;
  /** Total outcomes analyzed. */
  totalOutcomes:    number;
  generatedAt:      string;
}

// ── Helpers ─────────────────────────────────────────────────────

const MIN_SAMPLE = 5;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function gradeFromStats(
  sampleSize: number,
  winRate:    number,
  avgRR:      number,
): StrategyOutcomeStats['grade'] {
  if (sampleSize < MIN_SAMPLE) return 'insufficient_data';
  if (winRate >= 0.65 && avgRR >= 1.0)   return 'excellent';
  if (winRate >= 0.55 && avgRR >= 0.5)   return 'good';
  if (winRate >= 0.45 && avgRR >= 0.0)   return 'moderate';
  return 'poor';
}

function modifierFromGrade(
  grade:      StrategyOutcomeStats['grade'],
  sampleSize: number,
): { conf: number; weight: number } {
  if (grade === 'insufficient_data' || sampleSize < MIN_SAMPLE) {
    return { conf: 0, weight: 1.0 };
  }
  // Sample-strength damping — small samples get half the modifier.
  const damping = sampleSize >= 30 ? 1.0 : sampleSize >= 15 ? 0.7 : 0.4;
  switch (grade) {
    case 'excellent': return { conf:  +8 * damping, weight: 1 + 0.30 * damping };
    case 'good':      return { conf:  +4 * damping, weight: 1 + 0.15 * damping };
    case 'moderate':  return { conf:   0,           weight: 1.0 };
    case 'poor':      return { conf:  -8 * damping, weight: 1 - 0.40 * damping };
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function aggregate(
  outcomes:        SignalOutcome[],
  strategy:        string,
  regime:          string | null,
  volatilityState: string | null,
): StrategyOutcomeStats {
  const n = outcomes.length;
  if (n === 0) {
    return {
      strategy, regime, volatilityState,
      sampleSize:   0,
      winRate:      0,
      avgRRAchieved: 0,
      falseBreakoutRate:     0,
      stopLossRate:          0,
      avgHoldBars:           0,
      volatilityFailureRate: 0,
      grade:                 'insufficient_data',
      recommendedConfidenceModifier: 0,
      recommendedWeightMultiplier:   1.0,
      reason: `${strategy}: zero outcomes`,
    };
  }

  const wins      = outcomes.filter((o) => o.target1Hit).length;
  const stops     = outcomes.filter((o) => o.stopHit && !o.target1Hit).length;
  // False breakout = entry triggered but stopped without T1.
  const falseBO   = outcomes.filter((o) => o.entryTriggered && o.stopHit && !o.target1Hit).length;
  // Volatility failure = stopped, with MAE > MFE (adverse excursion outpaced favorable).
  const volFail   = outcomes.filter((o) =>
    o.stopHit && Math.abs(o.maxAdverseExcursionPct) > Math.abs(o.maxFavorableExcursionPct),
  ).length;
  const avgRR     = outcomes.reduce((s, o) => s + (Number.isFinite(o.pnlR) ? o.pnlR : 0), 0) / n;
  // We don't yet persist barsToTarget — use barsToEntry + a constant
  // proxy (5 bars) when entry triggered, else 0. Replace with real
  // bars-to-resolution as soon as the outcome tracker stores it.
  const avgHold   = outcomes.reduce(
    (s, o) => s + (o.entryTriggered ? (o.barsToEntry ?? 0) + 5 : 0),
    0,
  ) / n;

  const winRate          = wins / n;
  const stopRate         = stops / n;
  const falseBreakoutR   = falseBO / n;
  const volFailureR      = volFail / n;

  const grade = gradeFromStats(n, winRate, avgRR);
  const { conf, weight } = modifierFromGrade(grade, n);

  const reason =
    `${strategy} (${regime ?? 'any'}/${volatilityState ?? 'any'}) — ` +
    `n=${n}, win=${(winRate * 100).toFixed(0)}%, avgR=${avgRR.toFixed(2)}, ` +
    `stop=${(stopRate * 100).toFixed(0)}%, falseBO=${(falseBreakoutR * 100).toFixed(0)}%, ` +
    `volFail=${(volFailureR * 100).toFixed(0)}% → grade=${grade}, ` +
    `confΔ=${conf.toFixed(1)}, wMul=${weight.toFixed(2)}`;

  return {
    strategy, regime, volatilityState,
    sampleSize: n,
    winRate:               round4(winRate),
    avgRRAchieved:         round4(avgRR),
    falseBreakoutRate:     round4(falseBreakoutR),
    stopLossRate:          round4(stopRate),
    avgHoldBars:           round4(avgHold),
    volatilityFailureRate: round4(volFailureR),
    grade,
    recommendedConfidenceModifier: round4(clamp(conf, -10, 10)),
    recommendedWeightMultiplier:   round4(clamp(weight, 0.5, 1.5)),
    reason,
  };
}

function round4(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10_000) / 10_000;
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Bucket outcomes by (strategy, regime, vol) and aggregate into per-
 * key + per-strategy + overall stats with adaptive recommendations.
 * Caller shapes outcomes from the q365_signal_outcomes table.
 */
export function buildOutcomeLearningSnapshot(
  outcomes: Array<{
    strategy:        string;
    regime?:         string | null;
    volatilityState?: string | null;
    outcome:         SignalOutcome;
  }>,
  now: Date = new Date(),
): OutcomeLearningSnapshot {
  // Bucket by (strategy, regime, vol)
  const tripleMap = new Map<string, Array<{ strategy: string; regime: string | null; vol: string | null; o: SignalOutcome }>>();
  const stratMap  = new Map<string, SignalOutcome[]>();
  const overallList: SignalOutcome[] = [];

  for (const row of outcomes) {
    const regime = row.regime ?? null;
    const vol    = row.volatilityState ?? null;
    const tk     = `${row.strategy}|${regime ?? '-'}|${vol ?? '-'}`;
    const arr    = tripleMap.get(tk) ?? [];
    arr.push({ strategy: row.strategy, regime, vol, o: row.outcome });
    tripleMap.set(tk, arr);

    const stratArr = stratMap.get(row.strategy) ?? [];
    stratArr.push(row.outcome);
    stratMap.set(row.strategy, stratArr);

    overallList.push(row.outcome);
  }

  const perKey: StrategyOutcomeStats[] = [];
  for (const [, arr] of tripleMap) {
    const first = arr[0];
    perKey.push(aggregate(arr.map((x) => x.o), first.strategy, first.regime, first.vol));
  }

  const perStrategy: StrategyOutcomeStats[] = [];
  for (const [strategy, arr] of stratMap) {
    perStrategy.push(aggregate(arr, strategy, null, null));
  }

  const overall = aggregate(overallList, '__overall__', null, null);

  return {
    perKey:        perKey.sort((a, b) => b.sampleSize - a.sampleSize),
    perStrategy:   perStrategy.sort((a, b) => b.sampleSize - a.sampleSize),
    overall,
    totalOutcomes: overallList.length,
    generatedAt:   now.toISOString(),
  };
}

/**
 * Apply the snapshot's recommendation for a given strategy/regime/vol
 * triple. Falls back to the per-strategy aggregate when the triple
 * has insufficient data, then to a no-op when neither does.
 */
export function applyLearningToConfidence(
  baseConfidence:   number,
  snapshot:         OutcomeLearningSnapshot,
  strategy:         string,
  regime?:          string | null,
  volatilityState?: string | null,
): { confidence: number; modifier: number; source: 'triple' | 'strategy' | 'none' } {
  const triple = snapshot.perKey.find(
    (k) =>
      k.strategy === strategy &&
      k.regime   === (regime ?? null) &&
      k.volatilityState === (volatilityState ?? null) &&
      k.grade !== 'insufficient_data',
  );
  if (triple) {
    const next = clamp(baseConfidence + triple.recommendedConfidenceModifier, 0, 100);
    return { confidence: next, modifier: triple.recommendedConfidenceModifier, source: 'triple' };
  }

  const strat = snapshot.perStrategy.find(
    (k) => k.strategy === strategy && k.grade !== 'insufficient_data',
  );
  if (strat) {
    const next = clamp(baseConfidence + strat.recommendedConfidenceModifier, 0, 100);
    return { confidence: next, modifier: strat.recommendedConfidenceModifier, source: 'strategy' };
  }

  return { confidence: baseConfidence, modifier: 0, source: 'none' };
}

/**
 * Strategy weight multiplier for the strategy weight model. Triple
 * match wins; falls back to strategy aggregate; default 1.0.
 */
export function strategyWeightMultiplier(
  snapshot:         OutcomeLearningSnapshot,
  strategy:         string,
  regime?:          string | null,
  volatilityState?: string | null,
): number {
  const triple = snapshot.perKey.find(
    (k) =>
      k.strategy === strategy &&
      k.regime   === (regime ?? null) &&
      k.volatilityState === (volatilityState ?? null) &&
      k.grade !== 'insufficient_data',
  );
  if (triple) return triple.recommendedWeightMultiplier;
  const strat = snapshot.perStrategy.find(
    (k) => k.strategy === strategy && k.grade !== 'insufficient_data',
  );
  return strat ? strat.recommendedWeightMultiplier : 1.0;
}

// ── Quick-glance debug helpers ─────────────────────────────────

export function describePercentiles(outcomes: SignalOutcome[]): string {
  if (outcomes.length === 0) return 'no outcomes';
  const rs = outcomes.map((o) => o.pnlR).filter((x) => Number.isFinite(x));
  const mfe = outcomes.map((o) => o.maxFavorableExcursionPct).filter((x) => Number.isFinite(x));
  const mae = outcomes.map((o) => Math.abs(o.maxAdverseExcursionPct)).filter((x) => Number.isFinite(x));
  return [
    `pnlR p25=${percentile(rs, 0.25).toFixed(2)} p50=${percentile(rs, 0.5).toFixed(2)} p75=${percentile(rs, 0.75).toFixed(2)}`,
    `MFE p50=${percentile(mfe, 0.5).toFixed(2)}`,
    `MAE p50=${percentile(mae, 0.5).toFixed(2)}`,
  ].join(' | ');
}
