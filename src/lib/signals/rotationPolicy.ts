// ════════════════════════════════════════════════════════════════
//  rotationPolicy — institutional-grade signal rotation guards.
//
//  Spec INSTITUTIONAL §B "REMOVE SAME-STOCK REPETITION":
//    1. Same symbol must not stay pinned for many hours unless its
//       score improves.
//    2. Cooldown: symbols shown for > N cycles get a priority demotion.
//    3. Freshness decay: older signals lose ranking weight.
//    4. Diversity: avoid same-sector domination of the main table.
//    5. Live invalidation: rows without a recent confirmation drop.
//    6. Aggressive expiry of stale signals.
//
//  Module-scope state (in-process, resets on restart). Production
//  rotation also persists in q365_signal_maturity_tracker; this layer
//  is the in-process "what did the API just ship" memory.
// ════════════════════════════════════════════════════════════════

import { getSector } from '@/lib/signal-engine/constants/phase3.constants';
import { cacheGet, cacheSet } from '@/lib/redis';

export interface RotatableSignalRow {
  id?:               number;
  symbol?:           string | null;
  tradingsymbol?:    string | null;
  final_score?:      number | null;
  confidence_score?: number | null;
  rr_ratio?:         number | null;
  risk_reward?:      number | null;
  confirmed_at?:     string | Date | null;
  generated_at?:     string | Date | null;
  /** Sector hint for diversity throttling. Optional; null disables the
   *  per-sector cap for that row. */
  sector?:           string | null;
}

// ── Freshness decay ─────────────────────────────────────────────
//
// Halve effective score weight after FRESHNESS_HALF_LIFE_MIN minutes.
// 90 minutes default = the standard confirmed-snapshot validity window;
// at the edge of the window the rotation comparator sees 50% weight,
// so a brand-new 80-score row will outrank a 90-minute-old 80-score row.
//
// Override via SIGNAL_FRESHNESS_HALF_LIFE_MIN (clamped to 15..480).
const FRESHNESS_HALF_LIFE_MIN = (() => {
  const raw = Number(process.env.SIGNAL_FRESHNESS_HALF_LIFE_MIN);
  if (!Number.isFinite(raw)) return 90;
  return Math.max(15, Math.min(480, Math.floor(raw)));
})();

/** Maximum tolerated age for a row to remain in the main table during
 *  ACTIVE trading hours. 6 hours catches the prior session and any
 *  pre-market drift. Override via SIGNAL_MAX_AGE_MIN. */
const SIGNAL_MAX_AGE_MIN = (() => {
  const raw = Number(process.env.SIGNAL_MAX_AGE_MIN);
  if (!Number.isFinite(raw)) return 6 * 60;
  return Math.max(60, Math.min(1440, Math.floor(raw)));
})();

/** Closed-market max age. When the cash session is closed, the latest
 *  confirmed batch is by definition from the previous session — a 6h
 *  cap drops everything and the dashboard goes blank between
 *  ~16:00 IST and the next morning's pre-open scan. Default 24h covers
 *  weekday close → open; override via SIGNAL_MAX_AGE_CLOSED_MIN
 *  (clamped 60..10080). */
const SIGNAL_MAX_AGE_CLOSED_MIN = (() => {
  const raw = Number(process.env.SIGNAL_MAX_AGE_CLOSED_MIN);
  if (!Number.isFinite(raw)) return 24 * 60;
  return Math.max(60, Math.min(7 * 24 * 60, Math.floor(raw)));
})();

/** Per-sector cap. Default 3 institutional rows per sector so financials
 *  / IT alone can't dominate the table on a sector-strong day. */
const PER_SECTOR_CAP = (() => {
  const raw = Number(process.env.SIGNAL_PER_SECTOR_CAP);
  if (!Number.isFinite(raw)) return 3;
  return Math.max(1, Math.min(20, Math.floor(raw)));
})();

/** Maximum cycles a symbol may dominate the main table before it gets
 *  a deterministic demotion (cooldown). 6 cycles ≈ 30 minutes at a
 *  5-min cadence — enough to be "actionable", not enough to be "pinned
 *  for the day". Score-improvement bypasses the cooldown so genuinely
 *  strengthening setups are not penalised. */
const COOLDOWN_MAX_CYCLES = (() => {
  const raw = Number(process.env.SIGNAL_COOLDOWN_MAX_CYCLES);
  if (!Number.isFinite(raw)) return 6;
  return Math.max(1, Math.min(50, Math.floor(raw)));
})();

/** When a symbol enters cooldown, it loses this many score points in
 *  the rotation comparator. Picked so a top-of-table 75 row with no
 *  improvement sinks below a fresh 70 row but above a fresh 65 row —
 *  giving the operator visible rotation without ejecting still-valid
 *  setups entirely. */
const COOLDOWN_SCORE_PENALTY = 8;

// ── State ───────────────────────────────────────────────────────
interface CooldownEntry {
  cyclesShown:    number;
  bestScoreSeen:  number;
  firstShownAtMs: number;
}
const cooldownState = new Map<string, CooldownEntry>();

function symKey(r: RotatableSignalRow): string {
  return String(r.symbol ?? r.tradingsymbol ?? '').toUpperCase();
}

function rowAgeMin(r: RotatableSignalRow): number {
  const t = r.confirmed_at ?? r.generated_at;
  if (!t) return 0;
  const ms = t instanceof Date ? t.getTime() : Date.parse(String(t));
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, (Date.now() - ms) / 60_000);
}

function freshnessWeight(ageMin: number): number {
  if (ageMin <= 0) return 1;
  return Math.pow(0.5, ageMin / FRESHNESS_HALF_LIFE_MIN);
}

/**
 * Effective rank score = final_score * freshnessWeight − cooldownPenalty.
 * Pure read: does NOT mutate cooldown state. Use commitRotation() once
 * per response to update the registry with the rows actually shipped.
 */
export function effectiveRotationScore(r: RotatableSignalRow): number {
  const fs = Number(r.final_score ?? r.confidence_score ?? 0);
  if (!Number.isFinite(fs)) return 0;
  const ageMin = rowAgeMin(r);
  const w = freshnessWeight(ageMin);
  const k = symKey(r);
  const entry = cooldownState.get(k);
  let penalty = 0;
  if (entry && entry.cyclesShown >= COOLDOWN_MAX_CYCLES) {
    // No demotion when the score is improving — institutional spec
    // explicitly carves this out (a strengthening setup keeps priority).
    if (fs <= entry.bestScoreSeen) penalty = COOLDOWN_SCORE_PENALTY;
  }
  return fs * w - penalty;
}

/**
 * Aggressive freshness gate. Drops rows older than the active max-age
 * cap regardless of their score. Use BEFORE the comparator so the age
 * cap is not bypassed by a still-tradeable but ancient row.
 *
 * The cap is market-aware: SIGNAL_MAX_AGE_MIN (default 6h) when the
 * cash session is OPEN; SIGNAL_MAX_AGE_CLOSED_MIN (default 24h) when
 * CLOSED. Pass `marketOpen=false` from the closed-market caller so the
 * previous-session batch isn't blanket-rejected.
 */
export function isFreshEnough(
  r: RotatableSignalRow,
  opts: { marketOpen?: boolean } = {},
): boolean {
  const cap = opts.marketOpen === false
    ? SIGNAL_MAX_AGE_CLOSED_MIN
    : SIGNAL_MAX_AGE_MIN;
  return rowAgeMin(r) <= cap;
}

/**
 * Sector diversity post-filter. Walks the already-sorted list and skips
 * rows that would push a sector past PER_SECTOR_CAP. The row's `sector`
 * field is preferred when populated; otherwise the symbol is mapped via
 * `getSector` (phase3 SECTOR_MAP, fallback 'Other'). Rows that resolve
 * to 'Other' (unmapped symbols) are NOT counted toward the cap so we
 * never silently drop a high-conviction setup just because the static
 * sector table is incomplete.
 */
export function applySectorDiversity<T extends RotatableSignalRow>(rows: T[]): T[] {
  if (rows.length === 0) return rows;
  const counts = new Map<string, number>();
  const out: T[] = [];
  for (const r of rows) {
    const sym = String(r.symbol ?? r.tradingsymbol ?? '').toUpperCase().trim();
    const sectorHint = String(r.sector ?? '').toUpperCase().trim();
    const sec = sectorHint || (sym ? getSector(sym).toUpperCase() : '');
    // 'OTHER' = unmapped symbol — don't enforce the cap on that bucket
    // or a portfolio of mid/small-caps would self-throttle to PER_SECTOR_CAP
    // total rows. Empty string = no symbol at all (defensive).
    if (!sec || sec === 'OTHER') {
      out.push(r);
      continue;
    }
    const n = counts.get(sec) ?? 0;
    if (n >= PER_SECTOR_CAP) continue;
    counts.set(sec, n + 1);
    out.push(r);
  }
  return out;
}

/**
 * Commit the rows that the response is about to ship. Bumps the
 * per-symbol cycle counter, refreshes bestScoreSeen, and decays
 * counters for symbols that fell out of the response (they get a
 * single grace cycle before a full reset).
 *
 * Call this AFTER the final response set is decided, ONCE per
 * /api/signals invocation. Idempotent within a request — safe to call
 * twice but wasteful.
 */
export function commitRotation<T extends RotatableSignalRow>(shipped: T[]): void {
  const nowMs = Date.now();
  const shippedKeys = new Set<string>();
  for (const r of shipped) {
    const k = symKey(r);
    if (!k) continue;
    shippedKeys.add(k);
    const fs = Number(r.final_score ?? r.confidence_score ?? 0);
    const prev = cooldownState.get(k);
    if (prev) {
      prev.cyclesShown += 1;
      if (Number.isFinite(fs) && fs > prev.bestScoreSeen) prev.bestScoreSeen = fs;
    } else {
      cooldownState.set(k, {
        cyclesShown:    1,
        bestScoreSeen:  Number.isFinite(fs) ? fs : 0,
        firstShownAtMs: nowMs,
      });
    }
  }
  // Decay symbols not in this batch: drop one cycle, evict at zero.
  for (const k of [...cooldownState.keys()]) {
    if (shippedKeys.has(k)) continue;
    const e = cooldownState.get(k)!;
    e.cyclesShown -= 1;
    if (e.cyclesShown <= 0) cooldownState.delete(k);
  }
}

/**
 * Telemetry helper for the validation script + /api/signals/rotation
 * inspector. Snapshot of the current registry, suitable for serialising.
 */
export function getRotationRegistry(): Array<{
  symbol:        string;
  cycles_shown:  number;
  best_score:    number;
  first_shown_ms: number;
  in_cooldown:   boolean;
}> {
  const out: Array<ReturnType<typeof getRotationRegistry>[number]> = [];
  for (const [sym, e] of cooldownState) {
    out.push({
      symbol:         sym,
      cycles_shown:   e.cyclesShown,
      best_score:     e.bestScoreSeen,
      first_shown_ms: e.firstShownAtMs,
      in_cooldown:    e.cyclesShown >= COOLDOWN_MAX_CYCLES,
    });
  }
  return out.sort((a, b) => b.cycles_shown - a.cycles_shown);
}

/** Tunable readouts for the boot summary. */
export function getRotationConfig(): {
  freshness_half_life_min: number;
  signal_max_age_min:      number;
  per_sector_cap:          number;
  cooldown_max_cycles:     number;
  cooldown_score_penalty:  number;
} {
  return {
    freshness_half_life_min: FRESHNESS_HALF_LIFE_MIN,
    signal_max_age_min:      SIGNAL_MAX_AGE_MIN,
    per_sector_cap:          PER_SECTOR_CAP,
    cooldown_max_cycles:     COOLDOWN_MAX_CYCLES,
    cooldown_score_penalty:  COOLDOWN_SCORE_PENALTY,
  };
}

/** Test helper — wipes registry. */
export function _resetRotationForTests(): void {
  cooldownState.clear();
}

// ════════════════════════════════════════════════════════════════
//  DISTRIBUTED ROTATION (Spec DISTRIBUTED-ROTATION-2026-05)
//
//  The in-process Map cooldownState is fast but cluster-incoherent:
//  three replicas each independently bump the same symbol's
//  cyclesShown, so a row that has shipped 3× across the cluster
//  still reads as "1 cycle" to each individual replica's fatigue
//  predicate. The fix is to mirror the registry to Redis and merge
//  peer snapshots before each /api/signals request.
//
//  Design:
//    • Each replica writes its own state under
//        rotation:cooldown:<instance>  (TTL = 4× sync interval)
//    • Each replica reads every peer's state and merges it into
//      local cooldownState by:
//        cyclesShown    = MAX over peers (worst case = most fatigued)
//        bestScoreSeen  = MAX over peers (best score wins)
//        firstShownAtMs = MIN over peers (oldest first-shown wins)
//    • The merge runs at most once per SYNC_INTERVAL_MS (cached).
//
//  Best-effort throughout: a Redis outage / disabled mode skips the
//  sync and the in-process state remains authoritative — same
//  semantics as before this layer existed. Override the sync
//  interval via DISTRIBUTED_ROTATION_SYNC_MS (clamped 5s..5min).
// ════════════════════════════════════════════════════════════════

const ROTATION_KEY_PREFIX  = 'rotation:cooldown:';
const ROTATION_INSTANCES   = 'rotation:cooldown:instances';

const DISTRIBUTED_ROTATION_SYNC_MS = (() => {
  const raw = Number(process.env.DISTRIBUTED_ROTATION_SYNC_MS);
  if (!Number.isFinite(raw)) return 30_000;
  return Math.max(5_000, Math.min(5 * 60_000, Math.floor(raw)));
})();

const DISTRIBUTED_ROTATION_DISABLED = process.env.DISTRIBUTED_ROTATION === '0';

function rotationInstanceId(): string {
  return process.env.HOSTNAME
      ?? process.env.INSTANCE_ID
      ?? `pid-${process.pid}`;
}

interface RedisRotationSnapshot {
  flushed_at: string;
  instance:   string;
  entries:    Array<{ symbol: string; cyclesShown: number; bestScoreSeen: number; firstShownAtMs: number }>;
}

let _lastPushAt = 0;
let _lastPullAt = 0;

/** Serialise the local cooldownState and write it to Redis. Best-effort
 *  — a Redis stall/outage is silently absorbed. Throttled to once per
 *  DISTRIBUTED_ROTATION_SYNC_MS so a tight commit loop doesn't hammer
 *  Redis on every request. Bypass the throttle with `force=true`. */
export async function pushRotationStateToRedis(force = false): Promise<void> {
  if (DISTRIBUTED_ROTATION_DISABLED) return;
  const now = Date.now();
  if (!force && now - _lastPushAt < DISTRIBUTED_ROTATION_SYNC_MS) return;
  _lastPushAt = now;
  const id  = rotationInstanceId();
  const key = ROTATION_KEY_PREFIX + id;
  const ttlSeconds = Math.ceil((DISTRIBUTED_ROTATION_SYNC_MS * 4) / 1000);
  const entries: RedisRotationSnapshot['entries'] = [];
  for (const [sym, e] of cooldownState) {
    entries.push({
      symbol:         sym,
      cyclesShown:    e.cyclesShown,
      bestScoreSeen:  e.bestScoreSeen,
      firstShownAtMs: e.firstShownAtMs,
    });
  }
  try {
    const snap: RedisRotationSnapshot = {
      flushed_at: new Date(now).toISOString(),
      instance:   id,
      entries,
    };
    await cacheSet(key, snap, ttlSeconds);
    // Track which instances have flushed in the last 4× window so the
    // peer-pull pass knows where to look.
    const tracker = (await cacheGet<Record<string, string>>(ROTATION_INSTANCES)) ?? {};
    const cutoff = now - DISTRIBUTED_ROTATION_SYNC_MS * 4;
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(tracker)) {
      const ts = Date.parse(v);
      if (Number.isFinite(ts) && ts >= cutoff) next[k] = v;
    }
    next[id] = new Date(now).toISOString();
    await cacheSet(ROTATION_INSTANCES, next, ttlSeconds * 2);
  } catch {
    /* Redis unavailable — local state is still authoritative. */
  }
}

/** Pull every peer's snapshot from Redis and merge into local
 *  cooldownState. Throttled to once per sync interval. The merge
 *  rule preserves the WORST-CASE fatigue: max cyclesShown across
 *  all peers wins so a symbol that shipped 3× cluster-wide is
 *  treated as 3-cycles-fatigued, not 1.
 *
 *  Best-effort: a Redis outage leaves local state unchanged. */
export async function pullRotationStateFromRedis(force = false): Promise<{ merged: number }> {
  if (DISTRIBUTED_ROTATION_DISABLED) return { merged: 0 };
  const now = Date.now();
  if (!force && now - _lastPullAt < DISTRIBUTED_ROTATION_SYNC_MS) return { merged: 0 };
  _lastPullAt = now;
  let merged = 0;
  const id = rotationInstanceId();
  try {
    const tracker = await cacheGet<Record<string, string>>(ROTATION_INSTANCES);
    if (!tracker) return { merged: 0 };
    for (const peerId of Object.keys(tracker)) {
      if (peerId === id) continue;
      const peer = await cacheGet<RedisRotationSnapshot>(ROTATION_KEY_PREFIX + peerId);
      if (!peer || !Array.isArray(peer.entries)) continue;
      for (const entry of peer.entries) {
        if (!entry?.symbol) continue;
        const k = entry.symbol.toUpperCase();
        const prev = cooldownState.get(k);
        if (!prev) {
          cooldownState.set(k, {
            cyclesShown:    Math.max(0, Math.floor(entry.cyclesShown)),
            bestScoreSeen:  Number.isFinite(entry.bestScoreSeen) ? entry.bestScoreSeen : 0,
            firstShownAtMs: Number.isFinite(entry.firstShownAtMs) ? entry.firstShownAtMs : Date.now(),
          });
        } else {
          // MAX cycles — preserve worst-case fatigue across the cluster.
          if (entry.cyclesShown > prev.cyclesShown) prev.cyclesShown = entry.cyclesShown;
          if (entry.bestScoreSeen > prev.bestScoreSeen) prev.bestScoreSeen = entry.bestScoreSeen;
          if (entry.firstShownAtMs > 0 && entry.firstShownAtMs < prev.firstShownAtMs) {
            prev.firstShownAtMs = entry.firstShownAtMs;
          }
        }
        merged += 1;
      }
    }
  } catch {
    /* Redis unavailable — caller continues with local state. */
  }
  return { merged };
}

/** Convenience: pull then run the supplied function then push. The
 *  caller (typically /api/signals before computing finalRows) gets a
 *  cluster-coherent snapshot at request entry, then publishes any
 *  state mutations on exit. Errors in the pull/push do NOT propagate
 *  — they're best-effort sync; the supplied function still runs. */
export async function withDistributedRotation<T>(
  fn: () => Promise<T> | T,
): Promise<T> {
  await pullRotationStateFromRedis().catch(() => undefined);
  const result = await fn();
  void pushRotationStateToRedis().catch(() => undefined);
  return result;
}

// ════════════════════════════════════════════════════════════════
//  FATIGUE STAMPING (Spec ROTATION-FATIGUE-2026-05)
//
//  Stamp every row about to ship with three explicit fields so the
//  wire shape carries the rotation context out to consumers:
//    repeat_count        — cycles this symbol has shipped consecutively
//    cooldown_remaining  — cycles until the cooldown_max_cycles cap
//                          is reached (0 once the row is in cooldown)
//    rotation_score      — effectiveRotationScore at the moment of
//                          stamping (final_score × freshness_weight
//                          − cooldown penalty)
//    fatigue_state       — 'fresh' | 'rotating' | 'fatigued'
//
//  Pure read of the in-process cooldownState — does not mutate it.
//  commitRotation is still the single mutator and must run AFTER
//  this stamping pass on the actually-shipped set.
// ════════════════════════════════════════════════════════════════

export interface RotationFatigueFields {
  repeat_count:       number;
  cooldown_remaining: number;
  rotation_score:     number;
  fatigue_state:      'fresh' | 'rotating' | 'fatigued';
}

/** Read-only fatigue probe for a single row. */
export function readFatigueFields<T extends RotatableSignalRow>(r: T): RotationFatigueFields {
  const k = symKey(r);
  const entry = cooldownState.get(k);
  const repeats = entry?.cyclesShown ?? 0;
  const remaining = Math.max(0, COOLDOWN_MAX_CYCLES - repeats);
  const rotScore = effectiveRotationScore(r);
  const state: RotationFatigueFields['fatigue_state'] =
    repeats >= COOLDOWN_MAX_CYCLES ? 'fatigued'
    : repeats >= Math.ceil(COOLDOWN_MAX_CYCLES / 2) ? 'rotating'
    : 'fresh';
  return {
    repeat_count:       repeats,
    cooldown_remaining: remaining,
    rotation_score:     Math.round(rotScore * 10) / 10,
    fatigue_state:      state,
  };
}

/**
 * Stamp every row in the array with rotation fatigue fields. Returns a
 * NEW array; does not mutate the inputs. Use after the elite gate so the
 * wire payload carries the rotation context for the actual shipped set.
 *
 * Note: this reads the current cooldown registry, which reflects the
 * PREVIOUS request's commitRotation call. The numbers describe "how
 * many times has this symbol shipped recently" before THIS response —
 * the operator sees the fatigue building up across cycles.
 */
export function annotateRotationFatigue<T extends RotatableSignalRow>(rows: readonly T[]): Array<T & RotationFatigueFields> {
  const out: Array<T & RotationFatigueFields> = [];
  for (const r of rows) {
    out.push({ ...r, ...readFatigueFields(r) });
  }
  return out;
}

/**
 * Comparator factory that combines:
 *   1. Effective rotation score (freshness-decayed minus cooldown penalty),
 *   2. Original deterministic tiebreak (final_score, confidence, rr_ratio,
 *      confirmed_at, id).
 *
 * Rows that fail `isFreshEnough` should be filtered out BEFORE sorting;
 * the comparator does not enforce the hard age cap.
 */
export function rotationCmp<T extends RotatableSignalRow & { id?: number }>(
  a: T, b: T,
): number {
  const ea = effectiveRotationScore(a);
  const eb = effectiveRotationScore(b);
  if (ea !== eb) return eb - ea;
  const fa = Number(a.final_score ?? 0);
  const fb = Number(b.final_score ?? 0);
  if (fb !== fa) return fb - fa;
  const ca = Number(a.confidence_score ?? 0);
  const cb = Number(b.confidence_score ?? 0);
  if (cb !== ca) return cb - ca;
  return Number(a.id ?? 0) - Number(b.id ?? 0);
}
