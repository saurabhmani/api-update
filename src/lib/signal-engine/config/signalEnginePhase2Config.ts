// ════════════════════════════════════════════════════════════════
//  Product A — Versioned Phase 2 Configuration
//
//  All Phase 2 thresholds live here. Env overrides are explicit and
//  clamped. Set SIGNAL_ENGINE_CONFIG_VERSION=1 to reproduce Phase 1
//  behaviour exactly (no calibration / quality-gate adjustments).
// ════════════════════════════════════════════════════════════════

export const SIGNAL_ENGINE_CONFIG_VERSION = '2.0.0';

export interface Phase2FeatureThresholds {
  minTrendStrength: number;
  minVolumeQuality: number;
  minLiquidityQuality: number;
  minBreakoutQuality: number;
  maxTrendExhaustion: number;
  minMomentumPersistence: number;
  minMarketParticipation: number;
}

export interface Phase2RejectionThresholds {
  minTrendStrength: number;
  minLiquidityQuality: number;
  maxEstimatedSpreadPct: number;
  maxAbnormalAtrPct: number;
  minConfirmationScore: number;
  minRewardRisk: number;
  maxLateBreakoutDistancePct: number;
  maxOverextensionFromEma20Pct: number;
}

export interface Phase2ConfidenceCalibration {
  enabled: boolean;
  maxAdjustment: number;
  minEnhancedTrendForBonus: number;
  minEnhancedVolumeForBonus: number;
  maxTrendExhaustionPenalty: number;
}

export interface Phase2TradePlanConfig {
  roundPrices: boolean;
  minStopAtrMultiple: number;
  maxStopAtrMultiple: number;
  structureStopBufferAtr: number;
}

export interface SignalEnginePhase2Config {
  version: number;
  configVersionLabel: string;
  features: Phase2FeatureThresholds;
  rejection: Phase2RejectionThresholds;
  confidence: Phase2ConfidenceCalibration;
  tradePlan: Phase2TradePlanConfig;
}

function envNum(name: string, lo: number, hi: number, fallback: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(lo, Math.min(hi, raw));
}

function envBool(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return fallback;
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') return true;
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') return false;
  return fallback;
}

const PHASE2_DEFAULTS: SignalEnginePhase2Config = {
  version: 2,
  configVersionLabel: SIGNAL_ENGINE_CONFIG_VERSION,
  features: {
    minTrendStrength: 35,
    minVolumeQuality: 30,
    minLiquidityQuality: 40,
    minBreakoutQuality: 25,
    maxTrendExhaustion: 75,
    minMomentumPersistence: 30,
    minMarketParticipation: 35,
  },
  rejection: {
    minTrendStrength: 30,
    minLiquidityQuality: 35,
    maxEstimatedSpreadPct: 1.5,
    maxAbnormalAtrPct: 8.0,
    minConfirmationScore: 40,
    minRewardRisk: 1.2,
    maxLateBreakoutDistancePct: 4.5,
    maxOverextensionFromEma20Pct: 7.0,
  },
  confidence: {
    enabled: true,
    maxAdjustment: 5,
    minEnhancedTrendForBonus: 60,
    minEnhancedVolumeForBonus: 55,
    maxTrendExhaustionPenalty: 70,
  },
  tradePlan: {
    roundPrices: true,
    minStopAtrMultiple: 0.5,
    maxStopAtrMultiple: 3.0,
    structureStopBufferAtr: 0.3,
  },
};

const PHASE1_COMPAT: SignalEnginePhase2Config = {
  ...PHASE2_DEFAULTS,
  version: 1,
  configVersionLabel: '1.0.0-phase1-compat',
  confidence: { ...PHASE2_DEFAULTS.confidence, enabled: false },
};

let cached: SignalEnginePhase2Config | null = null;

/**
 * Resolve active signal-engine config. Version 1 disables Phase 2
 * calibration and quality gates for historical replay parity.
 */
export function getSignalEngineConfig(): SignalEnginePhase2Config {
  if (cached) return cached;

  const versionRaw = Number(process.env.SIGNAL_ENGINE_CONFIG_VERSION);
  const version = Number.isFinite(versionRaw) && versionRaw >= 1 && versionRaw <= 2
    ? Math.floor(versionRaw)
    : 2;

  const base = version === 1 ? PHASE1_COMPAT : { ...PHASE2_DEFAULTS };

  cached = {
    ...base,
    version,
    features: {
      minTrendStrength: envNum('SIGNAL_P2_MIN_TREND_STRENGTH', 0, 100, base.features.minTrendStrength),
      minVolumeQuality: envNum('SIGNAL_P2_MIN_VOLUME_QUALITY', 0, 100, base.features.minVolumeQuality),
      minLiquidityQuality: envNum('SIGNAL_P2_MIN_LIQUIDITY_QUALITY', 0, 100, base.features.minLiquidityQuality),
      minBreakoutQuality: envNum('SIGNAL_P2_MIN_BREAKOUT_QUALITY', 0, 100, base.features.minBreakoutQuality),
      maxTrendExhaustion: envNum('SIGNAL_P2_MAX_TREND_EXHAUSTION', 0, 100, base.features.maxTrendExhaustion),
      minMomentumPersistence: envNum('SIGNAL_P2_MIN_MOMENTUM_PERSISTENCE', 0, 100, base.features.minMomentumPersistence),
      minMarketParticipation: envNum('SIGNAL_P2_MIN_MARKET_PARTICIPATION', 0, 100, base.features.minMarketParticipation),
    },
    rejection: {
      minTrendStrength: envNum('SIGNAL_P2_REJECT_MIN_TREND', 0, 100, base.rejection.minTrendStrength),
      minLiquidityQuality: envNum('SIGNAL_P2_REJECT_MIN_LIQUIDITY', 0, 100, base.rejection.minLiquidityQuality),
      maxEstimatedSpreadPct: envNum('SIGNAL_P2_MAX_SPREAD_PCT', 0.1, 10, base.rejection.maxEstimatedSpreadPct),
      maxAbnormalAtrPct: envNum('SIGNAL_P2_MAX_ATR_PCT', 1, 20, base.rejection.maxAbnormalAtrPct),
      minConfirmationScore: envNum('SIGNAL_P2_MIN_CONFIRMATION', 0, 100, base.rejection.minConfirmationScore),
      minRewardRisk: envNum('SIGNAL_P2_MIN_RR', 0.5, 5, base.rejection.minRewardRisk),
      maxLateBreakoutDistancePct: envNum('SIGNAL_P2_MAX_LATE_BREAKOUT_PCT', 1, 15, base.rejection.maxLateBreakoutDistancePct),
      maxOverextensionFromEma20Pct: envNum('SIGNAL_P2_MAX_OVEREXTENSION_PCT', 2, 20, base.rejection.maxOverextensionFromEma20Pct),
    },
    confidence: {
      enabled: envBool('SIGNAL_P2_CONFIDENCE_CALIBRATION', base.confidence.enabled),
      maxAdjustment: envNum('SIGNAL_P2_CONFIDENCE_MAX_ADJ', 0, 15, base.confidence.maxAdjustment),
      minEnhancedTrendForBonus: envNum('SIGNAL_P2_CONF_TREND_BONUS', 0, 100, base.confidence.minEnhancedTrendForBonus),
      minEnhancedVolumeForBonus: envNum('SIGNAL_P2_CONF_VOL_BONUS', 0, 100, base.confidence.minEnhancedVolumeForBonus),
      maxTrendExhaustionPenalty: envNum('SIGNAL_P2_CONF_EXHAUST_PENALTY', 0, 100, base.confidence.maxTrendExhaustionPenalty),
    },
    tradePlan: {
      roundPrices: envBool('SIGNAL_P2_ROUND_PRICES', base.tradePlan.roundPrices),
      minStopAtrMultiple: envNum('SIGNAL_P2_MIN_STOP_ATR', 0.1, 5, base.tradePlan.minStopAtrMultiple),
      maxStopAtrMultiple: envNum('SIGNAL_P2_MAX_STOP_ATR', 0.5, 10, base.tradePlan.maxStopAtrMultiple),
      structureStopBufferAtr: envNum('SIGNAL_P2_STRUCTURE_STOP_ATR', 0, 2, base.tradePlan.structureStopBufferAtr),
    },
  };

  return cached;
}

/** Reset cached config — for tests only. */
export function resetSignalEngineConfigCache(): void {
  cached = null;
}
