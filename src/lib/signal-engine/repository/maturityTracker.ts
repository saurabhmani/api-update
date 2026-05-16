// ════════════════════════════════════════════════════════════════
//  Signal Maturity Tracker — repository
//
//  Pre-confirmation staging for the maturity layer. Every fresh
//  scanner detection upserts here keyed by (symbol, direction).
//  The maturity worker walks this table, recomputes maturity, and
//  promotes mature rows into q365_confirmed_signal_snapshots.
//
//  Lifecycle of a tracker row:
//    1. saveSignals → upsertOnDetection (cycle 1, stage='candidate')
//    2. saveSignals (next batch, same symbol+dir) → upsertOnDetection
//       increments cycle, appends to stability history
//    3. maturityWorker → recomputes score, sets stage
//    4. maturityWorker → when promotable, calls insertConfirmedSnapshot,
//       sets stage='promoted' + promoted_snapshot_id
//    5. lifecycleWorker → when snapshot transitions to terminal,
//       resets tracker to stage='terminated'
//    6. New saveSignals detection on terminated tracker → fresh
//       cycle (cycle=1, history reset, stage='candidate' again)
//
//  IMPORTANT: a 'promoted' tracker is dormant. Re-detections by the
//  scanner do NOT increment its cycles — the snapshot is the source
//  of truth until it terminates. This prevents a long-running mature
//  signal from accumulating thousands of cycles.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type {
  StabilitySnapshot,
  MaturityStage,
  ConvictionLevel,
  MaturityFactor,
} from '@/lib/signal-engine/maturity/maturityScorer';

const MAX_HISTORY = 12;

/**
 * If a tracker hasn't been re-detected in this many minutes, the
 * next detection is treated as a fresh cycle — we reset cycles to 1
 * and clear history. Prevents stale trackers from polluting the
 * maturity calc when the scanner stops finding the signal and then
 * re-finds it hours later.
 *
 * The previous hard-coded value of 60 minutes was the root cause of
 * the "Cycle 1 lock" symptom in production. Two scan cadences run
 * in this codebase (see bootInProc.ts):
 *   • Q365_INPROC_REGEN=1 → 10-min regen cron (delta ≪ 60min, fine).
 *   • Always-on default   → HOURLY full-market scan at minute 0.
 * On the hourly path the realised inter-detection delta is "60 minutes
 * plus cron drift / job runtime", so `minutesSinceLastSeen > 60` was
 * tripping on the very first re-detection — every hour the tracker
 * was reset back to cycle 1, the maturity worker never accumulated
 * the 3 cycles needed for promotion, and the dashboard kept showing
 * scanner candidates with `validation_cycles_passed = 1` forever.
 *
 * Default raised to 180 minutes — three hourly ticks of headroom —
 * and made env-tunable so an operator on a faster cadence can
 * tighten it without code changes. Floor 30 (one rescore window),
 * ceiling 1440 (one trading day). The getter is invoked per call so
 * tests can override the env variable between cases.
 */
// MATURATION_AUDIT_2026-05 — default raised 180 → 360 minutes.
// Operator confirmed cycles stuck at 1 across multiple scans. The
// 180-min default was tripping every time scans landed > 3 hours
// apart (which happens routinely when the auto-scan fires once,
// then sits idle through low-activity periods, or when the
// pipeline is invoked manually with gaps). 360 min (6h, ~one
// trading session) gives realistic headroom — a symbol detected
// at 09:30 IST and re-detected at 14:30 IST still increments
// instead of resetting. Floor 30, ceiling 1440 unchanged.
// Set TRACKER_STALE_RESET_MIN=180 to restore the prior default.
export const TRACKER_STALE_RESET_DEFAULT_MIN = 360;
export function getTrackerStaleResetMin(): number {
  const raw = Number(process.env.TRACKER_STALE_RESET_MIN);
  if (!Number.isFinite(raw) || raw <= 0) return TRACKER_STALE_RESET_DEFAULT_MIN;
  return Math.max(30, Math.min(1440, Math.floor(raw)));
}

/** Diagnostic surface for `upsertTrackerOnDetection`. The previous
 *  return shape only carried `reset: boolean` — operators couldn't
 *  tell from logs / API output WHY a tracker reset (terminated vs
 *  stale) or how stale "stale" was. Surfacing both unblocks the
 *  "why is this stuck on Cycle 1?" diagnostic walk-through.
 */
export type CycleResetReason =
  | 'never_seen'   // first-ever detection for this (symbol, direction)
  | 'terminated'   // prior snapshot reached terminal state, fresh cycle starts
  | 'stale'        // last_seen older than getTrackerStaleResetMin()
  | 'live';        // none of the above — cycle was incremented in place

function toMysqlDateTime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

function parseHistory(json: unknown): StabilitySnapshot[] {
  if (!json) return [];
  if (Array.isArray(json)) return json as StabilitySnapshot[];
  if (typeof json === 'string') {
    try {
      const parsed = JSON.parse(json);
      return Array.isArray(parsed) ? parsed as StabilitySnapshot[] : [];
    } catch { return []; }
  }
  return [];
}

function dateToEpochMs(v: Date | string | null): number {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const iso = v.includes('T') ? v : v.replace(' ', 'T') + 'Z';
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : 0;
  }
  return 0;
}

// ════════════════════════════════════════════════════════════════
//  Public types
// ════════════════════════════════════════════════════════════════
export interface DetectionInput {
  symbol:         string;
  direction:      'BUY' | 'SELL';
  signal_id:      number;       // q365_signals.id of the row that triggered the detection
  entry_price:    number;
  stop_loss:      number;
  target1:        number;
  confidence:     number;
  final_score:    number | null;
  decay_state:    string | null;
}

export interface TrackerRow {
  id:                       number;
  symbol:                   string;
  direction:                'BUY' | 'SELL';
  first_detected_at:        number; // ms
  last_seen_at:             number; // ms
  last_evaluated_at:        number | null;
  validation_cycles_passed: number;
  maturity_score:           number;
  stage:                    MaturityStage;
  stable:                   boolean;
  conviction_level:         ConvictionLevel;
  last_signal_id:           number | null;
  promoted_snapshot_id:     number | null;
  history:                  StabilitySnapshot[];
}

interface RawTrackerRow {
  id:                       number;
  symbol:                   string;
  direction:                string;
  first_detected_at:        Date | string;
  last_seen_at:             Date | string;
  last_evaluated_at:        Date | string | null;
  validation_cycles_passed: number;
  maturity_score:           string | number;
  stage:                    string;
  stable:                   number;
  conviction_level:         string;
  last_signal_id:           number | null;
  promoted_snapshot_id:     number | null;
  stability_history_json:   unknown;
}

function shapeTracker(r: RawTrackerRow): TrackerRow {
  const direction: 'BUY' | 'SELL' = String(r.direction).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
  const stage = (['candidate','developing','mature','promoted','terminated'] as MaturityStage[])
    .includes(r.stage as MaturityStage) ? r.stage as MaturityStage : 'candidate';
  const conviction = (['MEDIUM','HIGH','INSTITUTIONAL'] as ConvictionLevel[])
    .includes(r.conviction_level as ConvictionLevel) ? r.conviction_level as ConvictionLevel : 'MEDIUM';
  return {
    id:                       r.id,
    symbol:                   r.symbol,
    direction,
    first_detected_at:        dateToEpochMs(r.first_detected_at),
    last_seen_at:             dateToEpochMs(r.last_seen_at),
    last_evaluated_at:        r.last_evaluated_at ? dateToEpochMs(r.last_evaluated_at) : null,
    validation_cycles_passed: Number(r.validation_cycles_passed ?? 0),
    maturity_score:           Number(r.maturity_score ?? 0),
    stage,
    stable:                   Number(r.stable ?? 0) === 1,
    conviction_level:         conviction,
    last_signal_id:           r.last_signal_id != null ? Number(r.last_signal_id) : null,
    promoted_snapshot_id:     r.promoted_snapshot_id != null ? Number(r.promoted_snapshot_id) : null,
    history:                  parseHistory(r.stability_history_json),
  };
}

// ════════════════════════════════════════════════════════════════
//  Public API
// ════════════════════════════════════════════════════════════════

/**
 * Called from saveSignals after a new q365_signals row is inserted.
 * Upserts the (symbol, direction) tracker:
 *   - First detection ever → INSERT cycle=1, stage='candidate'
 *   - Subsequent detection on a non-promoted tracker → increment
 *     cycles, append to history (capped at MAX_HISTORY).
 *   - Promoted tracker → no-op (the active snapshot is the truth
 *     and re-detections shouldn't pollute its lifecycle).
 *   - Terminated or stale tracker → reset to fresh cycle.
 */
export async function upsertTrackerOnDetection(input: DetectionInput): Promise<{
  trackerId: number | null;
  cycles:    number;
  stage:     MaturityStage;
  reset:     boolean;
  /** Why a reset fired (or did not). Used by the maturity worker to
   *  explain "Cycle 1" rows in the operator-facing diagnostics. */
  resetReason:           CycleResetReason;
  /** Minutes between the previous `last_seen_at` and the current
   *  detection — null when there was no prior tracker row. */
  minutesSinceLastSeen:  number | null;
  /** Threshold in effect for this call (resolved from env at call
   *  time). Surfaced so logs can show the exact cutoff that decided
   *  whether the tracker was treated as stale. */
  staleResetThresholdMin: number;
}> {
  const symbol    = input.symbol.toUpperCase();
  const direction = input.direction;
  const now       = new Date();
  const nowMs     = now.getTime();

  // MATURATION_AUDIT_2026-05 — function entry trace. If this log
  // doesn't fire, upsertTrackerOnDetection isn't being reached at
  // all (saveSignals dedupe gate didn't call us, OR Phase 4 didn't
  // reach saveSignals for this symbol).
  console.log(
    `[TRACKER_FUNCTION_ENTER] symbol=${symbol} direction=${direction} ` +
    `signal_id=${input.signal_id} runtime_ts=${now.toISOString()}`,
  );

  const existing = await db.query<RawTrackerRow>(
    `SELECT id, symbol, direction, first_detected_at, last_seen_at, last_evaluated_at,
            validation_cycles_passed, maturity_score, stage, stable, conviction_level,
            last_signal_id, promoted_snapshot_id, stability_history_json
       FROM q365_signal_maturity_tracker
      WHERE symbol = ? AND direction = ?
      LIMIT 1`,
    [symbol, direction],
  );
  const existingRow = (existing.rows as RawTrackerRow[])[0];

  // MATURATION_AUDIT_2026-05 — explicit lookup-result log so the
  // operator can see PER CALL whether the SELECT found an existing
  // tracker row, which determines whether the function takes the
  // INSERT branch or the UPDATE branch. Operator confirmed
  // [CYCLE_ACCUMULATION] logs were missing entirely — this log
  // surfaces the call itself even when subsequent branches don't.
  console.log(
    `[TRACKER_LOOKUP] symbol=${symbol} direction=${direction} ` +
    `found=${existingRow ? 'true' : 'false'} ` +
    (existingRow
      ? `tracker_id=${existingRow.id} cycles=${existingRow.validation_cycles_passed} stage=${existingRow.stage}`
      : `tracker_id=null cycles=0 stage=none`),
  );

  const newSnapshot: StabilitySnapshot = {
    cycle:       1,
    ts:          nowMs,
    entry_price: input.entry_price,
    stop_loss:   input.stop_loss,
    target1:     input.target1,
    confidence:  input.confidence,
    final_score: input.final_score,
    decay_state: input.decay_state,
  };

  const staleResetThresholdMin = getTrackerStaleResetMin();

  if (!existingRow) {
    console.log(`[TRACKER_BRANCH] symbol=${symbol} direction=${direction} branch=INSERT`);
    // First detection — INSERT.
    try {
      const ins: any = await db.query(
        `INSERT INTO q365_signal_maturity_tracker
          (symbol, direction, first_detected_at, last_seen_at,
           validation_cycles_passed, maturity_score, stage, stable, conviction_level,
           last_signal_id, stability_history_json)
         VALUES (?, ?, ?, ?, 1, 0, 'candidate', 0, 'MEDIUM', ?, ?)`,
        [
          symbol, direction,
          toMysqlDateTime(now), toMysqlDateTime(now),
          input.signal_id,
          JSON.stringify([newSnapshot]),
        ],
      );
      console.log(
        `[CYCLE_ACCUMULATION] symbol=${symbol} dir=${direction} ` +
        `prev_cycles=0 new_cycles=1 ` +
        `reset_reason=never_seen tracker_persisted=true tracker_reused=false ` +
        `tracker_id=${Number(ins?.insertId ?? 0) || 'unknown'} ` +
        `since_last_seen=n/a threshold=${staleResetThresholdMin}min`,
      );
      return {
        trackerId: Number(ins?.insertId ?? 0) || null,
        cycles: 1, stage: 'candidate', reset: false,
        resetReason: 'never_seen',
        minutesSinceLastSeen: null,
        staleResetThresholdMin,
      };
    } catch (err: any) {
      // Race: another request inserted between our SELECT and INSERT.
      // Re-read and fall through to the update path.
      if (!/duplicate/i.test(err?.message ?? '')) {
        console.warn('[maturityTracker] insert failed:', err?.message);
        return {
          trackerId: null, cycles: 0, stage: 'candidate', reset: false,
          resetReason: 'never_seen',
          minutesSinceLastSeen: null,
          staleResetThresholdMin,
        };
      }
    }
  }

  // Existing row — re-fetch (covers the race-recovery case too).
  const refetched = existingRow ?? ((await db.query<RawTrackerRow>(
    `SELECT id, symbol, direction, first_detected_at, last_seen_at, last_evaluated_at,
            validation_cycles_passed, maturity_score, stage, stable, conviction_level,
            last_signal_id, promoted_snapshot_id, stability_history_json
       FROM q365_signal_maturity_tracker
      WHERE symbol = ? AND direction = ?
      LIMIT 1`,
    [symbol, direction],
  )).rows as RawTrackerRow[])[0];
  if (!refetched) {
    return {
      trackerId: null, cycles: 0, stage: 'candidate', reset: false,
      resetReason: 'never_seen', minutesSinceLastSeen: null, staleResetThresholdMin,
    };
  }

  const tracker = shapeTracker(refetched);

  // Promoted trackers stay dormant. The active snapshot is the
  // source of truth; re-detections don't accrue cycles here.
  if (tracker.stage === 'promoted') {
    console.log(`[TRACKER_BRANCH] symbol=${symbol} direction=${direction} branch=PROMOTED_DORMANT`);
    const sincePromoted = (nowMs - tracker.last_seen_at) / 60_000;
    console.log(
      `[CYCLE_ACCUMULATION] symbol=${symbol} dir=${direction} ` +
      `prev_cycles=${tracker.validation_cycles_passed} new_cycles=${tracker.validation_cycles_passed} ` +
      `reset_reason=promoted_dormant tracker_persisted=false tracker_reused=true ` +
      `tracker_id=${tracker.id} ` +
      `since_last_seen=${Number.isFinite(sincePromoted) ? sincePromoted.toFixed(1) : 'n/a'}min ` +
      `threshold=${staleResetThresholdMin}min`,
    );
    return {
      trackerId: tracker.id,
      cycles: tracker.validation_cycles_passed,
      stage: tracker.stage,
      reset: false,
      // Promoted is not a "reset" event; report it as 'live' so the
      // worker logs don't misread it as a stale-driven reset.
      resetReason: 'live',
      minutesSinceLastSeen: Number.isFinite(sincePromoted) ? sincePromoted : null,
      staleResetThresholdMin,
    };
  }

  // Stale / terminated tracker → reset and start fresh. The threshold
  // is read from getTrackerStaleResetMin() so a per-environment
  // TRACKER_STALE_RESET_MIN override flows through without code changes
  // and so tests can vary the threshold between cases.
  const minutesSinceLastSeen = (nowMs - tracker.last_seen_at) / 60_000;
  const isTerminated = tracker.stage === 'terminated';
  const isStale      = minutesSinceLastSeen > staleResetThresholdMin;
  const shouldReset  = isTerminated || isStale;

  if (shouldReset) {
    console.log(`[TRACKER_BRANCH] symbol=${symbol} direction=${direction} branch=RESET reason=${isTerminated ? 'terminated' : 'stale'}`);
    await db.query(
      `UPDATE q365_signal_maturity_tracker SET
        first_detected_at        = ?,
        last_seen_at             = ?,
        validation_cycles_passed = 1,
        maturity_score           = 0,
        stage                    = 'candidate',
        stable                   = 0,
        conviction_level         = 'MEDIUM',
        last_signal_id           = ?,
        promoted_snapshot_id     = NULL,
        stability_history_json   = ?
       WHERE id = ?`,
      [
        toMysqlDateTime(now),
        toMysqlDateTime(now),
        input.signal_id,
        JSON.stringify([newSnapshot]),
        tracker.id,
      ],
    );
    // 'terminated' wins over 'stale' when both apply — terminated is
    // the authoritative lifecycle signal, stale is just a clock-based
    // heuristic. Operators reading the diagnostic prefer the explicit
    // reason.
    const resetReason: CycleResetReason = isTerminated ? 'terminated' : 'stale';
    console.log(
      `[CYCLE_ACCUMULATION] symbol=${symbol} dir=${direction} ` +
      `prev_cycles=${tracker.validation_cycles_passed} new_cycles=1 ` +
      `reset_reason=${resetReason} tracker_persisted=true tracker_reused=true ` +
      `tracker_id=${tracker.id} ` +
      `since_last_seen=${minutesSinceLastSeen.toFixed(1)}min ` +
      `threshold=${staleResetThresholdMin}min ` +
      (resetReason === 'stale'
        ? `→ RESET (gap exceeded threshold; bump TRACKER_STALE_RESET_MIN if scans are sparse)`
        : `→ RESET (prior cycle terminated)`),
    );
    return {
      trackerId: tracker.id, cycles: 1, stage: 'candidate', reset: true,
      resetReason,
      minutesSinceLastSeen,
      staleResetThresholdMin,
    };
  }

  console.log(`[TRACKER_BRANCH] symbol=${symbol} direction=${direction} branch=UPDATE`);
  // Live re-detection → bump cycles, append to history.
  const nextCycle = tracker.validation_cycles_passed + 1;
  newSnapshot.cycle = nextCycle;
  const history = [...tracker.history, newSnapshot].slice(-MAX_HISTORY);

  await db.query(
    `UPDATE q365_signal_maturity_tracker SET
      last_seen_at             = ?,
      validation_cycles_passed = ?,
      last_signal_id           = ?,
      stability_history_json   = ?
     WHERE id = ?`,
    [
      toMysqlDateTime(now),
      nextCycle,
      input.signal_id,
      JSON.stringify(history),
      tracker.id,
    ],
  );

  console.log(
    `[CYCLE_ACCUMULATION] symbol=${symbol} dir=${direction} ` +
    `prev_cycles=${tracker.validation_cycles_passed} new_cycles=${nextCycle} ` +
    `reset_reason=live tracker_persisted=true tracker_reused=true ` +
    `tracker_id=${tracker.id} stage=${tracker.stage} ` +
    `since_last_seen=${minutesSinceLastSeen.toFixed(1)}min ` +
    `threshold=${staleResetThresholdMin}min`,
  );

  return {
    trackerId: tracker.id, cycles: nextCycle, stage: tracker.stage, reset: false,
    resetReason: 'live',
    minutesSinceLastSeen,
    staleResetThresholdMin,
  };
}

/**
 * Read all non-promoted, non-terminated trackers — the maturity
 * worker's input set.
 */
export async function getActiveTrackers(): Promise<TrackerRow[]> {
  try {
    const result = await db.query<RawTrackerRow>(
      `SELECT id, symbol, direction, first_detected_at, last_seen_at, last_evaluated_at,
              validation_cycles_passed, maturity_score, stage, stable, conviction_level,
              last_signal_id, promoted_snapshot_id, stability_history_json
         FROM q365_signal_maturity_tracker
        WHERE stage IN ('candidate', 'developing', 'mature')
        ORDER BY last_seen_at DESC
        LIMIT 1000`,
    );
    return (result.rows as RawTrackerRow[]).map(shapeTracker);
  } catch (err: any) {
    if (/doesn'?t exist|unknown table/i.test(err?.message ?? '')) return [];
    throw err;
  }
}

/**
 * Update the maturity computation results on a tracker. Called by
 * the maturity worker after each scoring pass — does NOT change
 * stage to 'promoted'; that happens via markPromoted() once the
 * snapshot insert succeeds.
 */
export async function updateMaturityState(
  trackerId: number,
  state: {
    score:           number;
    stage:           Exclude<MaturityStage, 'promoted' | 'terminated'>;
    stable:          boolean;
    convictionLevel: ConvictionLevel;
    factors:         MaturityFactor[];
  },
): Promise<void> {
  await db.query(
    `UPDATE q365_signal_maturity_tracker SET
      maturity_score        = ?,
      stage                 = ?,
      stable                = ?,
      conviction_level      = ?,
      maturity_factors_json = ?,
      last_evaluated_at     = NOW()
     WHERE id = ?
       AND stage IN ('candidate','developing','mature')`,
    [
      state.score,
      state.stage,
      state.stable ? 1 : 0,
      state.convictionLevel,
      JSON.stringify(state.factors),
      trackerId,
    ],
  );
}

/**
 * Mark a tracker as promoted — its confirmed snapshot exists and
 * the tracker becomes dormant until the snapshot terminates.
 */
export async function markPromoted(trackerId: number, snapshotId: number): Promise<void> {
  await db.query(
    `UPDATE q365_signal_maturity_tracker SET
      stage                = 'promoted',
      promoted_snapshot_id = ?,
      last_evaluated_at    = NOW()
     WHERE id = ?`,
    [snapshotId, trackerId],
  );
}

/**
 * Lifecycle worker calls this when a confirmed snapshot transitions
 * to a terminal status. The tracker becomes 'terminated', its
 * promoted_snapshot_id is cleared, and the next detection will
 * reset it to a fresh maturity cycle.
 */
export async function markTerminated(snapshotId: number): Promise<void> {
  await db.query(
    `UPDATE q365_signal_maturity_tracker SET
      stage                = 'terminated',
      last_evaluated_at    = NOW()
     WHERE promoted_snapshot_id = ?`,
    [snapshotId],
  );
}

// ════════════════════════════════════════════════════════════════
//  In-progress tracker view — for the dashboard's "what's seasoning"
//  panel. These are the trackers that are not yet eligible for
//  promotion but are alive and accumulating cycles. The dashboard
//  surfaces them as emerging_opportunities so the operator sees the
//  maturity layer working even when confirmed snapshots are empty.
// ════════════════════════════════════════════════════════════════

export interface InProgressTrackerRow {
  tracker_id:                number;
  symbol:                    string;
  tradingsymbol:             string;
  exchange:                  string;
  direction:                 'BUY' | 'SELL';
  strategy:                  string | null;

  // Live snapshot of the trade plan from the latest q365_signals row.
  entry_price:               number;
  stop_loss:                 number;
  target1:                   number;
  target2:                   number | null;
  risk_reward:               number;
  confidence_score:          number;
  confidence:                number;
  final_score:               number | null;
  classification:            string | null;
  market_regime:             string | null;
  decay_state:               string | null;

  // Maturity progress.
  maturity_score:            number;
  stage:                     'candidate' | 'developing' | 'mature';
  conviction_level:          'MEDIUM' | 'HIGH' | 'INSTITUTIONAL';
  validation_cycles_passed:  number;
  signal_age_minutes:        number;
  stability_passed:          boolean;
  first_detected_at:         string;
  last_seen_at:              string;
  last_evaluated_at:         string | null;

  // UI tags so existing emerging-row renderers light up.
  is_developing_setup:       true;
  signal_status:             'DEVELOPING_SETUP';
  approved:                  false;
  status:                    'DEVELOPING';
}

interface InProgressJoinRow extends RawTrackerRow {
  signal_id:                 number | null;
  signal_symbol:             string | null;
  signal_exchange:           string | null;
  signal_entry_price:        string | number | null;
  signal_stop_loss:          string | number | null;
  signal_target1:            string | number | null;
  signal_target2:            string | number | null;
  signal_risk_reward:        string | number | null;
  signal_confidence_score:   number | null;
  signal_final_score:        string | number | null;
  signal_classification:    string | null;
  signal_market_regime:      string | null;
  signal_decay_state:        string | null;
  signal_scenario_tag:       string | null;
}

function dateToIso(v: Date | string | null): string | null {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return v.replace(' ', 'T') + 'Z';
    return v;
  }
  return null;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Returns developing + mature (not yet promoted) trackers, joined
 * with their latest q365_signals row so the UI can render the trade
 * plan alongside the maturity progress. Sorted by maturity score
 * descending so "almost-promotable" rows float to the top.
 */
export async function getInProgressTrackers(limit = 50): Promise<InProgressTrackerRow[]> {
  try {
    const result = await db.query<InProgressJoinRow>(
      `SELECT t.id, t.symbol, t.direction,
              t.first_detected_at, t.last_seen_at, t.last_evaluated_at,
              t.validation_cycles_passed, t.maturity_score, t.stage, t.stable, t.conviction_level,
              t.last_signal_id, t.promoted_snapshot_id, t.stability_history_json,
              s.id   AS signal_id,
              s.symbol AS signal_symbol,
              s.exchange AS signal_exchange,
              s.entry_price AS signal_entry_price,
              s.stop_loss   AS signal_stop_loss,
              s.target1     AS signal_target1,
              s.target2     AS signal_target2,
              s.risk_reward AS signal_risk_reward,
              s.confidence_score AS signal_confidence_score,
              s.final_score  AS signal_final_score,
              s.classification AS signal_classification,
              s.market_regime  AS signal_market_regime,
              s.decay_state    AS signal_decay_state,
              s.scenario_tag   AS signal_scenario_tag
         FROM q365_signal_maturity_tracker t
         LEFT JOIN q365_signals s ON s.id = t.last_signal_id
        WHERE t.stage IN ('candidate', 'developing', 'mature')
          AND t.maturity_score >= 30
          -- Recency gate. Without this the query returns "zombie"
          -- trackers — rows whose maturity worker stopped advancing
          -- them but whose stage is still candidate/developing. The
          -- live VPS hit this when scheduler.ts died: 420 trackers
          -- from the previous day surfaced in the emerging panel as
          -- if they were active, while local (with the worker alive)
          -- showed only the genuinely-in-motion 19. Filtering on
          -- last_seen_at (set by the scanner every detection) is the
          -- honest measure: a signal not re-detected for 6h is dead
          -- regardless of what stage column says. Tunable via
          -- TRACKER_FRESHNESS_HOURS for ops; floor 1h, ceiling 48h.
          AND t.last_seen_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
          -- Also drop trackers tied to a decayed underlying signal.
          -- decay_state='fresh' on a 20h-old signal is misleading
          -- (rescore worker hasn't aged it), but if rescore HAS run
          -- and stamped 'expired'/'stale' we honour that hard signal.
          AND (s.decay_state IS NULL OR s.decay_state NOT IN ('expired', 'stale'))
        ORDER BY t.stage = 'mature' DESC,
                 t.stage = 'developing' DESC,
                 t.maturity_score DESC,
                 t.last_seen_at DESC
        LIMIT ?`,
      [
        Math.max(1, Math.min(Number(process.env.TRACKER_FRESHNESS_HOURS) || 6, 48)),
        Math.max(1, Math.min(limit, 200)),
      ],
    );

    const now = Date.now();
    return (result.rows as InProgressJoinRow[])
      .filter((r) => r.signal_id != null)  // drop trackers whose underlying signal expired
      .map((r): InProgressTrackerRow => {
        const direction: 'BUY' | 'SELL' = String(r.direction).toUpperCase() === 'SELL' ? 'SELL' : 'BUY';
        const stage = (['candidate','developing','mature'] as const)
          .includes(r.stage as 'candidate'|'developing'|'mature')
          ? r.stage as 'candidate'|'developing'|'mature'
          : 'candidate';
        const conviction = (['MEDIUM','HIGH','INSTITUTIONAL'] as const)
          .includes(r.conviction_level as 'MEDIUM'|'HIGH'|'INSTITUTIONAL')
          ? r.conviction_level as 'MEDIUM'|'HIGH'|'INSTITUTIONAL'
          : 'MEDIUM';
        const detectedMs = dateToEpochMs(r.first_detected_at);
        const ageMin = detectedMs > 0 ? Math.max(0, Math.round((now - detectedMs) / 60_000)) : 0;
        const conf = num(r.signal_confidence_score);
        const rr   = num(r.signal_risk_reward);
        return {
          tracker_id:               r.id,
          symbol:                   r.symbol,
          tradingsymbol:            r.symbol,
          exchange:                 r.signal_exchange ?? 'NSE',
          direction,
          strategy:                 r.signal_scenario_tag,
          entry_price:              num(r.signal_entry_price),
          stop_loss:                num(r.signal_stop_loss),
          target1:                  num(r.signal_target1),
          target2:                  r.signal_target2 != null ? num(r.signal_target2) : null,
          risk_reward:              rr,
          confidence_score:         conf,
          confidence:               conf,
          final_score:              numOrNull(r.signal_final_score),
          classification:           r.signal_classification,
          market_regime:            r.signal_market_regime,
          decay_state:              r.signal_decay_state,
          maturity_score:           Number(r.maturity_score ?? 0),
          stage,
          conviction_level:         conviction,
          validation_cycles_passed: Number(r.validation_cycles_passed ?? 0),
          signal_age_minutes:       ageMin,
          stability_passed:         Number(r.stable ?? 0) === 1,
          first_detected_at:        dateToIso(r.first_detected_at) ?? new Date().toISOString(),
          last_seen_at:             dateToIso(r.last_seen_at) ?? new Date().toISOString(),
          last_evaluated_at:        dateToIso(r.last_evaluated_at),
          is_developing_setup:      true,
          signal_status:            'DEVELOPING_SETUP',
          approved:                 false,
          status:                   'DEVELOPING',
        };
      });
  } catch (err: any) {
    if (/doesn'?t exist|unknown table/i.test(err?.message ?? '')) return [];
    console.warn('[maturityTracker] getInProgressTrackers failed:', err?.message);
    return [];
  }
}

/**
 * Counts by stage — quick health-check / freshness-probe input.
 */
export async function getTrackerCounts(opts: {
  /** Override the default freshness window (`TRACKER_FRESHNESS_HOURS`,
   *  default 6h). The closed-market path passes a much wider value
   *  (typically 72h) so a Sunday poll can see Friday's candidate
   *  trackers — the env-driven 6h was correct for live polling but
   *  produced "all zeros" off-hours even when the DB had hundreds of
   *  prior-session candidate rows. Floored at 1h, ceiling 168h. */
  freshHours?: number;
} = {}): Promise<{
  candidate: number;
  developing: number;
  mature: number;
  promoted: number;
  terminated: number;
  total: number;
}> {
  const zero = { candidate: 0, developing: 0, mature: 0, promoted: 0, terminated: 0, total: 0 };
  // Apply the same freshness gate getInProgressTrackers uses, but only
  // to the in-motion stages (candidate/developing/mature). Terminal
  // stages (promoted/terminated) are lifetime counters by design — a
  // signal that promoted yesterday is still a real promotion.
  // Without this filter a dead VPS reports "420 candidates seasoning"
  // when really 0 trackers have moved in 20h. Same env-var as the
  // tracker reader so they stay in sync; explicit override wins.
  const freshHoursRaw = opts.freshHours
    ?? Number(process.env.TRACKER_FRESHNESS_HOURS)
    ?? 6;
  const freshHours = Math.max(1, Math.min(168,
    Math.floor(Number.isFinite(freshHoursRaw) && freshHoursRaw > 0 ? freshHoursRaw : 6),
  ));
  try {
    const result = await db.query<{ stage: string; c: number }>(
      `SELECT stage, COUNT(*) AS c
         FROM q365_signal_maturity_tracker
        WHERE
          stage IN ('promoted', 'terminated')
          OR (stage IN ('candidate', 'developing', 'mature')
              AND last_seen_at >= DATE_SUB(NOW(), INTERVAL ? HOUR))
        GROUP BY stage`,
      [freshHours],
    );
    const out = { ...zero };
    for (const r of result.rows as Array<{ stage: string; c: number }>) {
      const stage = String(r.stage).toLowerCase();
      const count = Number(r.c ?? 0);
      if (stage in out && stage !== 'total') (out as any)[stage] = count;
      out.total += count;
    }
    return out;
  } catch (err: any) {
    if (/doesn'?t exist|unknown table/i.test(err?.message ?? '')) return zero;
    return zero;
  }
}
