// ════════════════════════════════════════════════════════════════
//  Phase 6 — Correlation-aware consensus (not a strategy)
//
//  Aggregates independent evidence families for an already-matched
//  strategy. Correlated indicators share a family and cannot both
//  inflate the score via a family cap.
// ════════════════════════════════════════════════════════════════

import type {
  SignalFeatures,
  RelativeStrengthFeatures,
  StrategyCandidate,
  StrategyName,
} from '../types/signalEngine.types';
import { BEARISH_STRATEGIES } from '../types/signalEngine.types';
import { STRATEGY_REGISTRY } from '../strategies/strategyRegistry';

export const CONSENSUS_MODEL_VERSION = '6.0.0';

export type EvidenceFamily =
  | 'trend'
  | 'momentum'
  | 'structure'
  | 'volume'
  | 'relative_strength'
  | 'market_regime'
  | 'sector_context'
  | 'multi_timeframe'
  | 'news_event'
  | 'risk_geometry';

export interface FamilyEvidence {
  family: EvidenceFamily;
  /** Selected contributor labels (post-dedup). */
  factors: string[];
  /** 0–100 after family cap / correlation dedup. */
  score: number;
  /** Raw contributors before cap (audit). */
  rawFactors: Array<{ id: string; score: number }>;
}

export interface ConsensusResult {
  modelVersion: string;
  strategy: StrategyName;
  /** 0–100 correlation-aware aggregate. */
  consensusScore: number;
  familyCount: number;
  families: FamilyEvidence[];
  /** True when ≥4 independent families contribute meaningfully. */
  broadSupport: boolean;
  explain: string[];
  /** Factors that were suppressed as redundant. */
  suppressedDuplicates: string[];
}

/** Max points any single family may contribute to the average. */
const FAMILY_SCORE_CAP = 100;
/** Soft floor — empty family ignored (not averaged as zero). */
const FAMILY_ACTIVE_MIN = 15;

/**
 * Evaluate consensus for a matched strategy. Does not create a setup.
 */
export function evaluateStrategyConsensus(
  features: SignalFeatures,
  relativeStrength: RelativeStrengthFeatures,
  strategy: StrategyName,
  opts: {
    rewardRisk?: number;
    stopDistAtr?: number | null;
    mtfOverallScore?: number | null;
    newsRiskScore?: number | null;
  } = {},
): ConsensusResult {
  const suppressed: string[] = [];
  const families: FamilyEvidence[] = [];

  const isShort = BEARISH_STRATEGIES.has(strategy);
  const { trend, momentum, volume, structure, context, volatility, enhanced } = features;

  // ── Trend family: pick best single trend fact (EMAs are correlated) ──
  {
    const raw: Array<{ id: string; score: number }> = [];
    if (trend.ema20Above50 === !isShort || (isShort && !trend.ema20Above50)) {
      raw.push({ id: 'ema20_vs_ema50', score: 78 });
    }
    if (trend.closeAbove200Ema === !isShort || (isShort && !trend.closeAbove200Ema)) {
      raw.push({ id: 'close_vs_ema200', score: 72 });
    }
    if (trend.ema50Above200 && !isShort) raw.push({ id: 'ema50_vs_ema200', score: 70 });
    // Do NOT also count stacked EMAs as independent — keep max + small bonus
    const picked = pickIndependent(raw, ['ema20_vs_ema50', 'ema50_vs_ema200'], suppressed);
    families.push(capFamily('trend', picked));
  }

  // ── Momentum: RSI OR stochastic (correlated oscillators); MACD separate but capped with RSI if both high ──
  {
    const raw: Array<{ id: string; score: number }> = [];
    const rsiOk = isShort
      ? momentum.rsi14 <= 45
      : momentum.rsi14 >= 42 && momentum.rsi14 <= 72;
    if (rsiOk) raw.push({ id: 'rsi_band', score: Math.min(85, 50 + Math.abs(momentum.rsi14 - 50)) });
    const stochOk = isShort ? momentum.stochasticK <= 40 : momentum.stochasticK >= 40 && momentum.stochasticK <= 80;
    if (stochOk) raw.push({ id: 'stochastic', score: 65 });
    if ((isShort && momentum.macdHistogram <= 0) || (!isShort && momentum.macdHistogram > 0)) {
      raw.push({ id: 'macd_histogram', score: 70 });
    }
    if (momentum.adx >= 20) raw.push({ id: 'adx', score: Math.min(80, 40 + momentum.adx) });
    // RSI and stochastic are correlated — keep one
    const picked = pickIndependent(raw, ['rsi_band', 'stochastic'], suppressed);
    // MACD heavily overlaps EMA trend — if trend family already strong, soft-cap MACD
    families.push(capFamily('momentum', picked));
  }

  // ── Structure: breakout distance XOR close-above-resistance treated as one event ──
  {
    const raw: Array<{ id: string; score: number }> = [];
    if (structure.breakoutDistancePct > 0 && structure.breakoutDistancePct <= 3) {
      raw.push({ id: 'breakout_distance', score: 80 });
    }
    if (structure.breakoutDistancePct > 0) {
      raw.push({ id: 'close_above_resistance', score: 75 }); // correlated with breakout_distance
    }
    if (structure.fibZoneMatched) raw.push({ id: 'fib_zone', score: 82 });
    if (structure.consecutiveHigherLows >= 2 && !isShort) {
      raw.push({ id: 'higher_lows', score: 70 });
    }
    if (structure.rangeCompressionRatio < 0.75) raw.push({ id: 'compression', score: 65 });
    const picked = pickIndependent(raw, ['breakout_distance', 'close_above_resistance'], suppressed);
    families.push(capFamily('structure', picked));
  }

  // ── Volume ──
  {
    const raw: Array<{ id: string; score: number }> = [];
    if (volume.volumeVs20dAvg >= 1.2) {
      raw.push({ id: 'volume_expansion', score: Math.min(90, 40 + volume.volumeVs20dAvg * 20) });
    }
    if (volume.obvSlope > 0 && !isShort) raw.push({ id: 'obv_slope', score: 60 });
    if (volume.obvSlope < 0 && isShort) raw.push({ id: 'obv_slope', score: 60 });
    families.push(capFamily('volume', raw));
  }

  // ── Relative strength ──
  {
    const raw: Array<{ id: string; score: number }> = [];
    if (!isShort && relativeStrength.rsVsIndex >= 0) {
      raw.push({ id: 'rs_vs_index', score: Math.min(90, 50 + relativeStrength.rsVsIndex * 4) });
    }
    if (isShort && relativeStrength.rsVsIndex <= 0) {
      raw.push({ id: 'rs_vs_index', score: Math.min(90, 50 + Math.abs(relativeStrength.rsVsIndex) * 4) });
    }
    if (relativeStrength.sectorStrengthScore >= 55 && !isShort) {
      raw.push({ id: 'rs_sector_proxy', score: 55 }); // may correlate with sector family — kept mild
    }
    families.push(capFamily('relative_strength', raw));
  }

  // ── Market regime ──
  {
    const entry = STRATEGY_REGISTRY[strategy];
    const raw: Array<{ id: string; score: number }> = [];
    if (entry?.allowedRegimes.includes(context.marketRegime)) {
      raw.push({ id: 'regime_allowed', score: 75 });
    }
    if (entry?.idealMarketRegime?.includes(context.marketRegime)) {
      raw.push({ id: 'regime_ideal', score: 90 });
    }
    families.push(capFamily('market_regime', raw));
  }

  // ── Sector context (distinct from RS score used lightly above) ──
  {
    const raw: Array<{ id: string; score: number }> = [];
    if (!isShort && relativeStrength.sectorStrengthScore >= 60) {
      raw.push({ id: 'sector_strength', score: relativeStrength.sectorStrengthScore });
    }
    if (isShort && relativeStrength.sectorStrengthScore <= 40) {
      raw.push({ id: 'sector_weakness', score: 100 - relativeStrength.sectorStrengthScore });
    }
    families.push(capFamily('sector_context', raw));
  }

  // ── Multi-timeframe ──
  {
    const raw: Array<{ id: string; score: number }> = [];
    const mtf = opts.mtfOverallScore ?? enhanced?.multiTimeframeAlignment ?? null;
    if (mtf != null && mtf >= 55) raw.push({ id: 'mtf_alignment', score: mtf });
    families.push(capFamily('multi_timeframe', raw));
  }

  // ── News / event ──
  {
    const raw: Array<{ id: string; score: number }> = [];
    const news = opts.newsRiskScore;
    const gap = Math.abs(volatility.gapPct);
    if (news != null && news < 40) raw.push({ id: 'low_event_risk', score: 100 - news });
    else if (gap <= 1.5) raw.push({ id: 'calm_gap', score: 55 });
    // High gap is negative — leave family empty (no fake support)
    families.push(capFamily('news_event', raw));
  }

  // ── Risk / trade geometry ──
  {
    const raw: Array<{ id: string; score: number }> = [];
    const rr = opts.rewardRisk ?? 0;
    if (rr >= 1.5) raw.push({ id: 'reward_risk', score: Math.min(95, 40 + rr * 20) });
    if (opts.stopDistAtr != null && opts.stopDistAtr >= 0.5 && opts.stopDistAtr <= 2.5) {
      raw.push({ id: 'stop_atr_band', score: 70 });
    }
    if (volatility.atrPct > 0 && volatility.atrPct <= 4) {
      raw.push({ id: 'atr_sane', score: 60 });
    }
    families.push(capFamily('risk_geometry', raw));
  }

  const active = families.filter((f) => f.score >= FAMILY_ACTIVE_MIN);
  const consensusScore =
    active.length === 0
      ? 0
      : Math.round(active.reduce((s, f) => s + Math.min(FAMILY_SCORE_CAP, f.score), 0) / active.length);

  const explain = [
    `Consensus ${consensusScore}/100 across ${active.length} independent families (v${CONSENSUS_MODEL_VERSION})`,
    ...active.map((f) => `${f.family}: ${f.score} [${f.factors.join(', ')}]`),
    ...(suppressed.length
      ? [`Suppressed correlated duplicates: ${suppressed.join(', ')}`]
      : []),
  ];

  return {
    modelVersion: CONSENSUS_MODEL_VERSION,
    strategy,
    consensusScore,
    familyCount: active.length,
    families: active,
    broadSupport: active.length >= 4 && consensusScore >= 55,
    explain,
    suppressedDuplicates: suppressed,
  };
}

export function consensusFromCandidate(candidate: StrategyCandidate): ConsensusResult {
  const stopDist =
    candidate.features.volatility.atr14 > 0
      ? Math.abs(candidate.features.trend.close - candidate.tradePlan.stopLoss) /
        candidate.features.volatility.atr14
      : null;
  return evaluateStrategyConsensus(
    candidate.features,
    candidate.relativeStrength,
    candidate.strategy,
    {
      rewardRisk: candidate.tradePlan.rewardRiskApprox,
      stopDistAtr: stopDist,
      mtfOverallScore: candidate.features.enhanced?.multiTimeframeAlignment ?? null,
    },
  );
}

function pickIndependent(
  raw: Array<{ id: string; score: number }>,
  correlatedPair: [string, string],
  suppressed: string[],
): Array<{ id: string; score: number }> {
  const [a, b] = correlatedPair;
  const hasA = raw.find((r) => r.id === a);
  const hasB = raw.find((r) => r.id === b);
  if (hasA && hasB) {
    // Keep the stronger; suppress the other
    if (hasA.score >= hasB.score) {
      suppressed.push(b);
      return raw.filter((r) => r.id !== b);
    }
    suppressed.push(a);
    return raw.filter((r) => r.id !== a);
  }
  return raw;
}

function capFamily(
  family: EvidenceFamily,
  raw: Array<{ id: string; score: number }>,
): FamilyEvidence {
  if (raw.length === 0) {
    return { family, factors: [], score: 0, rawFactors: [] };
  }
  // Diminishing combination: max + 0.25 * sum(rest), capped
  const sorted = [...raw].sort((x, y) => y.score - x.score);
  const head = sorted[0].score;
  const rest = sorted.slice(1).reduce((s, r) => s + r.score, 0);
  const score = Math.min(FAMILY_SCORE_CAP, Math.round(head + 0.25 * rest));
  return {
    family,
    factors: sorted.map((r) => r.id),
    score,
    rawFactors: sorted,
  };
}
