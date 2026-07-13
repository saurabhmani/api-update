// ════════════════════════════════════════════════════════════════
//  Strategy Hub — configurable parameter catalog (Phase 3)
// ════════════════════════════════════════════════════════════════

import type {
  MarketRegimeLabel,
  StrategyRiskProfile,
} from '@/lib/signal-engine/types/signalEngine.types';

export const MARKET_REGIME_LABELS: MarketRegimeLabel[] = [
  'Strong Bullish',
  'Bullish',
  'Sideways',
  'Weak',
  'Bearish',
  'High Volatility Risk',
];

export const RISK_PROFILES: StrategyRiskProfile[] = [
  'conservative',
  'moderate',
  'moderate_high',
  'high',
];

export const TIMEFRAMES = ['intraday', 'swing', 'positional', 'daily'] as const;
export type ConfigurableTimeframe = (typeof TIMEFRAMES)[number];

export type ConfigurableParamKey =
  | 'idealRsiRange'
  | 'minAdx'
  | 'minVolumeExpansion'
  | 'defaultConfidenceWeight'
  | 'allowedRegimes'
  | 'blockedRegimes'
  | 'idealMarketRegime'
  | 'riskProfile'
  | 'timeframe';

export const CONFIGURABLE_PARAM_KEYS: ConfigurableParamKey[] = [
  'idealRsiRange',
  'minAdx',
  'minVolumeExpansion',
  'defaultConfidenceWeight',
  'allowedRegimes',
  'blockedRegimes',
  'idealMarketRegime',
  'riskProfile',
  'timeframe',
];

export type ConfigurableParamValue =
  | [number, number]
  | number
  | MarketRegimeLabel[]
  | StrategyRiskProfile
  | ConfigurableTimeframe;

export interface ParamFieldMeta {
  key: ConfigurableParamKey;
  label: string;
  description: string;
  type: 'rsiRange' | 'number' | 'regimeList' | 'riskProfile' | 'timeframe' | 'weight';
  optional?: boolean;
  min?: number;
  max?: number;
  step?: number;
}

export const PARAM_FIELD_CATALOG: ParamFieldMeta[] = [
  {
    key: 'idealRsiRange',
    label: 'Ideal RSI Range',
    description: 'RSI window considered ideal for strategy entry quality.',
    type: 'rsiRange',
    min: 0,
    max: 100,
  },
  {
    key: 'minAdx',
    label: 'Min ADX',
    description: 'Minimum ADX threshold for trend strength.',
    type: 'number',
    optional: true,
    min: 0,
    max: 100,
    step: 0.5,
  },
  {
    key: 'minVolumeExpansion',
    label: 'Min Volume Expansion',
    description: 'Minimum volume expansion multiplier vs baseline.',
    type: 'number',
    optional: true,
    min: 0.1,
    max: 10,
    step: 0.05,
  },
  {
    key: 'defaultConfidenceWeight',
    label: 'Confidence Weight',
    description: 'Registry weight applied in conflict resolution and scoring.',
    type: 'weight',
    min: 0.1,
    max: 2,
    step: 0.05,
  },
  {
    key: 'allowedRegimes',
    label: 'Allowed Regimes',
    description: 'Market regimes where the strategy may operate.',
    type: 'regimeList',
  },
  {
    key: 'blockedRegimes',
    label: 'Blocked Regimes',
    description: 'Market regimes where the strategy is blocked.',
    type: 'regimeList',
  },
  {
    key: 'idealMarketRegime',
    label: 'Ideal Market Regimes',
    description: 'Regimes where the strategy performs best.',
    type: 'regimeList',
  },
  {
    key: 'riskProfile',
    label: 'Risk Profile',
    description: 'Operator-facing risk aggressiveness label.',
    type: 'riskProfile',
  },
  {
    key: 'timeframe',
    label: 'Timeframe',
    description: 'Primary evaluation timeframe for the strategy.',
    type: 'timeframe',
  },
];

export interface ValidationIssue {
  key: ConfigurableParamKey | string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  sanitized: Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>;
}

function isRegimeList(value: unknown): value is MarketRegimeLabel[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((v) => MARKET_REGIME_LABELS.includes(v as MarketRegimeLabel));
}

function validateRsiRange(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const a = Number(value[0]);
  const b = Number(value[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (a < 0 || b > 100 || a >= b) return null;
  return [a, b];
}

export function validateParamValue(
  key: ConfigurableParamKey,
  value: unknown,
): { ok: true; value: ConfigurableParamValue } | { ok: false; message: string } {
  const meta = PARAM_FIELD_CATALOG.find((f) => f.key === key);
  if (!meta) return { ok: false, message: `Unknown parameter: ${key}` };

  switch (meta.type) {
    case 'rsiRange': {
      const range = validateRsiRange(value);
      if (!range) return { ok: false, message: 'RSI range must be [min, max] with 0 ≤ min < max ≤ 100' };
      return { ok: true, value: range };
    }
    case 'number':
    case 'weight': {
      const n = Number(value);
      if (!Number.isFinite(n)) return { ok: false, message: `${meta.label} must be a number` };
      if (meta.min != null && n < meta.min) return { ok: false, message: `${meta.label} must be ≥ ${meta.min}` };
      if (meta.max != null && n > meta.max) return { ok: false, message: `${meta.label} must be ≤ ${meta.max}` };
      return { ok: true, value: n };
    }
    case 'regimeList': {
      if (!isRegimeList(value)) {
        return { ok: false, message: `${meta.label} must be a non-empty list of valid regimes` };
      }
      return { ok: true, value: value as MarketRegimeLabel[] };
    }
    case 'riskProfile': {
      if (!RISK_PROFILES.includes(value as StrategyRiskProfile)) {
        return { ok: false, message: 'Invalid risk profile' };
      }
      return { ok: true, value: value as StrategyRiskProfile };
    }
    case 'timeframe': {
      if (!TIMEFRAMES.includes(value as ConfigurableTimeframe)) {
        return { ok: false, message: 'Timeframe must be intraday, swing, positional, or daily' };
      }
      return { ok: true, value: value as ConfigurableTimeframe };
    }
    default:
      return { ok: false, message: 'Unsupported parameter type' };
  }
}

export function validateConfigurationPatch(
  patch: Record<string, unknown>,
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const sanitized: Partial<Record<ConfigurableParamKey, ConfigurableParamValue>> = {};

  for (const [rawKey, rawValue] of Object.entries(patch)) {
    if (!CONFIGURABLE_PARAM_KEYS.includes(rawKey as ConfigurableParamKey)) {
      issues.push({ key: rawKey, message: `Parameter not configurable: ${rawKey}` });
      continue;
    }
    const key = rawKey as ConfigurableParamKey;
    const result = validateParamValue(key, rawValue);
    if (result.ok === false) {
      issues.push({ key, message: result.message });
      continue;
    }
    sanitized[key] = result.value;
  }

  // Cross-field: allowed vs blocked overlap
  const allowed = sanitized.allowedRegimes as MarketRegimeLabel[] | undefined;
  const blocked = sanitized.blockedRegimes as MarketRegimeLabel[] | undefined;
  if (allowed && blocked) {
    const overlap = allowed.filter((r) => blocked.includes(r));
    if (overlap.length > 0) {
      issues.push({
        key: 'allowedRegimes',
        message: `Allowed and blocked regimes overlap: ${overlap.join(', ')}`,
      });
    }
  }

  return { valid: issues.length === 0, issues, sanitized };
}

export function summarizeConfigChanges(
  before: Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>,
  after: Partial<Record<ConfigurableParamKey, ConfigurableParamValue>>,
): string {
  const keys = new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ]) as Set<ConfigurableParamKey>;

  const parts: string[] = [];
  for (const key of keys) {
    const prev = before[key];
    const next = after[key];
    if (JSON.stringify(prev) !== JSON.stringify(next)) {
      parts.push(`${key}: ${JSON.stringify(prev ?? null)} → ${JSON.stringify(next ?? null)}`);
    }
  }
  return parts.length ? parts.join('; ') : 'No changes';
}
