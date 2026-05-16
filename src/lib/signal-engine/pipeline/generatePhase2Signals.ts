// ════════════════════════════════════════════════════════════════
//  Phase 2 Signal Generation Pipeline
//
//  Multi-strategy pipeline with:
//  - Strategy registry + regime gating
//  - Enhanced multi-period relative strength
//  - Sector context enrichment
//  - Strategy-specific scoring
//  - Conflict resolution with audit trail
//  - Full breakdown persistence
// ════════════════════════════════════════════════════════════════

import type {
  Candle, Phase1Config, EnhancedMarketRegime,
  StrategyName, SignalAction, SignalSubtype, MarketContextTag, StrengthTag,
  Phase2Signal, Phase2PipelineResult, ConflictResolution,
  StrategyBreakdown, SectorContext, StrategyCandidate,
} from '../types/signalEngine.types';
import { DEFAULT_PHASE1_CONFIG } from '../constants/signalEngine.constants';
import { detectEnhancedRegime } from '../regime/detectMarketRegime';
import { buildSignalFeatures } from '../features/buildSignalFeatures';
import { computeEnhancedRelativeStrength, defaultEnhancedRelativeStrength } from '../context/relativeStrength';
import { buildSectorContextFromStock, defaultSectorContext } from '../context/sectorContext';
import { isStrategyAllowedInRegime, STRATEGY_REGISTRY } from '../strategies/strategyRegistry';
import { resolveConflicts } from '../strategy-engine/resolveConflicts';
import { scoreForStrategy } from '../scoring/strategyScorers';
import { scoreRisk } from '../scoring/riskScorer';
import { buildTradePlanForStrategy } from '../trade-plan/buildTradePlan';
import { buildReasons } from '../explain/buildReasons';
import { buildWarnings } from '../explain/buildWarnings';
import { rankSignals } from './rankSignals';
import { saveSignals } from '../repository/saveSignals';
import { saveStrategyBreakdowns, saveConflictResolution } from '../repository/saveStrategyBreakdowns';
import { validateCandleSeries } from '../utils/candles';
import { validateFeatures } from '../utils/validation';
import { round } from '../utils/math';
import type { CandleProvider } from './generatePhase1Signals';

// ── Strategy evaluators ────────────────────────────────────
import { evaluateBullishBreakout } from '../strategies/bullishBreakout';
import { evaluateBullishPullback } from '../strategies/bullishPullback';
import { evaluateBearishBreakdown } from '../strategies/bearishBreakdown';
import { evaluateMeanReversionBounce } from '../strategies/meanReversionBounce';
import { evaluateMomentumContinuation } from '../strategies/momentumContinuation';
import { evaluateBullishDivergence } from '../strategies/bullishDivergence';
import { evaluateVolumeClimaxReversal } from '../strategies/volumeClimaxReversal';
import { evaluateGapContinuation } from '../strategies/gapContinuation';
import { evaluateRangeBreakout } from '../strategies/rangeBreakout';
import { evaluateEmaCrossover } from '../strategies/emaCrossover';
import { evaluateOversoldBounce } from '../strategies/oversoldBounce';
import { evaluateOverboughtReversal } from '../strategies/overboughtReversal';
import { evaluateWeakTrendBreakdown } from '../strategies/weakTrendBreakdown';
import type { SignalFeatures, StrategyMatchResult } from '../types/signalEngine.types';

const STRATEGY_EVALUATORS: Record<StrategyName, (f: SignalFeatures) => StrategyMatchResult> = {
  bullish_breakout:       (f) => evaluateBullishBreakout(f),
  momentum_continuation:  evaluateMomentumContinuation,
  gap_continuation:       evaluateGapContinuation,
  bullish_pullback:       evaluateBullishPullback,
  bearish_breakdown:      evaluateBearishBreakdown,
  mean_reversion_bounce:  evaluateMeanReversionBounce,
  bullish_divergence:     evaluateBullishDivergence,
  volume_climax_reversal: evaluateVolumeClimaxReversal,
  range_breakout:         evaluateRangeBreakout,
  ema_crossover:          evaluateEmaCrossover,
  oversold_bounce:        evaluateOversoldBounce,
  overbought_reversal:    evaluateOverboughtReversal,
  weak_trend_breakdown:   evaluateWeakTrendBreakdown,
};

const ACTION_MAP: Record<StrategyName, SignalAction> = {
  bullish_breakout:       'enter_on_strength',
  bullish_pullback:       'enter_on_pullback',
  bearish_breakdown:      'enter_short',
  mean_reversion_bounce:  'enter_on_bounce',
  momentum_continuation:  'enter_on_momentum',
  bullish_divergence:     'enter_on_divergence',
  volume_climax_reversal: 'enter_on_climax',
  gap_continuation:       'enter_on_gap',
  range_breakout:         'enter_on_breakout',
  ema_crossover:          'enter_on_crossover',
  oversold_bounce:        'enter_on_oversold',
  overbought_reversal:    'enter_short',
  weak_trend_breakdown:   'enter_short',
};

const SUBTYPE_MAP: Record<StrategyName, SignalSubtype> = {
  bullish_breakout:       'fresh_breakout',
  bullish_pullback:       'pullback_entry',
  bearish_breakdown:      'breakdown',
  mean_reversion_bounce:  'reversal_bounce',
  momentum_continuation:  'momentum_ride',
  bullish_divergence:     'divergence_reversal',
  volume_climax_reversal: 'climax_reversal',
  gap_continuation:       'gap_and_go',
  range_breakout:         'range_expansion',
  ema_crossover:          'ema_cross',
  oversold_bounce:        'oversold_reversal',
  overbought_reversal:    'overbought_reversal_entry',
  weak_trend_breakdown:   'weak_trend_entry',
};

function contextTag(regime: string): MarketContextTag {
  if (regime === 'Strong Bullish' || regime === 'Bullish') return 'Bullish';
  if (regime === 'Bearish' || regime === 'Weak') return 'Weak';
  return 'Neutral';
}

function strengthTag(confidence: number): StrengthTag {
  if (confidence >= 85) return 'High Conviction';
  if (confidence >= 70) return 'Actionable';
  if (confidence >= 55) return 'Watchlist';
  return 'Avoid';
}

// ════════════════════════════════════════════════════════════════
//  MAIN PIPELINE
// ════════════════════════════════════════════════════════════════
export interface Phase2RunOptions {
  /** String tag persisted to q365_signals.generation_source for audit. */
  generationSource?: string;
}

export async function generatePhase2Signals(
  provider: CandleProvider,
  config: Phase1Config = DEFAULT_PHASE1_CONFIG,
  options: Phase2RunOptions = {},
): Promise<Phase2PipelineResult> {
  const generationSource = options.generationSource ?? 'signal-engine:generatePhase2Signals';
  const now = new Date().toISOString();
  const rejected: Phase2PipelineResult['rejected'] = [];
  const allConflicts: ConflictResolution[] = [];

  // ── Step 1: Detect enhanced regime ────────────────────────
  const benchmarkCandles = await provider.fetchDailyCandles(config.benchmarkSymbol);
  const benchValid = validateCandleSeries(benchmarkCandles, config.minCandleCount);
  if (!benchValid.valid) {
    throw new Error(`Benchmark data invalid: ${benchValid.reason}`);
  }
  const regime = detectEnhancedRegime(benchmarkCandles);

  console.log(`[Phase2] Regime: ${regime.label} (strength=${regime.strength}, vol=${regime.volatilityRegime}, slope=${regime.trendSlope})`);

  // ── Step 2: Process each symbol ──────────────────────────
  const signals: Phase2Signal[] = [];

  for (const symbol of config.universe) {
    try {
      const candles = await provider.fetchDailyCandles(symbol);
      const candleCheck = validateCandleSeries(candles, config.minCandleCount);
      if (!candleCheck.valid) {
        rejected.push({ symbol, reason: candleCheck.reason! });
        continue;
      }

      // ── Build features ────────────────────────────────────
      const features = buildSignalFeatures(candles, regime.label, config.minAvgVolume, config.minPrice);
      const featureCheck = validateFeatures(features);
      if (!featureCheck.valid) {
        rejected.push({ symbol, reason: featureCheck.reason! });
        continue;
      }

      // ── Compute enhanced relative strength ────────────────
      let enhancedRs = defaultEnhancedRelativeStrength();
      try {
        const sectorCtx = buildSectorContextFromStock(symbol, candles, benchmarkCandles);
        enhancedRs = computeEnhancedRelativeStrength(
          candles, benchmarkCandles, undefined, sectorCtx.sectorTrendLabel,
        );
      } catch {}

      // ── Build sector context ──────────────────────────────
      let sectorContext: SectorContext;
      try {
        sectorContext = buildSectorContextFromStock(symbol, candles, benchmarkCandles);
      } catch {
        sectorContext = defaultSectorContext(symbol);
      }

      // ── Run strategies with registry gating ───────────────
      const candidates: StrategyCandidate[] = [];
      const breakdowns: StrategyBreakdown[] = [];

      for (const [strategyName, evaluate] of Object.entries(STRATEGY_EVALUATORS) as [StrategyName, (f: SignalFeatures) => StrategyMatchResult][]) {
        // Registry gating: check regime compatibility
        const regimeCheck = isStrategyAllowedInRegime(strategyName, regime.label);
        if (!regimeCheck.allowed) {
          rejected.push({ symbol, strategy: strategyName, reason: regimeCheck.reason! });
          breakdowns.push({
            strategyName, matched: false,
            confidenceScore: 0, riskScore: 0, regimeFit: 0,
            rsAlignment: 0, sectorFit: 0, structuralQuality: 0,
            rejectionReason: regimeCheck.reason,
          });
          continue;
        }

        // Run strategy evaluation
        const result = evaluate(features);
        if (!result.matched) {
          rejected.push({ symbol, strategy: strategyName, reason: result.rejectionReason || 'Not matched' });
          breakdowns.push({
            strategyName, matched: false,
            confidenceScore: 0, riskScore: 0, regimeFit: 0,
            rsAlignment: 0, sectorFit: 0, structuralQuality: 0,
            rejectionReason: result.rejectionReason,
          });
          continue;
        }

        // Strategy matched → compute strategy-specific score
        const confidence = scoreForStrategy(features, strategyName, enhancedRs, sectorContext);
        const tradePlan = buildTradePlanForStrategy(features, strategyName);
        const stopDistPct = features.trend.close > 0
          ? Math.abs((features.trend.close - tradePlan.stopLoss) / features.trend.close) * 100
          : 0;
        const risk = scoreRisk(features, stopDistPct);
        const reasons = buildReasons(features, strategyName);
        const warnings = buildWarnings(features, strategyName);

        // RS-based rejection for long strategies
        const entry = STRATEGY_REGISTRY[strategyName];
        if (entry.direction === 'long' && enhancedRs.rsVsIndex < -5) {
          rejected.push({ symbol, strategy: strategyName, reason: `Weak RS vs index: ${enhancedRs.rsVsIndex}%` });
          breakdowns.push({
            strategyName, matched: true,
            confidenceScore: confidence.finalScore, riskScore: risk.totalScore,
            regimeFit: 70, rsAlignment: 0, sectorFit: sectorContext.sectorStrengthScore,
            structuralQuality: 50, rejectionReason: 'RS rejection',
          });
          continue;
        }
        if (entry.direction === 'short' && enhancedRs.rsVsIndex > 3) {
          rejected.push({ symbol, strategy: strategyName, reason: `Stock outperforming index` });
          continue;
        }

        // Sector weakness rejection for longs
        if (entry.direction === 'long' && sectorContext.sectorStrengthScore < 30) {
          rejected.push({ symbol, strategy: strategyName, reason: `Weak sector: ${sectorContext.sectorStrengthScore}` });
          continue;
        }

        candidates.push({
          strategy: strategyName,
          features, relativeStrength: enhancedRs,
          confidence, risk, tradePlan, reasons, warnings,
        });

        breakdowns.push({
          strategyName, matched: true,
          confidenceScore: confidence.finalScore,
          riskScore: risk.totalScore,
          regimeFit: regimeCheck.allowed ? 80 : 20,
          rsAlignment: round(50 + enhancedRs.rsVsIndex * 5),
          sectorFit: sectorContext.sectorStrengthScore,
          structuralQuality: round(confidence.structureScore / 20 * 100),
        });
      }

      // ── No candidates ─────────────────────────────────────
      if (candidates.length === 0) continue;

      // ── Conflict resolution ───────────────────────────────
      const { winner, resolution } = resolveConflicts(candidates, regime, sectorContext);
      resolution.symbol = symbol;

      if (resolution.losingStrategies.length > 0) {
        allConflicts.push(resolution);
      }

      // Early confidence filter REMOVED — API applies the final cut.
      void config;

      // ── Build context score ───────────────────────────────
      const contextScore = Math.round(
        regime.strength * 0.35 +
        sectorContext.sectorStrengthScore * 0.30 +
        (50 + enhancedRs.rsVsIndex) * 0.20 +
        (enhancedRs.rsTrend === 'improving' ? 15 : enhancedRs.rsTrend === 'stable' ? 8 : 0) * 0.15,
      );

      // ── Assemble Phase 2 Signal ───────────────────────────
      const signal: Phase2Signal = {
        symbol,
        timeframe: 'daily',
        signalType: winner.strategy,
        signalSubtype: SUBTYPE_MAP[winner.strategy],
        action: ACTION_MAP[winner.strategy],
        marketRegime: regime.label,
        marketContextTag: contextTag(regime.label),
        strengthTag: strengthTag(winner.confidence.finalScore),
        strategyName: winner.strategy.replace(/_/g, ' '),
        strategyConfidence: winner.confidence.finalScore,
        contextScore,

        confidenceScore: winner.confidence.finalScore,
        confidenceBand: winner.confidence.band,
        riskScore: winner.risk.totalScore,
        riskBand: winner.risk.band,

        entry: winner.tradePlan.entry,
        stopLoss: winner.tradePlan.stopLoss,
        targets: winner.tradePlan.targets,
        rewardRiskApprox: winner.tradePlan.rewardRiskApprox,

        reasons: winner.reasons,
        warnings: winner.warnings,

        features,
        relativeStrength: enhancedRs,
        confidenceBreakdown: winner.confidence,
        riskBreakdown: winner.risk,

        status: winner.confidence.band === 'Watchlist' ? 'watchlist' : 'active',
        generatedAt: now,

        // Phase 2 extensions
        sectorContext,
        enhancedRs: enhancedRs,
        strategyBreakdowns: breakdowns,
        conflictResolution: resolution.losingStrategies.length > 0 ? resolution : undefined,
        freshnessTag: 'fresh',
      };

      signals.push(signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      rejected.push({ symbol, reason: `Error: ${msg}` });
    }
  }

  // ── Step 3: Rank ──────────────────────────────────────────
  const ranked = rankSignals(signals) as Phase2Signal[];

  // ── Step 4: Persist ───────────────────────────────────────
  try {
    const signalIdMap = await saveSignals(ranked, generationSource);

    // Save breakdowns and conflicts for audit — now using REAL signal IDs.
    // Errors here are logged loudly rather than swallowed: strategy
    // transparency is a hard requirement, and a silent catch once hid
    // the fact that the table didn't even exist on live DBs.
    for (const signal of ranked) {
      if (signal.strategyBreakdowns?.length > 0) {
        const realId = signalIdMap.get(signal.symbol);
        if (realId) {
          try {
            await saveStrategyBreakdowns(realId, signal.strategyBreakdowns);
          } catch (err) {
            console.error(`[Phase2] saveStrategyBreakdowns failed for ${signal.symbol} (signal_id=${realId}):`, (err as Error).message);
          }
        }
      }
    }
    // Link each conflict to its winning signal id so the audit trail
    // is joinable. Falls back to null if the winner was not persisted
    // (e.g. saveOneSignal threw for that symbol).
    for (const conflict of allConflicts) {
      try {
        const winnerId = signalIdMap.get(conflict.symbol);
        await saveConflictResolution(conflict, winnerId);
      } catch (err) {
        console.error(`[Phase2] saveConflictResolution failed for ${conflict.symbol}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.error('[Phase2] Failed to persist signals:', err);
  }

  // ── Step 5: Log summary ───────────────────────────────────
  const byStrategy: Record<string, number> = {};
  for (const s of ranked) {
    byStrategy[s.signalType] = (byStrategy[s.signalType] || 0) + 1;
  }
  const stratSummary = Object.entries(byStrategy).map(([k, v]) => `${k}:${v}`).join(', ');
  console.log(`[Phase2] Complete — ${ranked.length} signals [${stratSummary}], ${allConflicts.length} conflicts, ${rejected.length} rejections`);

  return {
    regime,
    signals: ranked,
    scanned: config.universe.length,
    matched: ranked.length,
    conflicts: allConflicts,
    rejected,
  };
}
