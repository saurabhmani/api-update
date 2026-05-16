// ════════════════════════════════════════════════════════════════
//  freshnessService — build the `freshness` envelope, resolve the
//  synthetic batch id, and emit the [SIGNAL FUNNEL] log line.
//
//  Extracted from src/app/api/signals/route.ts. Behaviour is a
//  byte-for-byte port of the inline implementation; nothing here
//  is new logic.
//
//  Why this lives in its own file:
//    - The freshness object aggregates 4+ async sources (snapshot
//      freshness probe, candle latest ts, tracker counts, scanner
//      batch probe) — keeping the assembly out of the route handler
//      makes the action='top'/'all' branch readable.
//    - The same envelope shape is used by both the HTTP route and
//      (eventually) any diagnostic surface — single source of truth.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { getMarketDataHealth } from '@/lib/marketData/marketDataHealth';
import { getPipelineHeartbeat } from '@/lib/marketData/providers/batchScheduler';

/** Shape of the upstream snapshot freshness probe. Mirrors what
 *  `getConfirmedSnapshotFreshness()` returns; extra fields are
 *  passed through. */
export interface SnapshotFreshnessRaw {
  latest_confirmed_at:  string | null;
  latest_confirmed_ms:  number | null;
  active_count:         number;
  total_lifetime:       number;
}

export interface TrackerCounts {
  candidate?:   number;
  developing?:  number;
  mature?:      number;
  promoted?:    number;
  terminated?:  number;
  total?:       number;
}

export type ScannerEngineKind =
  | 'scanner'    // cuni-…  custom-universe scanner (Yahoo batch fan-out)
  | 'phase4'     // batch_…/phase4… signal-engine Phase-4 pipeline
  | 'bootstrap'  // nse_bootstrap_… cold-start NIFTY-500 seeder
  | 'inproc'     // inproc:… in-process regen worker
  | 'script'     // scripts:… ad-hoc CLI generator
  | 'unknown';

/** Kite health snapshot — surfaces auth status + WS/REST stream state // @deprecated marker
 *  directly on the API response so an empty signals list explains
 *  itself ("token expired" vs "market closed" vs "no data"). */
export interface KiteHealth { // @deprecated marker
  /** Aggregate state — OK | DEGRADED | FAIL. */
  health:               'OK' | 'DEGRADED' | 'FAIL';
  /** What's currently feeding live prices. After the IndianAPI
   *  cutover this is 'indianapi' | 'yahoo' | 'none'; the legacy // @deprecated marker
   *  values are kept on the union for backwards compat with older
   *  consumers that still read them. */
  source:               'indianapi' | 'yahoo' | 'kite_ws' | 'kite_rest' | 'kite' | 'none'; // @deprecated marker
  /** True when the WS reports loginRequired (token expired). */
  login_required:       boolean;
  /** WS state — idle | connecting | open | closed. */
  ws_state:             string;
  /** ms since the last tick arrived; null if no tick has ever arrived. */
  last_tick_age_ms:     number | null;
  /** Number of symbols currently subscribed on the ticker. */
  subscribed_count:     number;
  /** Cumulative reconnect attempts since process start. */
  reconnect_attempts:   number;
  /** Last error string emitted by the WS, if any. */
  last_error:           string | null;
  /** Operator-readable single-word summary. */
  status_label:         'streaming' | 'rest_only' | 'reconnecting' | 'login_required' | 'no_credentials' | 'closed';
  /** Human-readable, dashboard-ready explanation. The frontend can
   *  render this verbatim — no status_label → text mapping required. */
  message:              string;
}

/** @deprecated use KiteHealth — alias kept so callers that imported the
 *  legacy name continue to compile. */
export type YahooHealth = KiteHealth; // @deprecated marker

export interface FreshnessEnvelope {
  server_now:                       string;
  latest_confirmed_at:              string | null;
  last_pipeline_run:                string | null;
  signal_latest_generated:          string | null;
  signal_age_minutes:               number | null;
  active_count:                     number;
  total_lifetime:                   number;
  total_stored_signals:             number;
  candle_latest_ts:                 string | null;
  candle_age_hours:                 number | null;
  market_open:                      boolean;
  data_source:                      string;
  tracker_counts:                   TrackerCounts;
  in_progress_count:                number;
  last_validation_time:             string;
  latest_batch_id:                  string | null;
  latest_batch_engine_kind:         ScannerEngineKind;
  latest_batch_symbols:             number | null;
  latest_batch_persistence_percent: number | null;
  persistence_percent:              number | null;
  scan_coverage_percent:            number | null;
  total_persisted:                  number | null;
  total_scanned:                    number | null;
  universe_size:                    number | null;
  /** Kite health — populated on every response so an empty signals // @deprecated marker
   *  payload tells the operator exactly why (token expired, WS not
   *  streaming, market closed, or genuinely no data). */
  kite_health:                      KiteHealth; // @deprecated marker
  /** @deprecated alias for kite_health — kept so existing UI consumers
   *  that read freshness.yahoo_health don't need an immediate update. */ // @deprecated marker
  yahoo_health:                     KiteHealth; // @deprecated marker
}

export interface BuildFreshnessInput {
  freshnessRaw:         SnapshotFreshnessRaw;
  enrichedLength:       number;
  inProgressLength:     number;
  trackerCounts:        TrackerCounts;
  fallbackUsed:         boolean;
  fallbackBatchTs:      number | null;
}

export interface BuildFreshnessOutput {
  freshness:            FreshnessEnvelope;
  scannerBatchId:       string | null;
  scannerEngineKind:    ScannerEngineKind;
}

/** Probe `market_data_daily` for the latest candle ts (epoch ms),
 *  null on error. Cheap; non-blocking on failure. */
async function probeLatestCandleMs(): Promise<number | null> {
  try {
    const r = await db.query(
      `SELECT UNIX_TIMESTAMP(MAX(ts)) AS ts FROM market_data_daily`,
    );
    const ts = (r.rows[0] as any)?.ts;
    return ts != null ? Number(ts) * 1000 : null;
  } catch {
    return null;
  }
}

/** Probe q365_signals for the most-recently-started batch. Returns
 *  null on miss/error.
 *
 *  Originally only used when the snapshot fallback fired and the live
 *  dashboard banner needed scanner-side coverage data. Now also
 *  consumed by the closed-market path in /api/signals/route.ts so the
 *  off-hours freshness envelope can surface latest_batch_id /
 *  scanner_engine_kind / latest_batch_symbols instead of leaving them
 *  null over the weekend. Exported for that reason — the route layer
 *  imports it directly and stamps the result into its closed-market
 *  payload. */
export async function probeScannerBatch(opts: {
  /** Look-back window in hours for the GROUP BY scan. Defaults to 24h
   *  to keep the live-path probe cheap on a wide table. The
   *  closed-market path passes a wider window (e.g. 72h) so a Sunday
   *  poll still surfaces Friday's batch metadata in the freshness
   *  envelope. Floored at 1, ceiling 168 (one week — beyond which the
   *  result isn't operationally meaningful). */
  windowHours?: number;
} = {}): Promise<{
  scannerBatchId:    string | null;
  scannerEngineKind: ScannerEngineKind;
  scannerLatestSymbols: number | null;
}> {
  let scannerBatchId:    string | null = null;
  let scannerEngineKind: ScannerEngineKind = 'unknown';
  let scannerLatestSymbols: number | null = null;
  const windowHours = Math.max(1, Math.min(168,
    Math.floor(Number(opts.windowHours ?? 24)),
  ));
  try {
    // ORDER BY MIN(generated_at) DESC — pick the most-recently
    // STARTED batch. ORDER BY MAX(generated_at) lets a long-running
    // older batch's tail row win over a fresher batch's early rows.
    // Window-restrict so the GROUP BY stays cheap on a wide table;
    // tunable so weekend / post-holiday polls span the prior session.
    const head = await db.query<{ batch_id: string | null }>(
      `SELECT batch_id
         FROM q365_signals
        WHERE batch_id IS NOT NULL
          AND generated_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
        GROUP BY batch_id
        ORDER BY MIN(generated_at) DESC LIMIT 1`,
      [windowHours],
    );
    const headRow = (head.rows[0] as any) ?? {};
    scannerBatchId = headRow.batch_id ?? null;
    if (scannerBatchId) {
      // Prefix → engine-kind. Add new producers here as they appear in
      // q365_signals.batch_id; keep the literal-string starts-with form
      // so the type-narrowed return remains decidable at compile time.
      scannerEngineKind =
        scannerBatchId.startsWith('cuni-')          ? 'scanner'
      : scannerBatchId.startsWith('batch_')         ? 'phase4'
      : scannerBatchId.startsWith('phase4')         ? 'phase4'
      : scannerBatchId.startsWith('nse_bootstrap_') ? 'bootstrap'
      : scannerBatchId.startsWith('inproc:')        ? 'inproc'
      : scannerBatchId.startsWith('scripts:')       ? 'script'
      :                                                'unknown';
      const symRes = await db.query<{ c: number }>(
        `SELECT COUNT(DISTINCT symbol) AS c FROM q365_signals WHERE batch_id = ?`,
        [scannerBatchId],
      );
      scannerLatestSymbols = Number((symRes.rows[0] as any)?.c ?? 0);
    }
  } catch (err: any) {
    console.warn('[API/signals] scanner batch probe failed:', err?.message);
  }
  return { scannerBatchId, scannerEngineKind, scannerLatestSymbols };
}

/** Build a Kite health snapshot from the WS ticker state + token check. // @deprecated marker
 *  Pure read; never mutates state. */
function probeKiteHealth(): KiteHealth { // @deprecated marker
  const h = getMarketDataHealth();
  let status_label: KiteHealth['status_label']; // @deprecated marker
  let message: string;

  if (h.health === 'FAIL' && h.source === 'none') {
    status_label = h.ws.loginRequired ? 'login_required' : 'no_credentials';
    message = h.reason;
  } else if (h.source === 'indianapi') {
    // Post-IndianAPI cutover: an IndianAPI source maps to streaming-
    // equivalent for the legacy status_label union.
    status_label = h.health === 'OK' ? 'streaming' : 'rest_only';
    message = h.reason;
  } else if (h.source === 'yahoo') { // @deprecated marker
    status_label = 'rest_only';
    message = h.reason;
  } else {
    status_label = 'closed';
    message = h.reason;
  }

  return {
    health:               h.health,
    source:               h.source,
    login_required:       h.ws.loginRequired,
    ws_state:             h.ws.state,
    last_tick_age_ms:     h.lastTickAgeMs,
    subscribed_count:     h.subscribedCount,
    reconnect_attempts:   h.ws.reconnectAttempts,
    last_error:           h.ws.lastError,
    status_label,
    message,
  };
}

/** @deprecated alias kept for callers that imported the legacy probe
 *  name. New code should call `probeKiteHealth()`. */ // @deprecated marker
function probeYahooHealth(): KiteHealth { // @deprecated marker
  return probeKiteHealth(); // @deprecated marker
}

/** Look up the configured Phase-1 universe size for coverage % math.
 *  Lazy-imported to avoid load-time coupling with the engine config.
 *  Exported so the closed-market freshness path can compute
 *  `scan_coverage_percent` off-hours without duplicating the import. */
export async function loadUniverseSize(): Promise<number | null> {
  try {
    const { DEFAULT_PHASE1_CONFIG } = await import(
      '@/lib/signal-engine/constants/signalEngine.constants'
    );
    return DEFAULT_PHASE1_CONFIG.universe.length;
  } catch {
    return null;
  }
}

/** Build the freshness envelope returned to the dashboard. Pure
 *  composition — all I/O is via the helper probes above. */
export async function buildFreshness(
  input: BuildFreshnessInput,
): Promise<BuildFreshnessOutput> {
  const {
    freshnessRaw,
    enrichedLength,
    inProgressLength,
    trackerCounts,
    fallbackUsed,
    fallbackBatchTs,
  } = input;

  const candleMs = await probeLatestCandleMs();

  // Spec FIX-DATA-PIPELINE §4: when no signals have been promoted yet,
  // surface the pipeline heartbeat so `last_pipeline_run` is never
  // null while the engine is actually running. The heartbeat is bumped
  // every 60s by `runHeartbeatTier()` (or by any successful tier).
  const heartbeat = await getPipelineHeartbeat().catch(() => null);

  // BUG-FIX (2026-05) — final fallback: when confirmed_snapshots is
  // empty AND the closed-market loader didn't fire AND Redis is
  // unavailable (heartbeat null), but the scanner has actually
  // produced rows in q365_signals, surface that timestamp so
  // last_pipeline_run is never null while the engine is alive. This
  // closes the production gap reported as "last_pipeline_run remains
  // null" — operators were seeing a healthy q365_signals table with
  // a null pipeline timestamp because every higher-priority probe was
  // missing. One indexed scalar query, capped to a 24h window so the
  // ORDER BY is bounded.
  let q365LatestMs: number | null = null;
  if (
    freshnessRaw.latest_confirmed_ms == null
    && fallbackBatchTs == null
    && (heartbeat?.at ?? null) == null
  ) {
    try {
      const { rows } = await db.query<{ ts: Date | string | null }>(
        `SELECT MAX(generated_at) AS ts FROM q365_signals
          WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
      );
      const tsRaw = (rows[0] as any)?.ts;
      if (tsRaw) {
        const ms = tsRaw instanceof Date
          ? tsRaw.getTime()
          : Date.parse(String(tsRaw).replace(' ', 'T'));
        if (Number.isFinite(ms)) q365LatestMs = ms;
      }
    } catch (err: any) {
      // Non-fatal — the field stays null exactly as before this fix.
      console.warn('[freshness] q365_signals MAX(generated_at) fallback failed:', err?.message);
    }
  }

  const effectiveLatestMs =
    freshnessRaw.latest_confirmed_ms
    ?? fallbackBatchTs
    ?? heartbeat?.at
    ?? q365LatestMs
    ?? null;
  const effectiveLatestIso = effectiveLatestMs
    ? new Date(effectiveLatestMs).toISOString()
    : null;

  // Always probe the scanner state — these fields tell the operator
  // whether the scanner has run at all, independent of whether
  // anything has been promoted to q365_confirmed_signal_snapshots.
  // Previously gated on `fallbackUsed`, but the fallback path was
  // removed (route.ts: "Fallback path: REMOVED per spec"), so the
  // gate effectively always evaluated to false → latest_batch_id /
  // universe_size / total_persisted were ALWAYS null in the
  // response, making it impossible to tell "scanner never ran"
  // apart from "scanner ran but lifecycle promotion didn't fire".
  // Both probes are cheap (one indexed COUNT each, 24h window).
  const probe = await probeScannerBatch();
  const scannerBatchId       = probe.scannerBatchId;
  const scannerEngineKind    = probe.scannerEngineKind;
  const scannerLatestSymbols = probe.scannerLatestSymbols;
  const scannerUniverseSize  = await loadUniverseSize();

  const scannerPersistencePct =
    scannerUniverseSize && scannerUniverseSize > 0 && scannerLatestSymbols != null
      ? Math.round((scannerLatestSymbols / scannerUniverseSize) * 1000) / 10
      : null;

  const freshness: FreshnessEnvelope = {
    server_now:               new Date().toISOString(),
    latest_confirmed_at:      freshnessRaw.latest_confirmed_at,
    last_pipeline_run:        effectiveLatestIso,
    signal_latest_generated:  effectiveLatestIso,
    signal_age_minutes:       effectiveLatestMs
      ? Math.round((Date.now() - effectiveLatestMs) / 60_000)
      : null,
    active_count:             freshnessRaw.active_count,
    total_lifetime:           freshnessRaw.total_lifetime,
    total_stored_signals:     fallbackUsed ? enrichedLength : freshnessRaw.total_lifetime,
    candle_latest_ts:         candleMs ? new Date(candleMs).toISOString() : null,
    candle_age_hours:         candleMs ? Math.round((Date.now() - candleMs) / 3_600_000 * 10) / 10 : null,
    market_open:              getMarketStatus().isOpen,
    data_source:              fallbackUsed ? 'q365_signals_fallback' : 'confirmed_snapshots',
    tracker_counts:           trackerCounts,
    in_progress_count:        inProgressLength,
    // Scanner / batch / coverage banner fields — populated only
    // when the fallback fired.
    last_validation_time:               new Date().toISOString(),
    latest_batch_id:                    scannerBatchId,
    latest_batch_engine_kind:           scannerEngineKind,
    latest_batch_symbols:               scannerLatestSymbols,
    // Spec "FIX NULL METRICS" / "ensure pipeline metrics never null".
    // probeScannerBatch returns null when no batch is found in the
    // 24h window (cold start, or pipeline ran with zero approved
    // signals). Coalesce to 0 — the truthful value when the pipeline
    // has scanned but persisted nothing — instead of null. Frontend
    // consumers and dashboards interpret 0 unambiguously; null
    // forces every reader to add its own `?? 0` defensive coalesce.
    // The `latest_batch_*` identity fields stay null when absent so
    // the dashboard can still distinguish "no batch yet" from "empty
    // batch" via the id alone.
    latest_batch_persistence_percent:   scannerPersistencePct ?? 0,
    persistence_percent:                scannerPersistencePct ?? 0,
    scan_coverage_percent:              scannerPersistencePct ?? 0,
    total_persisted:                    scannerLatestSymbols ?? 0,
    total_scanned:                      scannerLatestSymbols ?? 0,
    universe_size:                      scannerUniverseSize ?? 0,
    // Kite health — read every response so an empty signals payload // @deprecated marker
    // explains why (token expired / WS reconnecting / market closed).
    // `yahoo_health` is the legacy alias of `kite_health`; both point // @deprecated marker
    // at the same probe result so existing UI consumers keep working.
    kite_health:                        probeKiteHealth(), // @deprecated marker
    yahoo_health:                       probeKiteHealth(), // @deprecated marker
  };

  return { freshness, scannerBatchId, scannerEngineKind };
}

/** Synthetic batch id for the response envelope. Confirmed-snapshots
 *  have no batch column, so we tag with the latest confirmed_at
 *  timestamp; falls back to scannerBatchId, then to a heartbeat
 *  derived id, then null. The frontend `acceptResponse()` compares
 *  lexicographically — ISO timestamps are correctly ordered.
 *
 *  Heartbeat fallback (Spec FIX-DATA-PIPELINE §4): on a cold-start /
 *  fresh DB where neither confirmed snapshots nor q365_signals batches
 *  exist, the heartbeat tag (`heartbeat:<iso>`) keeps `latest_batch_id`
 *  non-null so the dashboard reports the engine as alive. */
export async function resolveSyntheticBatchId(
  freshnessRaw: SnapshotFreshnessRaw,
  scannerBatchId: string | null,
): Promise<string | null> {
  if (freshnessRaw.latest_confirmed_at) return freshnessRaw.latest_confirmed_at;
  if (scannerBatchId) return scannerBatchId;
  const hb = await getPipelineHeartbeat().catch(() => null);
  if (hb?.at) return `heartbeat:${new Date(hb.at).toISOString()}`;
  return null;
}

export interface SignalFunnelLogInput {
  action:            string;
  fallbackUsed:      boolean;
  scannerBatchId:    string | null;
  scannerEngineKind: ScannerEngineKind;
  finalRowsLength:   number;
  inProgressLength:  number;
  trackerCounts:     TrackerCounts;
  buyCount:          number;
  sellCount:         number;
  validationStatus:  string;
  syntheticBatchId:  string | null;
}

/** Per-request funnel log — single line, always on, grep-able as
 *  `[SIGNAL FUNNEL]`. Includes Yahoo health so a stuck-empty state // @deprecated marker
 *  is immediately visible (e.g. `yahoo_health: 'breaker_open'` next // @deprecated marker
 *  to `shipped_signals: 0`). */
export function logSignalFunnel(input: SignalFunnelLogInput): void {
  const yh = probeYahooHealth(); // @deprecated marker
  console.log('[SIGNAL FUNNEL]', {
    action:               input.action,
    data_source:          input.fallbackUsed ? 'q365_signals_fallback' : 'confirmed_snapshots',
    latest_batch_id:      input.syntheticBatchId,
    latest_batch_engine:  input.scannerEngineKind,
    snapshots_active:     input.finalRowsLength,
    fallback_used:        input.fallbackUsed,
    emerging_count:       input.inProgressLength,
    tracker_counts:       input.trackerCounts,
    shipped_signals:      input.finalRowsLength,
    buy_count:            input.buyCount,
    sell_count:           input.sellCount,
    validation_status:    input.validationStatus,
    yahoo_health:         yh.status_label, // @deprecated marker
  });
}
