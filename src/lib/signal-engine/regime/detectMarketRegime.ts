// ════════════════════════════════════════════════════════════════
//  Market Regime Detector — Product A Phase 3
//
//  ONE regime engine. All classification flows through this module.
//  Supporting calculators live under ./regime* but there is a single
//  returned contract and a single source of strategy eligibility
//  (strategyRegistry + evaluateStrategyRegimeEligibility).
// ════════════════════════════════════════════════════════════════

import type {
  Candle,
  MarketRegime,
  MarketRegimeLabel,
  EnhancedMarketRegime,
  RegimeDetectionOptions,
  RegimeDimensions,
} from '../types/signalEngine.types';
import { BULLISH_ALLOWED_REGIMES } from '../constants/signalEngine.constants';
import { round } from '../utils/math';
import { buildRegimeEvidence } from './regimeEvidence';
import {
  classifyAllDimensions,
  volatilityLabelFromState,
  trendStateFromLabel,
} from './regimeDimensions';
import {
  applyRegimeHysteresis,
  getLastPublishedRegime,
  setLastPublishedRegime,
  REGIME_MIN_CONFIRMATION_BARS,
} from './regimeHysteresis';

export const REGIME_MODEL_VERSION = '3.0.0';

export {
  applyRegimeHysteresis,
  getLastPublishedRegime,
  setLastPublishedRegime,
  clearLastPublishedRegime,
  REGIME_MIN_CONFIRMATION_BARS,
} from './regimeHysteresis';
export { buildRegimeEvidence } from './regimeEvidence';
export {
  classifyAllDimensions,
  classifyTrendState,
  classifyVolatilityState,
  classifyBreadthState,
  classifyLiquidityState,
  classifyTransitionState,
  labelFromTrendAndVol,
  trendStateFromLabel,
  volatilityLabelFromState,
} from './regimeDimensions';

/**
 * Full structured regime detection — production + backtest entry point.
 */
export function detectEnhancedRegime(
  benchmarkCandles: Candle[],
  options: RegimeDetectionOptions = {},
): EnhancedMarketRegime {
  const evidence = buildRegimeEvidence(benchmarkCandles, options.external);

  // Deterministic default: do NOT pull process-local hysteresis memory.
  // Local vs production previously diverged (e.g. Sideways vs High Vol)
  // solely because each Node process remembered a different last label.
  // Opt in with useProcessMemory=true for live tick continuity only.
  const prev =
    options.previous !== undefined
      ? options.previous
      : options.useProcessMemory
        ? (() => {
            const mem = getLastPublishedRegime();
            return mem
              ? {
                  label: mem.label,
                  dimensions: mem.dimensions,
                  confirmationBarsHeld: mem.confirmationBarsHeld,
                  candidateLabel: mem.candidateLabel,
                }
              : null;
          })()
        : null;

  const previousTrend = prev?.dimensions?.trend_state ?? (prev ? trendStateFromLabel(prev.label) : null);
  const rawDimensions = classifyAllDimensions(evidence, previousTrend);

  const hyst = applyRegimeHysteresis({
    candidateTrend: rawDimensions.trend_state,
    candidateVol: rawDimensions.volatility_state,
    previousLabel: prev?.label ?? null,
    previousDimensions: prev?.dimensions ?? null,
    previousCandidateLabel: prev?.candidateLabel ?? null,
    confirmationBarsHeld: prev?.confirmationBarsHeld ?? 0,
    minConfirmationBars: REGIME_MIN_CONFIRMATION_BARS,
  });

  const publishedLabel = hyst.changed || prev == null ? hyst.candidateLabel : (prev!.label);
  const dimensions = refineDimensionsForPublishedLabel(rawDimensions, publishedLabel);

  // Strength / confidence
  let bullishCount = 0;
  if (evidence.closeVsEma20 > 0) bullishCount++;
  if (evidence.closeVsEma50 > 0) bullishCount++;
  if (evidence.closeVsEma200 > 0) bullishCount++;
  if (evidence.ema20VsEma50 > 0) bullishCount++;
  if (evidence.ema50VsEma200 > 0) bullishCount++;
  if (evidence.rsi >= 50 && evidence.rsi <= 70) bullishCount++;
  const strength = round((bullishCount / 6) * 100);
  const confidence = round(
    Math.min(
      100,
      strength * 0.6 +
        hyst.transitionConfidence * 0.4 +
        (publishedLabel.includes('Strong') ? 5 : 0),
    ),
  );

  const result: EnhancedMarketRegime = {
    label: publishedLabel,
    allowBullishSignals: (BULLISH_ALLOWED_REGIMES as readonly string[]).includes(publishedLabel),
    details: {
      closeVsEma20: evidence.closeVsEma20,
      closeVsEma50: evidence.closeVsEma50,
      closeVsEma200: evidence.closeVsEma200,
      ema20VsEma50: evidence.ema20VsEma50,
      ema50VsEma200: evidence.ema50VsEma200,
      rsi: evidence.rsi,
      atrPct: evidence.atrPct,
    },
    strength,
    volatilityRegime: volatilityLabelFromState(dimensions.volatility_state),
    trendSlope: evidence.ema20SlopePct,
    confidence,
    dimensions,
    evidence,
    hysteresis: { ...hyst, previousLabel: prev?.label ?? null },
    modelVersion: REGIME_MODEL_VERSION,
  };

  if (options.useProcessMemory) {
    setLastPublishedRegime({
      label: result.label,
      dimensions: result.dimensions,
      confirmationBarsHeld: result.hysteresis.confirmationBarsHeld,
      candidateLabel: result.hysteresis.candidateLabel,
    });
  }

  return result;
}

/**
 * Lightweight / Phase-1-compatible entry — same engine, thinner return type.
 */
export function detectMarketRegime(
  benchmarkCandles: Candle[],
  options: RegimeDetectionOptions = {},
): MarketRegime {
  const full = detectEnhancedRegime(benchmarkCandles, options);
  return {
    label: full.label,
    allowBullishSignals: full.allowBullishSignals,
    details: full.details,
    dimensions: full.dimensions,
    evidence: full.evidence,
    hysteresis: full.hysteresis,
    modelVersion: full.modelVersion,
  };
}

function refineDimensionsForPublishedLabel(
  dims: RegimeDimensions,
  label: MarketRegimeLabel,
): RegimeDimensions {
  // Keep vol extreme aligned with High Volatility Risk label
  if (label === 'High Volatility Risk') {
    return { ...dims, volatility_state: 'extreme', trend_state: dims.trend_state };
  }
  return {
    ...dims,
    trend_state: trendStateFromLabel(label) === 'neutral' && label === 'Sideways'
      ? 'neutral'
      : label === 'Strong Bullish'
        ? 'strong_bull'
        : label === 'Bullish'
          ? 'bull'
          : label === 'Bearish'
            ? 'strong_bear'
            : label === 'Weak'
              ? 'bear'
              : dims.trend_state,
  };
}
