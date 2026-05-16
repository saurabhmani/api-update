// ════════════════════════════════════════════════════════════════
//  Pre-Filter Engine — scanner-side liquidity / sanity gate
//
//  First filter run on a candidate's raw candle series, BEFORE any
//  indicator math or signal scoring. Rejects junk early so we don't
//  burn compute on illiquid, broken, or structurally-noisy symbols.
//
//  Rules (all configurable, defaults below):
//    • candle history < N            → insufficient_history
//    • latest close < ₹X             → low_price
//    • avgVolume(N) < threshold      → low_volume
//    • close × avgVolume(N) < ₹Y     → low_traded_value
//    • |today open vs prev close| gap
//          > Z% AND volume(today)/avg < confirmation multiple
//                                  → abnormal_gap
//    • missing close / missing volume → missing_data
//
//  All applicable reasons are collected — the result returns every
//  rule that fired, not just the first, so the operator sees the
//  full reject picture. `passed` is true iff `reasons` is empty.
// ════════════════════════════════════════════════════════════════

import type { NormalizedCandle } from './yahooDataService'; // @deprecated marker

// ── Public types ─────────────────────────────────────────────────

export interface PreFilterConfig {
  /** Minimum number of candles required. Default 50. */
  minCandles:           number;
  /** Minimum latest close, in INR. Default 20. */
  minClose:             number;
  /** Lookback window for the avg-volume / traded-value metrics. Default 20. */
  avgVolumePeriod:      number;
  /** Minimum trailing avgVolume(period). Default 100,000 shares. */
  minAvgVolume:         number;
  /** Minimum trailing traded value (close × avgVolume). Default ₹1 Cr. */
  minTradedValue:       number;
  /** Reject when |gapPct| exceeds this AND volume doesn't confirm. Default 18. */
  maxAbsGapPct:         number;
  /** Today's volume must exceed this × avgVolume for a >maxAbsGapPct gap to pass. Default 1.5. */
  gapVolumeConfirmMult: number;
}

export const DEFAULT_PRE_FILTER_CONFIG: PreFilterConfig = {
  minCandles:           50,
  minClose:             20,
  avgVolumePeriod:      20,
  minAvgVolume:         100_000,        // 1 L shares
  minTradedValue:       10_000_000,     // ₹1 Cr daily turnover
  maxAbsGapPct:         18,
  gapVolumeConfirmMult: 1.5,
};

export interface PreFilterMetrics {
  /** Latest close, INR. null when missing. */
  close:         number | null;
  /** Trailing avg volume — note: field name is fixed even when
   *  `avgVolumePeriod` is overridden, the value reflects the configured period. */
  avgVolume20:   number | null;
  /** close × avgVolume20, INR. null when either input is missing. */
  tradedValue20: number | null;
  /** (today_open − prev_close) / prev_close × 100. null when prev bar is absent. */
  gapPct:        number | null;
}

export interface PreFilterResult {
  passed:  boolean;
  reasons: string[];
  metrics: PreFilterMetrics;
}

// ── Internals ────────────────────────────────────────────────────

const EMPTY_METRICS: PreFilterMetrics = {
  close:         null,
  avgVolume20:   null,
  tradedValue20: null,
  gapPct:        null,
};

function fmtINR(n: number): string {
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)}L`;
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function fmtCount(n: number): string {
  return Math.round(n).toLocaleString('en-IN');
}

// ── Public ───────────────────────────────────────────────────────

/**
 * Run the pre-filter on a normalised candle series. Pure function:
 * no I/O, no logging, no exceptions. The scanner is expected to
 * record `result.reasons` before discarding rejected candidates.
 *
 * Multiple rules can fire in one call — every applicable failure
 * is appended to `reasons` so the operator can see the full reject
 * picture instead of just the first miss.
 */
export function runPreFilter(
  candles:  NormalizedCandle[] | null | undefined,
  cfgInput: Partial<PreFilterConfig> = {},
): PreFilterResult {
  const cfg = { ...DEFAULT_PRE_FILTER_CONFIG, ...cfgInput };

  // Empty/missing series — return immediately with shaped metrics so
  // callers can treat the result uniformly without a null check.
  if (!candles || candles.length === 0) {
    return {
      passed:  false,
      reasons: ['missing_data: no candles supplied'],
      metrics: EMPTY_METRICS,
    };
  }

  const reasons: string[] = [];

  if (candles.length < cfg.minCandles) {
    reasons.push(`insufficient_history: ${candles.length} < ${cfg.minCandles} candles`);
  }

  const last = candles[candles.length - 1];
  const prev = candles.length >= 2 ? candles[candles.length - 2] : null;

  // ── Latest-bar data quality ──
  // Treat 0 or non-finite as "missing" — Yahoo occasionally emits // @deprecated marker
  // a zero-volume placeholder for halt days, which the pre-filter
  // should reject regardless of cfg thresholds.
  const lastClose  = last && Number.isFinite(last.close)  ? last.close  : NaN;
  const lastVolume = last && Number.isFinite(last.volume) ? last.volume : NaN;
  const hasClose   = Number.isFinite(lastClose)  && lastClose  > 0;
  const hasVolume  = Number.isFinite(lastVolume) && lastVolume > 0;

  if (!hasClose)  reasons.push('missing_data: latest close is null or zero');
  if (!hasVolume) reasons.push('missing_data: latest volume is null or zero');

  // ── Trailing-window metrics ──
  // avgVolume / tradedValue are computed defensively. When the series
  // is shorter than `avgVolumePeriod` we use whatever's available —
  // the insufficient_history rule above has already flagged that case,
  // so the metric is informational only on a thin series.
  const window = candles.slice(-cfg.avgVolumePeriod);
  let volSum = 0;
  let volCount = 0;
  for (const b of window) {
    if (b && Number.isFinite(b.volume) && b.volume >= 0) {
      volSum   += b.volume;
      volCount += 1;
    }
  }
  const avgVolume: number | null = volCount > 0 ? volSum / volCount : null;
  const close:     number | null = hasClose ? lastClose : null;
  const tradedValue: number | null =
    close != null && avgVolume != null ? close * avgVolume : null;

  let gapPct: number | null = null;
  if (prev &&
      Number.isFinite(prev.close) && prev.close > 0 &&
      last && Number.isFinite(last.open) && last.open > 0) {
    gapPct = ((last.open - prev.close) / prev.close) * 100;
  }

  const metrics: PreFilterMetrics = {
    close,
    avgVolume20:   avgVolume,
    tradedValue20: tradedValue,
    gapPct,
  };

  // ── Threshold rules ──

  if (close != null && close < cfg.minClose) {
    reasons.push(`low_price: ${close.toFixed(2)} < ₹${cfg.minClose}`);
  }

  if (avgVolume != null && avgVolume < cfg.minAvgVolume) {
    reasons.push(
      `low_volume: avg ${fmtCount(avgVolume)} < ${fmtCount(cfg.minAvgVolume)} ` +
      `(period=${cfg.avgVolumePeriod})`,
    );
  }

  if (tradedValue != null && tradedValue < cfg.minTradedValue) {
    reasons.push(
      `low_traded_value: ${fmtINR(tradedValue)} < ${fmtINR(cfg.minTradedValue)} ` +
      `(close × avgVolume${cfg.avgVolumePeriod})`,
    );
  }

  if (gapPct != null && Math.abs(gapPct) > cfg.maxAbsGapPct) {
    // Volume confirmation: today's volume vs trailing avg. If we
    // can't compute the ratio (no avgVolume), the gap fails by
    // default — we never accept an outlier without confirmation.
    const todayVol = hasVolume ? lastVolume : 0;
    const ratio    = avgVolume && avgVolume > 0 ? todayVol / avgVolume : 0;
    if (ratio < cfg.gapVolumeConfirmMult) {
      reasons.push(
        `abnormal_gap: ${gapPct.toFixed(2)}% with volume ${ratio.toFixed(2)}× avg ` +
        `(< ${cfg.gapVolumeConfirmMult.toFixed(2)}× confirm)`,
      );
    }
  }

  return {
    passed:  reasons.length === 0,
    reasons,
    metrics,
  };
}
