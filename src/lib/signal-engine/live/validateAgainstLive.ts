/**
 * Live-sanity stage.
 *
 * Runs AFTER enrichWithLiveLtp has attached `livePrice` / `livePChange`
 * onto each frozen signal row. Reconciles the snapshot against the
 * current market tick and either:
 *
 *   - confirms the row is still valid (most common case),
 *   - applies a soft confidence penalty on a moderate adverse pct move,
 *   - downgrades the row when price has drifted far from entry but the
 *     stop hasn't been broken (PRICE_DRIFT_TOO_FAR — main-table demote,
 *     not hard kill),
 *   - hard-invalidates only when the live tape unambiguously breaks the
 *     stop loss (i.e. crossed the buffered band) or the target has
 *     already been reached.
 *
 * Buffered invalidation
 *   The previous version flipped `live_invalidated=true` the moment the
 *   live price touched stop_loss. With Yahoo's ~15-minute delayed feed
 *   that produced ~95% false-positive invalidations on volatile names
 *   — a 0.05% adverse tick was enough to kill an otherwise-valid signal.
 *   The buffer below requires the price to cross the stop BY MORE THAN
 *   max(ATR*0.25, entry*0.75%) before invalidation fires. Without ATR
 *   we fall back to entry*1%. The result: only genuine stop-outs are
 *   marked, intraday noise is absorbed.
 *
 * Reason codes (per spec)
 *   STOP_LOSS_BROKEN_CONFIRMED — live price > buffered stop, hard kill
 *   PRICE_DRIFT_TOO_FAR        — live price has drifted ≥66% of the
 *                                 entry→stop range without breaking the
 *                                 stop. Soft demote, NOT a hard kill.
 *   TARGET_ALREADY_REACHED      — live price ≥ target1 (BUY) /
 *                                 ≤ target1 (SELL). Hard kill (trade done).
 *   YAHOO_PRICE_STALE           — livePrice came back null / 0
 *   YAHOO_PRICE_UNAVAILABLE     — fetcher errored and didn't populate
 *   BUFFER_PROTECTED            — live price crossed stop but stayed
 *                                 inside the buffer; row retained.
 */

// ── Soft-penalty thresholds (kept from the legacy implementation) ──
const BUY_SOFT_DROP_PCT  = -3.0;
const SELL_SOFT_RISE_PCT =  3.0;
const CONF_PENALTY       =  10;

// ── Buffer formula constants ──────────────────────────────────────
/** Multiplier on ATR(14). Tuned so a 1× ATR is the "real" stop distance
 *  and 0.25 ATR is the "absorb intraday wiggle" zone. */
const BUFFER_ATR_MULT     = 0.25;
/** Min buffer floor as fraction of entry. Catches low-ATR or
 *  ATR-missing rows so the buffer never collapses to zero. */
const BUFFER_PCT_OF_ENTRY = 0.0075;
/** Used when ATR isn't available on the row at all (most rows in
 *  q365_signals don't carry ATR through to read time). */
const BUFFER_FALLBACK_PCT = 0.01;

// ── Drift-downgrade threshold ─────────────────────────────────────
/** Fraction of (entry → stop) range that the live price must travel
 *  adversely (without breaking the stop) before we mark the row as
 *  drift-degraded. 0.66 = "two-thirds of the way to the stop".
 *  Below this we leave the row alone — small drift is normal. */
const DRIFT_DOWNGRADE_FRACTION = 0.66;

export type LiveInvalidationReason =
  | 'STOP_LOSS_BROKEN_CONFIRMED'
  | 'PRICE_DRIFT_TOO_FAR'
  | 'TARGET_ALREADY_REACHED'
  | 'YAHOO_PRICE_STALE'
  | 'YAHOO_PRICE_UNAVAILABLE'
  | 'BUFFER_PROTECTED';

export interface LiveSanityRow {
  symbol?:           string;
  tradingsymbol?:    string;
  direction?:        string;
  confidence?:       number | null;
  confidence_score?: number | null;
  entry_price?:      number | null;
  stop_loss?:        number | null;
  target1?:          number | null;
  /** Optional — when populated by an upstream stage, used by the
   *  buffer formula. Most q365_signals rows do not carry it through
   *  to API read time, in which case we fall back to entry * 1%. */
  atr14?:            number | null;
  ltp?:              number | null;
  livePrice?:        number | null;
  livePChange?:      number | null;
  liveSource?:       string | null;
  // ── Outputs written by this stage ───────────────────────────────
  live_invalidated?:        boolean;
  live_warnings?:           string[];
  live_penalty_applied?:    number;
  /** One of LiveInvalidationReason. Null on healthy rows. Mirrors
   *  whichever code drove the most-severe outcome on this row. */
  live_invalidation_reason?: LiveInvalidationReason | null;
  /** Set when PRICE_DRIFT_TOO_FAR fires. The route handler reads this
   *  flag and applies the same -5 final_score demote it already does
   *  for `stale` and `Avoid` rows, so the drift-downgraded row ranks
   *  below healthy peers without disappearing entirely. */
  live_drift_downgrade?:    boolean;
  /** Drift fraction for diagnostics (0 = at entry, 1 = at stop). */
  live_drift_fraction?:     number | null;
  /** Buffer (price units) used on this row. Logged for transparency. */
  live_buffer_used?:        number | null;
}

export interface LiveSanityReport {
  beforeBuy:        number;
  beforeSell:       number;
  afterBuy:         number;
  afterSell:        number;
  invalidated:      number;
  downgraded:       number;
  bufferProtected:  number;
  pricesStale:      number;
  reasons:          Record<string, number>;
  examples:         Array<LiveSanityExample>;
}

export interface LiveSanityExample {
  symbol:        string;
  direction:     string;
  entry:         number | null;
  stop_loss:     number | null;
  target1:       number | null;
  livePrice:     number | null;
  buffer:        number | null;
  driftFraction: number | null;
  reason:        LiveInvalidationReason | null;
  invalidated:   boolean;
  downgraded:    boolean;
}

/** Compute the price-units buffer used for the stop-loss tolerance. */
function calculateBuffer(
  entry: number | null | undefined,
  atr:   number | null | undefined,
): number {
  const e = Number(entry ?? 0);
  if (!Number.isFinite(e) || e <= 0) return 0;
  const a = Number(atr ?? 0);
  if (Number.isFinite(a) && a > 0) {
    return Math.max(a * BUFFER_ATR_MULT, e * BUFFER_PCT_OF_ENTRY);
  }
  return e * BUFFER_FALLBACK_PCT;
}

function bumpReason(
  reasons: Record<string, number>,
  code: LiveInvalidationReason,
): void {
  reasons[code] = (reasons[code] ?? 0) + 1;
}

function applyConfPenalty(r: LiveSanityRow, penalty: number): void {
  const base = r.confidence_score ?? r.confidence ?? 0;
  const next = Math.max(0, base - penalty);
  r.confidence_score     = next;
  r.confidence           = next;
  r.live_penalty_applied = penalty;
}

/**
 * Mutates rows in place (back-compat with all existing callers — both
 * route.ts call sites ignore the return value) AND returns a structured
 * report so the route handler can log a single before/after summary
 * and surface counts on the /signals freshness probe.
 */
export function applyLiveSanity<T extends LiveSanityRow>(rows: T[]): LiveSanityReport {
  const report: LiveSanityReport = {
    beforeBuy:       0,
    beforeSell:      0,
    afterBuy:        0,
    afterSell:       0,
    invalidated:     0,
    downgraded:      0,
    bufferProtected: 0,
    pricesStale:     0,
    reasons:         {},
    examples:        [],
  };
  // Cap dropped/downgraded examples surfaced to the report so the
  // log line stays readable on big universes; full attribution remains
  // available on the row-level fields.
  const EXAMPLE_CAP = 20;

  for (const r of rows) {
    r.live_warnings           = [];
    r.live_invalidated        = false;
    r.live_penalty_applied    = 0;
    r.live_invalidation_reason = null;
    r.live_drift_downgrade    = false;
    r.live_drift_fraction     = null;
    r.live_buffer_used        = null;

    const dir = (r.direction || '').toUpperCase();
    if (dir === 'BUY')  report.beforeBuy++;
    if (dir === 'SELL') report.beforeSell++;

    // ── Missing tick: cannot judge ────────────────────────────────
    // We DO NOT invalidate a row just because Yahoo failed — that
    // would punish the row for an upstream outage. Mark it stale
    // so the UI can render an indicator; rank-side logic in the
    // route handler treats stale rows as healthy.
    if (r.livePrice == null) {
      r.live_warnings.push('YAHOO_PRICE_UNAVAILABLE');
      r.live_invalidation_reason = 'YAHOO_PRICE_UNAVAILABLE';
      bumpReason(report.reasons, 'YAHOO_PRICE_UNAVAILABLE');
      report.pricesStale++;
      if (dir === 'BUY')  report.afterBuy++;
      if (dir === 'SELL') report.afterSell++;
      continue;
    }
    if (r.livePrice <= 0) {
      r.live_warnings.push('YAHOO_PRICE_STALE');
      r.live_invalidation_reason = 'YAHOO_PRICE_STALE';
      bumpReason(report.reasons, 'YAHOO_PRICE_STALE');
      report.pricesStale++;
      if (dir === 'BUY')  report.afterBuy++;
      if (dir === 'SELL') report.afterSell++;
      continue;
    }

    const entry = r.entry_price != null ? Number(r.entry_price) : null;
    const stop  = r.stop_loss   != null ? Number(r.stop_loss)   : null;
    const tgt   = r.target1     != null ? Number(r.target1)     : null;
    const live  = Number(r.livePrice);
    const pct   = r.livePChange ?? null;
    const buffer = calculateBuffer(entry, r.atr14);
    r.live_buffer_used = buffer > 0 ? buffer : null;

    // Drift fraction: 0 at entry, 1 at stop, >1 past stop.
    // Computed as adverse distance / total distance for the direction.
    let driftFraction: number | null = null;
    if (entry != null && stop != null && entry !== stop) {
      const range = Math.abs(entry - stop);
      if (range > 0) {
        const adverseDelta =
          dir === 'BUY'  ? (entry - live)  :    // BUY: live below entry is adverse
          dir === 'SELL' ? (live  - entry) :    // SELL: live above entry is adverse
          0;
        driftFraction = adverseDelta / range;
      }
    }
    r.live_drift_fraction = driftFraction;

    let invalidated     = false;
    let bufferProtected = false;
    let downgraded      = false;
    let reason: LiveInvalidationReason | null = null;

    if (dir === 'BUY') {
      // ── Stop-loss check (buffered) ─────────────────────────────
      if (stop != null && stop > 0) {
        const breachAmount = stop - live;            // positive → live is below stop
        if (breachAmount > buffer) {
          invalidated = true;
          reason = 'STOP_LOSS_BROKEN_CONFIRMED';
          r.live_warnings.push(
            `STOP_LOSS_BROKEN_CONFIRMED live=${live.toFixed(2)} stop=${stop.toFixed(2)} buffer=${buffer.toFixed(2)}`,
          );
        } else if (breachAmount > 0) {
          // Inside the buffer — retain the row but flag for log.
          bufferProtected = true;
          reason = 'BUFFER_PROTECTED';
          r.live_warnings.push(
            `BUFFER_PROTECTED live=${live.toFixed(2)} stop=${stop.toFixed(2)} buffer=${buffer.toFixed(2)}`,
          );
        }
      }
      // ── Target-already-reached ─────────────────────────────────
      if (!invalidated && tgt != null && tgt > 0 && live >= tgt) {
        invalidated = true;
        reason = 'TARGET_ALREADY_REACHED';
        r.live_warnings.push(
          `TARGET_ALREADY_REACHED live=${live.toFixed(2)} target1=${tgt.toFixed(2)}`,
        );
      }
      // ── Drift-too-far (soft) ───────────────────────────────────
      if (!invalidated && driftFraction != null && driftFraction >= DRIFT_DOWNGRADE_FRACTION) {
        downgraded = true;
        reason = 'PRICE_DRIFT_TOO_FAR';
        r.live_warnings.push(
          `PRICE_DRIFT_TOO_FAR drift=${(driftFraction * 100).toFixed(1)}% of entry→stop range`,
        );
      }
      // ── Soft adverse-pct penalty ───────────────────────────────
      if (!invalidated && pct != null && pct <= BUY_SOFT_DROP_PCT) {
        r.live_warnings.push(`soft_adverse_move_${pct.toFixed(2)}pct`);
        applyConfPenalty(r, CONF_PENALTY);
      }
    } else if (dir === 'SELL') {
      // ── Stop-loss check (buffered, mirrored) ───────────────────
      if (stop != null && stop > 0) {
        const breachAmount = live - stop;            // positive → live is above stop
        if (breachAmount > buffer) {
          invalidated = true;
          reason = 'STOP_LOSS_BROKEN_CONFIRMED';
          r.live_warnings.push(
            `STOP_LOSS_BROKEN_CONFIRMED live=${live.toFixed(2)} stop=${stop.toFixed(2)} buffer=${buffer.toFixed(2)}`,
          );
        } else if (breachAmount > 0) {
          bufferProtected = true;
          reason = 'BUFFER_PROTECTED';
          r.live_warnings.push(
            `BUFFER_PROTECTED live=${live.toFixed(2)} stop=${stop.toFixed(2)} buffer=${buffer.toFixed(2)}`,
          );
        }
      }
      // ── Target-already-reached (SELL: live ≤ target1) ─────────
      if (!invalidated && tgt != null && tgt > 0 && live <= tgt) {
        invalidated = true;
        reason = 'TARGET_ALREADY_REACHED';
        r.live_warnings.push(
          `TARGET_ALREADY_REACHED live=${live.toFixed(2)} target1=${tgt.toFixed(2)}`,
        );
      }
      // ── Drift-too-far (soft, mirrored) ─────────────────────────
      if (!invalidated && driftFraction != null && driftFraction >= DRIFT_DOWNGRADE_FRACTION) {
        downgraded = true;
        reason = 'PRICE_DRIFT_TOO_FAR';
        r.live_warnings.push(
          `PRICE_DRIFT_TOO_FAR drift=${(driftFraction * 100).toFixed(1)}% of entry→stop range`,
        );
      }
      // ── Soft adverse-pct penalty (mirrored) ────────────────────
      if (!invalidated && pct != null && pct >= SELL_SOFT_RISE_PCT) {
        r.live_warnings.push(`soft_adverse_move_+${pct.toFixed(2)}pct`);
        applyConfPenalty(r, CONF_PENALTY);
      }
    }

    if (invalidated) {
      r.live_invalidated = true;
      r.live_invalidation_reason = reason;
      report.invalidated++;
      if (reason) bumpReason(report.reasons, reason);
    } else if (downgraded) {
      r.live_drift_downgrade = true;
      r.live_invalidation_reason = reason;
      report.downgraded++;
      if (reason) bumpReason(report.reasons, reason);
    } else if (bufferProtected) {
      r.live_invalidation_reason = reason;
      report.bufferProtected++;
      if (reason) bumpReason(report.reasons, reason);
    }

    // Surviving rows: count toward after-buy/after-sell.
    if (!invalidated) {
      if (dir === 'BUY')  report.afterBuy++;
      if (dir === 'SELL') report.afterSell++;
    }

    // Capture a small, representative sample for the report. Prefer
    // the noteworthy rows (invalidated / downgraded / buffer-protected)
    // over the bulk of healthy ones.
    if (
      report.examples.length < EXAMPLE_CAP &&
      (invalidated || downgraded || bufferProtected)
    ) {
      report.examples.push({
        symbol:        String(r.symbol ?? r.tradingsymbol ?? ''),
        direction:     dir,
        entry:         entry,
        stop_loss:     stop,
        target1:       tgt,
        livePrice:     live,
        buffer:        r.live_buffer_used,
        driftFraction,
        reason,
        invalidated,
        downgraded,
      });
    }
  }

  return report;
}
