// ════════════════════════════════════════════════════════════════
//  signalRotationTracker — verifies that the strict-filter signal
//  set is changing over time (not stuck on the same row group).
//
//  Holds a module-scope `Map<id, lifecycle>` so successive calls
//  to /api/signals/rotation can diff "what was there last time" vs
//  "what is there now":
//
//    NEW       — id is in current snapshot, not in previous
//    REMOVED   — id was in previous snapshot, not in current
//    UNCHANGED — id is in both
//
//  Per-id lifecycle:
//    first_seen_at — wall-clock time the id first appeared
//    last_seen_at  — wall-clock of the most recent appearance
//    status        — 'ACTIVE' (in latest snapshot) | 'DROPPED' (gone)
//
//  No DB writes. Cheap, in-process. Reset on server restart.
//  Useful as a verification harness; production rotation tracking
//  belongs in q365_signal_maturity_tracker.
// ════════════════════════════════════════════════════════════════

export type LifecycleStatus = 'ACTIVE' | 'DROPPED';

export interface SignalLifecycle {
  id:             number;
  symbol:         string | null;
  direction:      string | null;
  first_seen_at:  string;
  last_seen_at:   string;
  status:         LifecycleStatus;
}

export interface SignalIdent {
  id:        number;
  symbol?:   string | null;
  direction?: string | null;
}

export interface RotationDiff {
  /** Server wall-clock when this snapshot was recorded. */
  recorded_at:        string;
  /** ID set seen on the previous call (or [] if first call). */
  previous:           number[];
  /** ID set in the current call. */
  current:            number[];
  /** ids in current but not previous. */
  new:                number[];
  /** ids in previous but not current. */
  removed:            number[];
  /** ids in both. */
  unchanged:          number[];
  /** snapshot counts. */
  previous_count:     number;
  current_count:      number;
  new_count:          number;
  removed_count:      number;
  unchanged_count:    number;
  /** Rotation % = (new + removed) / max(previous, current).
   *  0% when both snapshots are identical, 100% when fully rotated. */
  rotation_percent:   number;
  /** True when the very first call is being made (previous=[]). */
  first_observation:  boolean;
  /** Lifecycle entries for every signal we have ever seen. */
  lifecycle:          SignalLifecycle[];
}

// ── Module-scope state — survives across requests within a process.
const lifecycleById = new Map<number, SignalLifecycle>();
let lastSnapshotIds: number[] = [];
let observationCount = 0;

/** Record a new snapshot. Returns the diff vs the last observation. */
export function recordSnapshot(currentSignals: SignalIdent[]): RotationDiff {
  observationCount += 1;
  const recordedAt = new Date().toISOString();

  const currentIds = currentSignals
    .map((s) => Number(s.id))
    .filter((n) => Number.isFinite(n) && n > 0);
  const currentSet = new Set(currentIds);
  const previousSet = new Set(lastSnapshotIds);

  const newIds       = currentIds.filter((id) => !previousSet.has(id));
  const removedIds   = lastSnapshotIds.filter((id) => !currentSet.has(id));
  const unchangedIds = currentIds.filter((id) => previousSet.has(id));

  // Update lifecycle map.
  // (a) Bump last_seen_at + ensure ACTIVE for every id in the
  //     current snapshot. Insert a new lifecycle entry on first
  //     sighting.
  for (const sig of currentSignals) {
    const id = Number(sig.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    const existing = lifecycleById.get(id);
    if (existing) {
      existing.last_seen_at = recordedAt;
      existing.status       = 'ACTIVE';
      // Refresh the symbol/direction on every sighting in case the
      // server updates the classification or normalises the symbol.
      if (sig.symbol)    existing.symbol    = sig.symbol;
      if (sig.direction) existing.direction = sig.direction;
    } else {
      lifecycleById.set(id, {
        id,
        symbol:        sig.symbol    ?? null,
        direction:     sig.direction ?? null,
        first_seen_at: recordedAt,
        last_seen_at:  recordedAt,
        status:        'ACTIVE',
      });
    }
  }
  // (b) Mark removed ids DROPPED. Keep last_seen_at at whatever the
  //     prior call set it to so the operator can see WHEN the row
  //     fell out of the strict filter.
  for (const id of removedIds) {
    const lc = lifecycleById.get(id);
    if (lc) lc.status = 'DROPPED';
  }

  // Rotation %: changes vs the larger of (previous, current).
  // 0/0 → 0% (first observation, no comparison possible).
  const denom = Math.max(lastSnapshotIds.length, currentIds.length);
  const rotationPercent = denom === 0
    ? 0
    : Math.round(((newIds.length + removedIds.length) / denom) * 1000) / 10;

  const firstObservation = observationCount === 1;
  const diff: RotationDiff = {
    recorded_at:       recordedAt,
    previous:          [...lastSnapshotIds],
    current:           currentIds,
    new:               newIds,
    removed:           removedIds,
    unchanged:         unchangedIds,
    previous_count:    lastSnapshotIds.length,
    current_count:     currentIds.length,
    new_count:         newIds.length,
    removed_count:     removedIds.length,
    unchanged_count:   unchangedIds.length,
    rotation_percent:  rotationPercent,
    first_observation: firstObservation,
    lifecycle:         [...lifecycleById.values()].sort((a, b) =>
                          a.last_seen_at < b.last_seen_at ? 1
                        : a.last_seen_at > b.last_seen_at ? -1
                        : a.id - b.id),
  };

  // Commit the new "previous" before returning.
  lastSnapshotIds = currentIds;
  return diff;
}

/** Read-only peek for tests / health endpoints. Does NOT advance the
 *  rotation pointer or update lifecycle state. */
export function peekTracker(): {
  observationCount: number;
  lastSnapshotIds:  number[];
  lifecycleSize:    number;
} {
  return {
    observationCount,
    lastSnapshotIds: [...lastSnapshotIds],
    lifecycleSize:   lifecycleById.size,
  };
}

/** Test helper — wipes module state. */
export function _resetForTests(): void {
  lifecycleById.clear();
  lastSnapshotIds = [];
  observationCount = 0;
}
