// ════════════════════════════════════════════════════════════════
//  Canonical Input Snapshot — Product A Phase 1 (versioned contract)
//
//  Every candidate signal must capture enough provenance to
//  reconstruct the identical feature vector and strategy decision.
//  Store this alongside features_json — do not persist indicators only.
// ════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import type { Candle, SignalFeatures } from '@/lib/signal-engine/types/signalEngine.types';
import type { IntegrityIssue } from '@/lib/marketData/integrity/marketDataIntegrity';
import { ENGINE_VERSION } from '@/lib/signal-engine/constants/engineVersion';
import {
  getSignalEngineConfig,
  type SignalEnginePhase2Config,
} from '@/lib/signal-engine/config/signalEnginePhase2Config';

/** Alias for Phase 1 lineage module naming. */
export type SignalEngineRuntimeConfig = SignalEnginePhase2Config;
export const getActiveSignalEngineConfig = getSignalEngineConfig;

/** Bump when the snapshot schema / required fields change. */
export const CANONICAL_INPUT_SNAPSHOT_VERSION = '1.0.0';

export type PriceAdjustmentMode = 'adjusted' | 'unadjusted' | 'unknown';

export type DataQualitySeverity = 'none' | 'minor' | 'moderate' | 'critical';

export type FreshnessStatusLabel =
  | 'fresh'
  | 'aging'
  | 'stale'
  | 'frozen'
  | 'unknown'
  | 'incomplete_current';

export interface CorporateActionSnapshotFields {
  price_adjustment_mode:      PriceAdjustmentMode;
  corporate_action_detected:  boolean;
  adjustment_source:          string;
  adjustment_version:         string;
  /** Unexplained split-like jump inside lookback → strategy blocks apply. */
  unexplained_discontinuity:  boolean;
}

export interface DataQualitySnapshotFields {
  score:             number; // 0–100
  severity:          DataQualitySeverity;
  rejection_reasons: string[];
  warnings:          string[];
  /** Points deducted by the single canonical DQ modifier (1.5). */
  score_modifier:    number;
  actionable:        boolean;
}

export interface ProviderLineageSnapshot {
  /** Zerodha / Kite when primary; never IndiaAPI after Gate Z. */
  provider_identity:     string;
  session_identity:      string | null;
  /** Human-readable resolution path, e.g. kite→cache|yahoo_emergency. */
  resolution_path:       string;
  candle_source:         string;
  data_timestamp_iso:    string | null;
}

/**
 * Versioned canonical input snapshot — Product A Phase 1 contract.
 */
export interface CanonicalInputSnapshot {
  contract_version:             typeof CANONICAL_INPUT_SNAPSHOT_VERSION;
  symbol:                       string;
  exchange:                     string;
  strategy_engine_version:      string;
  strategy_version:             string;
  threshold_config_version:     string;
  candle_timeframe:             string;
  candle_start_ts:              string | null;
  candle_end_ts:                string | null;
  last_completed_candle_ts:     string | null;
  provider:                     ProviderLineageSnapshot;
  candle_count:                 number;
  candle_series_hash:           string;
  benchmark_series_hash:        string | null;
  sector_series_hash:           string | null;
  corporate_action:             CorporateActionSnapshotFields;
  freshness_status:             FreshnessStatusLabel;
  data_quality:                 DataQualitySnapshotFields;
  /** Full feature vector at decision time (not indicators alone). */
  feature_vector:               SignalFeatures;
  integrity_issues:             IntegrityIssue[];
  /** Frozen candle copy used for features (provenance for replay). */
  candles:                      Candle[];
}

export function hashCandleSeries(candles: Candle[]): string {
  const payload = candles.map((c) =>
    [c.ts, c.open, c.high, c.low, c.close, c.volume].join('|'),
  ).join('\n');
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

export interface BuildCanonicalSnapshotInput {
  symbol:                   string;
  exchange?:                string;
  candles:                  Candle[];
  features:                 SignalFeatures;
  integrityIssues:          IntegrityIssue[];
  freshnessStatus:          FreshnessStatusLabel;
  dataQuality:              DataQualitySnapshotFields;
  corporateAction:          CorporateActionSnapshotFields;
  provider:                 ProviderLineageSnapshot;
  benchmarkCandles?:        Candle[] | null;
  sectorCandles?:           Candle[] | null;
  strategyVersion?:         string;
  candleTimeframe?:         string;
  lastCompletedCandleTs?:   string | null;
  config?:                  SignalEngineRuntimeConfig;
}

/**
 * Build a versioned snapshot. Pure given explicit config + series.
 */
export function buildCanonicalInputSnapshot(
  input: BuildCanonicalSnapshotInput,
): CanonicalInputSnapshot {
  const cfg = input.config ?? getActiveSignalEngineConfig();
  const candles = input.candles;
  const start = candles[0]?.ts ?? null;
  const end = candles[candles.length - 1]?.ts ?? null;
  const lastCompleted = input.lastCompletedCandleTs ?? end;

  return {
    contract_version:         CANONICAL_INPUT_SNAPSHOT_VERSION,
    symbol:                   input.symbol.toUpperCase(),
    exchange:                 (input.exchange ?? 'NSE').toUpperCase(),
    strategy_engine_version:  ENGINE_VERSION,
    strategy_version:         input.strategyVersion ?? 'registry-1',
    threshold_config_version: cfg.configVersionLabel,
    candle_timeframe:         input.candleTimeframe ?? '1d',
    candle_start_ts:          start,
    candle_end_ts:            end,
    last_completed_candle_ts: lastCompleted,
    provider:                 input.provider,
    candle_count:             candles.length,
    candle_series_hash:       hashCandleSeries(candles),
    benchmark_series_hash:    input.benchmarkCandles?.length
      ? hashCandleSeries(input.benchmarkCandles)
      : null,
    sector_series_hash:       input.sectorCandles?.length
      ? hashCandleSeries(input.sectorCandles)
      : null,
    corporate_action:         input.corporateAction,
    freshness_status:         input.freshnessStatus,
    data_quality:             input.dataQuality,
    feature_vector:           input.features,
    integrity_issues:         input.integrityIssues,
    candles,
  };
}

/** Stable JSON for replay / byte-equality tests. */
export function freezeSnapshotForReplay(snap: CanonicalInputSnapshot): string {
  return JSON.stringify(snap, (_k, v) =>
    typeof v === 'number' && !Number.isFinite(v) ? null : v,
  );
}
