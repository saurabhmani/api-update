// ════════════════════════════════════════════════════════════════
//  Scanner State — process-local, cross-route shared state
//
//  Two pieces of state need to be visible from BOTH the run handler
//  and the status handler:
//    • inFlight  — a scan is currently executing; a second run
//                  should 409 instead of stacking
//    • lastSummary — the most recent ScannerSummary, surfaced by the
//                    status endpoint without re-querying the DB
//
//  Stored on globalThis under stable symbols so HMR re-imports
//  don't reset the values mid-scan.
//
//  Disk persistence (`.next/scanner-last-summary.json`):
//    setLastSummary writes the summary to disk. On a cold start /
//    process restart, getLastSummary lazily reads it back so the
//    /api/signals freshness probe can still report TRUE scan
//    coverage (≈100%) instead of falling back to the persistence
//    rate (~10%) and confusing operators with a "low coverage"
//    reading. Best-effort — disk failures are silently ignored.
// ════════════════════════════════════════════════════════════════

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import path from 'path';
import type { ScannerSummary } from './customUniverseBatchScanner';

const KEY_IN_FLIGHT            = '__customUniverseScanInFlight';
const KEY_IN_FLIGHT_STARTED_AT = '__customUniverseScanInFlightStartedAt';
const KEY_LAST_SUMMARY         = '__customUniverseScanLastSummary';
const KEY_PROGRESS             = '__customUniverseScanProgress';

/** Default stale-inflight threshold. A pipeline run that hasn't
 *  cleared the flag within this window is treated as stuck and the
 *  next caller force-clears it. Spec "FIX STUCK INFLIGHT LOCK":
 *  elapsed > 30 s ⇒ stale, unconditionally. Aligned with the
 *  no-progress watchdog (`isInFlightStaleByNoProgress`, also 30 s) so
 *  every entry point uses the same wall-clock budget — the previous
 *  60 s general / 30 s no-progress split let `[PIPELINE BLOCKED]
 *  inFlight=true` fire for an extra 30 s after the lock had clearly
 *  wedged. Env-tunable (floor 10 s) for ops who want either a tighter
 *  window or a longer grace period on heavy hardware. */
export const PIPELINE_STALE_INFLIGHT_MS = (() => {
  const raw = Number(process.env.PIPELINE_STALE_INFLIGHT_MS);
  if (Number.isFinite(raw) && raw >= 10_000) return Math.floor(raw);
  return 30_000;
})();

// Disk persistence path. Lives under .next so it gets cleaned by a
// `next build` (we want the latest production artifact) but survives
// a dev-server restart (which is the common case operators hit).
const SUMMARY_DISK_PATH = path.join(
  process.cwd(),
  '.next',
  'scanner-last-summary.json',
);

type Globals = Record<string, unknown>;
const g = globalThis as unknown as Globals;

/** Shape pushed into globals by setProgress; returned by getProgress. */
export interface ScannerProgress {
  done:      number;       // symbols completed so far
  total:     number;       // total symbols in this run
  startedAt: number;       // ms epoch — used by the UI to compute elapsed
  updatedAt: number;       // ms epoch — used to detect a stalled scan
  lastSymbol: string | null;
}

export function isInFlight(): boolean {
  return g[KEY_IN_FLIGHT] === true;
}

/** Wall-clock timestamp (ms epoch) recorded by the most recent
 *  `setInFlight(true)` call. Null when the flag is currently false
 *  (no recorded start). Used by the stale-watchdog to decide whether
 *  a long-stuck flag should be force-cleared. */
export function getInFlightStartedAt(): number | null {
  const raw = g[KEY_IN_FLIGHT_STARTED_AT];
  return typeof raw === 'number' && raw > 0 ? raw : null;
}

export function setInFlight(v: boolean): void {
  g[KEY_IN_FLIGHT] = v;
  // Spec STEP 1 — record the wall-clock at flag-set time so the
  // stale watchdog can compute elapsed without depending on the
  // route's autoScanState (which is not authoritative when a manual
  // /api/run-signal-engine run is in flight). Cleared on release.
  if (v === true) {
    g[KEY_IN_FLIGHT_STARTED_AT] = Date.now();
  } else {
    g[KEY_IN_FLIGHT_STARTED_AT] = null;
  }
}

/** Returns elapsed ms since the in-flight flag was set, or null when
 *  the flag is currently false / no start recorded. */
export function getInFlightElapsedMs(): number | null {
  const startedAt = getInFlightStartedAt();
  if (startedAt == null) return null;
  return Math.max(0, Date.now() - startedAt);
}

/**
 * Returns a combined state object for the scanner. 
 * Used by custom universe run/status routes.
 */
export function getScannerState() {
  return {
    inFlight: isInFlight(),
    status: isInFlight() ? 'running' : 'idle',
    startedAt: getInFlightStartedAt(),
    elapsedMs: getInFlightElapsedMs(),
  };
}

/**
 * Updates the global scanner state.
 */
export function setScannerState(state: { inFlight: boolean; status?: string; batchId?: string }) {
  setInFlight(state.inFlight);
}

/** True when the flag is set AND has been set longer than
 *  `thresholdMs` (default `PIPELINE_STALE_INFLIGHT_MS`). When this
 *  returns true the in-flight gate at every entry point should
 *  force-clear the flag, log [PIPELINE RESET], and proceed with a
 *  fresh run. */
export function isInFlightStale(
  thresholdMs: number = PIPELINE_STALE_INFLIGHT_MS,
): boolean {
  if (!isInFlight()) return false;
  const elapsed = getInFlightElapsedMs();
  if (elapsed == null) {
    // Flag set but timestamp missing — treat as stale (defensive
    // path for HMR / pre-fix flag values that survived a reload
    // without a paired startedAt).
    return true;
  }
  return elapsed > thresholdMs;
}

/** Stricter "no-progress" watchdog. Spec "HARD RESET STALE LOCK":
 *  inFlight=true AND no progress for >30s ⇒ force reset.
 *
 *  Returns true ONLY when the lock is held but Phase 1 never ticked
 *  the per-symbol counter (progress is null OR done===0). After Phase
 *  1 records its first symbol the watchdog goes quiet — Phase 1 calls
 *  `clearProgress()` on its way out, and a null progress AFTER Phase 1
 *  legitimately means "Phase 2/3/4 are running, no per-symbol counter
 *  to update", so we'd false-positive a healthy run. The threshold
 *  guard (`elapsed > thresholdMs`) prevents catching a brand-new run
 *  before Phase 1 has had time to fetch its first candle batch.
 *
 *  Default threshold = 30 s, env-tunable via PIPELINE_NO_PROGRESS_MS
 *  (floor 10 s). On cold-start production hardware Phase 1's candle
 *  prefetch can take 30-60 s before the global progress counter ticks,
 *  triggering an undeserved force-reset. Uncatchable cases (elapsed
 *  timestamp missing) fall through to `isInFlightStale` instead. */
export const PIPELINE_NO_PROGRESS_MS = (() => {
  const raw = Number(process.env.PIPELINE_NO_PROGRESS_MS);
  if (Number.isFinite(raw) && raw >= 10_000) return Math.floor(raw);
  return 30_000;
})();
export function isInFlightStaleByNoProgress(
  thresholdMs: number = PIPELINE_NO_PROGRESS_MS,
): boolean {
  if (!isInFlight()) return false;
  const elapsed = getInFlightElapsedMs();
  if (elapsed == null || elapsed < thresholdMs) return false;
  const p = getProgress();
  // Lock held >30s but Phase 1 has not registered a single symbol —
  // execution never started.
  if (!p) return true;
  if (p.done <= 0) return true;
  return false;
}

/** Force-clear the in-flight flag and progress in one call. Logs the
 *  spec-mandated [PIPELINE RESET] line so the operator sees the
 *  watchdog firing. Cheap to call defensively from any entry point —
 *  no-op when the flag is already clear.
 *
 *  Pass `tag='FORCE RESET'` for the no-progress watchdog (spec
 *  "HARD RESET STALE LOCK" wants the dedicated [PIPELINE FORCE RESET]
 *  marker in that path) — defaults to the standard [PIPELINE RESET]. */
export function forceClearInFlight(
  reason: string,
  tag: 'RESET' | 'FORCE RESET' = 'RESET',
): void {
  const elapsed = getInFlightElapsedMs();
  console.warn(
    `[PIPELINE ${tag}] stale lock detected — force clearing ` +
    `(elapsed_ms=${elapsed ?? 'n/a'} threshold_ms=${PIPELINE_STALE_INFLIGHT_MS} reason="${reason}")`,
  );
  setInFlight(false);
  clearProgress();
}

export function setLastSummary(s: ScannerSummary): void {
  g[KEY_LAST_SUMMARY] = s;
  // Synchronous + atomic disk write. Earlier the write was async
  // fire-and-forget, but the CLI scanner process exits as soon as
  // runCustomUniverseScan resolves — often before the async write
  // flushed, leaving a 0-byte file on disk. Sync write blocks the
  // process exit until the data is actually on disk. Atomic rename
  // ensures readers never see a half-written file.
  try {
    const dir = path.dirname(SUMMARY_DISK_PATH);
    try { mkdirSync(dir, { recursive: true }); } catch { /* exists */ }
    const tmp = SUMMARY_DISK_PATH + '.tmp';
    writeFileSync(tmp, JSON.stringify(s), 'utf8');
    renameSync(tmp, SUMMARY_DISK_PATH);
  } catch {
    /* swallow — disk failure must not break the scan */
  }
}

export function getLastSummary(): ScannerSummary | null {
  const s = g[KEY_LAST_SUMMARY];
  if (s && typeof s === 'object') return s as ScannerSummary;
  // Cold path — try the disk fallback once and hydrate the global.
  // Sync read here is intentional: this is called from the request
  // path (freshness probe) and we want the answer in the current
  // tick. The file is small (<1 KB) so the cost is negligible.
  try {
    if (existsSync(SUMMARY_DISK_PATH)) {
      const raw = readFileSync(SUMMARY_DISK_PATH, 'utf8');
      const parsed = JSON.parse(raw) as ScannerSummary;
      if (parsed && typeof parsed === 'object' && parsed.batchId) {
        g[KEY_LAST_SUMMARY] = parsed;   // hydrate globals so we don't re-read every call
        return parsed;
      }
    }
  } catch { /* ignore — corrupt or missing file */ }
  return null;
}

/**
 * Live scan progress. Updated by the run route's onProgress callback
 * after each symbol completes; read by the status route + the
 * /signals page so the dashboard can show "Scanning X / 2767" while
 * an auto-rebuild runs.
 *
 * Lives on globalThis so it survives Next's HMR re-imports — without
 * that, every code change during dev would zero out an in-flight
 * scan's progress display.
 */
export function setProgress(done: number, total: number, lastSymbol: string | null): void {
  const prev = g[KEY_PROGRESS] as ScannerProgress | undefined;
  const startedAt = prev?.startedAt ?? Date.now();
  g[KEY_PROGRESS] = {
    done,
    total,
    startedAt,
    updatedAt: Date.now(),
    lastSymbol,
  } satisfies ScannerProgress;
}

export function getProgress(): ScannerProgress | null {
  const p = g[KEY_PROGRESS];
  return (p && typeof p === 'object') ? (p as ScannerProgress) : null;
}

/** Called by the run route in the finally block so a fresh scan
 *  starts with a zeroed counter, not the residue from the prior run. */
export function clearProgress(): void {
  g[KEY_PROGRESS] = null;
}
