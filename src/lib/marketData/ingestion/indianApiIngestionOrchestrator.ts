// ════════════════════════════════════════════════════════════════
//  IndianAPI ingestion orchestrator — the ONLY caller of the
//  IndianAPI adapter.
//
//  Data flow:  IndianAPI → this orchestrator → Redis + MySQL/PG →
//              MarketDataProvider → Quantorus365 clients
//
//  Guarantees:
//    • Distributed lock per tier — duplicate schedulers and
//      overlapping runs SKIP instead of piling up.
//    • Rate-limit safety is the limiter + bounded concurrency +
//      budget caps; retries are a bounded secondary net with
//      exponential backoff + full jitter and Retry-After support.
//    • Circuit breaker: consecutive upstream failures pause the run;
//      repeated trips abort it (failure is loud, never silent).
//    • Checkpointing: progress persists to Redis every wave so a
//      restarted run resumes instead of re-spending quota.
//    • Dead letters: failed symbols land in
//      indianapi_symbol_sync_state (consecutive_failures > 0);
//      runRepairIngestion drains them with a small cap.
// ════════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto';
import { logger } from '@/lib/logger';
import type { HistoricalRange, HistoricalSeries, MarketSnapshot, ProviderResponse } from '@/types/market';
import { db } from '@/lib/db';
import { cacheGet as redisCacheGet, cacheSet as redisCacheSet } from '@/lib/redis';
import {
  getIndianApiIngestConfig,
  isIndianApiEnabled,
  indianApiCredentialsPresent,
} from '@/lib/marketData/providerFlags';
import {
  initNifty500UniverseFromDb,
  isNifty500Initialized,
  getNifty500Symbols,
} from '@/lib/marketData/nifty500Universe';
import { persistSnapshot } from '@/services/LiveQuoteService';
import {
  quoteCacheKey,
  corporateIntelCacheKey,
  moversCacheKey,
  nseMostActiveCacheKey,
  QUOTE_TTL_S,
  CORP_TTL_S,
  MOVERS_TTL_S,
} from '@/lib/cache';
import { migrateIndianApiIngestion } from '@/lib/db/migrateIndianApiIngestion';
import * as IndianApi from '@/providers/adapters/IndianAPIAdapter';
import {
  IndianApiConfigError,
  IndianApiRateLimitError,
  IndianApiHttpError,
} from '@/providers/adapters/IndianAPIAdapter';
import {
  ApiBudgetExceededError,
  beginPerRunBudget,
  endPerRunBudget,
} from '@/providers/adapters/indianApiUsageTracker';
import { acquireIngestLock } from './indianApiLocks';
import { getDatasetPolicy, type IndianApiDataset } from './datasets';
import {
  recordIndianApiCircuitOpen,
  recordIndianApiBudgetBlock,
  recordIndianApiIngestionRun,
} from '@/lib/monitor/institutionalHealth';

const log = logger.child({ component: 'indianApiIngestion' });

// ── Envelope ───────────────────────────────────────────────────────

export function wrapIndianApiSnapshot(snap: MarketSnapshot): ProviderResponse<MarketSnapshot> {
  const fetched_at = Date.now();
  const vendor_timestamp = snap.timestamp > 0 ? snap.timestamp : fetched_at;
  return {
    data: snap,
    source: 'indianapi',
    data_quality: 'near-live',
    fetched_at,
    provider_name: 'IndianAPI',
    source_type: 'primary',
    vendor_timestamp,
    freshness_ms: Math.max(0, fetched_at - vendor_timestamp),
    fallback_reason: null,
  };
}

// ── Preconditions ──────────────────────────────────────────────────

/** Loud configuration gate — never a silent no-op in selected mode. */
export function assertIngestionConfigured(): void {
  if (!isIndianApiEnabled()) {
    throw new IndianApiConfigError(
      'IndianAPI ingestion invoked but INDIANAPI_ENABLED is not true — enable the feature flag.',
    );
  }
  if (!indianApiCredentialsPresent()) {
    throw new IndianApiConfigError(
      'IndianAPI ingestion invoked but INDIANAPI_API_KEY is not set — configure credentials.',
    );
  }
}

// ── Run bookkeeping (MySQL, best-effort) ───────────────────────────

let _tablesReady: Promise<void> | null = null;

function ensureTables(): Promise<void> {
  if (!_tablesReady) {
    _tablesReady = migrateIndianApiIngestion().catch((err) => {
      _tablesReady = null;
      throw err;
    });
  }
  return _tablesReady;
}

async function createRunRecord(runId: string, tier: string, totalSymbols: number): Promise<void> {
  try {
    await ensureTables();
    await db.query(
      `INSERT INTO indianapi_ingestion_runs (run_id, tier, status, total_symbols)
       VALUES (?, ?, 'running', ?)`,
      [runId, tier, totalSymbols],
    );
  } catch (err) {
    log.warn('run record insert failed', { runId, error: (err as Error)?.message });
  }
}

interface RunUpdate {
  status?: 'running' | 'completed' | 'failed' | 'skipped';
  processed?: number;
  failed?: number;
  apiCalls?: number;
  rateLimited?: number;
  checkpoint?: number;
  errorMessage?: string | null;
  finished?: boolean;
}

async function updateRunRecord(runId: string, update: RunUpdate): Promise<void> {
  try {
    await ensureTables();
    const sets: string[] = [];
    const args: unknown[] = [];
    if (update.status) { sets.push('status = ?'); args.push(update.status); }
    if (update.processed != null) { sets.push('processed = ?'); args.push(update.processed); }
    if (update.failed != null) { sets.push('failed = ?'); args.push(update.failed); }
    if (update.apiCalls != null) { sets.push('api_calls = ?'); args.push(update.apiCalls); }
    if (update.rateLimited != null) { sets.push('rate_limited = ?'); args.push(update.rateLimited); }
    if (update.checkpoint != null) { sets.push('checkpoint = ?'); args.push(update.checkpoint); }
    if (update.errorMessage !== undefined) { sets.push('error_message = ?'); args.push(update.errorMessage?.slice(0, 512) ?? null); }
    if (update.finished) { sets.push('finished_at = CURRENT_TIMESTAMP(3)'); }
    if (sets.length === 0) return;
    args.push(runId);
    await db.query(
      `UPDATE indianapi_ingestion_runs SET ${sets.join(', ')} WHERE run_id = ?`,
      args,
    );
  } catch (err) {
    log.warn('run record update failed', { runId, error: (err as Error)?.message });
  }
}

async function markSymbolSuccess(symbol: string, dataset: IndianApiDataset): Promise<void> {
  try {
    await ensureTables();
    await db.query(
      `INSERT INTO indianapi_symbol_sync_state
         (symbol, dataset, last_success_at, last_attempt_at, consecutive_failures, last_error)
       VALUES (?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), 0, NULL)
       ON DUPLICATE KEY UPDATE
         last_success_at = CURRENT_TIMESTAMP(3),
         last_attempt_at = CURRENT_TIMESTAMP(3),
         consecutive_failures = 0,
         last_error = NULL`,
      [symbol.toUpperCase(), dataset],
    );
  } catch (err) {
    log.warn('sync state success upsert failed', { symbol, error: (err as Error)?.message });
  }
}

async function markSymbolFailure(symbol: string, dataset: IndianApiDataset, error: string): Promise<void> {
  try {
    await ensureTables();
    await db.query(
      `INSERT INTO indianapi_symbol_sync_state
         (symbol, dataset, last_attempt_at, consecutive_failures, last_error)
       VALUES (?, ?, CURRENT_TIMESTAMP(3), 1, ?)
       ON DUPLICATE KEY UPDATE
         last_attempt_at = CURRENT_TIMESTAMP(3),
         consecutive_failures = consecutive_failures + 1,
         last_error = VALUES(last_error)`,
      [symbol.toUpperCase(), dataset, error.slice(0, 512)],
    );
  } catch (err) {
    log.warn('sync state failure upsert failed', { symbol, error: (err as Error)?.message });
  }
}

// ── Universe / checkpoint / probe ──────────────────────────────────

const CHECKPOINT_KEY = (tier: string) => `indianapi:ingest:checkpoint:${tier}`;
const CHECKPOINT_TTL_S = 6 * 60 * 60;
const BATCH_PROBE_KEY = 'indianapi:batch:probe';
const BATCH_PROBE_TTL_S = 24 * 60 * 60;

interface Checkpoint { runId: string; index: number; total: number; at: number }

export async function resolveIngestUniverse(): Promise<string[]> {
  if (!isNifty500Initialized()) {
    try {
      await initNifty500UniverseFromDb();
    } catch (err) {
      log.warn('universe init failed for ingestion', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const symbols = getNifty500Symbols();
  const { ingestSymbolLimit } = getIndianApiIngestConfig();
  if (ingestSymbolLimit > 0) return symbols.slice(0, ingestSymbolLimit);
  return symbols;
}

/**
 * Batch endpoint capability — probed once per 24h (auto mode).
 * A 404 on the probe caches `false` so waves use per-symbol calls
 * without burning quota re-probing every run.
 */
export async function isBatchModeAvailable(sampleSymbols: string[]): Promise<boolean> {
  const { batchMode } = getIndianApiIngestConfig();
  if (batchMode === 'on') return true;
  if (batchMode === 'off') return false;

  const cached = await redisCacheGet<{ available: boolean }>(BATCH_PROBE_KEY);
  if (cached != null) return cached.available;

  try {
    const available = await IndianApi.probeBatchEndpoint(sampleSymbols);
    await redisCacheSet(BATCH_PROBE_KEY, { available }, BATCH_PROBE_TTL_S);
    log.info('batch endpoint probe complete', { available });
    return available;
  } catch (err) {
    // Transient (429 / 5xx) — don't cache; fall back to per-symbol for
    // this run only.
    log.warn('batch endpoint probe inconclusive — per-symbol for this run', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ── Retry policy (secondary net — the limiter is the primary) ──────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Exponential backoff with FULL jitter: delay ∈ [0, base·2^attempt]. */
export function backoffDelayMs(attempt: number, baseMs: number): number {
  const cap = Math.min(baseMs * Math.pow(2, attempt), 60_000);
  return Math.floor(Math.random() * cap);
}

async function withIngestRetries<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const { maxRetries, retryBaseMs } = getIndianApiIngestConfig();
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Budget / config errors abort immediately — retrying cannot fix them.
      if (err instanceof ApiBudgetExceededError || err instanceof IndianApiConfigError) throw err;
      // Hard 4xx (except 429) is permanent for this item.
      if (err instanceof IndianApiHttpError && !err.transient) throw err;
      if (attempt >= maxRetries) break;
      if (err instanceof IndianApiRateLimitError) {
        // Honor Retry-After (the shared limiter is already paused —
        // this wait keeps the retry behind the pause) + jitter.
        await sleep(err.retryAfterMs + backoffDelayMs(0, retryBaseMs));
      } else {
        await sleep(backoffDelayMs(attempt, retryBaseMs));
      }
      log.warn(`${label} retry ${attempt + 1}/${maxRetries}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  throw lastErr;
}

// ── Circuit state (per run) ────────────────────────────────────────

class RunCircuit {
  private consecutiveFailures = 0;
  private trips = 0;

  constructor(
    private readonly failureThreshold: number,
    private readonly cooldownMs: number,
    private readonly maxTrips = 3,
  ) {}

  noteSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /** Returns true when the run must ABORT (breaker exhausted). */
  async noteFailure(): Promise<boolean> {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < this.failureThreshold) return false;
    this.trips += 1;
    this.consecutiveFailures = 0;
    recordIndianApiCircuitOpen();
    if (this.trips >= this.maxTrips) {
      log.error('ingestion circuit exhausted — aborting run', { trips: this.trips });
      return true;
    }
    log.warn('ingestion circuit open — cooling down', {
      trip: this.trips,
      cooldown_ms: this.cooldownMs,
    });
    console.warn(`[INDIANAPI_INGEST] circuit_open trip=${this.trips} cooldown_ms=${this.cooldownMs}`);
    await sleep(this.cooldownMs);
    return false;
  }

  get tripCount(): number {
    return this.trips;
  }
}

// ── Quote ingestion (P0 — every batch-tier tick) ───────────────────

export interface QuoteIngestionReport {
  runId: string;
  skipped: boolean;
  skipReason?: string;
  totalSymbols: number;
  processed: number;
  failed: number;
  rateLimited: number;
  /** Top-level upstream attempts (retries counted separately in the usage tracker). */
  apiCalls: number;
  batchMode: boolean;
  resumedFrom: number;
  aborted: boolean;
  elapsedMs: number;
}

async function persistQuote(snap: MarketSnapshot): Promise<void> {
  const resp = wrapIndianApiSnapshot(snap);
  await redisCacheSet(quoteCacheKey(snap.symbol), snap, QUOTE_TTL_S);
  await persistSnapshot(resp);
}

export async function runQuoteIngestion(
  opts: { resume?: boolean } = {},
): Promise<QuoteIngestionReport> {
  assertIngestionConfigured();
  const cfg = getIndianApiIngestConfig();
  const startedAt = Date.now();
  const dataset: IndianApiDataset = 'quotes';

  const lock = await acquireIngestLock('quotes', cfg.lockTtlS);
  if (!lock) {
    return {
      runId: '', skipped: true, skipReason: 'lock_held',
      totalSymbols: 0, processed: 0, failed: 0, rateLimited: 0, apiCalls: 0,
      batchMode: false, resumedFrom: 0, aborted: false,
      elapsedMs: Date.now() - startedAt,
    };
  }

  const runId = `iaq_${Date.now()}_${randomUUID().slice(0, 8)}`;
  beginPerRunBudget();
  let processed = 0;
  let failed = 0;
  let rateLimited = 0;
  let apiCalls = 0;
  let aborted = false;
  let resumedFrom = 0;
  let batchAvailable = false;

  try {
    const universe = await resolveIngestUniverse();
    if (universe.length === 0) {
      log.warn('quote ingestion: empty universe — nothing to do');
      return {
        runId, skipped: true, skipReason: 'empty_universe',
        totalSymbols: 0, processed: 0, failed: 0, rateLimited: 0, apiCalls: 0,
        batchMode: false, resumedFrom: 0, aborted: false,
        elapsedMs: Date.now() - startedAt,
      };
    }

    // Resume from checkpoint when the previous run died mid-wave.
    if (opts.resume !== false) {
      const cp = await redisCacheGet<Checkpoint>(CHECKPOINT_KEY('quotes'));
      if (cp && cp.total === universe.length && cp.index > 0 && cp.index < universe.length) {
        resumedFrom = cp.index;
        log.info('resuming quote ingestion from checkpoint', { index: cp.index, total: cp.total });
      }
    }

    await createRunRecord(runId, 'quotes', universe.length);
    batchAvailable = await isBatchModeAvailable(universe.slice(0, 2));

    const circuit = new RunCircuit(cfg.circuitFailures, cfg.circuitCooldownMs);
    const pending = universe.slice(resumedFrom);

    if (batchAvailable) {
      // ── Batch mode: chunked POSTs ────────────────────────────────
      for (let i = 0; i < pending.length; i += cfg.batchSize) {
        const chunk = pending.slice(i, i + cfg.batchSize);
        try {
          apiCalls += 1;
          const { snapshots, missing } = await withIngestRetries(
            () => IndianApi.getBatchQuotes(chunk, 'quote-ingestion'),
            `batch[${i}]`,
          );
          for (const snap of snapshots) {
            try {
              await persistQuote(snap);
              await markSymbolSuccess(snap.symbol, dataset);
              processed += 1;
            } catch (err) {
              failed += 1;
              await markSymbolFailure(snap.symbol, dataset, (err as Error)?.message ?? 'persist failed');
            }
          }
          for (const sym of missing) {
            failed += 1;
            await markSymbolFailure(sym, dataset, 'missing from batch response');
          }
          circuit.noteSuccess();
        } catch (err) {
          if (err instanceof ApiBudgetExceededError) {
            recordIndianApiBudgetBlock();
            log.warn('quote ingestion stopped: budget exhausted', { bucket: err.bucket });
            aborted = true;
            break;
          }
          if (err instanceof IndianApiRateLimitError) rateLimited += 1;
          failed += chunk.length;
          for (const sym of chunk) {
            await markSymbolFailure(sym, dataset, (err as Error)?.message ?? 'batch failed');
          }
          if (await circuit.noteFailure()) {
            aborted = true;
            break;
          }
        }
        const index = resumedFrom + Math.min(i + cfg.batchSize, pending.length);
        await redisCacheSet(CHECKPOINT_KEY('quotes'), {
          runId, index, total: universe.length, at: Date.now(),
        } satisfies Checkpoint, CHECKPOINT_TTL_S);
        await updateRunRecord(runId, { processed, failed, rateLimited, checkpoint: index });
      }
    } else {
      // ── Per-symbol mode: bounded concurrency via the limiter ─────
      // The rate limiter enforces RPS + concurrency; this wave loop
      // additionally checkpoints every `checkpointEvery` symbols.
      const checkpointEvery = 25;
      let abortRequested = false;
      let nextIndex = 0;
      let completedCount = 0;

      const workers = Array.from({ length: cfg.maxConcurrency }, async () => {
        while (!abortRequested) {
          const idx = nextIndex++;
          if (idx >= pending.length) return;
          const symbol = pending[idx];
          try {
            apiCalls += 1;
            const { snapshot, intel } = await withIngestRetries(
              () => IndianApi.getStockDetail(symbol, 'quote-ingestion'),
              `stock[${symbol}]`,
            );
            await persistQuote(snapshot);
            // /stock also carries the profile — persist it for free.
            await redisCacheSet(corporateIntelCacheKey(symbol), intel, CORP_TTL_S);
            await markSymbolSuccess(symbol, dataset);
            processed += 1;
            circuit.noteSuccess();
          } catch (err) {
            if (err instanceof ApiBudgetExceededError) {
              recordIndianApiBudgetBlock();
              abortRequested = true;
              aborted = true;
              log.warn('quote ingestion stopped: budget exhausted', { bucket: err.bucket });
              return;
            }
            if (err instanceof IndianApiRateLimitError) rateLimited += 1;
            failed += 1;
            await markSymbolFailure(symbol, dataset, (err as Error)?.message ?? 'fetch failed');
            if (await circuit.noteFailure()) {
              abortRequested = true;
              aborted = true;
              return;
            }
          } finally {
            completedCount += 1;
            if (completedCount % checkpointEvery === 0) {
              const index = resumedFrom + completedCount;
              await redisCacheSet(CHECKPOINT_KEY('quotes'), {
                runId, index, total: universe.length, at: Date.now(),
              } satisfies Checkpoint, CHECKPOINT_TTL_S).catch(() => {});
              await updateRunRecord(runId, { processed, failed, rateLimited, checkpoint: index });
            }
          }
        }
      });
      await Promise.all(workers);
    }

    // Completed cleanly → clear the checkpoint so the next run starts fresh.
    if (!aborted) {
      await redisCacheSet(CHECKPOINT_KEY('quotes'), {
        runId, index: 0, total: universe.length, at: Date.now(),
      } satisfies Checkpoint, 60);
    }
    await redisCacheSet('indianapi:ingest:lastSuccess:quotes', { at: Date.now(), runId, processed }, 7 * 24 * 60 * 60);
    await updateRunRecord(runId, {
      status: aborted ? 'failed' : 'completed',
      processed, failed, rateLimited, apiCalls,
      errorMessage: aborted ? 'aborted (budget or circuit)' : null,
      finished: true,
    });

    recordIndianApiIngestionRun({ tier: 'quotes', ok: !aborted, processed, failed });
    const report: QuoteIngestionReport = {
      runId, skipped: false,
      totalSymbols: universe.length,
      processed, failed, rateLimited, apiCalls,
      batchMode: batchAvailable, resumedFrom, aborted,
      elapsedMs: Date.now() - startedAt,
    };
    console.log('[INDIANAPI_INGEST]', {
      tier: 'quotes', run_id: runId,
      total: universe.length, processed, failed,
      rate_limited: rateLimited, api_calls: apiCalls,
      batch_mode: batchAvailable,
      resumed_from: resumedFrom, aborted,
      elapsed_ms: report.elapsedMs,
    });
    return report;
  } catch (err) {
    await updateRunRecord(runId, {
      status: 'failed',
      processed, failed, rateLimited, apiCalls,
      errorMessage: err instanceof Error ? err.message : String(err),
      finished: true,
    });
    throw err;
  } finally {
    endPerRunBudget();
    await lock.release();
  }
}

// ── Movers ingestion (P0 — discovery endpoints, ~2 calls) ──────────

export interface MoversIngestionReport {
  skipped: boolean;
  gainers: number;
  losers: number;
  mostActive: number;
}

export async function runMoversIngestion(): Promise<MoversIngestionReport> {
  assertIngestionConfigured();
  const cfg = getIndianApiIngestConfig();
  const lock = await acquireIngestLock('movers', Math.min(cfg.lockTtlS, 300));
  if (!lock) return { skipped: true, gainers: 0, losers: 0, mostActive: 0 };

  try {
    const movers = await withIngestRetries(
      () => IndianApi.getMovers('movers-ingestion'),
      'movers',
    );
    const ttl = getDatasetPolicy('movers').cacheTtlS || MOVERS_TTL_S;
    await redisCacheSet(moversCacheKey(), movers, ttl);
    await redisCacheSet(nseMostActiveCacheKey(), movers.mostActive, ttl);
    await redisCacheSet('indianapi:ingest:lastSuccess:movers', { at: Date.now() }, 7 * 24 * 60 * 60);
    recordIndianApiIngestionRun({
      tier: 'movers',
      ok: true,
      processed: movers.gainers.length + movers.losers.length + movers.mostActive.length,
      failed: 0,
    });
    console.log('[INDIANAPI_INGEST]', {
      tier: 'movers',
      gainers: movers.gainers.length,
      losers: movers.losers.length,
      most_active: movers.mostActive.length,
    });
    return {
      skipped: false,
      gainers: movers.gainers.length,
      losers: movers.losers.length,
      mostActive: movers.mostActive.length,
    };
  } finally {
    await lock.release();
  }
}

// ── Profile ingestion (P2 — weekly rotation, stale-first) ──────────

export interface ProfileIngestionReport {
  skipped: boolean;
  attempted: number;
  processed: number;
  failed: number;
}

/**
 * Refresh company profiles for the most-stale slice of the universe.
 * Deliberately small (`limit`) — profiles change slowly and must never
 * compete with the quote budget.
 */
export async function runProfileIngestion(limit = 50): Promise<ProfileIngestionReport> {
  assertIngestionConfigured();
  const cfg = getIndianApiIngestConfig();
  const dataset: IndianApiDataset = 'profile';
  const lock = await acquireIngestLock('profile', cfg.lockTtlS);
  if (!lock) return { skipped: true, attempted: 0, processed: 0, failed: 0 };

  beginPerRunBudget(Math.min(limit * 2, cfg.perRunLimit));
  try {
    const universe = await resolveIngestUniverse();
    // Stale-first: symbols with no recent profile sync go first.
    let ordered = universe;
    try {
      await ensureTables();
      const { rows } = await db.query<{ symbol: string }>(
        `SELECT symbol FROM indianapi_symbol_sync_state
          WHERE dataset = ? AND last_success_at IS NOT NULL
          ORDER BY last_success_at DESC`,
        [dataset],
      );
      const fresh = new Set(rows.map(r => r.symbol.toUpperCase()));
      ordered = [
        ...universe.filter(s => !fresh.has(s.toUpperCase())),
        ...universe.filter(s => fresh.has(s.toUpperCase())),
      ];
    } catch {
      // fall back to natural universe order
    }
    const slice = ordered.slice(0, limit);

    let processed = 0;
    let failed = 0;
    for (const symbol of slice) {
      try {
        const { intel } = await withIngestRetries(
          () => IndianApi.getStockDetail(symbol, 'profile-ingestion'),
          `profile[${symbol}]`,
        );
        await redisCacheSet(corporateIntelCacheKey(symbol), intel, CORP_TTL_S);
        await markSymbolSuccess(symbol, dataset);
        processed += 1;
      } catch (err) {
        if (err instanceof ApiBudgetExceededError) break;
        failed += 1;
        await markSymbolFailure(symbol, dataset, (err as Error)?.message ?? 'profile fetch failed');
      }
    }
    recordIndianApiIngestionRun({ tier: 'profile', ok: true, processed, failed });
    console.log('[INDIANAPI_INGEST]', {
      tier: 'profile', attempted: slice.length, processed, failed,
    });
    return { skipped: false, attempted: slice.length, processed, failed };
  } finally {
    endPerRunBudget();
    await lock.release();
  }
}

// ── Historical fetch (P1/P2 — consumed by candle jobs) ─────────────

/**
 * Single-symbol historical series with the standard retry envelope.
 * Candle jobs (daily update / backfill) call this instead of the
 * adapter so budget, limiter, and retry policy apply uniformly.
 */
export async function fetchHistoricalSeries(
  symbol: string,
  range: HistoricalRange,
  sourceJob = 'candle-ingestion',
): Promise<HistoricalSeries> {
  assertIngestionConfigured();
  const dataset: IndianApiDataset = 'eod';
  try {
    const series = await withIngestRetries(
      () => IndianApi.getHistorical(symbol, range, sourceJob),
      `hist[${symbol}]`,
    );
    await markSymbolSuccess(symbol, dataset);
    return series;
  } catch (err) {
    await markSymbolFailure(symbol, dataset, (err as Error)?.message ?? 'historical fetch failed');
    throw err;
  }
}

// ── Dead-letter repair (drains failed symbols, capped) ─────────────

export interface RepairIngestionReport {
  skipped: boolean;
  attempted: number;
  recovered: number;
  stillFailing: number;
}

export async function runRepairIngestion(maxSymbols = 50): Promise<RepairIngestionReport> {
  assertIngestionConfigured();
  const cfg = getIndianApiIngestConfig();
  const dataset: IndianApiDataset = 'quotes';
  const lock = await acquireIngestLock('repair', cfg.lockTtlS);
  if (!lock) return { skipped: true, attempted: 0, recovered: 0, stillFailing: 0 };

  beginPerRunBudget(Math.min(maxSymbols * 2, cfg.perRunLimit));
  try {
    await ensureTables();
    const { rows } = await db.query<{ symbol: string }>(
      `SELECT symbol FROM indianapi_symbol_sync_state
        WHERE dataset = ? AND consecutive_failures > 0
        ORDER BY consecutive_failures DESC, last_attempt_at ASC
        LIMIT ?`,
      [dataset, maxSymbols],
    );
    const symbols = rows.map(r => r.symbol);

    let recovered = 0;
    let stillFailing = 0;
    for (const symbol of symbols) {
      try {
        const { snapshot } = await withIngestRetries(
          () => IndianApi.getStockDetail(symbol, 'repair-ingestion'),
          `repair[${symbol}]`,
        );
        await persistQuote(snapshot);
        await markSymbolSuccess(symbol, dataset);
        recovered += 1;
      } catch (err) {
        if (err instanceof ApiBudgetExceededError) break;
        stillFailing += 1;
        await markSymbolFailure(symbol, dataset, (err as Error)?.message ?? 'repair failed');
      }
    }
    recordIndianApiIngestionRun({ tier: 'repair', ok: true, processed: recovered, failed: stillFailing });
    console.log('[INDIANAPI_INGEST]', {
      tier: 'repair', attempted: symbols.length, recovered, still_failing: stillFailing,
    });
    return { skipped: false, attempted: symbols.length, recovered, stillFailing };
  } finally {
    endPerRunBudget();
    await lock.release();
  }
}
