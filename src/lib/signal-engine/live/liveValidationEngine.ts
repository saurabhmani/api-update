// ════════════════════════════════════════════════════════════════
//  Phase-8 Live Validation Engine
//
//  Synchronous pre-entry gate that decides whether a signal is still
//  safe to act on RIGHT NOW. Six checks; any failure rejects:
//
//    1. Entry zone        — current price still within the valid
//                            entry zone (drift from ideal entry under
//                            the configured limit, or inside an
//                            explicit [zoneLow, zoneHigh] band).
//    2. Stop proximity    — live price not near or beyond the stop.
//                            A trade whose stop is one tick away is
//                            not an entry, it is a pre-stop-out.
//    3. Signal age        — signal generated within the allowed
//                            window. A signal generated yesterday
//                            cannot be acted on at today's open.
//    4. Live-invalidated  — caller's `liveInvalidated` flag (set by
//                            the freshness/postSignal validator) is
//                            still false.
//    5. Entry drift       — price has not moved too far from ideal
//                            entry. Folded into the entry-zone check
//                            so callers without a zone band still
//                            get drift enforcement.
//    6. Spread / slippage — when bid/ask is supplied, spread bps must
//                            be under the configured ceiling. Skipped
//                            silently when no quote is provided so
//                            the engine still works against feeds
//                            that only emit last-trade prices.
//
//  Scope boundary vs existing live-layer files:
//
//    validateAgainstLive.ts   → batch sanity on persisted rows; soft
//                                penalties, not a gate.
//    candleFreshnessGuard.ts  → ingest-side: does today's bar exist?
//    freshnessEngine.ts       → produces the FreshnessReport that
//                                drives `liveInvalidated`. Upstream.
//    liveValidationEngine.ts  → THIS FILE: pre-entry hard gate. Main-
//                                table writers must hard-reject any
//                                signal whose `live_valid === false`.
//
//  Pure, synchronous, IO-free.
// ════════════════════════════════════════════════════════════════

import type { SignalDirection } from '../freshness/freshnessEngine';
import { round } from '../utils/math';

// ── Inputs ──────────────────────────────────────────────────────

export interface LiveValidationInput {
  symbol?:           string;
  direction:         SignalDirection;
  entryPrice:        number;
  stopLoss:          number;
  /** ISO ('2026-04-25T10:00:00Z') or MySQL ('2026-04-25 10:00:00'). */
  generatedAt:       string;
  /** Latest tick price from the broker / fallback feed. */
  livePrice:         number;
  /** Optional ISO timestamp of the live tick. Omitted = "as of now". */
  liveTickAt?:       string;
  /** Set by upstream freshness/postSignal validator. */
  liveInvalidated?:  boolean;
  /** Optional explicit entry zone — overrides drift-based check
   *  when supplied. Both bounds inclusive. */
  entryZoneLow?:     number;
  entryZoneHigh?:    number;
  /** Optional best bid / ask, used for the spread check. Both must
   *  be supplied together for the check to engage. */
  bid?:              number;
  ask?:              number;
}

export interface LiveValidationConfig {
  /** Max |live − entry|/entry allowed before "drifted_from_entry". */
  maxEntryDriftPct:    number;
  /** Min fraction of risk distance that must remain to the stop.
   *  0.1 = ≥10 % of stop distance intact. */
  minStopBufferPct:    number;
  /** Max signal age in hours. */
  maxSignalAgeHours:   number;
  /** Max live-tick age in seconds. Ignored when `liveTickAt` absent. */
  maxTickAgeSeconds:   number;
  /** Max spread in basis points (10 000 × spread / mid). */
  maxSpreadBps:        number;
}

export const DEFAULT_LIVE_VALIDATION_CONFIG: LiveValidationConfig = {
  maxEntryDriftPct:   3.0,
  minStopBufferPct:   0.1,
  maxSignalAgeHours:  20,
  maxTickAgeSeconds:  120,
  maxSpreadBps:       50,         // 0.50 % — caps illiquid quotes
};

// ── Outputs ─────────────────────────────────────────────────────

export type LiveValidationCode =
  | 'outside_entry_zone'
  | 'drifted_from_entry'
  | 'near_stop'
  | 'stop_violated'
  | 'signal_stale'
  | 'tick_stale'
  | 'live_invalidated'
  | 'spread_too_wide'
  | 'invalid_plan';

export interface LivePriceSnapshot {
  symbol:            string | null;
  live_price:        number;
  entry_price:       number;
  stop_loss:         number;
  /** Signed % change from entry to live. Positive = live above entry. */
  drift_pct:         number;
  /** Distance from live to stop, in price units. */
  distance_to_stop:  number;
  /** As fraction of risk distance. 0 = at stop, 1 = at entry. */
  stop_buffer_pct:   number;
  /** Spread in basis points. Null when bid/ask not supplied. */
  spread_bps:        number | null;
  signal_age_hours:  number;
  tick_age_seconds:  number | null;
  captured_at:       string;
}

export interface LiveValidationResult {
  live_valid:              boolean;
  live_validation_codes:   LiveValidationCode[];
  live_validation_reasons: string[];
  live_price_snapshot:     LivePriceSnapshot;
}

// ── Helpers ─────────────────────────────────────────────────────

function parseTimestamp(ts: string): number {
  // Accept ISO ('2026-04-25T10:00:00Z') and MySQL ('2026-04-25 10:00:00').
  // MySQL strings without a zone are treated as UTC, matching how the
  // ingest layer writes them.
  const withT = ts.includes('T') ? ts : ts.replace(' ', 'T');
  const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(withT) ? withT : `${withT}Z`;
  return Date.parse(withZ);
}

function tag(symbol?: string): string {
  return symbol ? `[${symbol}] ` : '';
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Run all six checks and return the Phase-8 verdict.
 *
 *   live_valid              false when ANY check fails.
 *   live_validation_codes   every failure code, never just the first.
 *   live_validation_reasons human-readable parallel to codes[].
 *   live_price_snapshot     the numbers the checks were evaluated on,
 *                            persisted to the signal row for audit.
 *
 * A degenerate plan (entry ≤ 0, live ≤ 0, or entry == stop) rejects
 * as `invalid_plan` and short-circuits the drift / stop reasons.
 */
export function validateLiveSignal(
  input:  LiveValidationInput,
  config: LiveValidationConfig = DEFAULT_LIVE_VALIDATION_CONFIG,
  now:    Date = new Date(),
): LiveValidationResult {
  const codes:   LiveValidationCode[] = [];
  const reasons: string[]             = [];
  const t = tag(input.symbol);

  // ── Plan sanity ────────────────────────────────────────────────
  const planBroken =
    !(input.entryPrice > 0) ||
    !(input.livePrice  > 0) ||
    input.entryPrice === input.stopLoss;

  // ── Snapshot fields (computed even when plan is broken) ────────
  const riskDistance   = Math.abs(input.entryPrice - input.stopLoss);
  const driftPctSigned = input.entryPrice > 0
    ? ((input.livePrice - input.entryPrice) / input.entryPrice) * 100
    : 0;
  const driftPctAbs    = Math.abs(driftPctSigned);

  const distanceToStop = Math.abs(input.livePrice - input.stopLoss);
  const stopBufferPct  = riskDistance > 0 ? distanceToStop / riskDistance : 0;

  let spreadBps: number | null = null;
  if (typeof input.bid === 'number' && typeof input.ask === 'number'
      && input.bid > 0 && input.ask > 0) {
    const mid    = (input.bid + input.ask) / 2;
    const spread = Math.abs(input.ask - input.bid);
    spreadBps    = mid > 0 ? (spread / mid) * 10_000 : null;
  }

  const generatedMs    = parseTimestamp(input.generatedAt);
  const signalAgeHours = Number.isFinite(generatedMs)
    ? (now.getTime() - generatedMs) / 3_600_000
    : Infinity;

  let tickAgeSeconds: number | null = null;
  if (input.liveTickAt) {
    const tickMs = parseTimestamp(input.liveTickAt);
    tickAgeSeconds = Number.isFinite(tickMs)
      ? (now.getTime() - tickMs) / 1000
      : Infinity;
  }

  const snapshot: LivePriceSnapshot = {
    symbol:           input.symbol ?? null,
    live_price:       round(input.livePrice, 4),
    entry_price:      round(input.entryPrice, 4),
    stop_loss:        round(input.stopLoss, 4),
    drift_pct:        round(driftPctSigned, 4),
    distance_to_stop: round(distanceToStop, 4),
    stop_buffer_pct:  round(stopBufferPct, 4),
    spread_bps:       spreadBps === null ? null : round(spreadBps, 2),
    signal_age_hours: round(signalAgeHours, 2),
    tick_age_seconds: tickAgeSeconds === null ? null : round(tickAgeSeconds, 2),
    captured_at:      now.toISOString(),
  };

  // ── Checks ─────────────────────────────────────────────────────
  if (planBroken) {
    codes.push('invalid_plan');
    reasons.push(
      `${t}Invalid plan: entry=${input.entryPrice}, stop=${input.stopLoss}, ` +
      `live=${input.livePrice}`,
    );
  }

  // 4. Live-invalidated flag — checked early. An upstream invalidation
  //    overrides any later analysis; report it but still gather the
  //    other failure codes so the UI shows the full picture.
  if (input.liveInvalidated) {
    codes.push('live_invalidated');
    reasons.push(`${t}Signal flagged live_invalidated by upstream validator`);
  }

  // 1+5. Entry-zone / drift. Explicit zone wins when supplied.
  if (!planBroken) {
    const hasZone = typeof input.entryZoneLow === 'number'
                 && typeof input.entryZoneHigh === 'number';
    if (hasZone) {
      const lo = Math.min(input.entryZoneLow!, input.entryZoneHigh!);
      const hi = Math.max(input.entryZoneLow!, input.entryZoneHigh!);
      if (input.livePrice < lo || input.livePrice > hi) {
        codes.push('outside_entry_zone');
        reasons.push(
          `${t}Live price ${input.livePrice} outside entry zone [${lo}, ${hi}]`,
        );
      }
    } else if (driftPctAbs > config.maxEntryDriftPct) {
      codes.push('drifted_from_entry');
      reasons.push(
        `${t}Price drifted ${round(driftPctAbs, 2)}% from entry ` +
        `(limit ${config.maxEntryDriftPct}%)`,
      );
    }
  }

  // 2. Stop proximity. Stop-violated wins; otherwise check buffer.
  if (!planBroken) {
    const stopViolated = input.direction === 'BUY'
      ? input.livePrice <= input.stopLoss
      : input.livePrice >= input.stopLoss;
    if (stopViolated) {
      codes.push('stop_violated');
      reasons.push(
        `${t}Live price ${input.livePrice} already past ${input.direction} stop ${input.stopLoss}`,
      );
    } else if (stopBufferPct < config.minStopBufferPct) {
      codes.push('near_stop');
      reasons.push(
        `${t}Only ${round(distanceToStop, 2)} to stop ` +
        `(${round(stopBufferPct * 100, 1)}% of risk distance, ` +
        `min ${round(config.minStopBufferPct * 100, 1)}%)`,
      );
    }
  }

  // 3. Signal age + tick age.
  if (signalAgeHours > config.maxSignalAgeHours) {
    codes.push('signal_stale');
    reasons.push(
      `${t}Signal age ${round(signalAgeHours, 2)}h > ${config.maxSignalAgeHours}h`,
    );
  }
  if (tickAgeSeconds !== null && tickAgeSeconds > config.maxTickAgeSeconds) {
    codes.push('tick_stale');
    reasons.push(
      `${t}Live tick age ${round(tickAgeSeconds, 2)}s > ${config.maxTickAgeSeconds}s`,
    );
  }

  // 6. Spread / slippage. Skipped silently when no bid/ask supplied.
  if (spreadBps !== null && spreadBps > config.maxSpreadBps) {
    codes.push('spread_too_wide');
    reasons.push(
      `${t}Spread ${round(spreadBps, 2)} bps > ${config.maxSpreadBps} bps`,
    );
  }

  return {
    live_valid:              codes.length === 0,
    live_validation_codes:   codes,
    live_validation_reasons: reasons,
    live_price_snapshot:     snapshot,
  };
}

/**
 * Batch helper: run `validateLiveSignal` across a list of inputs.
 * Valid signals returned in the first slot; rejected ones with their
 * verdicts in the second so callers can log / dim the UI.
 */
export function filterValidSignals<T extends LiveValidationInput>(
  signals: T[],
  config:  LiveValidationConfig = DEFAULT_LIVE_VALIDATION_CONFIG,
  now:     Date = new Date(),
): { valid: T[]; rejected: Array<{ signal: T; result: LiveValidationResult }> } {
  const valid:    T[] = [];
  const rejected: Array<{ signal: T; result: LiveValidationResult }> = [];
  for (const s of signals) {
    const result = validateLiveSignal(s, config, now);
    if (result.live_valid) valid.push(s);
    else                   rejected.push({ signal: s, result });
  }
  return { valid, rejected };
}
