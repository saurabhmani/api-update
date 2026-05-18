/**
 * GET /api/signals
 *
 * All signals come from the centralized q365_signals table.
 * Pipeline writes once → all pages read from here.
 *
 * Actions:
 *   ?action=top     — top N signals by opportunity score (default)
 *   ?action=all     — all active signals
 *   ?action=stats   — 7-day signal statistics
 *   ?action=instrument&symbol=TCS — live per-instrument deep analysis (keeps real-time search)
 *   ?action=history&symbol=TCS    — signal history for a symbol
 */
import { NextRequest, NextResponse }  from 'next/server';
import { requireSession }             from '@/lib/session';
import { db }                         from '@/lib/db';
// Legacy q365_signals readers (getActiveSignals, getTopSignals,
// getSignalStats, getStrategyBreakdownsBatch, getDevelopingSetupBackfill)
// are no longer reachable from this route after the dead-branch
// removal; only getStrategyBreakdowns survives for action='breakdowns'.
import { getStrategyBreakdowns }      from '@/lib/signal-engine/repository/readSignals';
// getActiveConfirmedSnapshots / getConfirmedSnapshotFreshness / the
// maturityTracker reads moved to confirmedSignalsService — only
// getConfirmedSnapshotStats survives here for action='stats'.
import { getConfirmedSnapshotStats }   from '@/lib/signal-engine/repository/readConfirmedSnapshots';
import { revalidateInstrument }       from '@/lib/signal-engine/live/revalidateInstrument';
// applyLiveSanity import removed: API is read-only over snapshots.
// Live-tape validation lives in runConfirmedSnapshotLifecycle.
// belongsInMainTable / MAIN_TABLE_CLASSIFICATIONS no longer referenced
// after the dead-branch removal; the active path's strict gate
// hardcodes its own approved classification set.
// compactConfirmedSignal is now used inside responseAssembly only;
// the route handler doesn't need a direct import.
import {
  type ConfirmedSignalRow,
  compactConfirmedSignal,
}                                     from '@/lib/signals/signalsResponseMapper';
import {
  applyConfirmedCap,
  confirmedSnapshotCmp,
  isBelowFloor,
  strictApproved,
  STRICT_FINAL_FLOOR,
  STRICT_CONFIDENCE_FLOOR,
  STRICT_RR_FLOOR,
  applyEliteGate,
}                                     from '@/lib/signals/confirmedSignalPolicy';
import {
  buildFreshness,
  resolveSyntheticBatchId,
  logSignalFunnel,
  probeScannerBatch,
  loadUniverseSize,
  type SnapshotFreshnessRaw,
}                                     from '@/lib/signals/freshnessService';
import {
  loadConfirmedSignalsBundle,
}                                     from '@/lib/signals/confirmedSignalsService';
import {
  loadClosedMarketSignals,
  resolveClosedSignalsMaxAgeHours,
  getRelaxedSignalFloors,
}                                     from '@/lib/signals/closedMarketSignals';
import { getTrackerCounts, getInProgressTrackersLenient } from '@/lib/signal-engine/repository/maturityTracker';
import {
  buildSignalsResponsePayload,
  deriveValidationStatus,
  dropStaleOrConflictingRows,
  filterSignalsToNifty500,
  type ClosestToApprovalRow,
}                                     from '@/lib/signals/responseAssembly';
import {
  getManipulationRiskForSymbols,
}                                     from '@/lib/manipulation-engine/manipulationSignalRisk';
import {
  rankSignalsByInstitutionalScore,
  buildClosestToApprovalSignals,
  CLOSEST_TO_APPROVAL_MAX,
  type RankableSignal,
  type NearestSignal,
}                                     from '@/lib/signals/signalRanking';
import {
  buildSignalDueDiligence,
  buildPerformanceReview,
  buildDueDiligenceSummary,
  type DueDiligenceContext,
  type DueDiligenceReview,
  type DueDiligenceSummary,
  type PerformanceReview,
  type ReviewedSignalGroup,
  type SignalTierContext,
}                                     from '@/lib/signals/signalDueDiligence';
import {
  buildLightweightDailyReportPreview,
}                                     from '@/lib/signals/dailySignalReport';
import {
  buildLightweightEngineHealthPreview,
}                                     from '@/lib/signals/engineHealthMap';
import { buildSignalFunnel }          from '@/lib/signals/signalFunnelBuilder';
import {
  partitionByTier,
  buildEmptyStateMessage,
  selectHighPotentialFallback,
  HIGH_POTENTIAL_MAX_ROWS,
  CONDITIONAL_CONFIDENCE_FLOOR,
  CONDITIONAL_RR_FLOOR,
  type TieredRow,
  type SignalTier,
}                                     from '@/lib/signals/signalTierClassifier';
import {
  applySectorDiversity,
  commitRotation,
  isFreshEnough,
  rotationCmp,
  pullRotationStateFromRedis,
}                                     from '@/lib/signals/rotationPolicy';
import { isInNifty500, getNifty500Symbols } from '@/lib/marketData/nifty500Universe';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';
import { resolveBatch }               from '@/lib/marketData/resolver/marketDataResolver';
import {
  indianApiBreakerState,
  getApiUsage,
  beginPerRunBudget,
  endPerRunBudget,
  INDIANAPI_PER_RUN_LIMIT,
}                                     from '@/providers/adapters/IndianAPIAdapter';
// fetchFromYahooCached import removed: only used by enrichWithLiveLtp,
// which moved to @/lib/signals/confirmedSignalsService.
import { getMarketStatus, isMarketOverrideEnabled } from '@/lib/marketData/marketHours';
import {
  isInFlight as isScannerInFlight,
  getLastSummary as getScannerLastSummary,
  getProgress as getScannerProgress,
  getInFlightElapsedMs as getScannerInFlightElapsedMs,
}                                     from '@/lib/scanner/scannerState';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

// Verbose per-request debug logs ([TRACE], [SELL DEBUG], [HARD FILTER],
// [LIVE-SANITY], [PHASE-12 PARTITION], [EMERGING DEDUP], [DEBUG FILTER],
// [FINAL ENGINE], [ENGINE BALANCE], [INVALIDATION]) used to fire on
// every GET /api/signals call. The dashboard polls this every few
// seconds, so each request was emitting many multi-line / multi-object
// logs — large console writes are synchronous I/O and add real latency
// (and fill PM2's log files fast). Gated behind LOG_VERBOSE_SIGNALS=1
// so operators can opt back in when diagnosing the funnel without
// paying the cost in production.
const VERBOSE_SIGNALS = process.env.LOG_VERBOSE_SIGNALS === '1';

// ────────────────────────────────────────────────────────────────
//  Snapshot freeze cache — performance only, NOT correctness.
//
//  The institutional gate downstream produces deterministic output
//  from a given DB state, so two consecutive uncached requests
//  already return the same payload. The freeze cache simply skips
//  the redundant DB read + Yahoo enrichment for callers within
//  FREEZE_TTL_MS of the last fetch.
//
//  EMPTY PAYLOADS ARE NEVER CACHED. Caching them would mask state
//  changes for FREEZE_TTL_MS — the dashboard would keep returning
//  `signals: []` even after a cold-start scan populated the DB,
//  because the empty result from the prior poll is still "fresh"
//  in the cache. The DB query is cheap when there's nothing to
//  return, so this costs nothing in practice and lets the
//  cold-start auto-scan trigger fire on every empty poll.
//
//  No sticky-LKG: empty stays empty. The operator must see the
//  genuine engine state, not a stale "last good" mask.
// ────────────────────────────────────────────────────────────────
const FREEZE_TTL_MS = Math.max(60_000, Number(process.env.SIGNALS_FREEZE_TTL_MS) || 5 * 60_000);
type FreezeEntry = { ts: number; payload: any; batchMs: number };
const freezeCache = new Map<string, FreezeEntry>();
function freezeKey(action: string, limit: number, lite: boolean): string {
  return `${action}|${limit}|${lite ? 1 : 0}`;
}

// PROD-STALE-FIX 2026-05 — generation-aware freeze cache.
//
// Symptom this closes: a fresh signal-engine batch landed in q365_signals
// while the in-memory cache was holding the prior batch's payload. With
// a flat 5-min TTL the route kept replaying the previous run for up to
// FREEZE_TTL_MS, masking the new BUY/SELL set. Local rarely sees this
// because dev TTLs are shorter and traffic is single-user; production
// 12+ concurrent pollers all sit on the same warm cache entry.
//
// Fix: tag every cache entry with MAX(generated_at) at write time, then
// on every read probe the same scalar and invalidate when the DB has
// advanced. One indexed scalar query per hit — cheaper than the work
// the cache is sparing us, and keeps the "stable across rapid polls"
// guarantee within a single batch generation.
let _latestBatchMsCache = { ts: 0, value: 0 };
const LATEST_BATCH_PROBE_TTL_MS = 1_000; // cap the probe to once per sec
async function getLatestBatchMs(): Promise<number> {
  const now = Date.now();
  if (now - _latestBatchMsCache.ts < LATEST_BATCH_PROBE_TTL_MS) {
    return _latestBatchMsCache.value;
  }
  try {
    const { rows } = await db.query<{ ts: number | string | null }>(
      `SELECT UNIX_TIMESTAMP(MAX(generated_at)) AS ts FROM q365_signals`,
    );
    const raw = (rows[0] as any)?.ts;
    const v = raw == null ? 0 : Math.round(Number(raw) * 1000);
    _latestBatchMsCache = { ts: now, value: Number.isFinite(v) ? v : 0 };
  } catch {
    // Probe failure — keep the previous value so a transient DB hiccup
    // doesn't drop every cache entry. Correctness still holds: when the
    // probe recovers, a newer ts will bust the cache on the next hit.
  }
  return _latestBatchMsCache.value;
}

async function freezeGetFresh(key: string): Promise<FreezeEntry | null> {
  const e = freezeCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > FREEZE_TTL_MS) return null;
  const latestBatchMs = await getLatestBatchMs();
  // 0 = probe unavailable (transient) — fall back to TTL-only behaviour.
  if (latestBatchMs > 0 && latestBatchMs > e.batchMs) {
    freezeCache.delete(key);
    return null;
  }
  return e;
}
/** Cache a non-empty payload. Empty payloads are deliberately NOT
 *  cached — see the header comment above. The caller MUST check
 *  emptiness before calling this. */
async function freezePut(key: string, payload: any): Promise<void> {
  const batchMs = await getLatestBatchMs();
  freezeCache.set(key, { ts: Date.now(), payload, batchMs });
}
/** Drop the cache entry for a key, if present. Used when a cached
 *  payload should no longer be served (e.g. after a successful
 *  cold-start scan invalidates the prior empty state). */
function freezeDrop(key: string): void {
  freezeCache.delete(key);
}

// ────────────────────────────────────────────────────────────────
//  q365_signals schema-compat probe.
//
//  The route's fail-safe queries reference columns
//  (raw_classification, live_invalidated, execution_allowed) that
//  some deployments don't have — `raw_classification` in particular
//  is an in-memory derived field that has never been a column on
//  any schema. A SELECT that names a missing column fails with
//  "Unknown column ... in 'field list'", which used to crash the
//  best-available fallback and surface as an empty UI.
//
//  We probe INFORMATION_SCHEMA once per process (TTL 5 min) and
//  build SELECT projections + WHERE filters that only reference
//  columns that actually exist. Missing columns are projected as
//  NULL aliases so the row shape callers expect stays stable.
// ────────────────────────────────────────────────────────────────
let _q365ColumnSet: Set<string> | null = null;
let _q365ColumnLoadAt = 0;
const Q365_COLUMN_TTL_MS = 5 * 60_000;

async function getQ365Columns(): Promise<Set<string>> {
  const now = Date.now();
  if (_q365ColumnSet && (now - _q365ColumnLoadAt) < Q365_COLUMN_TTL_MS) {
    return _q365ColumnSet;
  }
  try {
    const { rows } = await db.query<any>(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'q365_signals'`,
    );
    const set = new Set<string>(
      (rows as any[])
        .map((r) => String(r.COLUMN_NAME ?? r.column_name ?? '').toLowerCase())
        .filter((s) => s !== ''),
    );
    if (set.size > 0) {
      _q365ColumnSet = set;
      _q365ColumnLoadAt = now;
    }
    return set;
  } catch {
    // Probe failed (transient DB issue). Return whatever we cached
    // last; if nothing, return empty so callers fall back to the
    // most defensive projection (everything optional).
    return _q365ColumnSet ?? new Set<string>();
  }
}

/** SELECT-fragment helper: emit `col` if it exists, else `NULL AS col`
 *  so the result row keeps a consistent shape on older schemas. */
function q365Project(cols: Set<string>, col: string): string {
  return cols.has(col.toLowerCase()) ? col : `NULL AS ${col}`;
}

// Institutional approval predicate, score floors, classification sets,
// cap policy, and the deterministic comparator now live in
// `@/lib/signals/confirmedSignalPolicy`. Everything imported above.

// Zombie helpers retired: `withTimeout`, `withTimeoutTagged`,
// `swrCache`, `swrStores`, and the exported `invalidateSignalsCache`
// all lived here historically. They were only used by the long-since-
// deleted `buildFreshnessProbe`, so the SWR cache was permanently
// empty and the invalidator was a no-op. The named export also
// violated Next.js Route Handler rules (TS2344 in .next/types).
//
// External callers (customUniverseBatchScanner, revalidateInstrument,
// run-signal-engine) have been updated to drop the call. The SSE
// SWR cache + its invalidator (`invalidateStreamSignalsCache`) live
// in @/lib/signals/streamSignalsCache.
//
// enrichWithLiveLtp + freshness builder moved to @/lib/signals/.

// Spec "FIX FINAL SIGNAL VISIBILITY" §2 — single source of truth for
// the relaxed-tier floors used by both the [FILTER] funnel log and
// the ?debug=signals raw rejection-reason annotator. Reads through
// `getRelaxedSignalFloors()` so the SIGNAL_API_RELAX_* env vars
// continue to override at runtime without a rebuild.
const RELAXED_SIGNAL_FLOORS = getRelaxedSignalFloors();

// Server-side auto-recovery throttle. When /api/signals sees an empty
// DB pool we kick the Yahoo scanner once per 5 min so the dashboard
// recovers without operator intervention. Module-level so multiple
// concurrent requests share the same cooldown — without this, every
// poll on a cold deployment fires a scanner request → scanner refuses
// (in-flight cooldown) → log spam.
//
// Cold-start uses a SHORTER cooldown (60s) instead of bypassing it
// entirely. The previous "bypass on coldStart" path made every 5s
// dashboard poll fire a fresh scanner run, which thrashed the in-flight
// guard and drowned the log with `[AUTO-RECOVERY] scanner completed`
// lines. 60s is short enough that a fresh deploy recovers within a
// minute, long enough that polls don't pile up on a still-empty DB.
let lastAutoScanAtMs = 0;
const AUTO_SCAN_COOLDOWN_MS      = 5 * 60_000;
const AUTO_SCAN_COLDSTART_MIN_MS = 60_000;

// ────────────────────────────────────────────────────────────────
//  Live-empty market_data cache.
//
//  Symptom this fixes: when the strict confirmed-snapshot pool is
//  empty, the route fans out to `resolveBatch(NIFTY500.head)` to
//  produce live IndianAPI prices for the price view. On the dev
//  plan each /stock call is ~5–10s under load, so a 20-symbol fan-out
//  serialised through the adapter's rate limiter takes 1–2 minutes.
//  Without this cache that cost paid on every poll.
//
//  The resolver itself has a 60s per-symbol cache, but the FIRST
//  poll on a cold cache still pays the full fan-out. This route-
//  level cache short-circuits any subsequent poll within
//  LIVE_MARKET_TTL_MS even before the resolver layer is consulted —
//  zero IndianAPI calls, zero rate-limiter chain entries, single
//  Map lookup.
//
//  Keyed by `limit` because the fan-out size is `min(limit, N)`
//  and different limits produce different result sets.
// ────────────────────────────────────────────────────────────────
type LiveMarketSource =
  | 'indianapi' | 'cache' | 'nse_direct' | 'yahoo_emergency'
  | 'market_close_snapshot' | 'none';
interface LiveMarketCacheEntry {
  ts:     number;
  data:   any[];
  source: LiveMarketSource;
}
const LIVE_MARKET_TTL_MS = Math.max(
  5_000,
  Number(process.env.SIGNALS_LIVE_MARKET_TTL_MS) || 30_000,
);
const liveMarketCache = new Map<number, LiveMarketCacheEntry>();
function getLiveMarketCached(limit: number): LiveMarketCacheEntry | null {
  const e = liveMarketCache.get(limit);
  if (!e) return null;
  if (Date.now() - e.ts > LIVE_MARKET_TTL_MS) {
    liveMarketCache.delete(limit);
    return null;
  }
  return e;
}
function putLiveMarketCache(
  limit: number, data: any[], source: LiveMarketSource,
): void {
  liveMarketCache.set(limit, { ts: Date.now(), data, source });
}

// Hard wall-clock cap on the live-empty resolver call. The IndianAPI
// dev plan's per-IP throttle can stall a /stock call for 5–10s; a 20-
// symbol fan-out worst-case is well over a minute. Capping the await
// at 10s lets the request fall through to the snapshot fallback and
// return a complete (if stale) payload. The resolver call itself is
// NOT cancelled — its symbols continue filling the per-symbol quote
// cache so the next poll within TTL gets fresh data.
const LIVE_RESOLVE_TIMEOUT_MS = Math.max(
  3_000,
  Number(process.env.SIGNALS_LIVE_RESOLVE_TIMEOUT_MS) || 10_000,
);

// ────────────────────────────────────────────────────────────────
//  Auto-scan diagnostic state.
//
//  Without this, every auto-scan invocation was opaque: triggers fired
//  fire-and-forget and any error from refreshDailyCandles /
//  generatePhase4Signals was caught and logged but never surfaced to
//  the operator. The dashboard kept reporting `last_pipeline_run: null`
//  / `latest_batch_id: null` with no way to tell whether the recovery
//  was running, blocked, or failing.
//
//  This module-scope `autoScanState` records the most recent outcome.
//  Each /api/signals response now ships it under `auto_recovery` so
//  operators can see at a glance whether the pipeline has fired and,
//  if not, what's blocking it (cooldown / in-flight / error / status).
// ────────────────────────────────────────────────────────────────
type AutoScanStatus =
  | 'idle'                // process just booted, no trigger has fired yet
  | 'in_flight'           // trigger fired, recovery running
  | 'completed'           // last run finished without throwing
  | 'failed'              // last run threw — see lastError
  | 'skipped_cooldown'    // last attempt suppressed by the cooldown window
  | 'skipped_inflight';   // last attempt suppressed by the in-flight guard

// Spec "FIX FINAL SIGNAL VISIBILITY" §1 — operators need to see WHICH
// stage of the recovery is running (not just "in_flight"). Phase 1's
// per-symbol progress only ticks once Phase 4 reaches Phase 1; up
// until then `progress` is null and the response was opaque about
// whether candle warmup, dynamic imports, or Phase 4 was the stuck
// stage. The `stage` field gives an honest answer.
type AutoScanStage =
  | 'idle'           // no recovery has run yet
  | 'importing'      // dynamic imports of the recovery deps
  | 'candle_warmup'  // refreshDailyCandles fan-out
  | 'phase4'         // generatePhase4Signals (Phase 1 inside emits per-symbol progress)
  | 'heartbeat'      // markPipelineHeartbeat write
  | 'completed'
  | 'failed';

interface AutoScanState {
  status:           AutoScanStatus;
  stage:            AutoScanStage;
  lastFiredAt:      number | null;
  lastCompletedAt:  number | null;
  lastReason:       string | null;
  lastError:        string | null;
  lastResult: {
    candleRefreshed: number;
    candleBars:      number;
    candleFailed:    number;
    phase4Scanned:   number;
    phase4Approved:  number;
    phase4Rejected:  number;
  } | null;
}

let autoScanState: AutoScanState = {
  status:          'idle',
  stage:           'idle',
  lastFiredAt:     null,
  lastCompletedAt: null,
  lastReason:      null,
  lastError:       null,
  lastResult:      null,
};

// Progress envelope assembled from the shared scannerState global.
// Phase 1 calls setProgress(scannedCount, totalSymbols, symbol) per
// symbol while the scan loop is running, so any caller (including a
// concurrent /api/signals poll that gets `skipped_inflight`) can read
// the live counter and surface "73% scanned, ~45s remaining" instead
// of an opaque "pipeline still running" message.
function buildProgressEnvelope(): {
  scanned:         number;
  total:           number;
  percent:         number;
  last_symbol:     string | null;
  started_at:      string | null;
  updated_at:      string | null;
  elapsed_seconds: number | null;
  eta_seconds:     number | null;
  stalled:         boolean;
} | null {
  const p = getScannerProgress();
  if (!p) return null;
  const total   = p.total > 0 ? p.total : 0;
  const scanned = Math.min(p.done, total || p.done);
  const percent = total > 0 ? Math.round((scanned / total) * 1000) / 10 : 0;
  const now     = Date.now();
  const elapsedMs = Math.max(0, now - p.startedAt);
  const elapsedSec = Math.round(elapsedMs / 1000);
  // Linear ETA based on scanned/elapsed. Reads as null until at least
  // one symbol has finished (otherwise we'd divide by zero) and after
  // the scan completes (scanned >= total).
  let etaSec: number | null = null;
  if (scanned > 0 && total > 0 && scanned < total) {
    const msPerSymbol = elapsedMs / scanned;
    etaSec = Math.max(1, Math.round((msPerSymbol * (total - scanned)) / 1000));
  }
  // 90s without a `setProgress` tick = scan is wedged (worker died,
  // upstream hung). Surfaced so the operator can decide to kick the
  // stale-inflight watchdog rather than wait the full 10-min default.
  const stalled = (now - p.updatedAt) > 90_000;
  return {
    scanned,
    total,
    percent,
    last_symbol:     p.lastSymbol,
    started_at:      new Date(p.startedAt).toISOString(),
    updated_at:      new Date(p.updatedAt).toISOString(),
    elapsed_seconds: elapsedSec,
    eta_seconds:     etaSec,
    stalled,
  };
}

function autoScanEnvelope() {
  const progress = buildProgressEnvelope();
  const elapsedMs = autoScanState.lastFiredAt
    ? Math.max(0, Date.now() - autoScanState.lastFiredAt)
    : null;
  return {
    status:           autoScanState.status,
    stage:            autoScanState.stage,
    elapsed_seconds:  elapsedMs == null ? null : Math.round(elapsedMs / 1000),
    last_fired_at:    autoScanState.lastFiredAt
      ? new Date(autoScanState.lastFiredAt).toISOString() : null,
    last_completed_at: autoScanState.lastCompletedAt
      ? new Date(autoScanState.lastCompletedAt).toISOString() : null,
    last_reason:      autoScanState.lastReason,
    last_error:       autoScanState.lastError,
    last_result:      autoScanState.lastResult,
    // null when no scan has started yet OR Phase 1 has cleared the
    // counter on completion. `status === 'in_flight'` + non-null
    // `progress` is the actionable "pipeline running, here's how far"
    // signal for the dashboard. While the recovery is in candle
    // warmup or imports (`stage` says so) progress legitimately reads
    // null because Phase 1 hasn't started yet.
    progress,
  };
}

/**
 * Spec "RELAX DATA QUALITY" §4 — coverage-quality label band.
 *
 *   HIGH    > 90 %
 *   MEDIUM  70 – 90 %
 *   LOW     50 – 70 %
 *   NONE    < 50 % (or no resolver call happened)
 *
 * Distinct from the resolver's internal `dataQuality` (HIGH/MEDIUM/LOW)
 * because that classifier also factors latency + freshness; this one
 * is a pure coverage signal so consumers can tag rows / show banners
 * without re-implementing the math.
 */
type CoverageQuality = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
function classifyCoverageQuality(pct: number | null | undefined): CoverageQuality {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return 'NONE';
  if (pct >  90) return 'HIGH';
  if (pct >= 70) return 'MEDIUM';
  if (pct >= 50) return 'LOW';
  return 'NONE';
}

/**
 * Resolve the same boot gate that `bootInProc` consults so the response
 * can warn the operator when the in-proc scheduler is OFF (which is
 * the most common reason `last_pipeline_run` never advances on its
 * own — the route's auto-recovery only fires on poll-driven empty
 * states, not on a 10-min cadence).
 *
 * Mirrors the precedence in src/lib/workers/bootInProc.ts:
 *   Q365_INPROC_SCHEDULER=1 → on
 *   Q365_INPROC_SCHEDULER=0 → off
 *   Q365_INPROC_REGEN=1     → on
 *   NODE_ENV='development'  → on
 *   otherwise               → off
 */
function inProcSchedulerActive(): boolean {
  const sched = (process.env.Q365_INPROC_SCHEDULER ?? '').trim().toLowerCase();
  if (sched === '1' || sched === 'true' || sched === 'yes' || sched === 'on') return true;
  if (sched === '0' || sched === 'false' || sched === 'no' || sched === 'off') return false;
  const regen = (process.env.Q365_INPROC_REGEN ?? '').trim().toLowerCase();
  if (regen === '1' || regen === 'true' || regen === 'yes' || regen === 'on') return true;
  return process.env.NODE_ENV === 'development';
}

/**
 * Build a `pipeline_health` envelope for the response. Surfaced
 * unconditionally so an operator hitting the API can immediately tell
 * (a) whether the scheduler is even running, (b) what to do about it
 * if it isn't, and (c) when the pipeline last completed.
 */
function pipelineHealthEnvelope(opts: {
  lastPipelineRunIso: string | null;
  marketOpen:         boolean;
  bootstrapInvoked:   boolean;
}): {
  scheduler_active:    boolean;
  market_open:         boolean;
  last_pipeline_run:   string | null;
  recommendation:      string | null;
  next_action:         'wait_for_recovery' | 'bootstrap' | 'enable_scheduler' | 'inspect_error' | 'healthy';
  bootstrap_endpoint:  string;
  manual_run_endpoint: string;
  indianapi_breaker:   {
    open:               boolean;
    remaining_ms:       number;
    reopens_at:         string | null;
    auth_failed:        boolean;
    auth_failed_for_ms: number;
  };
} {
  const schedActive = inProcSchedulerActive();
  // Recovery in flight = a previous request fired the trigger and the
  // background `runAutoScanRecovery` hasn't reached its terminal state
  // (completed or failed) yet. Detect this by a fired_at without a
  // matching completed_at, regardless of the current `status` field
  // (which may have been overwritten to skipped_cooldown by a later
  // trigger).
  const recoveryInFlight =
    autoScanState.lastFiredAt != null
    && autoScanState.lastCompletedAt == null
    && autoScanState.status !== 'failed'
    && autoScanState.status !== 'completed';
  const recoveryFailed =
    autoScanState.status === 'failed'
    || (autoScanState.lastError != null && autoScanState.lastCompletedAt != null);
  // Read breaker state ONCE so we can use it for both the
  // recommendation and the response envelope below.
  const breakerNow = indianApiBreakerState();
  let recommendation: string | null = null;
  let nextAction: 'wait_for_recovery' | 'bootstrap' | 'enable_scheduler' | 'inspect_error' | 'healthy' = 'healthy';
  // Auth failure takes priority — until the key is fixed, every other
  // recommendation is meaningless because Phase 4's candle calls also
  // depend on IndianAPI.
  if (breakerNow.auth_failed) {
    recommendation =
      'IndianAPI returned 403 (auth failed). Verify INDIANAPI_API_KEY in .env.local matches the live key from your IndianAPI dashboard. ' +
      'Common cause: env file edit truncated the key. Restart the server after fixing.';
    nextAction = 'inspect_error';
  } else if (!schedActive) {
    recommendation =
      'In-proc scheduler is OFF. Set Q365_INPROC_REGEN=1 (or NODE_ENV=development) ' +
      'so the pipeline runs on a 10-min cadence and writes the heartbeat. ' +
      'Until then last_pipeline_run only advances when /api/signals fires its recovery trigger.';
    nextAction = 'enable_scheduler';
  } else if (recoveryFailed && !opts.lastPipelineRunIso) {
    recommendation =
      `Last recovery failed: ${autoScanState.lastError ?? 'unknown'}. ` +
      'Inspect auto_recovery.last_error and the [PIPELINE ERROR] console line for the failed stage.';
    nextAction = 'inspect_error';
  } else if (recoveryInFlight) {
    const elapsedSec = autoScanState.lastFiredAt != null
      ? Math.round((Date.now() - autoScanState.lastFiredAt) / 1000) : 0;
    recommendation =
      `Recovery is currently running (${elapsedSec}s elapsed). ` +
      'Phase 4 typically completes in 30-90s on a 503-symbol universe. ' +
      'Poll again in ~30s for the result, or hit ?bootstrap=true to await it on this request.';
    nextAction = 'wait_for_recovery';
  } else if (!opts.lastPipelineRunIso && !opts.bootstrapInvoked) {
    recommendation =
      'Scheduler is active but no pipeline run is on record yet. ' +
      'Hit /api/signals?action=all&bootstrap=true once for a synchronous run, ' +
      'or POST /api/run-signal-engine?sync=true.';
    nextAction = 'bootstrap';
  } else if (!opts.lastPipelineRunIso && opts.bootstrapInvoked) {
    recommendation =
      'Bootstrap finished without writing a heartbeat. Inspect auto_recovery.last_error / last_result to see whether candle warmup or Phase 4 failed.';
    nextAction = 'inspect_error';
  }
  // Reuse the breakerNow read above (used for the auth-priority
  // recommendation) so the response carries a consistent snapshot.
  return {
    scheduler_active:    schedActive,
    market_open:         opts.marketOpen,
    last_pipeline_run:   opts.lastPipelineRunIso,
    recommendation,
    next_action:         nextAction,
    bootstrap_endpoint:  '/api/signals?action=all&bootstrap=true',
    manual_run_endpoint: '/api/run-signal-engine?sync=true',
    indianapi_breaker: {
      open:               breakerNow.open,
      remaining_ms:       breakerNow.remainingMs,
      reopens_at:         breakerNow.until ? new Date(breakerNow.until).toISOString() : null,
      auth_failed:        breakerNow.auth_failed,
      auth_failed_for_ms: breakerNow.auth_failed_for_ms,
    },
  };
}

/**
 * Spec FIX-DATA-PIPELINE §5: auto-scan must fire when the signals
 * pool is empty OR the latest batch is stale (>10 min). Previously
 * the function was retired to a no-op, which left the dashboard
 * stuck on `validation_status: NO_SIGNALS_CONFIRMED` indefinitely
 * with no in-process recovery path.
 *
 * Reinstated with the original 5-minute throttle + an in-flight
 * guard so a busy poll loop can't fire the scanner more than once
 * per cooldown window. Cold-start mode forces the scan even if a
 * scan already ran today (the original throttle would otherwise
 * suppress the recovery on a fresh deployment).
 */
async function runAutoScanRecovery(reason: string): Promise<void> {
  const pipelineStartedAt = Date.now();
  // Spec — surface the IndianAPI breaker state at every recovery
  // entry so an operator grepping the console can see whether the
  // pipeline ran with or without live upstream access. Combined with
  // the [CANDLE] fallback log, this makes it explicit that the
  // pipeline RAN regardless of breaker state — running on stored
  // bars when the upstream is throttled.
  const breakerSnapshot = indianApiBreakerState();
  console.log(
    `[BREAKER STATUS] open=${breakerSnapshot.open} ` +
    `${breakerSnapshot.open ? `remaining_ms=${breakerSnapshot.remainingMs} reopens_at=${breakerSnapshot.until ? new Date(breakerSnapshot.until).toISOString() : 'n/a'}` : ''}`,
  );
  if (breakerSnapshot.open) {
    console.log(
      `[PIPELINE FORCED RUN] starting recovery despite breaker open — Phase 4 will run on stored market_data_daily bars (${reason})`,
    );
  } else {
    console.log(`[PIPELINE] starting reason="${reason}"`);
    console.log(`[PIPELINE START] reason="${reason}" started_at=${new Date(pipelineStartedAt).toISOString()}`);
  }
  autoScanState = {
    ...autoScanState,
    status:      'in_flight',
    stage:       'importing',
    lastFiredAt: pipelineStartedAt,
    lastReason:  reason,
    lastError:   null,
  };

  // Spec "FIX LOCK TIMING" — resolve the scannerState module BEFORE
  // setting any flag. If the dynamic import fails, the flag never
  // goes high, so a failed module load can't leave the global flag
  // stuck. Pulled OUT of the try/finally below: this section runs
  // before any lock is claimed, so there's nothing to release.
  let setInFlight:   (v: boolean) => void;
  let clearProgress: () => void;
  try {
    const mod = await import('@/lib/scanner/scannerState');
    setInFlight   = mod.setInFlight;
    clearProgress = mod.clearProgress;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Spec "FAIL FAST IF NO EXECUTION" — scannerState resolution is
    // the precondition for setting any lock. If it fails the recovery
    // never claims the flag, but we still want a loud, greppable
    // marker so the operator sees [PIPELINE FAILED TO START] paired
    // with the underlying [PIPELINE ERROR].
    console.error(`[PIPELINE FAILED TO START] reason="scannerState_import_failed: ${msg}"`);
    console.warn(`[PIPELINE ERROR] stage=scannerState_import reason=${msg}`);
    autoScanState = {
      ...autoScanState,
      status:          'failed',
      stage:           'failed',
      lastCompletedAt: Date.now(),
      lastError:       msg,
    };
    throw err;
  }

  // Spec "FIX PIPELINE NOT COMPLETING" §3 — per-stage try/catch so
  // the operator sees exactly which stage failed instead of one
  // generic "[AUTO-RECOVERY] failed" line. Each stage records its
  // status into `stageState` for the [PIPELINE] summary at the end.
  type StageStatus = 'pending' | 'completed' | 'failed' | 'skipped';
  const stageState: {
    importDeps: StageStatus;
    candleWarmup: StageStatus;
    phase4: StageStatus;
    heartbeat: StageStatus;
  } = {
    importDeps:   'pending',
    candleWarmup: 'pending',
    phase4:       'pending',
    heartbeat:    'pending',
  };
  let pipelineErr: Error | null = null;

  // Spec "GUARANTEE FINALLY EXECUTION" — setInFlight(true) lives
  // INSIDE the try block. Anything that throws between the flag set
  // and the work (or during the work) lands in the finally, which
  // unconditionally clears the flag + per-run budget + progress.
  try {
    setInFlight(true);
    // Spec "Per-run API call limit" — open a fresh per-run window
    // alongside the in-flight flag, paired with endPerRunBudget() in
    // the finally block below. Same lifecycle as run-signal-engine's
    // claimLock/releaseLock — both pipeline entry points share the
    // 500-call ceiling so a manual run + an auto-recovery on the
    // same day still get fair per-run budgets.
    beginPerRunBudget();
    console.log(`[API RUN] start limit=${INDIANAPI_PER_RUN_LIMIT} reason="${reason}"`);
    // Spec "FAIL FAST IF NO EXECUTION" — explicit "lock acquired,
    // about to import + run" trace tag. Pairs with [PIPELINE START]
    // above; if [API RUN] start fires but no [PIPELINE INVOKE] /
    // [PIPELINE END] follows, the body threw silently and the finally
    // released the flag.
    console.log(`[PIPELINE INVOKE] reason="${reason}"`);

    // Stage 1 — dynamic imports.
    const [
      { refreshDailyCandles },
      { DEFAULT_PHASE1_CONFIG, loadTradeableUniverse },
      { generatePhase4Signals, DEFAULT_PHASE3_CONFIG },
      { db: dbModule },
      { markPipelineHeartbeat },
    ] = await Promise.all([
      import('@/lib/marketData/candleIngest'),
      import('@/lib/signal-engine/constants/signalEngine.constants'),
      import('@/lib/signal-engine'),
      import('@/lib/db'),
      import('@/lib/marketData/providers/batchScheduler'),
    ]);
    stageState.importDeps = 'completed';

    await loadTradeableUniverse();
    // Cap the warm-up universe so the recovery completes in bounded
    // time. The full regen tick (in bootInProc) handles the rest of
    // the universe on its 10-min cadence.
    //
    // Spec INSTITUTIONAL §C (calibrated 2026-05) — recovery scans the
    // FULL universe by default, mirroring the manual /api/run-signal-engine
    // route. The legacy 50-symbol cap dates from a cold-cache era when
    // IndianAPI was the only provider and the candle warmup took >30min
    // for 500 symbols. With the market-aware candle scheduler now
    // keeping the universe warm continuously, the recovery's slice
    // doesn't need to be different from the manual run.
    //
    // Env precedence:
    //   1. SIGNAL_RECOVERY_UNIVERSE_CAP=<n>  → explicit override (legacy)
    //   2. SIGNAL_FULL_UNIVERSE_SCAN=false   → fall back to historical 50 cap
    //   3. (default)                          → full universe
    const fullScanForRecovery = (() => {
      const raw = (process.env.SIGNAL_FULL_UNIVERSE_SCAN ?? 'true').trim().toLowerCase();
      return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on';
    })();
    const RECOVERY_UNIVERSE_CAP = (() => {
      const raw = Number(process.env.SIGNAL_RECOVERY_UNIVERSE_CAP);
      if (Number.isFinite(raw) && raw >= 1) {
        return Math.min(1000, Math.floor(raw));
      }
      return fullScanForRecovery ? DEFAULT_PHASE1_CONFIG.universe.length : 50;
    })();
    const recoveryUniverse = DEFAULT_PHASE1_CONFIG.universe.slice(0, RECOVERY_UNIVERSE_CAP);
    console.log(
      `[AUTO-RECOVERY] universe sizing: full_scan=${fullScanForRecovery} ` +
      `cap=${RECOVERY_UNIVERSE_CAP} ` +
      `default_universe=${DEFAULT_PHASE1_CONFIG.universe.length} ` +
      `recovery_slice=${recoveryUniverse.length}`,
    );
    // Single-grep carve-point trace. When `out` < expected, the
    // bottleneck is either DEFAULT_PHASE1_CONFIG.universe.length (DB
    // state — q365_universe(is_active=1) row count) or RECOVERY_CAP.
    console.log('[UNIVERSE_CARVE]', {
      stage:    'auto_recovery_slice',
      in:       DEFAULT_PHASE1_CONFIG.universe.length,
      out:      recoveryUniverse.length,
      cap:      RECOVERY_UNIVERSE_CAP,
      full_scan: fullScanForRecovery,
    });

    // Stage 2 — candle warmup.
    //
    // Spec "FIX 429" — when stored bars in market_data_daily are
    // already fresh enough for Phase 4, SKIP the IndianAPI fan-out
    // entirely. This is the load-bearing fix for the dev-plan 429
    // storm: hammering /historical_data with `force: true` for 50
    // symbols when each call already 429s burns 3-10s per symbol on
    // pointless retries. With 80%+ of bars already <12h old, the
    // refresh contributes nothing — the candle ingest fallback would
    // use the stored bars anyway. SIGNAL_RECOVERY_CANDLE_REFRESH_SKIP_HOURS
    // controls the threshold (default 12h, set to 0 to always refresh).
    const skipFreshHours = (() => {
      const raw = Number(process.env.SIGNAL_RECOVERY_CANDLE_REFRESH_SKIP_HOURS);
      return Number.isFinite(raw) && raw >= 0 ? raw : 12;
    })();
    let skipCandleWarmup = false;
    if (skipFreshHours > 0) {
      try {
        const { rows: ageRows } = await dbModule.query<{ fresh: number; total: number }>(
          `SELECT
             SUM(CASE WHEN latest_ts IS NOT NULL
                       AND TIMESTAMPDIFF(HOUR, latest_ts, NOW()) <= ?
                  THEN 1 ELSE 0 END) AS fresh,
             COUNT(*) AS total
           FROM (
             SELECT MAX(ts) AS latest_ts FROM market_data_daily
              WHERE symbol IN (${recoveryUniverse.map(() => '?').join(',')})
              GROUP BY symbol
           ) t`,
          [skipFreshHours, ...recoveryUniverse],
        );
        const ageRow = (ageRows[0] as any) ?? { fresh: 0, total: 0 };
        const fresh = Number(ageRow.fresh) || 0;
        const total = Number(ageRow.total) || 0;
        const freshPct = total > 0 ? Math.round((fresh / total) * 100) : 0;
        if (total > 0 && freshPct >= 80) {
          skipCandleWarmup = true;
          console.log(
            `[AUTO-RECOVERY] candle warmup SKIPPED — ${fresh}/${total} (${freshPct}%) symbols have bars ≤${skipFreshHours}h old; using stored bars`,
          );
        } else {
          console.log(
            `[AUTO-RECOVERY] candle warmup needed — only ${fresh}/${total} (${freshPct}%) symbols have bars ≤${skipFreshHours}h old`,
          );
        }
      } catch (err) {
        console.warn(
          `[AUTO-RECOVERY] freshness probe failed (${(err as Error)?.message ?? 'unknown'}) — proceeding with refresh`,
        );
      }
    }

    // Spec "FIX CANDLE WARMUP HANG" — refreshDailyCandles fan-outs to
    // IndianAPI per-symbol with `force: true`. When the upstream is
    // 429-throttled / unauthenticated / network-flaky, each call's
    // retry-backoff stretches the wall-clock to 5-15 minutes for 50
    // symbols. During that time autoScanState.stage stays frozen at
    // 'candle_warmup', last_pipeline_run never advances (heartbeat is
    // stage 4), and the API surfaces {validation_status:
    // NO_SIGNALS_CONFIRMED, auto_recovery.stage: candle_warmup}
    // forever. Cap with a hard wall-clock timeout — on timeout we
    // DO NOT throw: Phase 4 runs against whatever stored bars exist
    // (its candle fallback chain is built for exactly this case).
    type CandleWarmupResult = {
      refreshed:    number;
      barsIngested: number;
      failed:       { symbol: string; reason: string }[];
    };
    let cr: CandleWarmupResult = { refreshed: 0, barsIngested: 0, failed: [] };
    autoScanState = { ...autoScanState, stage: 'candle_warmup' };
    if (skipCandleWarmup) {
      stageState.candleWarmup = 'skipped';
    } else {
      const CANDLE_WARMUP_TIMEOUT_MS: number = (() => {
        const raw = Number(process.env.SIGNAL_RECOVERY_CANDLE_TIMEOUT_MS);
        if (Number.isFinite(raw) && raw >= 5_000) return Math.floor(raw);
        return 30_000;  // 30s — pipeline MUST never get stuck in candle_warmup; fall through to Phase 4 fast
      })();
      const warmupStart = Date.now();
      console.log('[AUTO-RECOVERY] Candle warmup start');
      console.log(
        `[AUTO-RECOVERY] candle warmup → ${recoveryUniverse.length} symbols ` +
        `(timeout=${CANDLE_WARMUP_TIMEOUT_MS}ms)`,
      );

      // Symbol sentinel makes the race winner unambiguously typed —
      // no `any`, no cast. CandleWarmupResult and `unique symbol` are
      // disjoint, so `winner === TIMEOUT_SENTINEL` discriminates the
      // union with TS narrowing.
      const TIMEOUT_SENTINEL: unique symbol = Symbol('candle_warmup_timeout') as never;
      let timeoutHandle: NodeJS.Timeout | null = null;
      const timeoutPromise: Promise<typeof TIMEOUT_SENTINEL> =
        new Promise((resolve) => {
          timeoutHandle = setTimeout(
            () => resolve(TIMEOUT_SENTINEL),
            CANDLE_WARMUP_TIMEOUT_MS,
          );
        });

      const refreshPromise: Promise<CandleWarmupResult> = refreshDailyCandles({
        symbols: recoveryUniverse,
        force:   true,
        noCap:   true,
      });

      try {
        const winner: CandleWarmupResult | typeof TIMEOUT_SENTINEL =
          await Promise.race([refreshPromise, timeoutPromise]);
        if (winner === TIMEOUT_SENTINEL) {
          stageState.candleWarmup = 'failed';
          console.warn('[AUTO-RECOVERY] Candle warmup TIMEOUT');
          console.warn(
            `[AUTO-RECOVERY] candle warmup timed out after ${Date.now() - warmupStart}ms ` +
            `(limit=${CANDLE_WARMUP_TIMEOUT_MS}ms) — Phase 4 will run on stored ` +
            `market_data_daily bars; the refresh continues in the background.`,
          );
          // Attach AFTER the race resolved, so the pending refresh's
          // eventual rejection (if any) is captured instead of bubbling
          // as an unhandled rejection. This prevents the memory leak /
          // node:warning that comes from orphaned rejecting promises.
          refreshPromise
            .then((late: CandleWarmupResult) => {
              console.log(
                `[AUTO-RECOVERY] background candle warmup eventually completed: ` +
                `refreshed=${late.refreshed} bars=${late.barsIngested} failed=${late.failed.length}`,
              );
            })
            .catch((err: unknown) => {
              const m = err instanceof Error ? err.message : String(err);
              console.warn(`[AUTO-RECOVERY] background candle warmup eventually failed: ${m}`);
            });
        } else {
          cr = winner;
          console.log(
            `[AUTO-RECOVERY] candle warmup done: refreshed=${cr.refreshed} ` +
            `bars=${cr.barsIngested} failed=${cr.failed.length} ` +
            `elapsed=${Date.now() - warmupStart}ms`,
          );
          stageState.candleWarmup = 'completed';
        }
      } catch (err: unknown) {
        // refreshPromise rejected before the timeout fired. Same
        // degraded-mode policy as the timeout path: do NOT rethrow;
        // Phase 4 runs against stored bars.
        stageState.candleWarmup = 'failed';
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[PIPELINE ERROR] stage=candle_warmup reason=${msg} ` +
          `elapsed=${Date.now() - warmupStart}ms`,
        );
        console.warn(`[AUTO-RECOVERY] candle warmup failed (${msg})`);
      } finally {
        // Always clear the timer — covers the success path (timer
        // still pending), the timeout path (already fired, clearTimeout
        // is a no-op but cheap), and the throw path (timer leaks
        // otherwise). Single source of truth = no missed branch.
        if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      }

      if (stageState.candleWarmup === 'failed') {
        console.log('[AUTO-RECOVERY] Proceeding to Phase 4');
      }
    }

    // Stage 3 — Phase 4.
    // Spec "FIX CANDLE FETCH LOGIC" — auto-recovery uses the same
    // unified fallback chain as /api/run-signal-engine: DB-fast →
    // IndianAPI live → NSE direct → DB-thin → throw. Without this
    // the auto-recovery's DB-only provider would silently produce
    // zero candles whenever market_data_daily lagged a refresh, even
    // though the manual route had a working fallback.
    autoScanState = { ...autoScanState, stage: 'phase4' };
    const { fetchDailyCandlesWithFallback: fetchCandlesChain } =
      await import('@/lib/marketData/candleFallbackChain');
    const candleProvider = {
      async fetchDailyCandles(symbol: string) {
        const result = await fetchCandlesChain(symbol);
        return result.candles;
      },
    };
    const portfolio = {
      capital:        DEFAULT_PHASE3_CONFIG.defaultCapital,
      cashAvailable:  DEFAULT_PHASE3_CONFIG.defaultCapital,
      openPositions:  [],
      pendingSignals: [],
    };
    // Spec "PIPELINE MUST ALWAYS COMPLETE" — Phase 4 failure must NOT
    // prevent the heartbeat. A thrown Phase 4 leaves the operator with
    // `last_pipeline_run: null` and no signal trail of what happened.
    // Degrade to a zero-envelope and continue so:
    //  • markPipelineHeartbeat fires (last_pipeline_run advances)
    //  • autoScanState.lastResult records the failure with totals
    //  • the route returns a coherent summary instead of 500-ing
    type Phase4Lite = {
      meta:    { scanned: number; approved: number; deferred: number; rejected: number };
      signals: { length: number };
    };
    let result: Phase4Lite;
    console.log(`[SCAN START] universe=${recoveryUniverse.length} source=auto-recovery:indianapi`);
    // Spec "FIX UNIVERSE BLOWUP" — Phase 4 was previously called with
    // p1Config=undefined, which falls back to DEFAULT_PHASE1_CONFIG
    // (the FULL ~500-symbol universe) regardless of the 50-symbol
    // recovery cap. Combined with IndianAPI's slow per-call latency
    // (45s+ on the dev plan), this made auto-recovery runs effectively
    // never complete: the candle warmup timed out after 30s, then
    // Phase 3's prefetch tried to fetch 500 symbols' worth of candles
    // serially through the rate limiter, which took >30 minutes.
    //
    // Pass a Phase-1 config whose `universe` IS the recovery slice so
    // Phase 3's per-symbol loop matches the warmup scope.
    const phase1ConfigForRecovery = {
      ...DEFAULT_PHASE1_CONFIG,
      universe: recoveryUniverse,
    };
    console.log(
      `[DEBUG] symbols length: recovery=${recoveryUniverse.length} ` +
      `default_universe=${DEFAULT_PHASE1_CONFIG.universe.length} ` +
      `(Phase 4 scoped to recovery universe)`,
    );
    const scanStart = Date.now();
    try {
      result = await generatePhase4Signals(
        candleProvider, portfolio,
        undefined, undefined,
        phase1ConfigForRecovery,
        undefined,
        { generationSource: 'auto-recovery:indianapi' },
      );
      console.log(
        `[AUTO-RECOVERY] Phase4 done: scanned=${result.meta.scanned} ` +
        `approved=${result.signals.length} rejected=${result.meta.rejected}`,
      );
      stageState.phase4 = 'completed';
    } catch (err: unknown) {
      stageState.phase4 = 'failed';
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[PIPELINE ERROR] stage=phase4 reason=${msg}`);
      console.warn('[AUTO-RECOVERY] Phase 4 failed — continuing to heartbeat with empty result');
      pipelineErr = err instanceof Error ? err : new Error(msg);
      result = {
        meta:    { scanned: 0, approved: 0, deferred: 0, rejected: 0 },
        signals: { length: 0 },
      };
    }
    console.log(
      `[SCAN COMPLETE] scanned=${result.meta.scanned} ` +
      `persisted=${result.signals.length} ` +
      `rejected=${result.meta.rejected} ` +
      `elapsed_ms=${Date.now() - scanStart} ` +
      `phase4=${stageState.phase4}`,
    );

    // Spec "FIX BATCH_ID PERSISTENCE BUG" §2 — auto-recovery path now
    // stamps a per-run batch_id on its inserted rows so the freshness
    // probe (`probeScannerBatch`, `WHERE batch_id IS NOT NULL`) finds
    // them. Previously the only path that wrote batch_id was the
    // manual /api/run-signal-engine route; auto-recovery rows always
    // stayed null → `latest_batch_id: null` even after a successful
    // recovery. Stamping with the recovery's pipelineStartedAt keeps
    // the id unique per run AND sortable lexicographically alongside
    // the manual route's `batch_${epoch}` ids.
    const autoBatchId = `auto-recovery_${pipelineStartedAt}`;
    try {
      const stamp = await dbModule.query(
        `UPDATE q365_signals
            SET batch_id = ?
          WHERE generation_source = 'auto-recovery:indianapi'
            AND batch_id IS NULL
            AND created_at >= FROM_UNIXTIME(?)`,
        [autoBatchId, Math.floor(pipelineStartedAt / 1000)],
      );
      const affected = (stamp as any)?.affectedRows ?? '?';
      console.log(`[AUTO-RECOVERY] batch_id stamped — id=${autoBatchId} affected=${affected}`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AUTO-RECOVERY] batch_id stamp failed (non-fatal): ${msg}`);
    }

    // Stage 4 — heartbeat. Spec "FIX PIPELINE NOT COMPLETING" §2:
    // last_pipeline_run MUST update even when Phase 4 produced 0
    // signals — the pipeline DID complete, just with 0 approved.
    // markPipelineHeartbeat writes the Redis key the freshness
    // probe reads, so the dashboard sees a non-null timestamp.
    autoScanState = { ...autoScanState, stage: 'heartbeat' };
    try {
      await markPipelineHeartbeat('auto-recovery:indianapi');
      stageState.heartbeat = 'completed';
      console.log('[PIPELINE] Heartbeat updated');
    } catch (err: unknown) {
      // Heartbeat write failures are non-fatal (Redis unavailable etc).
      // The pipeline still completed; we just couldn't stamp it.
      stageState.heartbeat = 'failed';
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[PIPELINE WARN] stage=heartbeat reason=${msg} (non-fatal)`);
    }

    // Spec "PIPELINE MUST ALWAYS COMPLETE" — when Phase 4 degraded,
    // pipelineErr is set but we still wrote the heartbeat above. Mark
    // status='completed_degraded' (not 'failed') so the dashboard
    // distinguishes "pipeline never finished" from "pipeline finished
    // with a degraded inner stage". lastResult always carries the totals
    // (zeroed when Phase 4 degraded) so /api/signals can report
    // total_scanned / total_persisted instead of null.
    const degraded = pipelineErr !== null;
    autoScanState = {
      ...autoScanState,
      status:          degraded ? 'failed' : 'completed',
      stage:           degraded ? 'failed' : 'completed',
      lastCompletedAt: Date.now(),
      lastError:       degraded ? (pipelineErr?.message ?? null) : null,
      lastResult: {
        candleRefreshed: cr.refreshed,
        candleBars:      cr.barsIngested,
        candleFailed:    cr.failed.length,
        phase4Scanned:   result.meta.scanned,
        phase4Approved:  result.signals.length,
        phase4Rejected:  result.meta.rejected,
      },
    };

    const elapsedMs = Date.now() - pipelineStartedAt;
    console.log(
      `[PIPELINE] ${degraded ? 'completed DEGRADED' : 'completed successfully'} elapsed_ms=${elapsedMs} ` +
      `candle_refreshed=${cr.refreshed} candle_bars=${cr.barsIngested} ` +
      `phase4_scanned=${result.meta.scanned} phase4_approved=${result.signals.length} ` +
      `phase4_rejected=${result.meta.rejected} heartbeat=${stageState.heartbeat}`,
    );
    console.log(
      `[PIPELINE END] status=${degraded ? 'degraded' : 'success'} elapsed_ms=${elapsedMs} ` +
      `scanned=${result.meta.scanned} approved=${result.signals.length} ` +
      `rejected=${result.meta.rejected} heartbeat=${stageState.heartbeat}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!pipelineErr) {
      console.warn(`[PIPELINE ERROR] stage=imports reason=${msg}`);
      pipelineErr = err instanceof Error ? err : new Error(msg);
    }
    console.warn('[AUTO-RECOVERY] failed:', msg);
    autoScanState = {
      ...autoScanState,
      status:          'failed',
      stage:           'failed',
      lastCompletedAt: Date.now(),
      lastError:       msg,
    };
    const elapsedMs = Date.now() - pipelineStartedAt;
    console.warn(
      `[PIPELINE] FAILED elapsed_ms=${elapsedMs} ` +
      `imports=${stageState.importDeps} candle=${stageState.candleWarmup} ` +
      `phase4=${stageState.phase4} heartbeat=${stageState.heartbeat} ` +
      `reason="${msg}"`,
    );
    console.warn(`[PIPELINE END] status=failed elapsed_ms=${elapsedMs} reason="${msg}"`);
    throw err;
  } finally {
    // Spec "GUARANTEE FINALLY EXECUTION" — flag + progress + per-run
    // budget all reset unconditionally. Wrapped individually so any
    // one of them throwing can never block the others.
    try { setInFlight(false); }   catch { /* swallow */ }
    try { clearProgress(); }      catch { /* swallow */ }
    try {
      const s = endPerRunBudget();
      console.log(
        `[API RUN] end count=${s.count}/${s.limit} hit=${s.hit} ` +
        `duration_ms=${s.durationMs} reason="${reason}"`,
      );
    } catch { /* swallow — must never block flag release */ }
  }
}

async function triggerAutoScanIfEmpty(
  reason: string,
  opts: { coldStart?: boolean; awaitCompletion?: boolean } = {},
): Promise<void> {
  const now = Date.now();

  // Spec "OPTIMIZE API USAGE" §5 — refuse to fire a fresh recovery
  // when the daily IndianAPI budget is already exhausted. A
  // recovery does ~50 candle calls + ~503 Phase-4 quotes; firing it
  // when we're at the limit either fails-fast inside the adapter
  // (every call throws API_BUDGET_EXCEEDED) or, worse, hammers
  // upstream until the breaker trips. Better to mark the trigger as
  // skipped and let the operator see the budget state.
  const usage = getApiUsage();
  if (usage.daily_exceeded || usage.monthly_exceeded) {
    const which = usage.daily_exceeded ? 'daily' : 'monthly';
    const used  = usage.daily_exceeded ? usage.daily : usage.monthly;
    const cap   = usage.daily_exceeded ? usage.daily_limit : usage.monthly_limit;
    console.warn(
      `[PIPELINE BLOCKED] api_budget_exhausted bucket=${which} ` +
      `used=${used}/${cap} reason="${reason}"`,
    );
    autoScanState = {
      ...autoScanState,
      status:     autoScanState.status === 'in_flight' ? autoScanState.status : 'failed',
      lastReason: reason,
      lastError:  `API budget exhausted (${which}: ${used}/${cap}). New scans refused until ` +
                  (which === 'daily' ? 'midnight IST.' : 'next month.'),
    };
    return;
  }

  // Spec "FIX FINAL SIGNAL VISIBILITY" §1 — restructured ordering.
  //
  // The route fires this trigger up to 3 times per request (snapshots
  // empty / pipeline_run null / stale batch). The previous ordering —
  //
  //   1. claim (lastAutoScanAtMs=now, status='in_flight', lastFiredAt=now)
  //   2. await import
  //   3. check isInFlight
  //   4. on isInFlight=true → 'skipped_inflight'
  //
  // — had two bugs:
  //
  //   (a) trigger #2 in the same request rewrote `lastFiredAt` to `now`
  //       BEFORE the watchdog ran, so the watchdog's `inflightAge` was
  //       always ~0ms and could never force-clear a wedged recovery.
  //   (b) trigger #2 then overwrote the genuine `status='in_flight'`
  //       set by the running recovery to `'skipped_inflight'`, so the
  //       /api/signals response lied about what the engine was doing.
  //
  // New ordering:
  //
  //   1. dynamic-import the scanner state module (cheap after first call)
  //   2. if isInFlight → watchdog: stale → force-clear & fall through;
  //                               not stale → DON'T touch autoScanState
  //                               beyond `lastReason`, just return
  //   3. cooldown gate
  //   4. claim (status='in_flight', stage='importing', lastFiredAt=now)
  //   5. dispatch runAutoScanRecovery
  //
  // Safety: step 1's import is the only await before the in-flight
  // check, so two concurrent triggers can both pass the (a) check —
  // but only the FIRST one reaches the claim block (step 4) and starts
  // a recovery; the second sees `isInFlight()=true` and exits cleanly.
  let isInFlight: () => boolean;
  let getProgress: () => ReturnType<typeof getScannerProgress>;
  let getInFlightStartedAt: () => number | null;
  let getInFlightElapsedMs: () => number | null;
  let isInFlightStale: () => boolean;
  let isInFlightStaleByNoProgress: () => boolean;
  let forceClearInFlight: (reason: string, tag?: 'RESET' | 'FORCE RESET') => void;
  try {
    const mod = await import('@/lib/scanner/scannerState');
    isInFlight                  = mod.isInFlight;
    getProgress                 = mod.getProgress;
    getInFlightStartedAt        = mod.getInFlightStartedAt;
    getInFlightElapsedMs        = mod.getInFlightElapsedMs;
    isInFlightStale             = mod.isInFlightStale;
    isInFlightStaleByNoProgress = mod.isInFlightStaleByNoProgress;
    forceClearInFlight          = mod.forceClearInFlight;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[AUTO-RECOVERY] could not load scannerState:', msg);
    autoScanState = {
      ...autoScanState,
      status:          'failed',
      stage:           'failed',
      lastCompletedAt: Date.now(),
      lastError:       msg,
      lastReason:      reason,
    };
    return;
  }
  if (isInFlight()) {
    // Spec STEP 1 — authoritative stale watchdog driven by the
    // scannerState timestamp (not autoScanState — that field is wrong
    // when a manual /api/run-signal-engine run is in flight). Default
    // 30 s via PIPELINE_STALE_INFLIGHT_MS in scannerState.ts. The
    // no-progress watchdog runs first with the same 30 s threshold —
    // it fires only when Phase 1 never ticked, which is the exact
    // "lock acquired but execution never started" symptom.
    const elapsedMs   = getInFlightElapsedMs();
    const startedAtMs = getInFlightStartedAt();
    const progress    = getProgress();
    if (isInFlightStaleByNoProgress()) {
      console.warn(
        `[PIPELINE FORCE RESET] no-progress watchdog — elapsed_ms=${elapsedMs ?? 'n/a'} ` +
        `threshold_ms=30000 (lock held but Phase 1 produced no progress)`,
      );
      forceClearInFlight('auto_recovery_no_progress_watchdog', 'FORCE RESET');
      autoScanState = {
        ...autoScanState,
        status:          'failed',
        stage:           'failed',
        lastCompletedAt: now,
        lastError:       'no-progress watchdog cleared a stuck lock',
      };
      // Fall through to the cooldown / claim path.
    } else if (isInFlightStale()) {
      forceClearInFlight('auto_recovery_watchdog');
      // Mark the wedged run as failed so the cold-start cooldown
      // bypass kicks in below (status==='failed' branch).
      autoScanState = {
        ...autoScanState,
        status:          'failed',
        stage:           'failed',
        lastCompletedAt: now,
        lastError:       'stale in-flight watchdog cleared',
      };
      // Fall through to the cooldown / claim path.
    } else {
      // Genuine recovery is running. Don't touch autoScanState.status
      // (it should remain 'in_flight'). Refresh `lastReason` so the
      // dashboard surfaces the most recent reason a poll asked for a
      // fresh scan, but leave `lastFiredAt`, `stage`, and `status`
      // alone so subsequent watchdog computations stay accurate.
      const progressTag = progress
        ? ` scanned=${progress.done}/${progress.total} last_symbol=${progress.lastSymbol ?? 'n/a'}`
        : ` stage=${autoScanState.stage}`;
      // Spec STEP 5 — structured BLOCKED log with the canonical
      // startedAt / elapsed fields the operator can grep for.
      console.log(
        `[PIPELINE BLOCKED] inFlight=true ` +
        `startedAt=${startedAtMs ? new Date(startedAtMs).toISOString() : 'n/a'} ` +
        `elapsed=${elapsedMs ?? 'n/a'}ms ` +
        `reason="${reason}"${progressTag}`,
      );
      autoScanState = {
        ...autoScanState,
        // Preserve status / stage / lastFiredAt — the running recovery
        // owns those fields. Only `lastReason` is updated so operators
        // can see why the latest poll wanted a fresh scan.
        lastReason: reason,
      };
      return;
    }
  }

  // ── Cooldown gate ────────────────────────────────────────────────
  //
  // Pick the right cooldown band: cold-start gets 60s so a fresh deploy
  // recovers fast, steady-state gets 5min so we don't hammer the scanner.
  // Either way the cooldown is RESPECTED — bypass-on-cold-start (the
  // previous behaviour) made the dashboard fire scans every 5s.
  const cooldown = opts.coldStart
    ? AUTO_SCAN_COLDSTART_MIN_MS
    : AUTO_SCAN_COOLDOWN_MS;
  // ── Cold-start cooldown bypass ───────────────────────────────────
  //
  // Spec — when the caller requested a cold-start trigger AND no
  // recovery has SUCCEEDED yet (process boot OR every prior attempt
  // ended in 'failed' status), skip the cooldown gate so a failed
  // pipeline run can be retried on the next poll without waiting
  // the 60s cold-start cooldown.
  //
  // The bypass auto-disengages once a recovery completes successfully
  // (status='completed', lastCompletedAt set). After that, the
  // standard cooldown applies.
  const noSuccessYet =
    autoScanState.lastCompletedAt === null
    || autoScanState.status === 'failed';
  const bypassCooldown =
    (opts.coldStart === true && noSuccessYet)
    || opts.awaitCompletion === true;
  if (bypassCooldown) {
    const reasonTag =
      lastAutoScanAtMs === 0  ? 'first-ever cold-start' :
      autoScanState.status === 'failed' ? 'retry-after-failure' :
      'cold-start';
    console.log(`[AUTO-RECOVERY] bypassing cooldown (${reasonTag}) — ${reason}`);
  }
  if (!bypassCooldown && now - lastAutoScanAtMs < cooldown) {
    const cooldownRemainingMs = Math.max(0, cooldown - (now - lastAutoScanAtMs));
    console.log(
      `[AUTO-RECOVERY] cooldown active (${Math.round(cooldownRemainingMs / 1000)}s remaining) — skipping trigger (${reason})`,
    );
    // Preserve any in-flight / completed / failed status the prior
    // trigger established so a 3rd-trigger overwrite can't mask the
    // genuine pipeline state.
    const preserveStatus =
      autoScanState.status === 'in_flight'
      || autoScanState.status === 'completed'
      || autoScanState.status === 'failed';
    autoScanState = {
      ...autoScanState,
      status:     preserveStatus ? autoScanState.status : 'skipped_cooldown',
      lastReason: reason,
    };
    return;
  }

  // ── Claim ───────────────────────────────────────────────────────
  // We've cleared the in-flight check (no recovery running) AND the
  // cooldown. Safe to claim the slot and dispatch the recovery body.
  lastAutoScanAtMs = now;
  autoScanState = {
    ...autoScanState,
    status:      'in_flight',
    stage:       'importing',
    lastFiredAt: now,
    lastReason:  reason,
    lastError:   null,
  };
  console.log(`[AUTO-RECOVERY] triggering IndianAPI-backed recovery (${reason})`);

  // Fire-and-forget by default — the dashboard polls every few
  // seconds and a 30-60s synchronous wait would stall every poll
  // until the recovery completes. When `awaitCompletion=true` (the
  // ?bootstrap=true query path) we await so the operator's single
  // request returns AFTER the recovery has produced rows.
  if (opts.awaitCompletion) {
    try {
      await runAutoScanRecovery(reason);
    } catch { /* state already records the failure */ }
    return;
  }
  void runAutoScanRecovery(reason).catch(() => { /* state already records the failure */ });
}

// Staleness threshold for the latest batch. Above this, the route's
// fallback path treats the data as too old to surface and triggers a
// fresh scan instead of shipping rows from a 5-hour-old batch (the
// `signal_age_minutes = 300+` symptom). 10 min matches the regen cron
// cadence — every scan tick that's overdue triggers an auto-recovery.
const STALE_BATCH_THRESHOLD_MS = 10 * 60_000;
// Hard ceiling above which q365_signals fallback rows are NEVER
// surfaced — the operator gets an honest empty state instead of a
// table full of stale prices that no longer reflect the live tape.
// Picked at 30 min so a regen cron that's running on a 10-min cadence
// gets a 3-tick grace window before fallback rows are blocked. Above
// this, the route ships zero rows + triggers an auto-scan.
const FALLBACK_MAX_AGE_MS = 30 * 60_000;

// Stamps the runtime identity once per process so two environments
// running the "same commit" but different MySQL hosts / universe files
// surface the divergence in their first log line instead of looking
// identical until the data diverges. Idempotent across module reloads
// in dev (HMR re-imports this module).
let __envStampLogged = false;
function logEnvStampOnce(): void {
  if (__envStampLogged) return;
  __envStampLogged = true;
  // Spec "FIX 403" §2 + §8 — surface IndianAPI key load status at
  // startup. Reveals only LENGTH and the first 5 chars (the prefix
  // sk-live-* is documented in their public examples) so an operator
  // can tell at a glance whether (a) the key is loaded at all, (b)
  // it's been truncated by a bad env edit. Never logs the full secret.
  const apiKeyRaw = (
    process.env.INDIANAPI_API_KEY?.trim()
    || process.env.INDIANAPI_KEY?.trim()
    || process.env.INDIAN_API_KEY?.trim()
    || ''
  );
  const apiKeyLoaded = apiKeyRaw.length > 0;
  // Empirically, valid IndianAPI live keys are ~48 chars. Below 30 is
  // almost certainly truncated.
  const apiKeyLikelyTruncated = apiKeyLoaded && apiKeyRaw.length < 30;
  if (!apiKeyLoaded) {
    console.error(
      '[ENV STAMP] INDIANAPI_API_KEY is NOT loaded. Every IndianAPI call will throw "key not configured". ' +
      'Add INDIANAPI_API_KEY=<key> to .env.local and restart.',
    );
  } else if (apiKeyLikelyTruncated) {
    console.error(
      `[ENV STAMP] INDIANAPI_API_KEY is loaded but only ${apiKeyRaw.length} chars long — likely TRUNCATED ` +
      `(valid live keys are typically 48 chars). Re-paste the full key in .env.local and restart.`,
    );
  }
  console.log('[ENV STAMP]', {
    NODE_ENV:              process.env.NODE_ENV ?? 'unknown',
    MYSQL_HOST:            process.env.MYSQL_HOST ?? 'unset',
    MYSQL_DATABASE:        process.env.MYSQL_DATABASE ?? 'unset',
    KITE_ONLY:             process.env.KITE_ONLY ?? 'unset',
    REDIS_DISABLED:        process.env.REDIS_DISABLED ?? 'unset',
    CUSTOM_UNIVERSE_PATH:  process.env.CUSTOM_UNIVERSE_PATH ?? 'unset',
    Q365_INPROC_SCHEDULER: process.env.Q365_INPROC_SCHEDULER ?? 'unset',
    Q365_INPROC_REGEN:     process.env.Q365_INPROC_REGEN ?? 'unset',
    Q365_REGEN_24X7:       process.env.Q365_REGEN_24X7 ?? 'unset',
    ENABLE_MANIPULATION_JOIN: process.env.ENABLE_MANIPULATION_JOIN ?? 'unset',
    SIGNALS_TARGET_CAP:    process.env.SIGNALS_TARGET_CAP ?? 'unset',
    SIGNALS_MAX_LIMIT:     process.env.SIGNALS_MAX_LIMIT ?? 'unset',
    INDIANAPI_API_KEY_LOADED:    apiKeyLoaded,
    INDIANAPI_API_KEY_LENGTH:    apiKeyRaw.length,
    INDIANAPI_API_KEY_PREFIX:    apiKeyLoaded ? apiKeyRaw.slice(0, 5) + '…' : 'unset',
    INDIANAPI_API_KEY_TRUNCATED: apiKeyLikelyTruncated,
  });
}

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  // Spec STEP 2 — universe init guard. Idempotent + race-safe via
  // the shared promise lock in initOnce(). On a cold instrumentation
  // boot (or if instrumentation's universe load failed transiently)
  // this runs the DB load once before the request reads from the
  // sync getters; on every subsequent request it's a single-property
  // check. A clean 503 beats a 500 with NIFTY500_UNIVERSE_NOT_INITIALIZED
  // in the body.
  const universeReady = await ensureUniverseReady();
  if (!universeReady.ok) {
    return NextResponse.json(
      {
        error:  'Universe not ready',
        code:   'UNIVERSE_NOT_READY',
        detail: universeReady.error,
      },
      { status: 503 },
    );
  }

  // Spec DISTRIBUTED-ROTATION-2026-05 — pull peer rotation state into
  // local cooldownState before the response is assembled. Throttled
  // internally to once per sync interval so the per-request cost is
  // bounded. No-op when REDIS_DISABLED=1 or DISTRIBUTED_ROTATION=0;
  // best-effort otherwise (Redis outage leaves local state intact).
  await pullRotationStateFromRedis().catch(() => undefined);

  logEnvStampOnce();

  const { searchParams } = req.nextUrl;
  const action       = searchParams.get('action') || 'top';
  const symParam     = searchParams.get('symbol')?.trim().replace(/\s+/g, '') || null;
  const keyParam     = searchParams.get('key')?.trim().replace(/\s+/g, '') || null;
  // Hard cap on display limit. The dashboard never asks for more than
  // 50; the legacy 10,000 ceiling let a stray client (or someone poking
  // the URL) trigger a fetch of 40,000+ rows from q365_signals via
  // getActiveSignals (which uses limit*4 internally with its own 40,000
  // cap). That's the worst-case path that produced the 504 Gateway
  // Timeouts. 1000 is plenty for any real consumer; keep the env-var
  // escape hatch for one-off admin tools.
  const HARD_LIMIT_CAP = Math.max(50, Math.min(5000, Number(process.env.SIGNALS_MAX_LIMIT) || 1000));
  const limit        = Math.min(parseInt(searchParams.get('limit') || '20'), HARD_LIMIT_CAP);
  const forceRefresh = searchParams.get('forceRefresh') === 'true';
  // `noCache=true` skips the SWR layer for the freshness probes — used
  // by the Run-Pipeline polling loop in /signals to detect a freshly-
  // landed batch_id within 1-2s instead of waiting up to 10s for the
  // SWR cache TTL to expire.
  const noCache      = searchParams.get('noCache') === 'true';
  // `lite=true` strips each signal to the operator-essential fields
  // (symbol, entry_price, stop_loss, target, confidence, direction,
  // risk_reward, final_score). Cuts ~80% of payload size for callers
  // that only need the trade plan (mobile widgets, lightweight clients,
  // status pages). Existing /signals page does NOT pass lite — it
  // continues to receive the full enriched row.
  const lite         = searchParams.get('lite') === 'true';
  // `bootstrap=true` makes the route AWAIT the auto-scan recovery
  // when last_pipeline_run is null (cold start / fresh deploy). The
  // request returns AFTER refreshDailyCandles + generatePhase4Signals
  // have written rows to q365_signals — typically 30–90s on the
  // recovery's 50-symbol head. Without this, every poll receives an
  // empty response while the fire-and-forget recovery runs in the
  // background; operators have no signal that the engine has produced
  // anything until the next poll catches the new rows.
  const bootstrap   = searchParams.get('bootstrap') === 'true';
  // `debug=signals` adds a `debug.tiers` envelope to the response so an
  // operator can see exactly which tier produced which row count. Pure
  // visibility — no behavior change, no extra DB writes.
  const debugSignals = searchParams.get('debug') === 'signals';
  // The local 13-field `compactSignal` shaper that lived here was only
  // used by the now-deleted dead 'top'/'all' legacy q365_signals
  // branches. The active confirmed-snapshot path uses the typed
  // `compactConfirmedSignal` from signalResponseMapper instead.

  const reqStart = Date.now();

  // ── No in-route scanning ──────────────────────────────────────
  // /api/signals reads from q365_signals only. It MUST NOT scan the
  // universe or trigger the pipeline — that would couple page-poll
  // latency to a multi-minute Yahoo fetch and re-introduce the
  // "Loading signals from database…" hang the live-pricing path is
  // designed to avoid.
  //
  // Manual scan triggers live in dedicated endpoints:
  //   • POST /api/scanner/custom-universe/run    — custom-universe Yahoo scanner
  //   • GET  /api/scanner/custom-universe/status — in-flight + last-summary state
  //   • src/app/api/signal-engine                — main signal-engine pipeline
  //   • npm run scan:custom-universe             — CLI wrapper
  //
  // The `forceRefresh` query param is retained for backward compat
  // with existing clients; it is now a no-op on this route. Live
  // freshness is provided by enrichWithLiveLtp + applyLiveSanity
  // running per-row on the rows already in the DB.
  if (VERBOSE_SIGNALS && forceRefresh) {
    console.log('[API/signals] forceRefresh=true — ignored (use POST /api/scanner/custom-universe/run to trigger a scan)');
  }

  try {
    // ════════════════════════════════════════════════════════════
    // Two-layer split: top / all / stats read ONLY from
    // q365_confirmed_signal_snapshots. q365_signals is the live
    // scanner table — frequently updated, non-actionable. Any row
    // surfaced to the dashboard from here has cleared every gate
    // and is locked for its validity window (60–120 min).
    //
    // No BUY/SELL quota. No fixed-count fallback. If 3 snapshots
    // are active, 3 rows ship; if 0, 0. Quality > quantity.
    // ════════════════════════════════════════════════════════════
    if (action === 'top' || action === 'all') {
      const reqIdParam   = searchParams.get('request_id');
      const requestId    = reqIdParam ?? `srv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      // ════════════════════════════════════════════════════════════
      // MARKET-CLOSED MODE — return static last-close data instead of
      // an empty signals envelope.
      //
      // The institutional gate downstream produces 0 confirmed
      // snapshots when the market hasn't moved (off-hours, weekend,
      // holiday). The dashboard then renders an empty page even though
      // q365_market_close_snapshot has perfectly valid last-close
      // prices for the entire universe.
      //
      // When the market is closed we short-circuit BEFORE
      // loadConfirmedSignalsBundle so:
      //   1. No DB pipeline runs for confirmed-snapshot enrichment
      //      (yahoo enrichment, strict gate, etc. are wasted work
      //      against an empty table).
      //   2. The response carries `mode: 'market_closed'` so the UI
      //      can render the market_data list instead of an empty
      //      signals card.
      //   3. ZERO IndianAPI calls — read is a single SELECT against
      //      q365_market_close_snapshot.
      //
      // Existing legacy fields (signals=[], validation_status, etc.)
      // remain populated for back-compat with consumers that pre-date
      // the `mode` field.
      //
      // Bypass: pass `?force=live` to skip the gate (used by
      // operator tools / debugging). Default behaviour is the gate.
      // Env bypass: FORCE_MARKET_OPEN=true makes the API serve the
      // live signal flow even off-hours so the most recent pipeline
      // batch is visible without the market_close_snapshot envelope.
      const forceLive = searchParams.get('force') === 'live';
      const overrideMarket = isMarketOverrideEnabled();
      if (overrideMarket) {
        console.log('[MARKET OVERRIDE] forcing pipeline run');
      }
      if (!forceLive && !overrideMarket) {
        const { isMarketOpen, getMarketStatus } = await import('@/lib/marketData/marketHours');
        if (!isMarketOpen()) {
          const status = getMarketStatus();
          const { rows: snapRows } = await db.query<{
            symbol: string; price: string | number;
            change_abs: string | number | null;
            change_pct: string | number | null;
            volume:     string | number | null;
            open_price: string | number | null;
            high_price: string | number | null;
            low_price:  string | number | null;
            prev_close: string | number | null;
            snapshot_ts: Date | string;
          }>(
            `SELECT symbol, price, change_abs, change_pct, volume,
                    open_price, high_price, low_price, prev_close, snapshot_ts
               FROM q365_market_close_snapshot
              ORDER BY symbol
              LIMIT ?`,
            [Math.max(1, Math.min(limit, 500))],
          );
          const snapToNum = (v: unknown): number | null => {
            if (v === null || v === undefined || v === '') return null;
            const n = typeof v === 'number' ? v : Number(v);
            return Number.isFinite(n) ? n : null;
          };
          const market_data = (snapRows as any[])
            // Spec §6 — market_data list must contain NIFTY 500 only.
            // Older snapshot rows for delisted / non-NIFTY 500 symbols
            // are dropped here so the off-hours UI matches the live one.
            .filter((r) => isInNifty500(String(r.symbol)))
            .map((r) => ({
              symbol:        String(r.symbol),
              price:         snapToNum(r.price)      ?? 0,
              change:        snapToNum(r.change_abs),
              change_percent: snapToNum(r.change_pct),
              volume:        snapToNum(r.volume),
              open:          snapToNum(r.open_price),
              high:          snapToNum(r.high_price),
              low:           snapToNum(r.low_price),
              prev_close:    snapToNum(r.prev_close),
              timestamp:     r.snapshot_ts instanceof Date
                                ? r.snapshot_ts.toISOString()
                                : String(r.snapshot_ts),
            }));
          const has_data = market_data.length > 0;
          // Newest snapshot timestamp drives `signal_latest_generated` /
          // `candle_latest_ts` so the client's `[CLIENT] DATA DATE`
          // log + freshness banner aren't all `undefined` off-hours.
          // We pull MAX(snapshot_ts) instead of relying on the limited
          // `market_data` slice — `limit` may have capped the rows shown
          // but the freshness envelope must reflect the full table.
          let latestSnapshotIso: string | null = null;
          let latestSnapshotMs:  number | null = null;
          let totalStoredCount  = 0;
          try {
            const { rows: maxRows } = await db.query<{
              max_ts: Date | string | null; total: number;
            }>(`SELECT MAX(snapshot_ts) AS max_ts, COUNT(*) AS total FROM q365_market_close_snapshot`);
            const maxRow = (maxRows as any[])[0];
            totalStoredCount = Number(maxRow?.total ?? 0);
            if (maxRow?.max_ts) {
              const d = maxRow.max_ts instanceof Date ? maxRow.max_ts : new Date(maxRow.max_ts);
              if (Number.isFinite(d.getTime())) {
                latestSnapshotIso = d.toISOString();
                latestSnapshotMs  = d.getTime();
              }
            }
          } catch { /* probe failure non-fatal; fields stay null */ }
          const ageMinutes = latestSnapshotMs
            ? Math.round((Date.now() - latestSnapshotMs) / 60_000) : null;
          const ageHours   = latestSnapshotMs
            ? Math.round((Date.now() - latestSnapshotMs) / 3_600_000 * 10) / 10 : null;

          // ── Scanner-batch / coverage probe (Bucket 2 fix) ────────
          // Off-hours we still want the freshness envelope to surface
          // the most recent scanner batch metadata (latest_batch_id /
          // engine_kind / symbols / persistence / coverage). The live
          // path (buildFreshness) does this; the closed path used to
          // emit `null` for every one of these because the original
          // implementation assumed off-hours = no batch state worth
          // reading. But `q365_signals` keeps the prior session's
          // batch row regardless of market state, so probing it here
          // costs one indexed COUNT and gives operators the visibility
          // they need on Saturday/Sunday. Failure is non-fatal — the
          // probe falls back to nulls if either query throws.
          // Use the same look-back window as the closed-market signal
          // loader so a Sunday poll spans Friday's batch (CLOSED_SIGNALS_MAX_AGE_HOURS,
          // default 72h). Without widening the probe past its 24h
          // default, latest_batch_id is null on every weekend even
          // though q365_signals still has Friday's batch metadata.
          const probeWindowHours = resolveClosedSignalsMaxAgeHours();
          const scannerProbe = await probeScannerBatch({ windowHours: probeWindowHours }).catch(() => ({
            scannerBatchId:       null as string | null,
            scannerEngineKind:    'unknown' as 'scanner' | 'phase4' | 'unknown',
            scannerLatestSymbols: null as number | null,
          }));
          const scannerUniverseSize = await loadUniverseSize().catch(() => null);
          const scannerPersistencePct =
            scannerUniverseSize && scannerUniverseSize > 0 && scannerProbe.scannerLatestSymbols != null
              ? Math.round((scannerProbe.scannerLatestSymbols / scannerUniverseSize) * 1000) / 10
              : null;
          // Probe real tracker counts so the closed-market envelope
          // reflects the actual maturity-tracker state (was hardcoded
          // to all zeros, which falsely implied "no trackers exist"
          // even when q365_signal_maturity_tracker had stale candidate
          // rows from the prior session). Failure is non-fatal — falls
          // back to the all-zeros object so the response shape stays
          // stable when the table query throws.
          const closedTrackerCounts = await getTrackerCounts({
            // Reuse the closed-market max-age window (default 72h) so
            // weekend polls can see Friday's candidate trackers. The
            // live-path 6h freshness gate is too tight off-hours and
            // would surface zero counts even when the DB has hundreds
            // of prior-session rows.
            freshHours: probeWindowHours,
          }).catch(() => ({
            candidate: 0, developing: 0, mature: 0,
            promoted: 0, terminated: 0, total: 0,
          }));

          // ── Last-stored filtered signals (DB-only, no upstream) ──
          // Spec: "Return LAST STORED FILTERED signals" — apply
          //   confidence>=70  final>=75  rr>=1.5  status='ACTIVE'
          //   not invalidated, not expired, sorted DESC by final
          //   then confidence, capped at the 20–30 spec band.
          // Failure of this loader MUST NOT break the closed-market
          // branch — we already have market_data ready to ship, so a
          // bad query just leaves signals empty and logs.
          const closedSignals = await loadClosedMarketSignals({ limit })
            .catch((err) => {
              console.warn('[/api/signals] closed-mode signal loader failed', err?.message);
              return null;
            });
          // Spec §9 — even off-hours, every emitted signal MUST be in
          // the locked NIFTY 500 set. Stale rows from before the lock
          // landed are dropped here.
          const closedSignalRowsRaw = closedSignals?.signals ?? [];
          const closedSignalRows = filterSignalsToNifty500(closedSignalRowsRaw, 'closedMarketSignals');
          const closedSignalSource = closedSignals?.source ?? 'none';
          const closedBuyCount  = closedSignalRows.length === closedSignalRowsRaw.length
            ? (closedSignals?.buyCount ?? 0)
            : closedSignalRows.filter((r) => String((r as any).direction ?? '').toUpperCase() === 'BUY').length;
          const closedSellCount = closedSignalRows.length === closedSignalRowsRaw.length
            ? (closedSignals?.sellCount ?? 0)
            : closedSignalRows.filter((r) => String((r as any).direction ?? '').toUpperCase() === 'SELL').length;
          const closedSignalQuality = closedSignals?.signalQuality ?? 'NONE';
          const closedStrictCount   = closedSignals?.strictCount   ?? 0;
          const closedRelaxedUsed   = closedSignals?.relaxedUsed   ?? false;
          // Spec MAIN-TABLE-STRICT §4 — q365_signals strict rows that
          // didn't clear the main-table gate (or confirmed snapshots
          // that fell short on maturity/cycles/stability) get surfaced
          // separately so the UI's "Stored Scanner Candidates / Not
          // Tradable" panel renders them without polluting the main
          // signals list.
          const scannerCandidatesRaw = closedSignals?.scannerCandidates ?? [];
          const scannerCandidates = filterSignalsToNifty500(scannerCandidatesRaw, 'scannerCandidates');

          // Spec-required log line — grep on "MARKET CLOSED — SERVING
          // LAST SIGNALS FROM DB" to confirm the off-hours path fired.
          console.log(
            `MARKET CLOSED — SERVING LAST SIGNALS FROM DB  ` +
            `source=${closedSignalSource}  quality=${closedSignalQuality}  ` +
            `rows=${closedSignalRows.length}  strict=${closedStrictCount}  ` +
            `relaxed=${closedRelaxedUsed}  ` +
            `buy=${closedBuyCount}  sell=${closedSellCount}  ` +
            `scanned=${closedSignals?.scannedRowCount ?? 0}  ` +
            `approved=${closedSignals?.approvedRowCount ?? 0}`,
          );

          // Spec INSTITUTIONAL §B — bump rotation registry on the
          // closed-market path too. Without this, off-hours polls don't
          // accumulate "consecutive cycles shown" counters and the next
          // open-market session starts fresh, defeating cooldown.
          try { commitRotation(closedSignalRows as any[]); } catch { /* non-fatal */ }

          // ── INSTITUTIONAL_TIER_2026-05 — partition closed-market rows ──
          // The closed-market loader can return relaxed-tier rows mixed
          // with strict ones. Apply the same five-tier split here so
          // the off-hours response matches the live response shape.
          const closedTierPart = partitionByTier(closedSignalRows as unknown as TieredRow[]);
          const closedDedupKey = (r: TieredRow): string =>
            `${r.symbol ?? r.tradingsymbol ?? '?'}|${(r as { id?: number }).id ?? ''}|${(r as { generated_at?: unknown }).generated_at ?? ''}`;
          const closedDedupe = <T extends TieredRow>(arr: T[]): T[] => {
            const seen = new Set<string>();
            const out: T[] = [];
            for (const r of arr) {
              const k = closedDedupKey(r);
              if (seen.has(k)) continue;
              seen.add(k);
              out.push(r);
            }
            return out;
          };
          const closedStamp = (rows: TieredRow[], tier: SignalTier): TieredRow[] =>
            rows.map((r) => ({ ...r, tier }));
          const closedTieredApproved   = closedTierPart.approved;
          let closedTieredDeveloping   = closedDedupe(closedTierPart.developing);
          let closedTieredScanner      = closedDedupe([
            ...closedTierPart.scannerCandidates,
            ...closedStamp(scannerCandidates as TieredRow[], 'EMERGING_OPPORTUNITY'),
          ]);
          const closedTieredWatchlist  = closedDedupe(closedTierPart.watchlist);
          const closedTieredRisk       = closedDedupe(closedTierPart.riskRestricted);

          // CONDITIONAL_FALLBACK_2026-05 — same Tier 1.5 promotion on
          // the closed-market path. Off-hours often has zero strict
          // approvals (the previous session's data ages past the
          // strict freshness gate); the conditional floors accept
          // STALE rows so the operator still sees the strongest
          // candidates from the last batch.
          let closedHighPotential: TieredRow[] = [];
          let closedConditionalActive = false;
          if (closedTieredApproved.length === 0) {
            const pool = [...closedTieredDeveloping, ...closedTieredScanner];
            closedHighPotential = selectHighPotentialFallback(pool, HIGH_POTENTIAL_MAX_ROWS);
            if (closedHighPotential.length > 0) {
              closedConditionalActive = true;
              const promoted = new Set(closedHighPotential.map(closedDedupKey));
              closedTieredDeveloping = closedTieredDeveloping.filter((r) => !promoted.has(closedDedupKey(r)));
              closedTieredScanner    = closedTieredScanner.filter((r)    => !promoted.has(closedDedupKey(r)));
              console.log(
                `[CONDITIONAL] closed-market fallback engaged → promoted ${closedHighPotential.length} ` +
                `row${closedHighPotential.length === 1 ? '' : 's'} (pool=${pool.length})`,
              );
            }
          }

          const closedTieredBuy  = closedTieredApproved.filter(
            (r) => String((r as { direction?: string | null }).direction ?? '').toUpperCase() === 'BUY',
          ).length;
          const closedTieredSell = closedTieredApproved.filter(
            (r) => String((r as { direction?: string | null }).direction ?? '').toUpperCase() === 'SELL',
          ).length;
          const closedConditionalBuy  = closedHighPotential.filter(
            (r) => String((r as { direction?: string | null }).direction ?? '').toUpperCase() === 'BUY',
          ).length;
          const closedConditionalSell = closedHighPotential.filter(
            (r) => String((r as { direction?: string | null }).direction ?? '').toUpperCase() === 'SELL',
          ).length;

          const dataSourceField =
            closedSignalRows.length > 0 ? 'last_close_signals' :
            has_data                     ? 'market_close_snapshot' :
                                           'none';
          
          const approvedZero = closedTieredApproved.length === 0;
          const messageField = (approvedZero && (closedTieredWatchlist.length > 0 || closedTieredScanner.length > 0 || closedHighPotential.length > 0))
            ? 'Market Closed — Showing last-close watchlist candidates' :
            closedSignalQuality === 'STRICT'  ? 'Market closed — showing matured confirmed signals' :
            closedSignalQuality === 'RELAXED' ? 'Market closed — showing relaxed-quality signals (strict filter empty)' :
            scannerCandidates.length > 0      ? 'Market closed — no matured confirmed snapshots; see scanner candidates below'
                                              : 'No matured confirmed signals available — try again next session';
          const reasonSummaryField = approvedZero
            ? 'No approved live signals. Candidates are under monitoring and awaiting fresh confirmation.'
            : null;

          const closedTierCounts = {
            execution_ready:        closedTieredApproved.length,
            high_potential:         closedHighPotential.length,
            awaiting_confirmation:  closedTieredDeveloping.length,
            emerging_opportunity:   closedTieredScanner.length,
            monitor:                closedTieredWatchlist.length,
            risk_restricted:        closedTieredRisk.length,
          };
          const closedEmptyMessage = buildEmptyStateMessage(
            {
              approved:           closedTieredApproved,
              developing:         closedTieredDeveloping,
              scannerCandidates:  closedTieredScanner,
              watchlist:          closedTieredWatchlist,
              riskRestricted:     closedTieredRisk,
            },
            closedHighPotential.length,
          );
          const closedDefaultTab:
            | 'APPROVED' | 'HIGH_POTENTIAL' | 'AWAITING_CONFIRMATION'
            | 'EMERGING_OPPORTUNITY' | 'MONITOR' | 'RISK_RESTRICTED' | 'REJECTED' =
            closedTieredApproved.length > 0    ? 'APPROVED'
            : closedHighPotential.length > 0    ? 'HIGH_POTENTIAL'
            : closedTieredDeveloping.length > 0 ? 'AWAITING_CONFIRMATION'
            : closedTieredScanner.length > 0    ? 'EMERGING_OPPORTUNITY'
            : closedTieredWatchlist.length > 0  ? 'MONITOR'
            : closedTieredRisk.length > 0       ? 'RISK_RESTRICTED'
                                                : 'REJECTED';

          // ── PHASE_1_RANKING_AND_NEAREST_SIGNAL + PHASE_2_DUE_DILIGENCE ──
          // Pre-rank each tier once (instead of running the ranker
          // multiple times inside the literal below) and then enrich
          // each list with per-row dueDiligence + performanceReview.
          const closedRankedApproved        = rankSignalsByInstitutionalScore(closedTieredApproved        as unknown as RankableSignal[]) as typeof closedTieredApproved;
          const closedRankedDeveloping      = rankSignalsByInstitutionalScore(closedTieredDeveloping      as unknown as RankableSignal[]) as typeof closedTieredDeveloping;
          const closedRankedScanner         = rankSignalsByInstitutionalScore(closedTieredScanner         as unknown as RankableSignal[]) as typeof closedTieredScanner;
          const closedRankedWatchlist       = rankSignalsByInstitutionalScore(closedTieredWatchlist       as unknown as RankableSignal[]) as typeof closedTieredWatchlist;
          const closedRankedRisk            = rankSignalsByInstitutionalScore(closedTieredRisk            as unknown as RankableSignal[]) as typeof closedTieredRisk;
          const closedRankedHighPotential   = rankSignalsByInstitutionalScore(closedHighPotential         as unknown as RankableSignal[]) as typeof closedHighPotential;

          const closedDDContext: DueDiligenceContext = {
            tier:        'approved', // overridden per row below
            marketOpen:  false,
            marketLabel: status.label,
            isBootstrap: bootstrap,
            isFallback:  true,
            freshnessMode: 'NORMAL_OPERATION',
            candleAgeMinutes: ageMinutes,
          };
          const closedEnrich = <T extends { symbol?: string | null; tradingsymbol?: string | null }>(
            rows: readonly T[], tier: SignalTierContext,
          ): Array<T & { dueDiligence: DueDiligenceReview; performanceReview: PerformanceReview }> => {
            if (!rows || rows.length === 0) return [];
            return rows.map((r) => {
              const ctx: DueDiligenceContext = { ...closedDDContext, tier };
              const performance = buildPerformanceReview(r as unknown as RankableSignal, ctx);
              const dd          = buildSignalDueDiligence(r as unknown as RankableSignal, ctx, performance);
              return { ...r, dueDiligence: dd, performanceReview: performance };
            });
          };

          const closedEnrichedApproved        = closedEnrich(closedRankedApproved as any[], 'approved');
          const closedEnrichedHighPotential   = closedEnrich(closedRankedHighPotential as any[], 'high_potential');
          const closedEnrichedWatchlist       = closedEnrich(closedRankedWatchlist as any[], 'watchlist');
          const closedEnrichedDeveloping      = closedEnrich(closedRankedDeveloping as any[], 'developing');
          const closedEnrichedScanner         = closedEnrich(closedRankedScanner as any[], 'scanner_candidate');
          const closedEnrichedRisk            = closedEnrich(closedRankedRisk as any[], 'risk_restricted');

          const closedDDSummary: DueDiligenceSummary = buildDueDiligenceSummary([
            { signals: closedRankedApproved      as unknown as RankableSignal[], tier: 'approved' },
            { signals: closedRankedHighPotential as unknown as RankableSignal[], tier: 'high_potential' },
            { signals: closedRankedWatchlist     as unknown as RankableSignal[], tier: 'watchlist' },
            { signals: closedRankedDeveloping    as unknown as RankableSignal[], tier: 'developing' },
            { signals: closedRankedScanner       as unknown as RankableSignal[], tier: 'scanner_candidate' },
            { signals: closedRankedRisk          as unknown as RankableSignal[], tier: 'risk_restricted' },
          ], closedDDContext);

          // PHASE_3_DAILY_INTELLIGENCE_2026-05 — lightweight preview
          // for the closed-market payload (mirrors the live path).
          const countClosedOutcome = (rows: Array<{ performanceReview?: PerformanceReview }>): { success: number | null; failed: number | null } => {
            let success = 0, failed = 0, withOutcome = 0;
            for (const r of rows) {
              const m = r.performanceReview?.movePercent;
              if (m == null) continue;
              withOutcome++;
              if (m >= 0.5) success++;
              else if (m <= -0.5) failed++;
            }
            return {
              success: withOutcome > 0 ? success : null,
              failed:  withOutcome > 0 ? failed  : null,
            };
          };
          const closedApprovedOutcome = countClosedOutcome(closedEnrichedApproved as Array<{ performanceReview?: PerformanceReview }>);
          const closedHpOutcome       = countClosedOutcome(closedEnrichedHighPotential as Array<{ performanceReview?: PerformanceReview }>);
          const closedDailyReportPreview = buildLightweightDailyReportPreview({
            approvedTotal:          closedEnrichedApproved.length,
            approvedSuccess:        closedApprovedOutcome.success,
            approvedFailed:         closedApprovedOutcome.failed,
            highPotentialTotal:     closedEnrichedHighPotential.length,
            highPotentialPerformed: closedHpOutcome.success,
            watchlistTotal:         closedEnrichedWatchlist.length + closedEnrichedDeveloping.length + closedEnrichedScanner.length,
            rejectedTotal:          closedEnrichedRisk.length,
            topBlockReason:         closedDDSummary.topBlockReasons[0]?.reason ?? null,
            marketOpen:             false,
            isBootstrap:            bootstrap,
            isFallback:             true,
            staleMinutes:           ageMinutes,
          });
          // PHASE_5_HEALTH_OBSERVABILITY_2026-05 — closed-market preview.
          const closedHealthPreview = buildLightweightEngineHealthPreview({
            marketOpen:     false,
            isBootstrap:    bootstrap,
            isFallback:     true,
            staleMinutes:   ageMinutes,
            approvedTotal:  closedEnrichedApproved.length,
            candidateTotal: closedEnrichedHighPotential.length
                          + closedEnrichedWatchlist.length
                          + closedEnrichedDeveloping.length
                          + closedEnrichedScanner.length
                          + closedEnrichedRisk.length,
          });

          const closedPayload = {
            // ── New market-aware fields ────────────────────────────
            mode:        'market_closed' as const,
            data_source: dataSourceField,
            // ── STRUCTURED_SIGNALS_2026-05 ──
            // PHASE_1_RANKING + PHASE_2_DUE_DILIGENCE — each tier is
            // sorted by highest final score first and enriched with
            // per-row dueDiligence + performanceReview.
            signals:             closedEnrichedApproved as typeof closedTieredApproved,
            approved:            closedEnrichedApproved as typeof closedTieredApproved,
            developing:          closedEnrichedDeveloping as typeof closedTieredDeveloping,
            scanner_candidates:  closedEnrichedScanner as typeof closedTieredScanner,
            watchlist:           closedEnrichedWatchlist as typeof closedTieredWatchlist,
            risk_restricted:     closedEnrichedRisk as typeof closedTieredRisk,
            high_potential:      closedEnrichedHighPotential as typeof closedHighPotential,
            high_potential_buy:       closedConditionalBuy,
            high_potential_sell:      closedConditionalSell,
            conditional_mode_active:  closedConditionalActive,
            conditional_floors: {
              confidence: CONDITIONAL_CONFIDENCE_FLOOR,
              rr:         CONDITIONAL_RR_FLOOR,
              max_rows:   HIGH_POTENTIAL_MAX_ROWS,
            },
            tier_counts:         closedTierCounts,
            empty_state_message: closedEmptyMessage,
            default_tab:         closedDefaultTab,
            // ── STRUCTURED_SIGNALS_2026-05 ──
            // PHASE_1_RANKING + PHASE_2_DUE_DILIGENCE — enriched lists.
            approvedSignals:      closedEnrichedApproved as typeof closedTieredApproved,
            approvedCount:        closedTieredApproved.length,
            highPotentialSignals: closedEnrichedHighPotential as typeof closedHighPotential,
            watchlistSignals:     closedEnrichedWatchlist as typeof closedTieredWatchlist,
            rejectedSignals:      closedEnrichedRisk as typeof closedTieredRisk,
            counters: {
              approvedTotal:       closedTieredApproved.length,
              approvedBuy:         closedTieredBuy,
              approvedSell:        closedTieredSell,
              highPotentialTotal:  closedHighPotential.length,
              watchlistTotal:      closedTieredWatchlist.length + closedTieredDeveloping.length + closedTieredScanner.length,
              rejectedTotal:       closedTieredRisk.length,
              candidateTotal:      closedHighPotential.length + 
                                   closedTieredDeveloping.length + 
                                   closedTieredScanner.length + 
                                   closedTieredWatchlist.length + 
                                   closedTieredRisk.length,
            },
            reasonSummary:       reasonSummaryField,
            // Price view: last-close snapshots for the universe.
            market_data,
            message:             messageField,
            market_state:        status.state,   // 'closed' | 'pre-open' | 'holiday'
            market_label:        status.label,
            // ── Two-tier filter debug fields (spec §6) ─────────────
            //   signal_quality   = 'STRICT' | 'RELAXED' | 'NONE'
            //   strict_count     = rows produced by tier-1 before fallback
            //   relaxed_used     = true when the response is tier-2
            //   final_returned   = rows ultimately shipped
            signal_quality:      closedSignalQuality,
            strict_count:        closedStrictCount,
            relaxed_used:        closedRelaxedUsed,
            final_returned:      closedSignalRows.length,
            // ── Validation report fields per spec section 10 ───────
            scanned:             closedSignals?.scannedRowCount  ?? 0,
            returned:            closedSignalRows.length,
            api_blocked:         true,
            closed_signal_source: closedSignalSource,
            // ── Legacy fields kept populated for back-compat ───────
            // INSTITUTIONAL_TIER_2026-05 — counts now reflect the
            // strict APPROVED tier only. closedBuyCount / closedSellCount
            // counted relaxed rows too; the new dashboard reads tier_counts
            // for the per-tier numbers and these legacy fields are
            // recomputed from the post-partition approved set.
            request_id:           requestId,
            main_signals_count:   closedTieredApproved.length,
            buy_count:            closedTieredBuy,
            sell_count:           closedTieredSell,
            direction_breakdown:  { BUY: closedTieredBuy, SELL: closedTieredSell },
            empty_confirmed:      closedTieredApproved.length === 0,
            validation_status:    'MARKET_CLOSED',
            developing_count:     0,
            in_progress:          [] as any[],
            below_floor_demoted:  [] as any[],
            // Freshness envelope MUST match the field names the live
            // path emits (freshnessService.ts:283-318) — the client logs
            // and banner read these by exact key. Closed-mode values:
            //   signal_latest_generated / candle_latest_ts → MAX(snapshot_ts)
            //   tick_ws_state                              → 'closed'
            //   tick_newest_age_ms                         → null (no live ticks)
            //   market_open                                → false
            //   data_source                                → 'market_close_snapshot'
            //   tracker_counts                             → zero counters
            //   yahoo_health / kite_health                 → 'market_closed'
            freshness: {
              server_now:               new Date().toISOString(),
              latest_confirmed_at:      null,
              last_pipeline_run:        latestSnapshotIso,
              signal_latest_generated:  latestSnapshotIso,
              signal_age_minutes:       ageMinutes,
              active_count:             closedSignalRows.length,
              total_lifetime:           closedSignalRows.length,
              total_stored_signals:     totalStoredCount,
              candle_latest_ts:         latestSnapshotIso,
              candle_age_hours:         ageHours,
              candle_max_ts:            latestSnapshotIso,
              market_open:              false,
              market_state:             status.state,
              market_label:             status.label,
              feed_provider:            has_data ? 'market_close_snapshot' : 'none',
              data_source:              has_data ? 'market_close_snapshot' : 'none',
              tracker_counts:           closedTrackerCounts,
              in_progress_count:        0,
              last_validation_time:     latestSnapshotIso,
              // Bucket 2 fix — populate from probeScannerBatch + loadUniverseSize.
              // latest_batch_symbols falls back to `totalStoredCount` (rows
              // in q365_market_close_snapshot) when the scanner probe
              // returns no batch — that keeps the field useful even on a
              // cold start where q365_signals has nothing.
              latest_batch_id:                  scannerProbe.scannerBatchId,
              latest_batch_engine_kind:         scannerProbe.scannerEngineKind,
              latest_batch_symbols:             scannerProbe.scannerLatestSymbols ?? totalStoredCount,
              // Spec "FIX NULL METRICS" — never serve null on the
              // closed-market path. scannerPersistencePct is null
              // when probeScannerBatch found nothing or universe
              // hasn't loaded; 0 is the truthful coverage in that
              // case. Held in lockstep with freshnessService.ts.
              latest_batch_persistence_percent: scannerPersistencePct ?? 0,
              persistence_percent:              scannerPersistencePct ?? 0,
              scan_coverage_percent:            scannerPersistencePct ?? 0,
              total_persisted:                  scannerProbe.scannerLatestSymbols ?? totalStoredCount ?? 0,
              total_scanned:                    scannerProbe.scannerLatestSymbols ?? totalStoredCount ?? 0,
              universe_size:                    scannerUniverseSize ?? 0,
              tick_ws_state:            'closed',
              tick_newest_age_ms:       null,
              kite_health:              'market_closed',  // @deprecated marker
              yahoo_health:             'market_closed',  // @deprecated marker
            },
            served_from_cache:    false,

            // ── FIX FINAL SIGNAL VISIBILITY 2026-05 ──
            marketStatus: {
              isOpen: false,
              label:  status.label,
              state:  status.state,
            },
            dataFreshness: {
              isStale:    (ageMinutes ?? 0) > 30,
              ageMinutes: ageMinutes,
              label:      ageMinutes != null ? `${ageMinutes}m ago` : 'Unknown',
            },
            provider:             'market_close_snapshot',
            isBootstrap:          bootstrap,
            isFallback:           true,
            lastApiRequestAt:     new Date().toISOString(),
            lastSuccessAt:        new Date().toISOString(),
            lastPipelineRunAt:    latestSnapshotIso,
            lastConfirmedSignalAt: latestSnapshotIso,

            // ── PHASE_1_RANKING_AND_NEAREST_SIGNAL_2026-05 ──
            // closestToApprovalClosed / nearestSignalsClosed pre-computed
            // immediately below so the closedPayload literal can reference
            // both fields by name without invoking a self-reference inside
            // an object initialiser.
            closestToApproval: undefined as unknown as { total: number; signals: ClosestToApprovalRow[]; generatedAt: string; reason: string },
            nearestSignals:    undefined as unknown as ClosestToApprovalRow[],

            // ── PHASE_2_DUE_DILIGENCE_2026-05 ──
            dueDiligenceSummary: closedDDSummary,

            // ── PHASE_3_DAILY_INTELLIGENCE_2026-05 ──
            dailyReportPreview:  closedDailyReportPreview,

            // ── PHASE_5_HEALTH_OBSERVABILITY_2026-05 ──
            healthPreview:       closedHealthPreview,
          };
          // Compute closest-to-approval for the closed-market path,
          // and enrich each row with per-row due diligence so the
          // nearest-signal cards can render explainability.
          {
            const closestRows: ClosestToApprovalRow[] = closedTieredApproved.length === 0
              ? buildClosestToApprovalSignals(
                  {
                    highPotential:    closedHighPotential as unknown as RankableSignal[],
                    watchlist:        closedTieredWatchlist as unknown as RankableSignal[],
                    developing:       closedTieredDeveloping as unknown as RankableSignal[],
                    scannerCandidates: closedTieredScanner as unknown as RankableSignal[],
                  },
                  CLOSEST_TO_APPROVAL_MAX,
                ).map((n: NearestSignal): ClosestToApprovalRow => {
                  const s = n.signal as RankableSignal;
                  const symbol = String(s.symbol ?? s.tradingsymbol ?? '');
                  const tier = n.sourceTier;
                  const status = tier === 'high_potential'    ? 'High Potential'
                               : tier === 'watchlist'         ? 'Watchlist'
                               : tier === 'developing'        ? 'Awaiting Confirmation'
                               : tier === 'scanner_candidate' ? 'Emerging Opportunity'
                               :                                'Rejected (Soft)';
                  const sourceTierForCtx: SignalTierContext =
                    tier === 'high_potential' ? 'high_potential'
                    : tier === 'watchlist'    ? 'watchlist'
                    : tier === 'developing'   ? 'developing'
                    : tier === 'scanner_candidate' ? 'scanner_candidate'
                    :                                'nearest';
                  const ctx: DueDiligenceContext = { ...closedDDContext, tier: sourceTierForCtx };
                  const performance = buildPerformanceReview(s, ctx);
                  const dd          = buildSignalDueDiligence(s, ctx, performance);
                  return {
                    symbol,
                    tradingsymbol:          s.tradingsymbol ?? symbol,
                    direction:              s.direction ?? null,
                    final_score:            s.final_score ?? null,
                    confidence_score:       s.confidence_score ?? s.confidence ?? null,
                    risk_reward:            s.risk_reward ?? s.rr_ratio ?? null,
                    approvalGap:            n.approvalGap,
                    approvalGapPercent:     n.approvalGapPercent,
                    missingApprovalFactors: n.missingApprovalFactors,
                    nearestSignalRank:      n.nearestSignalRank,
                    sourceTier:             n.sourceTier,
                    isClosestToApproval:    n.isClosestToApproval,
                    status,
                    is_bootstrap:           bootstrap || undefined,
                    is_stale:               true, // Closed-market data is always last-close.
                    dueDiligence:           dd,
                    performanceReview:      performance,
                  };
                })
              : [];
            const closestReason = closedTieredApproved.length === 0
              ? 'Market Closed — nearest candidates from last close. Awaiting fresh market confirmation.'
              : 'Approved signals available — closest-to-approval surfaced for reference only.';
            closedPayload.closestToApproval = {
              total:        closestRows.length,
              signals:      closestRows,
              generatedAt:  new Date().toISOString(),
              reason:       closestReason,
            };
            closedPayload.nearestSignals = closestRows;
          }
          return NextResponse.json(closedPayload, {
            headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
          });
        }
      }

      // ── Freeze cache: serve immutable snapshot within window ─────
      // Same (action, limit, lite) within FREEZE_TTL_MS gets the
      // identical payload — guarantees BUY count and row order are
      // stable across rapid polls. Cache key intentionally excludes
      // request_id so concurrent clients share one frozen view.
      //
      // Defence-in-depth: treat a cached EMPTY payload as a miss and
      // drop the entry. This protects against a legacy cache entry
      // that was written before empty payloads were excluded from
      // freezePut — a 5-min stale empty would otherwise mask a
      // newly-populated DB. Also protects against any future code
      // path that bypasses the freezePut emptiness check.
      const cacheKey = freezeKey(action, limit, lite);
      const fresh = await freezeGetFresh(cacheKey);
      const cachedIsEmpty =
        fresh != null &&
        (fresh.payload?.empty_confirmed === true ||
         fresh.payload?.main_signals_count === 0 ||
         (Array.isArray(fresh.payload?.signals) && fresh.payload.signals.length === 0));
      if (cachedIsEmpty) {
        freezeDrop(cacheKey);
      }
      // ?bootstrap=true means the operator is asking for a fresh
      // synchronous recovery run — never serve a cached payload, since
      // the whole point is to land new data on this single request.
      if (fresh && !cachedIsEmpty && !bootstrap) {
        return NextResponse.json(
          { ...fresh.payload, request_id: requestId, served_from_cache: true },
          { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
        );
      }

      // ── READ-ONLY CONTRACT ───────────────────────────────────────
      // The API NO LONGER runs applyLiveSanity. Live-tape validation
      // is owned by the cron worker `runConfirmedSnapshotLifecycle`
      // (src/lib/cron/confirmedSnapshotLifecycle.ts), which persists
      // its verdict to `status` + `invalidation_reason`. The snapshot
      // reader filters `WHERE status = 'ACTIVE'`, so any row a
      // lifecycle pass has killed is invisible here by construction.
      // Per-request applyLiveSanity caused the BUY-count flap
      // (22 → 50 → 28) and is gone for good.
      //
      // The whole data pipeline (Promise.all of 4 DB reads, Yahoo
      // enrichment, strict gate, deterministic sort, cap, below-floor
      // demote, tracker enrichment) lives in confirmedSignalsService.
      // The route just forwards `limit` and consumes the bundle.
      let bundle = await loadConfirmedSignalsBundle({ limit });
      let enriched           = bundle.enriched;
      let finalRows          = bundle.finalRows;
      let belowFloorDemoted  = bundle.belowFloorDemoted;
      let inProgressEnriched = bundle.inProgressEnriched;
      let freshnessRaw       = bundle.freshnessRaw;
      // MATURATION_AUDIT_2026-05 — bottleneck diagnosis carried through
      // to the wire so an operator can curl /api/signals?action=all and
      // read .approval_bottleneck.cause / .suggested_env directly.
      let approvalBottleneck = bundle.approvalBottleneck;
      let trackerCounts      = bundle.trackerCounts;

      // ── Maturity-layer warm-up fallback ─────────────────────────
      // Hard-empty steady state: confirmed snapshots are empty AND
      // the maturity tracker has zero rows. This is the symptom of
      // a fresh deployment, or any environment where saveSignals
      // hasn't yet upserted a tracker (regen cron not running, dev
      // mode without Q365_INPROC_REGEN=1, etc.). Without a fallback
      // the dashboard ships zero rows forever even when q365_signals
      // has perfectly tradeable rows from a manual scan.
      //
      // We read the live scanner table directly and surface those
      // rows as the MAIN signals list. They are NOT yet promoted —
      // the `is_signal_engine_fallback` flag tells the UI they came
      // from the live scanner table without going through the
      // maturity gate — but the operator sees the BUY/SELL table
      // populate instead of an empty "No signals in database" screen
      // alongside a count-only "77 emerging available" tease.
      //
      // We also kick the scanner (5-min throttled) so the live
      // table starts populating if it's also empty.
      // ── Fallback path: REMOVED per spec ───────────────────────────
      //
      // Previously, when q365_confirmed_signal_snapshots was empty the
      // route surfaced rows from q365_signals with a freshness ceiling
      // and `is_signal_engine_fallback: true` flag. Per current spec
      // ("No fallback data — return empty if no signals"), this is
      // gone entirely. An empty snapshots table now ships an empty
      // response with validation_status=NO_SIGNALS_CONFIRMED. The
      // auto-scan trigger below still kicks the scanner so the
      // pipeline recovers without the operator manually intervening.
      const fallbackBatchTs: number | null = null;
      const fallbackUsed = false;
      if (enriched.length === 0) {
        // Cold-start = nothing has ever populated the system: BOTH the
        // confirmed-snapshot pool AND the maturity tracker are empty.
        // In that state the market-hours gate is bypassed (otherwise
        // the dashboard would be stuck empty until next market open).
        const totalTrackers = Number(trackerCounts?.total ?? 0);
        const isColdStart =
          inProgressEnriched.length === 0 &&
          (!Number.isFinite(totalTrackers) || totalTrackers === 0) &&
          (freshnessRaw?.total_lifetime ?? 0) === 0;
        await triggerAutoScanIfEmpty(
          isColdStart
            ? 'cold-start — snapshots + tracker both empty'
            : 'confirmed_snapshots empty — no fallback per spec',
          { coldStart: isColdStart, awaitCompletion: bootstrap },
        );
      }

      // Spec §5 — when last_pipeline_run is null the pipeline has never
      // produced a confirmed snapshot in this environment (or the
      // heartbeat row is missing). Fire the recovery scan immediately
      // even when the tracker has rows from a partial run, so a fresh
      // deploy doesn't sit on `last_pipeline_run: null` until the next
      // regen cron tick. The 60s cold-start cooldown still applies via
      // `triggerAutoScanIfEmpty` so a busy poll loop can't pile up.
      if (!freshnessRaw?.latest_confirmed_at) {
        await triggerAutoScanIfEmpty(
          'last_pipeline_run is null — kicking pipeline immediately',
          { coldStart: true, awaitCompletion: bootstrap },
        );
      }

      // Stale-batch auto-trigger — fires even when q365_signals has
      // rows (so we recover from a "5-hour-old data" state without
      // needing the table to be empty). Sits outside the
      // `enriched.length === 0` branch so a populated-but-stale state
      // also kicks a fresh scan.
      try {
        const ageRes = await db.query<{ ms: number | null }>(
          `SELECT (UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(MAX(generated_at))) * 1000 AS ms
             FROM q365_signals WHERE batch_id IS NOT NULL`,
        );
        const ageMs = Number((ageRes.rows[0] as any)?.ms);
        if (Number.isFinite(ageMs) && ageMs > STALE_BATCH_THRESHOLD_MS) {
          void triggerAutoScanIfEmpty(`latest batch ${Math.round(ageMs / 60_000)}min old (>15min)`);
        }
      } catch { /* probe failure is non-fatal */ }

      // ── ?bootstrap=true reload ─────────────────────────────────
      // If the operator forced a synchronous recovery and it completed,
      // the bundle we loaded above is stale (it predates the new rows).
      // Reload so the response reflects the freshly-generated signals
      // instead of returning the empty pre-recovery snapshot. We only
      // reload on `completed` — `failed` / `skipped_*` leave the
      // bundle as-is so the operator sees the genuine empty state
      // along with auto_recovery.last_error explaining why.
      if (bootstrap && autoScanState.status === 'completed') {
        console.log('[BOOTSTRAP] reloading confirmed-signals bundle after synchronous recovery');
        bundle = await loadConfirmedSignalsBundle({ limit });
        enriched           = bundle.enriched;
        finalRows          = bundle.finalRows;
        belowFloorDemoted  = bundle.belowFloorDemoted;
        inProgressEnriched = bundle.inProgressEnriched;
        freshnessRaw       = bundle.freshnessRaw;
        trackerCounts      = bundle.trackerCounts;
        approvalBottleneck = bundle.approvalBottleneck;
      }

      const buyCount  = finalRows.filter((r: ConfirmedSignalRow) => String(r.direction ?? '').toUpperCase() === 'BUY').length;
      const sellCount = finalRows.filter((r: ConfirmedSignalRow) => String(r.direction ?? '').toUpperCase() === 'SELL').length;

      // Freshness envelope assembly (candle probe, scanner batch
      // probe, universe size lookup, all of the banner fields) lives
      // in `@/lib/signals/freshnessService`. Same I/O, same fields —
      // the route just forwards the inputs.
      const freshnessOut = await buildFreshness({
        freshnessRaw,
        enrichedLength:    enriched.length,
        inProgressLength:  inProgressEnriched.length,
        trackerCounts,
        fallbackUsed,
        fallbackBatchTs,
      });
      const freshness         = freshnessOut.freshness;
      const scannerBatchId    = freshnessOut.scannerBatchId;
      const scannerEngineKind = freshnessOut.scannerEngineKind;

      // Validation status, synthetic batch id, funnel log, and the
      // full response envelope are all built in modular helpers now.
      // No sticky LKG — empty stays empty.
      const validationStatus = deriveValidationStatus(
        finalRows.length, inProgressEnriched.length,
      );
      const syntheticBatchId = await resolveSyntheticBatchId(freshnessRaw, scannerBatchId);
      logSignalFunnel({
        action,
        fallbackUsed,
        scannerBatchId,
        scannerEngineKind,
        finalRowsLength:  finalRows.length,
        inProgressLength: inProgressEnriched.length,
        trackerCounts,
        buyCount,
        sellCount,
        validationStatus,
        syntheticBatchId,
      });

      // ── PHASE_B_MANIPULATION_INTEGRATION ──
      // Fetch the manipulation risk map for every symbol the assembler
      // will see (approved + below-floor + in-progress). The map is
      // small and the lookup batches into two DB queries, so this is
      // cheap. On any failure we degrade to undefined so the assembler
      // skips the gate entirely (no false rejections).
      let manipulationRiskMap: Awaited<ReturnType<typeof getManipulationRiskForSymbols>> | undefined;
      try {
        const allSymbols: string[] = [];
        for (const r of [...finalRows, ...belowFloorDemoted, ...inProgressEnriched]) {
          const s = (r as { symbol?: string | null; tradingsymbol?: string | null }).symbol
                 ?? (r as { symbol?: string | null; tradingsymbol?: string | null }).tradingsymbol;
          if (s) allSymbols.push(String(s));
        }
        if (allSymbols.length > 0) {
          manipulationRiskMap = await getManipulationRiskForSymbols(allSymbols);
        }
      } catch (err) {
        console.warn('[api/signals] manipulation risk fetch failed — gate disabled this cycle:', err);
        manipulationRiskMap = undefined;
      }

      let responsePayloadBase = await buildSignalsResponsePayload({
        finalRows,
        belowFloorDemoted,
        inProgressEnriched,
        buyCount,
        sellCount,
        freshness,
        syntheticBatchId,
        requestId,
        lite,
        validationStatus,
        // Spec INSTITUTIONAL §B — when the strict pool is empty, the
        // closed-market fallback below is going to override `signals`
        // with a different set. Defer the rotation commit so we
        // record cycles against the rows the dashboard actually saw,
        // not the empty strict set (which would decay every entry in
        // the registry by 1 and miscount the next request's cooldowns).
        skipRotationCommit: finalRows.length === 0,
        manipulationRiskMap,
      });

      // ── Spec FAIL-SAFE §7 — relaxed / scanner-candidate fallback ──
      //
      // RUNS FIRST (before the slow live-empty market_data fetch).
      // When the strict confirmed-snapshot pool is empty (Phase 4 ran
      // but every row was rejected, or maturity tracker hasn't promoted
      // yet), reach into q365_signals for the relaxed-tier rows + the
      // not-yet-tradable scanner candidates. This is the same loader
      // the closed-market branch uses — it's purely DB SQL, so it's
      // fast (<100ms) and reliable. Surfacing signals[] before the
      // 10s IndianAPI timeout means the dashboard always shows trade
      // candidates immediately, even when the market_data fetch is
      // stuck waiting for upstream.
      //
      // Tier order:
      //   STRICT             confidence>=70, final>=75, rr>=1.5, APPROVED_SIGNAL
      //   RELAXED            >=60/65/1.2, APPROVED_SIGNAL or DEVELOPING_SETUP
      //   SCANNER_CANDIDATES rows that didn't clear maturity gates
      //   NONE               empty — operator sees auto_recovery state instead
      let signalQuality:    'STRICT' | 'RELAXED' | 'SCANNER_CANDIDATES' | 'NONE' =
        finalRows.length > 0 ? 'STRICT' : 'NONE';
      let relaxedUsed       = false;
      let strictTierCount   = finalRows.length;
      let scannerCandidates: any[] = [];
      let usedRelaxedSignals = false;

      if (finalRows.length > 0) {
        // Strict tier (confirmed_snapshots) already produced rows so
        // we never call the closed-market loader. Emit the funnel
        // line anyway so every /api/signals response leaves a grepable
        // [FILTER] trail with the active floors.
        console.log(
          `[FILTER] strict_in=${finalRows.length} strict_out=${finalRows.length} ` +
          `relaxed_in=0 relaxed_out=0 scanner_candidates=0 ` +
          `returned=${finalRows.length} quality=STRICT source=confirmed_snapshots ` +
          `floors_strict=${STRICT_CONFIDENCE_FLOOR}/${STRICT_FINAL_FLOOR}/${STRICT_RR_FLOOR}`,
        );
      }

      if (finalRows.length === 0) {
        try {
          console.log('[DEBUG] confirmed pool empty — querying q365_signals (strict→relaxed→candidates)');
          const closed = await loadClosedMarketSignals({ limit });
          if (closed) {
            signalQuality   = closed.signalQuality;
            relaxedUsed     = closed.relaxedUsed;
            strictTierCount = closed.strictCount;
            scannerCandidates = filterSignalsToNifty500(
              closed.scannerCandidates ?? [],
              'liveScannerCandidates',
            );

            // Spec INSTITUTIONAL §A + §B + §F + §I — the closed-market
            // loader returns rows that may include MEDIUM_CONVICTION /
            // LOW_CONVICTION classifications (relaxed tier rebucketing),
            // rows whose execution_allowed=false, rows that are stale,
            // and rows from the same sector cluster. None of these are
            // shippable as actionable BUY/SELL. Apply the same firewall
            // chain the live (loadConfirmedSignalsBundle) path does:
            //   1. NIFTY-500 lock
            //   2. dropStaleOrConflictingRows  → consistency + whitelist
            //   3. isFreshEnough                → aggressive expiry
            //   4. rotationCmp + sector diversity → no symbol pinning
            const nifty500Closed = filterSignalsToNifty500(
              closed.signals ?? [],
              'liveClosedMarketSignals',
            );
            const consistentClosed = dropStaleOrConflictingRows(
              nifty500Closed as ConfirmedSignalRow[],
              'closedMarketSignals',
            );
            // Spec INSTITUTIONAL §B + market-awareness — when the cash
            // session is closed, the 6h freshness cap blanket-rejects
            // the previous session's confirmed batch (~16:00 IST close
            // → next 09:15 IST open is ~17h). Pass marketOpen=false so
            // the closed-market freshness cap (default 24h) applies and
            // yesterday's institutional signals stay visible until the
            // next pre-open scan replaces them.
            //
            // BUG-FIX (2026-05) — Spec FIX RULE 5: when ALL rows fail
            // the freshness gate (e.g. weekend / multi-day data gap →
            // 6+ day-old candles) but the firewall (NIFTY-500, drop-
            // stale, dropStaleOrConflictingRows) accepted them, ship
            // them with `freshness_state='STALE'` instead of zeroing
            // the response. Without this fallback the dashboard reads
            // `signals=[]` while the engine has perfectly valid (just
            // old) rows internally — exactly the "data are not showing"
            // condition reported.
            const marketIsOpen = getMarketStatus().isOpen;
            const freshClosed = consistentClosed.filter(
              (r) => isFreshEnough(r, { marketOpen: marketIsOpen }),
            );
            let freshnessFallbackApplied = false;
            let workingClosed: ConfirmedSignalRow[] = freshClosed;
            if (freshClosed.length === 0 && consistentClosed.length > 0) {
              freshnessFallbackApplied = true;
              workingClosed = consistentClosed.map((r) => ({
                ...r,
                freshness_state: 'STALE',
              } as ConfirmedSignalRow & { freshness_state: 'STALE' }));
              console.log(
                `[DATA] freshness fallback engaged — shipping ${consistentClosed.length} ` +
                `STALE rows (no fresh candidates available); freshness_state='STALE'`,
              );
            }
            const sortedClosed = [...workingClosed].sort(rotationCmp);
            const sectorBalanced = applySectorDiversity(sortedClosed);
            // Spec ELITE-2026-05 — the closed-market fallback bypasses
            // buildSignalsResponsePayload (it overwrites signals[] in-
            // line below), so apply the elite gate explicitly here. Per
            // spec: "No padding rows. No filler rows. No relaxed mode
            // rows." If every closed-market candidate fails the elite
            // floors, we ship empty rather than degrading the bar.
            const closedElite = applyEliteGate(sectorBalanced);
            const closedSignals = closedElite.approved;
            if (closedElite.enabled) {
              console.log('[ELITE_GATE]', {
                stage:    'closed_market_fallback',
                input:    sectorBalanced.length,
                approved: closedSignals.length,
                dropped:  closedElite.dropped.length,
                bypassed: (closedElite as { bypassed?: boolean }).bypassed === true,
              });
            }
            if (freshnessFallbackApplied) {
              // Tag the response so the UI can render a clear "Stale
              // data" banner instead of silently rendering the rows
              // as if they were live.
              responsePayloadBase = {
                ...responsePayloadBase,
                freshness_state: 'STALE',
              } as typeof responsePayloadBase & { freshness_state: 'STALE' };
            }
            if (closedSignals.length > 0) {
              const newBuy  = closedSignals.filter(
                (r) => String((r as any).direction ?? '').toUpperCase() === 'BUY',
              ).length;
              const newSell = closedSignals.filter(
                (r) => String((r as any).direction ?? '').toUpperCase() === 'SELL',
              ).length;
              responsePayloadBase = {
                ...responsePayloadBase,
                signals:             lite ? closedSignals.map(compactConfirmedSignal) : closedSignals,
                main_signals_count:  closedSignals.length,
                buy_count:           newBuy,
                sell_count:          newSell,
                direction_breakdown: { BUY: newBuy, SELL: newSell },
                count:               closedSignals.length,
                empty_confirmed:     false,
                validation_status:   relaxedUsed ? 'NO_SIGNALS_CONFIRMED' : responsePayloadBase.validation_status,
              };
              // Spec INSTITUTIONAL §B — commit rotation on the actual
              // shipped set. buildSignalsResponsePayload above honoured
              // skipRotationCommit=true so we own the single commit
              // point for this response.
              try { commitRotation(closedSignals as any[]); } catch { /* non-fatal */ }
              usedRelaxedSignals = true;
              console.log(
                `[DATA] FAIL-SAFE relaxed fallback → quality=${signalQuality} ` +
                `rows=${closedSignals.length} buy=${newBuy} sell=${newSell} ` +
                `strict_before=${strictTierCount} relaxed_used=${relaxedUsed} ` +
                `scanner_candidates=${scannerCandidates.length}`,
              );
            } else if (scannerCandidates.length > 0) {
              // Spec FIX RULE 3 (2026-05) — scanner_candidates must
              // map into visible UI rows. Previously this branch only
              // logged and left `signals=[]`, so the dashboard rendered
              // a blank table while the engine had perfectly valid
              // (just early-cycle / sub-floor / stale) rows internally.
              // Promote the scanner candidates into signals[] with a
              // freshness_state='STALE' tag so the operator can see
              // them. Governance is unchanged — the rows were ALREADY
              // accepted as candidates by the closed-market loader's
              // own gates; this is purely a visibility surface change.
              const promotedRaw = (scannerCandidates as ConfirmedSignalRow[]).map((r) => ({
                ...r,
                freshness_state: 'STALE',
                is_scanner_candidate: true,
              } as ConfirmedSignalRow & { freshness_state: 'STALE'; is_scanner_candidate: true }));
              // Spec ELITE-2026-05 — scanner candidates carry
              // freshness_state='STALE' which the elite gate rejects.
              // Per spec "REJECT EVERYTHING ELSE" — scanner candidates
              // must NOT promote into signals[] when ELITE_GATE is on.
              // applyEliteGate handles this naturally: every row will
              // fail freshness_state=stale and the approved set is [].
              const promotedElite = applyEliteGate(promotedRaw);
              const promoted = promotedElite.approved;
              if (promotedElite.enabled) {
                console.log('[ELITE_GATE]', {
                  stage:    'scanner_candidate_promotion',
                  input:    promotedRaw.length,
                  approved: promoted.length,
                  dropped:  promotedElite.dropped.length,
                  bypassed: (promotedElite as { bypassed?: boolean }).bypassed === true,
                });
              }
              const promotedBuy  = promoted.filter(
                (r) => String((r as any).direction ?? '').toUpperCase() === 'BUY',
              ).length;
              const promotedSell = promoted.filter(
                (r) => String((r as any).direction ?? '').toUpperCase() === 'SELL',
              ).length;
              responsePayloadBase = {
                ...responsePayloadBase,
                signals:             lite ? promoted.map(compactConfirmedSignal) : promoted,
                main_signals_count:  promoted.length,
                buy_count:           promotedBuy,
                sell_count:          promotedSell,
                direction_breakdown: { BUY: promotedBuy, SELL: promotedSell },
                count:               promoted.length,
                empty_confirmed:     false,
                freshness_state:     'STALE',
              } as typeof responsePayloadBase & { freshness_state: 'STALE' };
              try { commitRotation(promoted as any[]); } catch { /* non-fatal */ }
              usedRelaxedSignals = true;
              console.log(
                `[DATA] FAIL-SAFE scanner-candidates promoted → ` +
                `count=${promoted.length} buy=${promotedBuy} sell=${promotedSell} ` +
                `freshness_state=STALE`,
              );
            } else {
              // ── Spec NEVER-EMPTY-WHEN-DB-HAS-ROWS (2026-05) ────────
              //
              // Strict/relaxed/scanner tiers all returned 0, but
              // q365_signals may still hold valid (just non-tradable
              // by classification — NO_TRADE / WATCHLIST_ONLY /
              // DEVELOPING_SETUP) rows from the latest scan. When the
              // user reports `funnel.scanned > 0 / signals=[]` the
              // fix is to surface the BEST AVAILABLE row(s) from the
              // pool with `is_relaxed=true` + `is_scanner_candidate=true`
              // so the dashboard renders a non-empty UI even when the
              // engine never promoted anything to APPROVED_SIGNAL.
              //
              // Hard floors retained: never ship invalidated /
              // expired / stop-loss-hit rows. We only relax the
              // CLASSIFICATION gate.
              //
              // Disable via SIGNAL_BEST_AVAILABLE_FALLBACK=0.
              const bestAvailableEnabled = ((
                process.env.SIGNAL_BEST_AVAILABLE_FALLBACK ?? 'true'
              ).trim().toLowerCase() !== '0');
              if (bestAvailableEnabled) {
                try {
                  const bestLimit = Math.min(Math.max(1, limit), 20);
                  // Schema-compat: project only columns that actually
                  // exist in q365_signals. raw_classification /
                  // live_invalidated / execution_allowed are absent on
                  // most schemas — projecting them used to crash with
                  // "Unknown column 'raw_classification' in 'field
                  // list'" and force-empty the UI. q365Project emits
                  // `NULL AS <col>` for missing columns so downstream
                  // code sees the same row shape either way.
                  const q365Cols = await getQ365Columns();
                  const proj = (c: string) => q365Project(q365Cols, c);
                  const hasInvalidationReason = q365Cols.has('invalidation_reason');
                  const hasLiveInvalidated    = q365Cols.has('live_invalidated');
                  const hasFinalScore         = q365Cols.has('final_score');
                  const hasStatus             = q365Cols.has('status');
                  const sql =
                    `SELECT id, symbol, exchange, direction, signal_type,
                            ${proj('scenario_tag')},
                            ${proj('classification')}, ${proj('raw_classification')},
                            entry_price, stop_loss, target1, target2,
                            confidence_score, ${proj('final_score')},
                            risk_reward AS rr_ratio, risk_reward,
                            risk_score, ${proj('stress_survival_score')},
                            ${proj('signal_status')}, ${proj('status')},
                            ${proj('invalidation_reason')}, ${proj('live_invalidated')},
                            ${proj('execution_allowed')}, ${proj('market_regime')},
                            generated_at, ${proj('expires_at')},
                            ${proj('batch_id')}, ${proj('generation_source')}
                       FROM q365_signals
                      WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
                        ${hasInvalidationReason ? `AND COALESCE(invalidation_reason, '') = ''` : ''}
                        ${hasLiveInvalidated ? `AND COALESCE(live_invalidated, 0) = 0` : ''}
                        ${hasStatus ? `AND UPPER(COALESCE(status, 'ACTIVE')) NOT IN
                              ('INVALIDATED','EXPIRED','STOP_LOSS_HIT','TARGET_HIT',
                               'CLOSED','TERMINATED','CANCELLED','REJECTED')` : ''}
                        AND confidence_score IS NOT NULL
                      ORDER BY confidence_score DESC${hasFinalScore ? ', final_score DESC' : ''}, id DESC
                      LIMIT ?`;
                  const { rows: bestRows } = await db.query<any>(sql, [bestLimit]);
                  // Synthesize raw_classification when the column is
                  // absent so downstream consumers that read this
                  // field still see a value. Mirror `classification`
                  // — these rows are explicitly tagged is_relaxed=true
                  // so any NEVER_SHIP gate has already been bypassed
                  // by intent at this layer.
                  if (!q365Cols.has('raw_classification')) {
                    for (const row of bestRows as any[]) {
                      if (row && row.raw_classification == null) {
                        row.raw_classification = row.classification ?? null;
                      }
                    }
                  }
                  const bestN500 = (bestRows as any[]).filter(
                    (r) => isInNifty500(String(r.symbol ?? '')),
                  );
                  if (bestN500.length > 0) {
                    const bestTagged = bestN500.map((r) => ({
                      ...r,
                      is_relaxed:           true,
                      is_scanner_candidate: true,
                      freshness_state:      'STALE',
                    }));
                    const bestBuy = bestTagged.filter(
                      (r) => String(r.direction ?? '').toUpperCase() === 'BUY',
                    ).length;
                    const bestSell = bestTagged.filter(
                      (r) => String(r.direction ?? '').toUpperCase() === 'SELL',
                    ).length;
                    // Derive last_pipeline_run / latest_batch_id from the
                    // shipped rows so the dashboard's "last run" timestamp
                    // is no longer null when the engine has actually
                    // produced data. Falls back to existing freshness
                    // values when the row doesn't carry them.
                    const latestRowTs = bestTagged
                      .map((r) => r.generated_at)
                      .filter((v) => v != null)
                      .map((v) => v instanceof Date ? v.getTime() : Date.parse(String(v).replace(' ', 'T')))
                      .filter((ms) => Number.isFinite(ms))
                      .sort((a, b) => b - a)[0] ?? null;
                    const latestRowIso = latestRowTs != null
                      ? new Date(latestRowTs).toISOString()
                      : null;
                    const derivedBatchId = bestTagged
                      .map((r) => r.batch_id)
                      .find((v) => v != null && v !== '') ?? null;
                    const updatedFreshness = {
                      ...responsePayloadBase.freshness,
                      last_pipeline_run:
                        responsePayloadBase.freshness.last_pipeline_run ?? latestRowIso,
                      signal_latest_generated:
                        responsePayloadBase.freshness.signal_latest_generated ?? latestRowIso,
                      latest_batch_id:
                        responsePayloadBase.freshness.latest_batch_id
                        ?? (derivedBatchId != null ? String(derivedBatchId) : null)
                        ?? syntheticBatchId,
                    };
                    responsePayloadBase = {
                      ...responsePayloadBase,
                      signals:             lite ? bestTagged.map(compactConfirmedSignal) : (bestTagged as any),
                      approved:            lite ? bestTagged.map(compactConfirmedSignal) : (bestTagged as any),
                      main_signals_count:  bestTagged.length,
                      buy_count:           bestBuy,
                      sell_count:          bestSell,
                      direction_breakdown: { BUY: bestBuy, SELL: bestSell },
                      count:               bestTagged.length,
                      empty_confirmed:     false,
                      validation_status:   'NO_SIGNALS_CONFIRMED',
                      freshness_state:     'STALE',
                      freshness:           updatedFreshness,
                      latest_batch_id:
                        responsePayloadBase.latest_batch_id
                        ?? (derivedBatchId != null ? String(derivedBatchId) : null)
                        ?? syntheticBatchId,
                      last_pipeline_run:
                        responsePayloadBase.last_pipeline_run ?? latestRowIso,
                    } as typeof responsePayloadBase & { freshness_state: 'STALE' };
                    try { commitRotation(bestTagged as any[]); } catch { /* non-fatal */ }
                    usedRelaxedSignals = true;
                    signalQuality = 'SCANNER_CANDIDATES';
                    console.log(
                      `[DATA] FAIL-SAFE best-available fallback engaged → ` +
                      `count=${bestTagged.length} buy=${bestBuy} sell=${bestSell} ` +
                      `top_confidence=${bestTagged[0]?.confidence_score ?? '?'} ` +
                      `top_symbol=${bestTagged[0]?.symbol ?? '?'} ` +
                      `(strict/relaxed/scanner all empty)`,
                    );
                  } else {
                    console.log(
                      '[DATA] FAIL-SAFE q365_signals empty across strict/relaxed/candidates ' +
                      '(best-available probe also returned 0 NIFTY-500 rows)',
                    );
                  }
                } catch (err: any) {
                  console.warn(
                    `[DATA] FAIL-SAFE best-available probe failed: ${err?.message ?? String(err)}`,
                  );
                  console.log('[DATA] FAIL-SAFE q365_signals empty across strict/relaxed/candidates');
                }
              } else {
                console.log('[DATA] FAIL-SAFE q365_signals empty across strict/relaxed/candidates');
              }
            }
            // Spec "FIX FINAL SIGNAL VISIBILITY" §5 — explicit [FILTER]
            // funnel line: strict_in (rows scanned by the strict tier)
            // → strict_out (rows that cleared it) → relaxed_in →
            // relaxed_out → returned. Surfaces the exact count drop at
            // each gate so an operator can pinpoint "DB has rows but
            // signals empty" with a single grep.
            const returnedCount = closed.signals?.length ?? 0;
            const relaxedCount = relaxedUsed ? returnedCount : 0;
            const enabledRelaxed =
              ((process.env.SIGNAL_API_ENABLE_RELAXED ?? '').trim().toLowerCase() || 'true');
            console.log(
              `[FILTER] strict_in=${closed.scannedRowCount ?? 0} ` +
              `strict_out=${strictTierCount} ` +
              `relaxed_in=${closed.scannedRowCount ?? 0} ` +
              `relaxed_out=${relaxedCount} ` +
              `scanner_candidates=${scannerCandidates.length} ` +
              `returned=${returnedCount} ` +
              `quality=${signalQuality} ` +
              `relaxed_enabled=${enabledRelaxed} ` +
              `floors_strict=${STRICT_CONFIDENCE_FLOOR}/${STRICT_FINAL_FLOOR}/${STRICT_RR_FLOOR} ` +
              `floors_relaxed=${RELAXED_SIGNAL_FLOORS.confidence}/${RELAXED_SIGNAL_FLOORS.final}/${RELAXED_SIGNAL_FLOORS.rr}`,
            );
          }
        } catch (err: any) {
          console.warn(
            `[DATA] FAIL-SAFE relaxed fallback failed: ${err?.message ?? String(err)}`,
          );
        }
        // Spec INSTITUTIONAL §B — when the closed-market loader did not
        // ship rows (truly empty across strict/relaxed/candidates), the
        // rotation registry must still decay. buildSignalsResponsePayload
        // was called with skipRotationCommit=true above; commit on the
        // empty set here so unshipped symbols decrement their cycles.
        if (!usedRelaxedSignals) {
          try { commitRotation([]); } catch { /* non-fatal */ }
        }
      }

      // ── Spec "FIX INDIANAPI NOT BEING CALLED" §1 + §6 + §8 ────────
      // When the market is OPEN and confirmed signals are empty, the
      // price-view (`market_data`) is backed by a live IndianAPI fetch
      // before falling through to q365_market_close_snapshot.
      //
      // Order now (matches §8 priority):
      //   1. 30s TTL cache                → instant hit on warm cache
      //   2. resolveBatch(NIFTY500 head)  → IndianAPI primary, with
      //                                     a hard timeout so the dev-
      //                                     plan throttle can't hold
      //                                     the request for minutes
      //   3. q365_market_close_snapshot   → ONLY when (1)+(2) empty
      let liveMarketData: any[] = [];
      let liveMarketDataSource: LiveMarketSource = 'none';
      // Captured from the resolver call in the live-empty branch
      // (or the cache hit, if any) so we can attach a coverage label
      // to the response without recomputing from market_data.length.
      let liveCoveragePercent: number | null = null;
      if (finalRows.length === 0) {
        // ── 0. Skip live-empty fan-out when a scan is in flight ────
        // Spec "FIX 81s POLL DURING SCAN" — when /api/run-signal-engine
        // is currently scanning (isInFlight()=true), the live-empty
        // branch fans out to IndianAPI for 5 symbols + retries on a
        // 10s timeout + falls through to q365_market_close_snapshot.
        // That's 81s observed wall-clock for an /api/signals poll —
        // for data the in-flight scan will commit to q365_signals
        // within 30-60s anyway. Skip the fan-out and let the response
        // ship empty + auto_recovery.status=in_flight; the next poll
        // (after the scan commits) returns the real rows.
        const scanInFlight = isScannerInFlight();
        if (scanInFlight) {
          const elapsed = getScannerInFlightElapsedMs();
          console.log(
            `[DATA] live-empty path SKIPPED — scan in flight (elapsed_ms=${elapsed ?? 'n/a'}); ` +
            `next poll after [PIPELINE END] will hit q365_signals directly`,
          );
        }
        // ── 1. Hot cache (30s TTL) ────────────────────────────────
        // Drops cold-poll latency from ~2min to a single Map lookup
        // for every poll within TTL. The first poll inside a TTL
        // window pays the full fan-out; everything after is free.
        const cacheKey = limit;
        const cached = scanInFlight ? null : getLiveMarketCached(cacheKey);
        if (cached) {
          liveMarketData       = cached.data;
          liveMarketDataSource = cached.source;
          console.log(
            `[DATA] live-empty cache hit (age=${Date.now() - cached.ts}ms source=${cached.source} rows=${cached.data.length})`,
          );
        } else if (scanInFlight) {
          // Already logged above — fall through to the snapshot fallback.
        } else if (indianApiBreakerState().state === 'open') {
          // ── 1b. IndianAPI 429 breaker is FULLY open — short-circuit ──
          //
          // Skipped only in the 'open' state (not 'half_open'). In
          // 'half_open', one probe call is allowed through and may
          // close the breaker on success — letting the route fan-out
          // attempt that probe rather than skipping it.
          //
          // When the breaker is open, calling resolveBatch wastes the
          // full LIVE_RESOLVE_TIMEOUT_MS budget: IndianAPI fast-fails,
          // then NSE direct queues sequentially behind its
          // NSE_DIRECT_FALLBACK_MIN_DELAY_MS rate limit (typically
          // 7s/symbol), and the wall-clock cap cuts everything off
          // before the NSE chain finishes.
          //
          // When the breaker is open, skip resolveBatch entirely and
          // fall through to q365_market_close_snapshot below.
          const breakerInfo = indianApiBreakerState();
          console.log(
            `[DATA] live-empty path SKIPPED — IndianAPI breaker ${breakerInfo.state} for ${Math.round(breakerInfo.remainingMs / 1000)}s more; serving directly from snapshot table`,
          );
        } else {
          // ── 2. Live IndianAPI fan-out, time-bounded ────────────
          // Cap fan-out size at min(limit, 5) per "FIX INDIANAPI
          // TIMEOUT" §2 — small batches keep each tick short under
          // the dev-plan throttle. Race against LIVE_RESOLVE_TIMEOUT_MS
          // so a single stalled /stock call doesn't hold the request
          // for the rest of the fan-out.
          const universeHead = getNifty500Symbols().slice(
            0, Math.max(1, Math.min(limit, 5)),
          );
          console.log(
            `[DEBUG] live-empty path → IndianAPI fetch for ${universeHead.length} symbols (timeout=${LIVE_RESOLVE_TIMEOUT_MS}ms)`,
          );

          // Helper that races one resolveBatch call against the
          // wall-clock cap. Returns null on timeout so the caller
          // can decide whether to retry (coverage path) or fall
          // through (snapshot path).
          const resolveWithTimeout = async (
            syms: string[],
            label: string,
          ): Promise<{ resolved: any | null; durationMs: number; timedOut: boolean }> => {
            const t0 = Date.now();
            let timedOut = false;
            try {
              const resolved = await Promise.race([
                resolveBatch(syms, { quiet: false }),
                new Promise<null>((resolve) =>
                  setTimeout(() => { timedOut = true; resolve(null); }, LIVE_RESOLVE_TIMEOUT_MS),
                ),
              ]);
              const durationMs = Date.now() - t0;
              if (timedOut || !resolved) {
                console.warn(
                  `[DEBUG] live-empty resolver timeout (${label}) after ${durationMs}ms — falling through`,
                );
                return { resolved: null, durationMs, timedOut: true };
              }
              console.log(
                `[DEBUG] live-empty resolver (${label}) ${durationMs}ms: provider=${resolved.provider} returned=${resolved.symbolsReturned}/${resolved.symbolsRequested} fallbackUsed=${resolved.fallbackUsed} coverage=${resolved.coveragePercent}% errorCode=${resolved.errorCode ?? 'none'}`,
              );
              return { resolved, durationMs, timedOut: false };
            } catch (err: any) {
              const durationMs = Date.now() - t0;
              console.warn(
                `[DEBUG] live-empty resolver (${label}) threw (${durationMs}ms) — ${err?.message ?? String(err)}`,
              );
              return { resolved: null, durationMs, timedOut: false };
            }
          };

          // First pass.
          // Spec "RELAX DATA QUALITY" §1 — floor lowered 80→50 so a
          // 60–80% coverage response (the dev-plan steady state) is
          // accepted without retry. The retry only fires on truly
          // poor responses (<50%) where it has a real chance of
          // recovering missing symbols. Operators can override via
          // SIGNALS_COVERAGE_RETRY_FLOOR.
          const COVERAGE_RETRY_FLOOR = Math.max(
            0, Math.min(100, Number(process.env.SIGNALS_COVERAGE_RETRY_FLOOR) || 50),
          );
          const firstPass = await resolveWithTimeout(universeHead, 'pass1');
          let resolvedFinal = firstPass.resolved;

          // Coverage-retry. If the first pass came back below the
          // configured floor AND we have time left in the wall clock,
          // fire a single retry on JUST the missing symbols. Bounded
          // at 1 retry so the worst case stays predictable.
          if (
            firstPass.resolved
            && firstPass.resolved.coveragePercent < COVERAGE_RETRY_FLOOR
            && Array.isArray(firstPass.resolved.failedSymbols)
            && firstPass.resolved.failedSymbols.length > 0
            && firstPass.durationMs < LIVE_RESOLVE_TIMEOUT_MS
          ) {
            console.log(
              `[PERF] coverage_below_floor first_pass=${firstPass.resolved.coveragePercent}% floor=${COVERAGE_RETRY_FLOOR}% retrying ${firstPass.resolved.failedSymbols.length} missing symbols`,
            );
            const retryPass = await resolveWithTimeout(firstPass.resolved.failedSymbols, 'pass2-coverage-retry');
            if (retryPass.resolved && retryPass.resolved.snapshots?.size > 0) {
              // Merge retry snapshots into first-pass snapshots map so
              // the downstream mapper sees a unified result.
              const merged = new Map(firstPass.resolved.snapshots);
              for (const [k, v] of retryPass.resolved.snapshots.entries()) {
                merged.set(k, v);
              }
              const totalRequested = universeHead.length;
              const mergedCount    = merged.size;
              resolvedFinal = {
                ...firstPass.resolved,
                snapshots:        merged,
                symbolsReturned:  mergedCount,
                coveragePercent:  totalRequested > 0
                  ? Math.round((mergedCount / totalRequested) * 100) : 0,
                failedSymbols:    universeHead.filter((s) => !merged.has(s)),
              };
              console.log(
                `[PERF] coverage_after_retry=${resolvedFinal.coveragePercent}% (added ${retryPass.resolved.snapshots.size} symbols)`,
              );
            }
          }

          if (resolvedFinal && typeof resolvedFinal.coveragePercent === 'number') {
            liveCoveragePercent = resolvedFinal.coveragePercent;
          }

          if (resolvedFinal && resolvedFinal.snapshots?.size > 0) {
            const provider = resolvedFinal.provider;
            // Resolver returns only the providers we ship as live
            // (indianapi / cache / nse_direct / yahoo_emergency).
            // The closed-market gate path returns 'snapshot' — we
            // already skipped that path because market is open here.
            // Treat 'snapshot' / 'none' defensively as a miss so we
            // never claim live data when none was produced.
            if (
              provider === 'indianapi'
              || provider === 'cache'
              || provider === 'nse_direct'
              || provider === 'yahoo_emergency'
            ) {
              liveMarketDataSource = provider;
              liveMarketData = [...resolvedFinal.snapshots.values()].map((s: any) => ({
                symbol:         s.symbol,
                price:          Number.isFinite(s.price) ? s.price : 0,
                change:         Number.isFinite(s.change) ? s.change : null,
                change_percent: Number.isFinite(s.changePercent) ? s.changePercent : null,
                volume:         Number.isFinite(s.volume) ? s.volume : null,
                open:           Number.isFinite(s.open) ? s.open : null,
                high:           Number.isFinite(s.high) ? s.high : null,
                low:            Number.isFinite(s.low)  ? s.low  : null,
                prev_close:     Number.isFinite(s.prevClose) ? s.prevClose : null,
                timestamp:      new Date(
                                  Number.isFinite(s.timestamp) && s.timestamp > 0
                                    ? s.timestamp : Date.now(),
                                ).toISOString(),
              }));
              console.log(
                `[DATA] live-empty path served by ${provider} → market_data=${liveMarketData.length} coverage=${resolvedFinal.coveragePercent}%`,
              );
            }
          } else if (firstPass.resolved && firstPass.resolved.snapshots?.size === 0) {
            console.log(
              `[DEBUG] fallback triggered → reason=resolver_returned_zero (errorCode=${firstPass.resolved.errorCode ?? 'none'})`,
            );
          }

          // ── 3. q365_market_close_snapshot fallback ─────────────
          // Consulted ONLY after the live path failed to produce rows
          // (timeout, zero return, or throw). This is the "snapshot
          // is LAST ONLY" rule.
          if (liveMarketData.length === 0) {
            console.log('[DEBUG] fallback triggered → reason=live_path_empty, reading q365_market_close_snapshot');
            try {
              const { rows: snapRows } = await db.query<{
                symbol: string; price: string | number;
                change_abs: string | number | null;
                change_pct: string | number | null;
                volume:     string | number | null;
                open_price: string | number | null;
                high_price: string | number | null;
                low_price:  string | number | null;
                prev_close: string | number | null;
                snapshot_ts: Date | string;
              }>(
                `SELECT symbol, price, change_abs, change_pct, volume,
                        open_price, high_price, low_price, prev_close, snapshot_ts
                   FROM q365_market_close_snapshot
                  ORDER BY snapshot_ts DESC, symbol
                  LIMIT ?`,
                [Math.max(1, Math.min(limit, 200))],
              );
              const snapToNum = (v: unknown): number | null => {
                if (v === null || v === undefined || v === '') return null;
                const n = typeof v === 'number' ? v : Number(v);
                return Number.isFinite(n) ? n : null;
              };
              liveMarketData = (snapRows as any[])
                .filter((r) => isInNifty500(String(r.symbol)))
                .map((r) => ({
                  symbol:         String(r.symbol),
                  price:          snapToNum(r.price)      ?? 0,
                  change:         snapToNum(r.change_abs),
                  change_percent: snapToNum(r.change_pct),
                  volume:         snapToNum(r.volume),
                  open:           snapToNum(r.open_price),
                  high:           snapToNum(r.high_price),
                  low:            snapToNum(r.low_price),
                  prev_close:     snapToNum(r.prev_close),
                  timestamp:      r.snapshot_ts instanceof Date
                                    ? r.snapshot_ts.toISOString()
                                    : String(r.snapshot_ts),
                }));
              if (liveMarketData.length > 0) liveMarketDataSource = 'market_close_snapshot';
              console.log(`[DATA] live-empty snapshot fallback → market_data=${liveMarketData.length} emerging=${responsePayloadBase.emerging_count}`);
            } catch (err: any) {
              // Never let a price-view fallback fail the main response.
              console.warn('[/api/signals] live market_data fallback query failed:', err?.message);
            }
          }

          // Cache whatever we produced (live OR snapshot fallback)
          // so the next poll within TTL is a single Map lookup.
          // Empty results are NOT cached — masking a transient
          // upstream blip with cached emptiness would persist the
          // problem for TTL.
          if (liveMarketData.length > 0) {
            putLiveMarketCache(cacheKey, liveMarketData, liveMarketDataSource);
          }
        }
      }
      console.log(`[DATA] signals generated count=${finalRows.length} buy=${buyCount} sell=${sellCount} emerging=${responsePayloadBase.emerging_count}`);

      // ── data_source resolution ───────────────────────────────────
      // Tag once at the end based on what each prior block produced.
      // Priority (§8 + FAIL-SAFE §7):
      //   1. confirmed_signals       → strict pool non-empty
      //   2. q365_signals_relaxed    → relaxed-tier rows surfaced
      //   3. q365_signals_candidates → only candidates, no tradable rows
      //   4. resolver provider       → IndianAPI / cache / NSE / Yahoo served live
      //   5. market_close_snapshot   → snapshot table was the last resort
      const dataSourceTag:
        'confirmed_signals' | 'q365_signals_relaxed' | 'q365_signals_candidates'
        | 'indianapi' | 'cache' | 'nse_direct' | 'yahoo_emergency'
        | 'market_close_snapshot' | 'none' =
        finalRows.length > 0
          ? 'confirmed_signals'
          : usedRelaxedSignals
            ? (relaxedUsed ? 'q365_signals_relaxed' : 'confirmed_signals')
            : scannerCandidates.length > 0
              ? 'q365_signals_candidates'
              : (liveMarketData.length > 0 ? liveMarketDataSource : 'confirmed_signals');

      // Tag the live path with the same `mode` / `data_source` shape
      // the market-closed branch returns so the UI has a single
      // discriminator (`mode`) and never has to inspect both.
      //
      // data_source priority (§8 + FAIL-SAFE §7):
      //   1. confirmed_signals      → finalRows non-empty (strict pool)
      //   2. q365_signals_relaxed   → relaxed-tier surfaced from q365_signals
      //   3. q365_signals_candidates → scanner candidates only
      //   4. resolver provider      → IndianAPI / cache / NSE / Yahoo served live
      //   5. market_close_snapshot  → snapshot table is the LAST resort
      // Spec "RELAX DATA QUALITY" §4 + §6 — coverage label + log.
      // Computed from the resolver's coverage % when the live-empty
      // branch ran; otherwise null → 'NONE' so the field is always
      // populated. Distinct from `signal_quality` which describes the
      // tier (STRICT/RELAXED/SCANNER_CANDIDATES/NONE) the signals[]
      // came from. UI can render either as a banner.
      const coverageQuality = classifyCoverageQuality(liveCoveragePercent);
      // [QUALITY] one-liner — emitted unconditionally so operators can
      // grep for partial-mode decisions without flipping a verbose flag.
      console.log(
        `[QUALITY] coverage=${liveCoveragePercent ?? 'n/a'}% label=${coverageQuality} ` +
        `signal_quality=${signalQuality} signals=${responsePayloadBase.main_signals_count} ` +
        `partial_mode=${coverageQuality === 'LOW' ? 'enabled' : 'disabled'}`,
      );

      // ── ?debug=signals + SIGNAL_INCLUDE_INVALIDATED ──────────────
      //
      // Spec "FORCE SIGNAL VISIBILITY" §5 — diagnostic envelopes that
      // let operators see exactly which filter is hiding rows from the
      // main `signals` array, without changing what the dashboard
      // actually treats as actionable.
      //
      // `?debug=signals` adds a `debug.tiers` count breakdown.
      //
      // `SIGNAL_INCLUDE_INVALIDATED=true` (env opt-in, OFF by default)
      // additionally queries q365_signals for rows whose
      // invalidation_reason is set, attaches them under
      // `invalidated_signals[]` tagged is_invalidated=true. Those rows
      // are NEVER added to the main `signals[]` — invalidated means
      // the engine has determined the original entry/stop/target is
      // no longer valid (live tape moved adversely, validity expired,
      // etc.). Surfacing them is for diagnosis only; the UI must
      // render them with a clear "INVALIDATED — do not trade" banner
      // if it chooses to display them at all.
      const includeInvalidated =
        (process.env.SIGNAL_INCLUDE_INVALIDATED ?? '').trim().toLowerCase() === 'true';
      let debugTiers: any = null;
      let invalidatedSignals: any[] = [];
      // Spec "FIX FINAL SIGNAL VISIBILITY" §4 — `?debug=signals`
      // additionally surfaces EVERY q365_signals row from the latest
      // batch (raw, pre-filter) so an operator can see exactly which
      // floor / classification / invalidation hid each row. The
      // dashboard never reads this — the array is only present when
      // the query param asked for it.
      let debugRawSignals: any[] = [];
      if (debugSignals || includeInvalidated) {
        try {
          const ageHours = resolveClosedSignalsMaxAgeHours();
          const { rows: countRows } = await db.query<{
            total_active:        number;
            invalidated:         number;
            expired:             number;
            developing:          number;
            approved:            number;
            no_trade:            number;
            force_seed_excluded: number;
          }>(
            `SELECT
               SUM(CASE WHEN UPPER(COALESCE(status,'ACTIVE')) IN ('ACTIVE','')
                         AND COALESCE(invalidation_reason,'') = ''
                         AND (expires_at IS NULL OR expires_at > NOW())
                    THEN 1 ELSE 0 END) AS total_active,
               SUM(CASE WHEN COALESCE(invalidation_reason,'') <> ''
                    THEN 1 ELSE 0 END) AS invalidated,
               SUM(CASE WHEN expires_at IS NOT NULL AND expires_at <= NOW()
                    THEN 1 ELSE 0 END) AS expired,
               SUM(CASE WHEN UPPER(COALESCE(signal_status,'')) = 'DEVELOPING_SETUP'
                    THEN 1 ELSE 0 END) AS developing,
               SUM(CASE WHEN UPPER(COALESCE(signal_status,'')) = 'APPROVED_SIGNAL'
                    THEN 1 ELSE 0 END) AS approved,
               SUM(CASE WHEN UPPER(COALESCE(classification,'')) = 'NO_TRADE'
                    THEN 1 ELSE 0 END) AS no_trade,
               SUM(CASE WHEN COALESCE(signal_type,'') = 'force_seed'
                         OR COALESCE(batch_id,'') LIKE 'force_seed%%'
                    THEN 1 ELSE 0 END) AS force_seed_excluded
             FROM q365_signals
             WHERE generated_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
            [ageHours],
          );
          const c = (countRows[0] as any) ?? {};
          debugTiers = {
            window_hours:        ageHours,
            // Pre-filter view of q365_signals.
            q365_signals_window: {
              total_active:        Number(c.total_active        ?? 0),
              invalidated:         Number(c.invalidated         ?? 0),
              expired:             Number(c.expired             ?? 0),
              approved:            Number(c.approved            ?? 0),
              developing:          Number(c.developing          ?? 0),
              no_trade:            Number(c.no_trade            ?? 0),
              force_seed_excluded: Number(c.force_seed_excluded ?? 0),
            },
            // What the response actually surfaced.
            response: {
              strict_signals:     finalRows.length,
              relaxed_signals:    usedRelaxedSignals
                ? Number(responsePayloadBase.main_signals_count) - finalRows.length : 0,
              scanner_candidates: scannerCandidates.length,
              market_data:        liveMarketData.length,
            },
            // Filters that are CURRENTLY hiding rows (the main lever
            // operators ask about). Each filter is documented at its
            // call site in src/lib/signals/closedMarketSignals.ts.
            filters_active: [
              'invalidation_reason IS NULL/empty',
              'expires_at > NOW()',
              `generated_at >= NOW() - INTERVAL ${ageHours} HOUR`,
              'classification != WATCHLIST_ONLY',
              'signal_type != force_seed',
              `confidence_score >= ${
                relaxedUsed
                  ? RELAXED_SIGNAL_FLOORS.confidence
                  : STRICT_CONFIDENCE_FLOOR
              }`,
              `final_score      >= ${
                relaxedUsed
                  ? RELAXED_SIGNAL_FLOORS.final
                  : STRICT_FINAL_FLOOR
              }`,
              `risk_reward      >= ${
                relaxedUsed
                  ? RELAXED_SIGNAL_FLOORS.rr
                  : STRICT_RR_FLOOR
              }`,
            ],
          };

          // Spec "FIX FINAL SIGNAL VISIBILITY" §4 — raw row dump.
          // Returns every active row in the lookback window so an
          // operator can see EXACTLY what's in the table and why each
          // row is or isn't surfaced. The classification / signal_status
          // / invalidation columns are the diagnostic levers; the
          // payload includes them all unedited.
          if (debugSignals) {
            const { rows: rawRows } = await db.query<any>(
              `SELECT id, symbol, exchange, direction, signal_type,
                      classification, entry_price, stop_loss, target1, target2,
                      confidence_score, final_score, risk_reward,
                      opportunity_score, portfolio_fit_score,
                      status, signal_status, invalidation_reason,
                      batch_id, generated_at, expires_at
                 FROM q365_signals
                WHERE generated_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
                ORDER BY generated_at DESC, final_score DESC, confidence_score DESC
                LIMIT ?`,
              [ageHours, Math.max(1, Math.min(limit * 4, 500))],
            );
            debugRawSignals = (rawRows as any[]).map((r) => {
              const cs = Number(r.confidence_score ?? 0);
              const fs = r.final_score == null ? null : Number(r.final_score);
              const rr = r.risk_reward  == null ? null : Number(r.risk_reward);
              const cls    = String(r.classification ?? '').toUpperCase();
              const sstat  = String(r.signal_status ?? '').toUpperCase();
              const status = String(r.status ?? 'ACTIVE').toUpperCase();
              // Per-row reason the strict / relaxed gates would reject
              // it, expressed as the FIRST failing predicate. `null`
              // means the row passes the relaxed predicate end-to-end.
              const reasons: string[] = [];
              if (r.invalidation_reason) reasons.push('invalidated');
              if (r.expires_at && new Date(r.expires_at).getTime() <= Date.now()) reasons.push('expired');
              if (status !== 'ACTIVE' && status !== '') reasons.push(`status=${status}`);
              if (cls === 'NO_TRADE') reasons.push('classification=NO_TRADE');
              if (cls === 'WATCHLIST_ONLY') reasons.push('classification=WATCHLIST_ONLY');
              if (cs < RELAXED_SIGNAL_FLOORS.confidence) reasons.push(`confidence<${RELAXED_SIGNAL_FLOORS.confidence}`);
              if (fs == null || fs < RELAXED_SIGNAL_FLOORS.final) reasons.push(`final<${RELAXED_SIGNAL_FLOORS.final}`);
              if (rr == null || rr < RELAXED_SIGNAL_FLOORS.rr) reasons.push(`rr<${RELAXED_SIGNAL_FLOORS.rr}`);
              if (sstat !== 'APPROVED_SIGNAL' && sstat !== 'DEVELOPING_SETUP') reasons.push(`signal_status=${sstat || 'null'}`);
              return {
                id:                  Number(r.id),
                symbol:              String(r.symbol),
                exchange:            String(r.exchange ?? 'NSE'),
                direction:           String(r.direction),
                signal_type:         r.signal_type ?? null,
                classification:      cls || null,
                entry_price:         Number(r.entry_price),
                stop_loss:           Number(r.stop_loss),
                target1:             r.target1 == null ? null : Number(r.target1),
                target2:             r.target2 == null ? null : Number(r.target2),
                confidence_score:    cs,
                final_score:         fs,
                risk_reward:         rr,
                opportunity_score:   r.opportunity_score   == null ? null : Number(r.opportunity_score),
                portfolio_fit_score: r.portfolio_fit_score == null ? null : Number(r.portfolio_fit_score),
                status:              status,
                signal_status:       sstat || null,
                invalidation_reason: r.invalidation_reason ?? null,
                batch_id:            r.batch_id ?? null,
                generated_at:        r.generated_at instanceof Date ? r.generated_at.toISOString() : String(r.generated_at),
                expires_at:          r.expires_at == null ? null
                                      : (r.expires_at instanceof Date ? r.expires_at.toISOString() : String(r.expires_at)),
                // Diagnostic verdict. `would_pass_relaxed=true` means
                // every relaxed-tier predicate accepts this row — if
                // the API still hides it, the gate is the strict one
                // upstream of relaxed (e.g. confirmed-snapshot strict
                // tier already produced rows so we never fell through).
                would_pass_relaxed:  reasons.length === 0,
                rejection_reasons:   reasons,
              };
            });
            console.log(
              `[DEBUG] ?debug=signals → raw_signals=${debugRawSignals.length} ` +
              `would_pass_relaxed=${debugRawSignals.filter((s) => s.would_pass_relaxed).length}`,
            );
          }

          if (includeInvalidated) {
            const { rows: invRows } = await db.query<any>(
              `SELECT id, symbol, exchange, direction, signal_type,
                      classification, entry_price, stop_loss,
                      target1, confidence_score, final_score, risk_reward,
                      status, signal_status, invalidation_reason,
                      generated_at, expires_at
                 FROM q365_signals
                WHERE COALESCE(invalidation_reason,'') <> ''
                  AND generated_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
                ORDER BY generated_at DESC
                LIMIT ?`,
              [ageHours, Math.max(1, Math.min(limit, 100))],
            );
            invalidatedSignals = (invRows as any[])
              .filter((r) => isInNifty500(String(r.symbol)))
              .map((r) => ({
                id:                  Number(r.id),
                symbol:              String(r.symbol),
                exchange:            String(r.exchange ?? 'NSE'),
                direction:           String(r.direction),
                classification:      r.classification ?? null,
                entry_price:         Number(r.entry_price),
                stop_loss:           Number(r.stop_loss),
                target1:             Number(r.target1),
                confidence_score:    Number(r.confidence_score),
                final_score:         r.final_score == null ? null : Number(r.final_score),
                risk_reward:         r.risk_reward == null ? null : Number(r.risk_reward),
                signal_status:       r.signal_status ?? null,
                invalidation_reason: r.invalidation_reason,
                generated_at:        r.generated_at instanceof Date
                                       ? r.generated_at.toISOString()
                                       : String(r.generated_at),
                expires_at:          r.expires_at instanceof Date
                                       ? r.expires_at.toISOString()
                                       : (r.expires_at ? String(r.expires_at) : null),
                // Hard tag — these rows MUST NOT be treated as actionable.
                is_invalidated:      true,
                _warning:            'INVALIDATED — engine determined original setup is no longer valid. Do not trade.',
              }));
            console.log(
              `[DEBUG] SIGNAL_INCLUDE_INVALIDATED=true → surfacing ${invalidatedSignals.length} invalidated rows for diagnosis (NOT actionable)`,
            );
          }
        } catch (err: any) {
          console.warn('[DEBUG] debug counts probe failed:', err?.message);
        }
      }

      // Spec "EXPOSE REAL SCAN COUNT" — top-level debug_scan block so
      // the /signals dashboard can answer "is the engine scanning all
      // 500 stocks?" without parsing the freshness envelope. Same
      // numbers as freshness.{universe_size, total_scanned, …} but
      // exposed as a flat top-level shape per spec contract. Reads
      // from the freshness envelope built above so no extra DB hop.
      const debugScanUniverse = Number(freshnessOut.freshness.universe_size ?? 0) || 0;
      const debugScanScanned  = Number(freshnessOut.freshness.total_scanned ?? 0) || 0;
      const debugScanPersisted = Number(freshnessOut.freshness.total_persisted ?? 0) || 0;
      const debugScanCoverage =
        debugScanUniverse > 0
          ? Math.round((debugScanScanned / debugScanUniverse) * 1000) / 10
          : 0;
      const debugScan = {
        universe_size:    debugScanUniverse,
        scanned_count:    debugScanScanned,
        approved_count:   Number(responsePayloadBase.main_signals_count ?? 0) || 0,
        persisted_count:  debugScanPersisted,
        coverage_percent: debugScanCoverage,
        latest_batch_id:  freshnessOut.freshness.latest_batch_id ?? null,
        last_pipeline_run: freshnessOut.freshness.last_pipeline_run ?? null,
        is_full_universe_scan: debugScanUniverse > 0 && debugScanScanned >= debugScanUniverse,
      };

      // Spec INSTITUTIONAL §M — explainability funnel + parallel
      // pools. Built unconditionally (cheap: 1 GROUP BY + 3 capped
      // SELECTs against q365_signals). The institutional `signals[]`
      // array stays exactly as the strict gate produced it; these
      // additive fields expose the rest of the engine output so the
      // UI tabs (APPROVED / DEVELOPING / DEFERRED / REJECTED) can
      // render with explicit reason codes per row. NEVER promotes a
      // non-approved row into signals[].
      let funnelBundle: Awaited<ReturnType<typeof buildSignalFunnel>> | null = null;
      try {
        funnelBundle = await buildSignalFunnel({ windowMinutes: 60, poolLimit: 50 });
      } catch (err: any) {
        console.warn(`[FUNNEL] build failed: ${err?.message ?? String(err)}`);
      }
      // ── INSTITUTIONAL_TIER_2026-05 — partition into 5 professional tiers ──
      // The legacy fallback paths above (relaxed override, scanner-candidate
      // promotion, best-available probe) intentionally inject weaker rows
      // into responsePayloadBase.signals so the dashboard never renders
      // empty. The new dashboard model surfaces those weaker rows in
      // dedicated tabs instead, so we partition them out of signals[]
      // and expose them as top-level tier arrays:
      //   Tier 1  EXECUTION_READY      → signals[] (APPROVED tab)
      //   Tier 2  AWAITING_CONFIRMATION → developing[]
      //   Tier 3  EMERGING_OPPORTUNITY  → scanner_candidates[]
      //   Tier 4  MONITOR               → watchlist[]
      //   Tier 5  RISK_RESTRICTED       → risk_restricted[]
      //
      // signals[] becomes strict-only (institutional, highly selective).
      // Empty is acceptable — the empty_state_message field tells the
      // frontend which tier has rows so it can render the "see Awaiting
      // Confirmation" banner.
      const tierPartitionInput: TieredRow[] = [
        ...(responsePayloadBase.signals as unknown as TieredRow[]),
      ];
      const tierPartition = partitionByTier(tierPartitionInput);

      // Pre-existing tier sources from the route's own loaders. These
      // are already in their proper buckets — merge with the partition
      // output and dedupe so the same row doesn't appear in two tiers.
      const dedupKey = (r: TieredRow): string =>
        `${r.symbol ?? r.tradingsymbol ?? '?'}|${(r as { id?: number }).id ?? ''}|${(r as { generated_at?: unknown }).generated_at ?? ''}`;
      const dedupe = <T extends TieredRow>(arr: T[]): T[] => {
        const seen = new Set<string>();
        const out: T[] = [];
        for (const r of arr) {
          const k = dedupKey(r);
          if (seen.has(k)) continue;
          seen.add(k);
          out.push(r);
        }
        return out;
      };
      const stamp = (rows: TieredRow[], tier: SignalTier): TieredRow[] =>
        rows.map((r) => ({ ...r, tier }));

      const tieredApproved   = tierPartition.approved;
      let tieredDeveloping   = dedupe([
        ...tierPartition.developing,
        ...stamp(belowFloorDemoted as unknown as TieredRow[],    'AWAITING_CONFIRMATION'),
        ...stamp(inProgressEnriched as unknown as TieredRow[],   'AWAITING_CONFIRMATION'),
      ]);
      let tieredScannerCandidates = dedupe([
        ...tierPartition.scannerCandidates,
        ...stamp(scannerCandidates as TieredRow[], 'EMERGING_OPPORTUNITY'),
      ]);
      const tieredWatchlist = dedupe(tierPartition.watchlist);
      const tieredRiskRestricted = dedupe([
        ...tierPartition.riskRestricted,
        ...stamp(invalidatedSignals as TieredRow[], 'RISK_RESTRICTED'),
      ]);

      // ── DASHBOARD-PARITY-2026-05 — per-stage aggregation log ────────
      // Production parity audit hook. Operators grep `[TIER_AGGREGATION]`
      // and compare row counts across local vs prod for the same DB
      // state. Empty tier arrays on production while local renders rows
      // shows up immediately here. No data is altered.
      console.log('[TIER_AGGREGATION]', {
        stage:                  'initial',
        approved:               tieredApproved.length,
        developing:             tieredDeveloping.length,
        scanner_candidates:     tieredScannerCandidates.length,
        watchlist:              tieredWatchlist.length,
        risk_restricted:        tieredRiskRestricted.length,
        sources: {
          partition_developing:        tierPartition.developing.length,
          below_floor_demoted:         belowFloorDemoted.length,
          in_progress_enriched:        inProgressEnriched.length,
          partition_scanner:           tierPartition.scannerCandidates.length,
          route_scanner_candidates:    scannerCandidates.length,
          partition_watchlist:         tierPartition.watchlist.length,
          partition_risk:              tierPartition.riskRestricted.length,
          invalidated:                 invalidatedSignals.length,
        },
        tracker_counts: {
          candidate:   trackerCounts.candidate ?? 0,
          developing:  trackerCounts.developing ?? 0,
          mature:      trackerCounts.mature ?? 0,
          promoted:    trackerCounts.promoted ?? 0,
          terminated:  trackerCounts.terminated ?? 0,
        },
      });

      // ── DASHBOARD-PARITY-2026-05 — second-stage maturity-tracker fallback ──
      //
      // Production symptom this closes: `matured=27, promoted=0,
      // score_below_mature` — the maturity worker has 27 in-motion
      // trackers but the strict 75-score promotion gate keeps them out
      // of `q365_confirmed_signal_snapshots`. The primary reader
      // `getInProgressTrackers` filters on `s.decay_state NOT IN
      // ('expired','stale')` and a 6h `last_seen_at` recency cap; both
      // can suppress every row even when `getTrackerCounts` confirms the
      // trackers exist, so production's WATCHLIST / AWAITING tabs go
      // dark while local (different DB state or different decay tags)
      // renders fine. Strict-gate / promotion / scoring logic is
      // untouched; rows surfaced here keep their `is_developing_setup`
      // / `signal_status='DEVELOPING_SETUP'` / `approved=false` tags so
      // they cannot be mistaken for execution-ready signals.
      //
      // Trigger: APPROVED + every other non-rejected tier is empty AND
      // the tracker count says rows exist. Bypass by setting
      // SIGNAL_TIER_FALLBACK_DISABLED=1.
      const tierFallbackDisabled =
        (process.env.SIGNAL_TIER_FALLBACK_DISABLED ?? '').trim().toLowerCase() === '1';
      const nonApprovedTierCount =
        tieredDeveloping.length
        + tieredScannerCandidates.length
        + tieredWatchlist.length;
      const trackerMatureLike =
        (trackerCounts.candidate ?? 0)
        + (trackerCounts.developing ?? 0)
        + (trackerCounts.mature ?? 0);
      if (
        !tierFallbackDisabled
        && tieredApproved.length === 0
        && nonApprovedTierCount === 0
        && trackerMatureLike > 0
      ) {
        try {
          const lenient = await getInProgressTrackersLenient(
            Math.max(1, Math.min(limit * 2, 100)),
          );
          // Drop trackers whose underlying symbol fell out of NIFTY-500
          // (spec §9 — every emitted row must be in the locked universe).
          const lenientN500 = filterSignalsToNifty500(
            lenient as unknown as ConfirmedSignalRow[],
            'maturityTrackerFallback',
          );
          if (lenientN500.length > 0) {
            // Stamp every fallback row as AWAITING_CONFIRMATION so the
            // classifier / frontend tier router never confuses them with
            // execution-ready signals.
            const stampedLenient = stamp(
              lenientN500 as unknown as TieredRow[],
              'AWAITING_CONFIRMATION',
            );
            // Merge into developing[] (the maturity-tracker home tier).
            // Dedupe keys span symbol|id|generated_at so rows that also
            // appear in another tier never double-render.
            tieredDeveloping = dedupe([...tieredDeveloping, ...stampedLenient]);
            console.log('[TIER_FALLBACK_ENGAGED]', {
              source:        'getInProgressTrackersLenient',
              raw_rows:      lenient.length,
              after_nifty500: lenientN500.length,
              added_to_developing: stampedLenient.length,
              reason: 'approved=0 AND non-approved tiers all empty AND tracker_count_active>0',
              tracker_counts: {
                candidate:   trackerCounts.candidate ?? 0,
                developing:  trackerCounts.developing ?? 0,
                mature:      trackerCounts.mature ?? 0,
              },
            });
          } else {
            console.log('[TIER_FALLBACK_NOROWS]', {
              source:    'getInProgressTrackersLenient',
              raw_rows:  lenient.length,
              filtered_nifty500: 0,
              reason: 'lenient probe returned 0 NIFTY-500 rows despite tracker_count_active>0',
            });
          }
        } catch (err: any) {
          console.warn(
            `[TIER_FALLBACK_FAILED] getInProgressTrackersLenient threw: ${err?.message ?? String(err)}`,
          );
        }
      } else if (!tierFallbackDisabled && tieredApproved.length === 0 && nonApprovedTierCount === 0) {
        // Diagnostic: trackerCounts also zero. Confirms the engine isn't
        // producing trackers (different from "trackers exist but readers
        // hid them"). No fallback can synthesize rows that don't exist.
        console.log('[TIER_FALLBACK_SKIPPED]', {
          reason: 'all tiers empty AND tracker_count_active=0 — engine produced no candidates this cycle',
        });
      }

      // ── CONDITIONAL_FALLBACK_2026-05 — high-potential promotion ──
      // When the strict APPROVED tier is empty, promote up to 3
      // strongest emerging/developing candidates that clear the
      // conditional floors (conf ≥ 60, RR ≥ 1.5, executable, not
      // invalidated, freshness not frozen). The promoted rows are
      // tagged is_conditional=true and tier='HIGH_POTENTIAL' so the
      // dashboard renders a clear "Conditional Approval" badge —
      // they are NOT mixed into signals[]. They are ALSO removed
      // from their original tier arrays so they don't double-count
      // (a row showing as "Conditional" on the main tab shouldn't
      // also appear as "Emerging" in the side tab).
      let tieredHighPotential: TieredRow[] = [];
      let conditionalModeActive = false;
      if (tieredApproved.length === 0) {
        const fallbackPool = [...tieredDeveloping, ...tieredScannerCandidates];
        tieredHighPotential = selectHighPotentialFallback(
          fallbackPool, HIGH_POTENTIAL_MAX_ROWS,
        );
        if (tieredHighPotential.length > 0) {
          conditionalModeActive = true;
          // Remove promoted rows from developing[] / scanner_candidates[]
          // by composite key so they appear once on the dashboard.
          const promoted = new Set(tieredHighPotential.map(dedupKey));
          tieredDeveloping        = tieredDeveloping.filter((r)        => !promoted.has(dedupKey(r)));
          tieredScannerCandidates = tieredScannerCandidates.filter((r) => !promoted.has(dedupKey(r)));
          console.log(
            `[CONDITIONAL] fallback engaged → promoted ${tieredHighPotential.length} ` +
            `row${tieredHighPotential.length === 1 ? '' : 's'} from emerging/developing pool ` +
            `(pool=${fallbackPool.length}, floors conf≥${CONDITIONAL_CONFIDENCE_FLOOR} rr≥${CONDITIONAL_RR_FLOOR}, ` +
            `top_symbol=${String((tieredHighPotential[0] as { symbol?: string | null }).symbol ?? '?')})`,
          );
        }
      }

      const tieredBuy  = tieredApproved.filter(
        (r) => String((r as { direction?: string | null }).direction ?? '').toUpperCase() === 'BUY',
      ).length;
      const tieredSell = tieredApproved.filter(
        (r) => String((r as { direction?: string | null }).direction ?? '').toUpperCase() === 'SELL',
      ).length;
      const tieredConditionalBuy  = tieredHighPotential.filter(
        (r) => String((r as { direction?: string | null }).direction ?? '').toUpperCase() === 'BUY',
      ).length;
      const tieredConditionalSell = tieredHighPotential.filter(
        (r) => String((r as { direction?: string | null }).direction ?? '').toUpperCase() === 'SELL',
      ).length;

      const tierCounts = {
        execution_ready:        tieredApproved.length,
        high_potential:         tieredHighPotential.length,
        awaiting_confirmation:  tieredDeveloping.length,
        emerging_opportunity:   tieredScannerCandidates.length,
        monitor:                tieredWatchlist.length,
        risk_restricted:        tieredRiskRestricted.length,
      };

      const emptyStateMessage = buildEmptyStateMessage(
        {
          approved:           tieredApproved,
          developing:         tieredDeveloping,
          scannerCandidates:  tieredScannerCandidates,
          watchlist:          tieredWatchlist,
          riskRestricted:     tieredRiskRestricted,
        },
        tieredHighPotential.length,
      );

      console.log(
        `[TIER] approved=${tierCounts.execution_ready} ` +
        `high_potential=${tierCounts.high_potential} ` +
        `awaiting=${tierCounts.awaiting_confirmation} ` +
        `emerging=${tierCounts.emerging_opportunity} ` +
        `monitor=${tierCounts.monitor} ` +
        `risk=${tierCounts.risk_restricted}` +
        (conditionalModeActive ? ' [CONDITIONAL_MODE]' : '') +
        (emptyStateMessage ? ` empty_msg="${emptyStateMessage}"` : ''),
      );

      // Default tab points to the highest-priority tier with rows.
      // HIGH_POTENTIAL goes ahead of AWAITING/EMERGING because the
      // conditional fallback is meant to land on the main view.
      const defaultTab:
        | 'APPROVED' | 'HIGH_POTENTIAL' | 'AWAITING_CONFIRMATION'
        | 'EMERGING_OPPORTUNITY' | 'MONITOR' | 'RISK_RESTRICTED' | 'REJECTED' =
        tieredApproved.length > 0          ? 'APPROVED'
        : tieredHighPotential.length > 0    ? 'HIGH_POTENTIAL'
        : tieredDeveloping.length > 0       ? 'AWAITING_CONFIRMATION'
        : tieredScannerCandidates.length>0  ? 'EMERGING_OPPORTUNITY'
        : tieredWatchlist.length > 0        ? 'MONITOR'
        : tieredRiskRestricted.length > 0   ? 'RISK_RESTRICTED'
                                            : 'REJECTED';

      // DASHBOARD-PARITY-2026-05 — final aggregation stage log. Matches
      // the [TIER_AGGREGATION] {stage:'initial'} line emitted earlier
      // so an operator can grep one tag family and trace the per-stage
      // shape (initial → post-conditional → final) of the response.
      // `stage=final` reflects what ships on the wire.
      console.log('[TIER_AGGREGATION]', {
        stage:                   'final',
        approved:                tierCounts.execution_ready,
        high_potential:          tierCounts.high_potential,
        developing:              tierCounts.awaiting_confirmation,
        scanner_candidates:      tierCounts.emerging_opportunity,
        watchlist:               tierCounts.monitor,
        risk_restricted:         tierCounts.risk_restricted,
        conditional_mode_active: conditionalModeActive,
        default_tab:             defaultTab,
        empty_state_message:     emptyStateMessage,
      });

      const responsePayload = {
        ...responsePayloadBase,
        // INSTITUTIONAL_TIER_2026-05 — strict-only signals[]. The lite
        // path was already applied inside buildSignalsResponsePayload;
        // we preserve whatever shape was produced there. compactness
        // is preserved because partitionByTier only reads the discrim
        // fields and shallow-clones the rows.
        signals:               tieredApproved as unknown as typeof responsePayloadBase.signals,
        approved:              tieredApproved as unknown as typeof responsePayloadBase.approved,
        main_signals_count:    tieredApproved.length,
        buy_count:             tieredBuy,
        sell_count:            tieredSell,
        direction_breakdown:   { BUY: tieredBuy, SELL: tieredSell },
        count:                 tieredApproved.length,
        empty_confirmed:       tieredApproved.length === 0,
        // Five-tier wire shape — frontend tabs read these directly.
        developing:            tieredDeveloping,
        watchlist:             tieredWatchlist,
        risk_restricted:       tieredRiskRestricted,
        // CONDITIONAL_FALLBACK_2026-05 — Tier 1.5 promotion. When
        // signals[] is empty and the engine produced rows that
        // clear the conditional floors, up to 3 are surfaced here
        // tagged is_conditional=true. The frontend renders these on
        // the main APPROVED tab beneath a "Conditional Approval"
        // banner so the dashboard never feels dead while the strict
        // tier remains pure. Empty array when signals[] is non-empty
        // OR no candidate cleared the conditional floors.
        high_potential:           tieredHighPotential,
        high_potential_buy:       tieredConditionalBuy,
        high_potential_sell:      tieredConditionalSell,
        conditional_mode_active:  conditionalModeActive,
        conditional_floors: {
          confidence: CONDITIONAL_CONFIDENCE_FLOOR,
          rr:         CONDITIONAL_RR_FLOOR,
          max_rows:   HIGH_POTENTIAL_MAX_ROWS,
        },
        tier_counts:           tierCounts,
        empty_state_message:   emptyStateMessage,
        // MATURATION_AUDIT_2026-05 — single-line bottleneck diagnosis
        // an operator can read with `curl /api/signals?action=all | jq
        // .approval_bottleneck`. Names the dominant gate killing rows
        // this cycle and suggests the env var to tune. cause === 'none'
        // means the cycle produced approvals.
        approval_bottleneck:   approvalBottleneck,
        mode:                'live' as const,
        data_source:         dataSourceTag,
        market_data:         liveMarketData,
        debug_scan:          debugScan,
        // Spec INSTITUTIONAL §UX-SIMPLIFY — additive transparency
        // fields. signals[] is unchanged (institutional whitelist).
        // rejected[] is the union of every non-approved row in the
        // window with a per-row rejection_code sub-badge.
        ...(funnelBundle ? {
          funnel:   funnelBundle.funnel,
          rejected: funnelBundle.rejected,
        } : {}),
        default_tab: defaultTab,
        // FAIL-SAFE diagnostic envelope.
        signal_quality:      signalQuality,
        strict_count:        strictTierCount,
        relaxed_used:        relaxedUsed,
        // INSTITUTIONAL_TIER_2026-05 — scanner_candidates ships the
        // tier-stamped + deduped Tier-3 array so the EMERGING tab
        // reads from the same source the partition logic produced.
        scanner_candidates:  tieredScannerCandidates,
        // Diagnostic-only — present only when ?debug=signals OR
        // SIGNAL_INCLUDE_INVALIDATED=true. Never modifies signals[].
        // `debug.raw_signals` is the unfiltered q365_signals dump so
        // an operator can see EVERY row in the lookback window with
        // a per-row `would_pass_relaxed` + `rejection_reasons` annotation.
        ...(debugTiers ? {
          debug: {
            tiers:        debugTiers,
            raw_signals:  debugRawSignals,
            relaxed_floors: RELAXED_SIGNAL_FLOORS,
            strict_floors: {
              confidence: STRICT_CONFIDENCE_FLOOR,
              final:      STRICT_FINAL_FLOOR,
              rr:         STRICT_RR_FLOOR,
            },
          },
        } : {}),
        ...(includeInvalidated ? { invalidated_signals: invalidatedSignals } : {}),
        // Coverage-quality label (separate from signal_quality):
        //   HIGH    >90% IndianAPI returned for the requested set
        //   MEDIUM  70-90%
        //   LOW     50-70%   (partial-mode region)
        //   NONE    <50% or resolver didn't run
        coverage_quality:    coverageQuality,
        coverage_percent:    liveCoveragePercent,
        // Spec follow-up — surface the auto-scan recovery state so an
        // operator looking at this JSON can tell why signals[] is empty
        // without grepping the server console. Fields:
        //   status            'idle' | 'in_flight' | 'completed' | 'failed'
        //                     | 'skipped_cooldown' | 'skipped_inflight'
        //   last_fired_at     ISO of the most recent attempt
        //   last_completed_at ISO of the most recent terminal outcome
        //   last_reason       why the trigger fired (cold-start / null pipeline_run / stale)
        //   last_error        message from the failure if the last run threw
        //   last_result       counts from the last successful run
        auto_recovery: autoScanEnvelope(),
        // FIX-PIPELINE-NOT-TRIGGERING §5 + §8 — explicit diagnostic
        // envelope. `recommendation` tells the operator the next
        // concrete action when the pipeline isn't producing data.
        pipeline_health: pipelineHealthEnvelope({
          lastPipelineRunIso: freshness.last_pipeline_run,
          marketOpen:         true,
          bootstrapInvoked:   bootstrap,
        }),
        // Spec "OPTIMIZE API USAGE" §4 — daily / monthly counters,
        // limits, and percent. The dashboard renders a small bar from
        // `daily_percent`; alerting can hook on `daily_exceeded`.
        api_usage: getApiUsage(),

        // ── FIX FINAL SIGNAL VISIBILITY 2026-05 ──
        lastApiRequestAt: new Date().toISOString(),
        lastSuccessAt:    new Date().toISOString(),
        isBootstrap:      bootstrap,
      };

      // Cache for performance only. Correctness does not depend on
      // the cache: every cached payload was already produced by the
      // institutional gate above and is identical to a fresh fetch
      // from the same DB state.
      //
      // EMPTY payloads are never cached — see freezePut header. They
      // mask state changes (cold-start scan can populate the DB while
      // the cache keeps replaying `signals: []` for FREEZE_TTL_MS) and
      // they prevent the cold-start auto-scan trigger above from
      // firing on every poll. We also actively drop any stale cached
      // entry for this key so a now-empty answer doesn't lose to a
      // previously-cached non-empty one.
      if (finalRows.length > 0) {
        await freezePut(cacheKey, responsePayload);
      } else {
        freezeDrop(cacheKey);
      }

      return NextResponse.json(
        responsePayload,
        { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
      );
    }

    if (action === 'stats') {
      const stats = await getConfirmedSnapshotStats();
      return NextResponse.json(stats);
    }

    // ── Single instrument — stored signal + live revalidation ─────
    //
    // Previously this branch ran the live engine from scratch and
    // returned its verdict directly. That made the stock-detail page
    // disagree with the main /signals table whenever the engine
    // recomputed below threshold (e.g. RATEGAIN: BUY in /signals,
    // REJECTED in /market/RATEGAIN with "Confidence 58 below
    // threshold 60"). revalidateInstrument() is the single source
    // of truth: latest non-invalidated q365_signals row is the
    // displayed signal, live engine is enrichment + revalidation,
    // and a stored↔live disagreement triggers persistent invalidation
    // so the next /api/signals poll drops the row.
    if (action === 'instrument' && (symParam || keyParam)) {
      const identifier = symParam ?? keyParam!;
      const sym  = identifier.includes('|') ? identifier.split('|')[1].toUpperCase() : identifier.toUpperCase();
      const ikey = identifier.includes('|') ? identifier : `NSE_EQ|${sym}`;

      const dbResult = await db.query(
        `SELECT tradingsymbol, exchange, instrument_key FROM instruments
         WHERE tradingsymbol=? OR instrument_key=? LIMIT 1`,
        [sym, ikey]
      ).catch(() => ({ rows: [] }));

      const inst = (dbResult.rows[0] as any) ?? {
        tradingsymbol: sym, exchange: 'NSE', instrument_key: ikey,
      };
      if (!inst.tradingsymbol) {
        return NextResponse.json({ error: 'Instrument not found' }, { status: 404 });
      }

      const result = await revalidateInstrument(
        inst.instrument_key,
        inst.tradingsymbol,
        inst.exchange,
      );

      // 503 only when neither stored nor live produced a usable
      // signal (no_data). Every other path — including a live
      // rejection over a stored APPROVED row — still ships a 200
      // with the revalidation envelope so the UI can render the
      // banner instead of a hard error.
      if (result.revalidation.status === 'no_data') {
        return NextResponse.json(
          { ...result, error: 'No data available' },
          { status: 503 },
        );
      }

      return NextResponse.json(result);
    }

    // Dead `if (action === 'top')` legacy q365_signals branch removed.
    // action='top' is fully handled by the active confirmed-snapshot
    // branch above (line ~1073), which returns before reaching here.

    // Dead `if (action === 'all')` legacy q365_signals branch removed.
    // action='all' is fully handled by the active confirmed-snapshot
    // branch above (line ~1073), which returns before reaching here.

    // ── Strategy breakdown audit for one signal ──────────────────
    if (action === 'breakdowns') {
      const id = Number(searchParams.get('id') ?? searchParams.get('signal_id') ?? '0');
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
      const audit = await getStrategyBreakdowns(id);
      return NextResponse.json(audit);
    }

    // Dedup: duplicate dead `if (action === 'stats')` legacy handler
    // removed; the active confirmed-snapshot stats handler at line
    // ~1442 already returns for action='stats' before reaching here.
    if (action === 'history') {
      const sym = symParam ?? keyParam ?? '';
      if (!sym) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
      const { rows } = await db.query(`
        SELECT direction, signal_type, confidence_score, confidence_band,
               risk_score, risk_band, opportunity_score,
               entry_price, stop_loss, target1, risk_reward,
               market_regime, market_stance, scenario_tag,
               generated_at
        FROM q365_signals
        WHERE symbol=?
        ORDER BY generated_at DESC LIMIT 20
      `, [sym.toUpperCase()]);
      return NextResponse.json({ history: rows, symbol: sym });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err: any) {
    // Log the full stack so "undefined is not a function" tells us
    // which call site is failing, not just the message.
    console.error('[/api/signals]', err?.message, '\n', err?.stack ?? '(no stack)');
    return NextResponse.json({ error: 'Server error', details: err?.message }, { status: 500 });
  }
}
