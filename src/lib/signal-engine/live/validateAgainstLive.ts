/**
 * Live-sanity stage.
 *
 * Runs AFTER enrichWithLiveLtp has attached livePrice / livePChange
 * from the Kite tick cache. Reconciles each frozen signal row
 * against the current market tick and either:
 *
 *   - penalizes confidence on a soft adverse move,
 *   - invalidates the row entirely on a hard adverse move or a
 *     live price that has already crossed the stop loss.
 *
 * The pipeline itself is candle-based and only runs periodically,
 * so without this stage a BUY generated on yesterday's close will
 * still render as BUY even after the stock has gapped down 3%
 * today. This stage is the bridge between the snapshot world
 * (q365_signals) and the tick world (Kite WS).
 *
 * Thresholds are intentionally conservative — tune in one place.
 */

// Yahoo-only mode: thresholds relaxed because the tape is ~15 min
// delayed and normal intraday drift can trigger spurious invalidation.
// Hard-invalidation is kept only for "stopped out on the live price"
// (a price-vs-stop comparison that holds regardless of feed delay).
// The adverse-move invalidation that compared livePChange against
// -3% / +3% has been removed — those moves are indistinguishable
// from delayed-feed drift.
const BUY_SOFT_DROP  = -3.0; // %  → confidence penalty
const BUY_HARD_DROP  = -Infinity; // disabled: delayed-feed drift would fabricate hits
const SELL_SOFT_RISE =  3.0;
const SELL_HARD_RISE =  Infinity; // disabled: see above
const CONF_PENALTY   =   10;

export interface LiveSanityRow {
  direction?:        string;
  confidence?:       number | null;
  confidence_score?: number | null;
  entry_price?:      number | null;
  stop_loss?:        number | null;
  ltp?:              number | null;
  livePrice?:        number | null;
  livePChange?:      number | null;
  liveSource?:       string | null;
  // Outputs written by this stage
  live_invalidated?:    boolean;
  live_warnings?:       string[];
  live_penalty_applied?: number;
}

export function applyLiveSanity<T extends LiveSanityRow>(rows: T[]): T[] {
  for (const r of rows) {
    r.live_warnings        = [];
    r.live_invalidated     = false;
    r.live_penalty_applied = 0;

    // No fresh tick → we cannot judge the signal. Tag it so the UI
    // can show a "stale" indicator, but do not touch confidence.
    if (r.livePrice == null || r.livePrice <= 0) {
      r.live_warnings.push('live_price_stale');
      continue;
    }

    const dir  = (r.direction || '').toUpperCase();
    const pct  = r.livePChange ?? null;
    const stop = r.stop_loss ?? null;

    if (dir === 'BUY') {
      if (stop != null && stop > 0 && r.livePrice <= stop) {
        r.live_invalidated = true;
        r.live_warnings.push('stopped_out_live');
      }
      if (pct != null) {
        if (pct <= BUY_HARD_DROP) {
          r.live_invalidated = true;
          r.live_warnings.push(`hard_adverse_move_${pct.toFixed(2)}pct`);
        } else if (pct <= BUY_SOFT_DROP) {
          r.live_warnings.push(`soft_adverse_move_${pct.toFixed(2)}pct`);
          applyConfPenalty(r, CONF_PENALTY);
        }
      }
    } else if (dir === 'SELL') {
      if (stop != null && stop > 0 && r.livePrice >= stop) {
        r.live_invalidated = true;
        r.live_warnings.push('stopped_out_live');
      }
      if (pct != null) {
        if (pct >= SELL_HARD_RISE) {
          r.live_invalidated = true;
          r.live_warnings.push(`hard_adverse_move_+${pct.toFixed(2)}pct`);
        } else if (pct >= SELL_SOFT_RISE) {
          r.live_warnings.push(`soft_adverse_move_+${pct.toFixed(2)}pct`);
          applyConfPenalty(r, CONF_PENALTY);
        }
      }
    }
  }
  return rows;
}

function applyConfPenalty(r: LiveSanityRow, penalty: number) {
  const base = r.confidence_score ?? r.confidence ?? 0;
  const next = Math.max(0, base - penalty);
  r.confidence_score     = next;
  r.confidence           = next;
  r.live_penalty_applied = penalty;
}
