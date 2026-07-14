// ════════════════════════════════════════════════════════════════
//  Unified Signal Feature Builder
// ════════════════════════════════════════════════════════════════

import type { Candle, SignalFeatures, MarketRegimeLabel } from '../types/signalEngine.types';
import {
  validateCandleSeriesIntegrity,
  type CandleIntegrityOptions,
  type IntegrityIssue,
} from '@/lib/marketData/integrity/marketDataIntegrity';
import { buildTrendFeatures } from './buildTrendFeatures';
import { buildMomentumFeatures } from './buildMomentumFeatures';
import { buildVolumeFeatures } from './buildVolumeFeatures';
import { buildVolatilityFeatures } from './buildVolatilityFeatures';
import { buildStructureFeatures } from './buildStructureFeatures';
import { buildEnhancedFeatures } from './buildEnhancedFeatures';
import { isLiquid } from '../utils/validation';
import type { RelativeStrengthFeatures } from '../types/signalEngine.types';
import { MIN_AVG_VOLUME, MIN_PRICE } from '../constants/signalEngine.constants';
import type { AssetDefinition } from '@/lib/platform/types';
import { buildCanonicalSignalFeatures } from '@/lib/platform/featureAdapters/featureAdapterRouter';

export interface BuildSignalFeaturesOptions {
  /** Deterministic clock for integrity (required for replay). */
  nowMs?: number;
  integrity?: CandleIntegrityOptions;
  relativeStrength?: RelativeStrengthFeatures;
  asset?: AssetDefinition;
  /** Phase 3 — attach structured regime dimensions for eligibility. */
  regimeDimensions?: import('../types/signalEngine.types').RegimeDimensions;
  regimeHysteresis?: Pick<
    import('../types/signalEngine.types').RegimeHysteresisState,
    'confirmationBarsHeld' | 'changed' | 'minConfirmationBars'
  >;
}

export interface BuildSignalFeaturesResult {
  features: SignalFeatures;
  integrityIssues: IntegrityIssue[];
  integrityValid: boolean;
  candlesUsed: Candle[];
}

/**
 * Canonical feature builder. Pass `nowMs` / integrity options for
 * deterministic replay — do not rely on wall-clock inside callers.
 */
export function buildSignalFeaturesDetailed(
  candles: Candle[],
  marketRegime: MarketRegimeLabel,
  minAvgVolume = MIN_AVG_VOLUME,
  minPrice = MIN_PRICE,
  options: BuildSignalFeaturesOptions = {},
): BuildSignalFeaturesResult {
  if (options.asset && options.asset.assetClass !== 'equity') {
    const features = buildCanonicalSignalFeatures({
      asset: options.asset,
      candles,
      marketRegime,
      minAvgVolume,
      minPrice,
      relativeStrength: options.relativeStrength,
    });
    return {
      features,
      integrityIssues: [],
      integrityValid: true,
      candlesUsed: candles,
    };
  }

  const integrity = validateCandleSeriesIntegrity(candles, {
    ...options.integrity,
    nowMs: options.nowMs ?? options.integrity?.nowMs,
  });
  const series = integrity.candles.length > 0 ? integrity.candles : candles;

  const trend = buildTrendFeatures(series);
  const momentum = buildMomentumFeatures(series);
  const volume = buildVolumeFeatures(series);
  const volatility = buildVolatilityFeatures(series);
  const structure = buildStructureFeatures(series);

  const liquidityPass = isLiquid(volume.avgVolume20, trend.close, minAvgVolume, minPrice);

  const base: SignalFeatures = {
    trend,
    momentum,
    volume,
    volatility,
    structure,
    context: {
      marketRegime,
      liquidityPass,
      ...(options.regimeDimensions ? { regimeDimensions: options.regimeDimensions } : {}),
      ...(options.regimeHysteresis ? { regimeHysteresis: options.regimeHysteresis } : {}),
    },
  };

  const features: SignalFeatures = {
    ...base,
    enhanced: buildEnhancedFeatures(base, options.relativeStrength),
    _sourceCandles: series,
  };

  return {
    features,
    integrityIssues: integrity.issues,
    integrityValid: integrity.valid,
    candlesUsed: series,
  };
}

/** Backward-compatible wrapper — behaviour unchanged for default callers. */
export function buildSignalFeatures(
  candles: Candle[],
  marketRegime: MarketRegimeLabel,
  minAvgVolume = MIN_AVG_VOLUME,
  minPrice = MIN_PRICE,
  relativeStrength?: RelativeStrengthFeatures,
  asset?: AssetDefinition,
): SignalFeatures {
  return buildSignalFeaturesDetailed(
    candles,
    marketRegime,
    minAvgVolume,
    minPrice,
    { relativeStrength, asset },
  ).features;
}
