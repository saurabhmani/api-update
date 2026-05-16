// ════════════════════════════════════════════════════════════════
//  Manipulation Engine — Tunable Thresholds
//
//  All numeric knobs the detectors and scoring use. Every value has
//  a short comment explaining what it gates — if you change one,
//  keep the comment honest so future readers can reason about why.
// ════════════════════════════════════════════════════════════════

import type { SuspicionBucket } from '../types';

export const THRESHOLDS = {
  // Volume anomaly
  HIGH_VOLUME_MULT: 3.0,            // today's volume ≥ 3× 20d avg → high
  SEVERE_VOLUME_MULT: 5.0,          // ≥ 5× → severe
  HIGH_TURNOVER_MULT: 3.0,          // turnover multiplier mirror

  // Candle structure
  LARGE_GAP_PCT: 3.0,               // |gap%| ≥ 3% → abnormal gap candidate
  ABNORMAL_RANGE_PCT: 7.0,          // true range ≥ 7% → abnormal_intraday_range
  LONG_UPPER_SHADOW_PCT: 0.55,      // upper wick ≥ 55% of range → distribution
  LONG_LOWER_SHADOW_PCT: 0.55,      // lower wick ≥ 55% of range → absorption
  TINY_BODY_PCT: 0.15,              // body ≤ 15% of range → indecision / wick bar
  CLOSE_RAMP_CLR_MIN: 0.85,         // close in top 15% of range → close_ramping

  // Price behavior
  STRONG_MOVE_1D_PCT: 6.0,          // ≥ 6% intraday = spike candidate
  SEVERE_MOVE_1D_PCT: 10.0,
  REVERSAL_NEXT_DAY_PCT: -3.0,      // next bar ≤ −3% after spike → reversal
  DUMP_3D_PCT: -10.0,               // 3-day cumulative ≤ −10% → dump_risk
  PUMP_3D_PCT: 15.0,                // 3-day cumulative ≥ 15% → pump_risk

  // Liquidity fragility
  ILLIQUID_AVG_TURNOVER: 5_000_000, // ₹50 lakh/day — below this, any move suspect
  ILLIQUID_AVG_VOLUME: 50_000,      // shares/day
  MARKING_MIN_RETURN_PCT: 4.0,      // ≥ 4% move…
  MARKING_MAX_VOLUME_MULT: 1.5,     // …with ≤ 1.5× avg volume → marking

  // Composite / clustering
  CLUSTER_WINDOW: 20,
  DISTRIBUTION_REPETITION: 3,       // ≥ 3 long-upper-wick bars in window
  RAMP_REPETITION: 3,               // ≥ 3 high-CLR bars in window
  HIGH_VOLUME_STREAK_FOR_FLAG: 3,

  // Scoring aggregation
  SCORE_CEILING: 100,
  PENALTY_BAND_THRESHOLD: 50,       // elevated+ triggers confidence penalty hook
  REJECT_BAND_THRESHOLD: 85,        // severe triggers reject-symbol hook

  // ── Phase 2 detector thresholds ─────────────────────────────
  CLOSE_RAMP_REPETITION: 3,         // ≥ 3 high-CLR closes in last 5 → close ramp
  CLOSE_RAMP_WINDOW: 5,
  TRAP_BREAKOUT_BUFFER_PCT: 1.0,    // breakout candle high − level ≥ 1% counts
  TRAP_REVERSAL_PCT: -2.0,          // next bar close ≤ −2% from breakout high
  WASH_TURNOVER_MULT: 2.0,          // turnover ≥ 2× avg…
  WASH_MAX_PROGRESS_PCT: 1.0,       // …with |return| ≤ 1% → low-progress activity
  WASH_REPETITION: 3,               // ≥ 3 such bars in window
  CIRCULAR_EVENT_DENSITY: 0.25,     // ≥ 25% of recent bars triggered something
  CIRCULAR_REVERSAL_CYCLES: 2,      // ≥ 2 reversal bars in window
  SPOOF_DEPTH_FLIP_MIN: 5,          // ≥ 5 layered/cancelled depth events (intraday)
};

/**
 * Fixed buckets per spec §8. Order matters — first match wins when we
 * iterate ascending by `max`. Don't add overlapping ranges.
 */
export const SUSPICION_BANDS: SuspicionBucket[] = [
  { band: 'low',      min: 0,  max: 24, label: 'Low Suspicion' },
  { band: 'watch',    min: 25, max: 49, label: 'Watch' },
  { band: 'elevated', min: 50, max: 69, label: 'Elevated Suspicion' },
  { band: 'high',     min: 70, max: 84, label: 'High Suspicion' },
  { band: 'severe',   min: 85, max: 100, label: 'Severe Suspicion' },
];

export function bandFromScore(score: number): SuspicionBucket {
  const clamped = Math.max(0, Math.min(100, score));
  for (const b of SUSPICION_BANDS) {
    if (clamped >= b.min && clamped <= b.max) return b;
  }
  return SUSPICION_BANDS[0];
}
