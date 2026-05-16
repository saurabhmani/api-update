// ════════════════════════════════════════════════════════════════
//  batchScheduler — the new orchestrator.
//
//  Three phases, driven by cron entries in src/lib/scheduler.ts:
//
//    runBatchTier()     every 10 min  →  market-wide + batch quotes
//    runTriggerTier()   every 20 min  →  evaluate triggers, deep-fetch
//    runIntelTier()     every 60 min  →  news + historical refresh
//
//  Each phase is idempotent, exception-safe, and emits a structured
//  report for ops dashboards. None of them call per-symbol live quote
//  APIs except runTriggerTier(), and that one is gated by:
//    (a) trigger score, (b) cooldown store, (c) budget guard.
//
//  Contract preservation: per-symbol cache keys (quote:<SYMBOL>) are
//  populated by the batch phase, so existing consumers reading through
//  MarketDataProvider.getLiveSnapshot() see fresh data as cache hits.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import MarketDataProvider from '@/providers/MarketDataProvider';
import * as IndianAPI from '@/providers/adapters/IndianAPIAdapter';
import { mapToIndianApiSymbol } from '@/lib/marketData/symbolMapper';
import { persistSnapshot } from '@/services/LiveQuoteService';
import { cacheSet as redisCacheSet, cacheGet as redisCacheGet } from '@/lib/redis';
import { withProviderFrame } from '@/lib/marketData/enforcer';
import { guarded } from '@/providers/resilience';
import {
  isNifty500Initialized,
  initNifty500UniverseFromDb,
} from '@/lib/marketData/nifty500Universe';

import {
  CONFIG,
  getBatchUniverse,
  tierOf,
} from '../schedulerConfig';
import { recordHeartbeatTick } from '@/lib/monitor/institutionalHealth';
import { evaluate as evaluateTriggers, readRecentNewsSymbols } from '../triggerEngine';
import {
  isCoolingDown,
  setCooldown,
  filterNotCoolingDown,
} from '../cooldownStore';
import {
  canSpend,
  spend,
  snapshot as budgetSnapshot,
  maxDeepForLevel,
} from '../apiBudgetGuard';

import type { MarketSnapshot, MoversBucket, MoversResult, ProviderResponse } from '@/types/market';

const log = logger.child({ component: 'batchScheduler' });

// Construct a canonical ProviderResponse envelope for a snapshot we
// just pulled from the IndianAPI batch endpoint. The persistence layer
// requires every field in the envelope; supplying them explicitly here
// keeps signals/monitoring honest about where batch-sourced rows came
// from without leaking adapter internals.
function wrapBatchResponse(snap: MarketSnapshot): ProviderResponse<MarketSnapshot> {
  const fetched_at = Date.now();
  const vendor_timestamp = typeof snap.timestamp === 'number' && snap.timestamp > 0
    ? snap.timestamp
    : fetched_at;
  return {
    data: snap,
    source: 'indian',
    data_quality: 'near-live',
    fetched_at,
    provider_name: 'IndianAPI',
    source_type: 'primary',
    vendor_timestamp,
    freshness_ms: Math.max(0, fetched_at - vendor_timestamp),
    fallback_reason: null,
  };
}

// ── Run-state keys for ops visibility ───────────────────────────────
const LAST_RUN_KEY = (tier: 'batch' | 'trigger' | 'intel' | 'heartbeat') => `scheduler:lastRun:${tier}`;
const LAST_TRIGGER_PICKS_KEY = 'trigger:lastRun';
const LAST_RUN_TTL_S = 24 * 60 * 60;

/** Spec FIX-DATA-PIPELINE §4: the pipeline must always have a fresh
 *  `last_pipeline_run` during market hours, even when no signals have
 *  been promoted to confirmed_snapshots yet. The heartbeat is bumped
 *  every 60s by `runHeartbeatTier()` (or by any successful tier). The
 *  freshness probe in /api/signals reads this key when
 *  `freshnessRaw.latest_confirmed_ms` is null so the dashboard never
 *  shows `last_pipeline_run: null` while the heartbeat is alive. */
const HEARTBEAT_KEY = 'scheduler:heartbeat:pipeline';
const HEARTBEAT_TTL_S = 10 * 60;

async function bumpHeartbeat(source: string): Promise<void> {
  await redisCacheSet(HEARTBEAT_KEY, {
    at: Date.now(),
    source,
  }, HEARTBEAT_TTL_S);
}

/**
 * Public alias for `bumpHeartbeat`. Exposed so non-tier callers (the
 * route's auto-recovery, manual /api/run-signal-engine handlers) can
 * write the heartbeat directly when they complete a pipeline run.
 *
 * Without this, `last_pipeline_run` only advances when one of the
 * scheduled tiers (intraday regen, hourly scan, heartbeat tier) runs
 * — which never happens in environments where the in-proc scheduler
 * is OFF. The auto-recovery in /api/signals is the one path that
 * runs unconditionally on demand; it now bumps the heartbeat itself
 * so a fresh deploy without the scheduler still surfaces a
 * non-null last_pipeline_run after the first poll.
 */
export async function markPipelineHeartbeat(source: string): Promise<void> {
  return bumpHeartbeat(source);
}

export async function getPipelineHeartbeat(): Promise<{ at: number; source: string } | null> {
  return (await redisCacheGet<{ at: number; source: string }>(HEARTBEAT_KEY)) ?? null;
}

interface TierReport<T = unknown> {
  tier: 'batch' | 'trigger' | 'intel' | 'heartbeat';
  startedAt: number;
  elapsedMs: number;
  ok: boolean;
  error?: string;
  details: T;
}

// Shared run helper so every tier emits a consistent report.
async function runTier<T>(
  tier: TierReport['tier'],
  fn: () => Promise<T>,
): Promise<TierReport<T>> {
  const startedAt = Date.now();
  // Canonical pipeline-progress tag (start). Operators grep
  // [PIPELINE_PROGRESS] across every long-running stage to see what's
  // currently in flight regardless of which phase emitted it.
  console.log('[PIPELINE_PROGRESS]', {
    stage:      `scheduler.${tier}`,
    event:      'start',
    started_at: new Date(startedAt).toISOString(),
  });
  try {
    // Spec STEP 2 — universe init guard. Tiers fan out through the
    // resolver, which calls isInNifty500() per symbol; if the
    // in-memory cache hasn't been hydrated by instrumentation, the
    // shared promise lock in initOnce() loads it once before the
    // first symbol is touched. Idempotent — single-property check
    // after hydration.
    if (!isNifty500Initialized()) {
      await initNifty500UniverseFromDb();
    }
    const details = await fn();
    const report: TierReport<T> = {
      tier,
      startedAt,
      elapsedMs: Date.now() - startedAt,
      ok: true,
      details,
    };
    await redisCacheSet(LAST_RUN_KEY(tier), report, LAST_RUN_TTL_S);
    // Every successful tier counts as a pipeline heartbeat so the
    // freshness envelope reflects engine liveness even when no new
    // confirmed snapshots have been promoted this cycle.
    await bumpHeartbeat(tier);
    console.log(`[PIPELINE] batch created tier=${tier} elapsedMs=${report.elapsedMs}`);
    console.log('[PIPELINE_PROGRESS]', {
      stage:      `scheduler.${tier}`,
      event:      'complete',
      elapsed_ms: report.elapsedMs,
      ok:         true,
    });
    log.info(`${tier} tier complete`, { elapsedMs: report.elapsedMs });
    return report;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const report: TierReport<T> = {
      tier,
      startedAt,
      elapsedMs: Date.now() - startedAt,
      ok: false,
      error: message,
      details: undefined as unknown as T,
    };
    await redisCacheSet(LAST_RUN_KEY(tier), report, LAST_RUN_TTL_S);
    console.log('[PIPELINE_PROGRESS]', {
      stage:      `scheduler.${tier}`,
      event:      'fail',
      elapsed_ms: report.elapsedMs,
      ok:         false,
      error:      message,
    });
    log.error(`${tier} tier failed`, { error: message });
    return report;
  }
}

// ══════════════════════════════════════════════════════════════════
//  TIER A — batch + market-wide (every 10 minutes)
// ══════════════════════════════════════════════════════════════════

interface BatchTierDetails {
  batchSymbols: number;
  batchCallsMade: number;
  batchReceived: number;
  batchMissing: number;
  trendingCount: number;
  shockersCount: number;
  mostActiveCount: number;
  persistErrors: number;
}

export async function runBatchTier(): Promise<TierReport<BatchTierDetails>> {
  return runTier('batch', async () => {
    const universe = getBatchUniverse();

    // 1. Batch quotes — ONE (or a handful, chunked) request for the
    //    whole Tier1+Tier2 universe. Fans out to per-symbol cache,
    //    so downstream consumers are unaffected.
    const batch = await MarketDataProvider.getBatchLiveSnapshots(universe);

    // 2. Persist fresh snapshots in parallel with a bounded concurrency.
    //    This mirrors the old scheduler's behavior so DB-writing
    //    consumers (market.snapshots_current etc.) stay populated.
    let persistErrors = 0;
    const persistables = batch.entries.filter(
      e => e.snapshot !== null && e.source === 'indian',
    );
    await boundedAll(persistables, 4, async (e) => {
      try {
        await persistSnapshot(wrapBatchResponse(e.snapshot!));
      } catch (err) {
        persistErrors += 1;
        log.warn('batch tier persist failed', {
          symbol: e.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // 3. Market-wide cheap endpoints. Each is one API call and
    //    independently cached. Run in parallel since each has its
    //    own budget check inside MarketDataProvider.
    const [trending, shockers, mostActive] = await Promise.all([
      MarketDataProvider.getTrendingSymbols().catch(() => ({ data: [] as string[] })),
      MarketDataProvider.getPriceShockers().catch(() => ({ data: [] as string[] })),
      MarketDataProvider.getNseMostActive().catch(() => ({ data: [] as MoversBucket[] })),
    ]);

    const batchReceived = batch.entries.filter(e => e.source === 'indian').length;
    const coveragePct   = universe.length > 0
      ? Math.round((batchReceived / universe.length) * 1000) / 10
      : 0;
    // Spec OPERATIONAL OBSERVABILITY (2026-05) — canonical scan-coverage
    // tag. coverage_pct = received / requested. A wide gap means the
    // upstream returned partial data (rate-limit, breaker open, plan
    // limits) and downstream consumers are seeing stale cache entries.
    console.log('[SCAN_COVERAGE]', {
      stage:           'scheduler.batch',
      universe:        universe.length,
      batch_calls:     batch.batchCallsMade,
      received:        batchReceived,
      missing:         batch.missingAfterBatch.length,
      coverage_pct:    coveragePct,
      persist_errors:  persistErrors,
    });
    // Provider freshness/breaker snapshot — pulled at the end of the
    // tier so it reflects the state AFTER any breaker-trip during this
    // run. Routes through [PROVIDER_HEALTH] so SRE dashboards can
    // count breaker events independently of tier success.
    try {
      const breaker = IndianAPI.indianApiBreakerState();
      console.log('[PROVIDER_HEALTH]', {
        provider:           'IndianAPI',
        breaker_open:       breaker.open,
        breaker_state:      breaker.state,
        breaker_remaining_ms: breaker.remainingMs,
        auth_failed:        breaker.auth_failed,
        auth_failed_for_ms: breaker.auth_failed_for_ms,
        batch_coverage_pct: coveragePct,
      });
    } catch { /* breaker probe is best-effort */ }
    return {
      batchSymbols: universe.length,
      batchCallsMade: batch.batchCallsMade,
      batchReceived,
      batchMissing: batch.missingAfterBatch.length,
      trendingCount: trending.data.length,
      shockersCount: shockers.data.length,
      mostActiveCount: mostActive.data.length,
      persistErrors,
    };
  });
}

// ══════════════════════════════════════════════════════════════════
//  TIER B — trigger-driven deep fetches (every 20 minutes)
// ══════════════════════════════════════════════════════════════════

interface TriggerTierDetails {
  scored: number;
  picked: number;
  deepFetched: number;
  skippedCooldown: number;
  skippedBudget: number;
  level: string;
  picks: Array<{ symbol: string; score: number; reasons: string[] }>;
}

export async function runTriggerTier(): Promise<TierReport<TriggerTierDetails>> {
  return runTier('trigger', async () => {
    const budget = await budgetSnapshot();
    const max = maxDeepForLevel(budget.level);
    if (max === 0) {
      return {
        scored: 0, picked: 0, deepFetched: 0,
        skippedCooldown: 0, skippedBudget: 0,
        level: budget.level, picks: [],
      };
    }

    // Read the Tier A outputs from cache (no new API calls).
    const [snapshots, movers, shockers, mostActive, newsSymbols] =
      await Promise.all([
        loadBatchUniverseSnapshots(),
        loadMoversFromCache(),
        loadShockersFromCache(),
        loadMostActiveFromCache(),
        readRecentNewsSymbols(),
      ]);

    const candidates = await evaluateTriggers({
      snapshots,
      movers,
      shockers,
      mostActive: mostActive.map(m => m.symbol),
      freshNewsSymbols: newsSymbols,
    }, { maxSymbols: max });

    // Deep-fetch loop — bounded concurrency, budget-checked per symbol.
    let deepFetched = 0;
    let skippedBudget = 0;
    let skippedCooldown = 0;

    await boundedAll(candidates, 2, async (c) => {
      // Double-check cooldown in case a parallel task set it.
      if (await isCoolingDown(c.symbol, 'deep')) {
        skippedCooldown += 1;
        return;
      }
      const chk = await canSpend('deep', 1);
      if (!chk.allowed) {
        skippedBudget += 1;
        return;
      }
      await spend('deep', 1);
      try {
        // Use the single-symbol path directly — NOT getLiveSnapshot,
        // because we explicitly want to bypass the cache tier here
        // and get a fresh snapshot for the triggered signal.
        const snap = await withProviderFrame(() =>
          guarded('indian', async () => IndianAPI.getQuote(await mapToIndianApiSymbol(c.symbol)), { timeoutMs: 2500, attempts: 2 }), // @deprecated marker
        );
        // Write to per-symbol cache so downstream reads are hot.
        await redisCacheSet(`quote:${c.symbol}`, snap, 120);
        try {
          await persistSnapshot(wrapBatchResponse(snap));
        } catch (persistErr) {
          log.warn('trigger persist failed', {
            symbol: c.symbol,
            error: persistErr instanceof Error ? persistErr.message : String(persistErr),
          });
        }
        await setCooldown(c.symbol, 'deep', {
          triggeredBy: c.reasons.join(','),
        });
        deepFetched += 1;
      } catch (err) {
        log.warn('trigger deep fetch failed', {
          symbol: c.symbol,
          error: err instanceof Error ? err.message : String(err),
        });
        // Still cool down on failure — don't hammer a symbol whose
        // upstream is misbehaving.
        await setCooldown(c.symbol, 'deep', {
          ttlMs: 10 * 60 * 1000,
          triggeredBy: 'error-cooldown',
        });
      }
    });

    const picks = candidates.map(c => ({
      symbol: c.symbol,
      score: c.score,
      reasons: c.reasons,
    }));
    await redisCacheSet(LAST_TRIGGER_PICKS_KEY, {
      at: Date.now(), level: budget.level, picks,
    }, LAST_RUN_TTL_S);

    return {
      scored: candidates.length,
      picked: candidates.length,
      deepFetched,
      skippedCooldown,
      skippedBudget,
      level: budget.level,
      picks,
    };
  });
}

// ══════════════════════════════════════════════════════════════════
//  TIER C — slow intelligence (every 60 minutes)
// ══════════════════════════════════════════════════════════════════

interface IntelTierDetails {
  marketNewsOk: boolean;
  companyNewsFetched: number;
  historicalRefreshed: number;
  level: string;
}

export async function runIntelTier(): Promise<TierReport<IntelTierDetails>> {
  return runTier('intel', async () => {
    const budget = await budgetSnapshot();
    if (budget.level === 'freeze') {
      return {
        marketNewsOk: false, companyNewsFetched: 0,
        historicalRefreshed: 0, level: budget.level,
      };
    }

    // 1. Market-wide news — one call.
    let marketNewsOk = false;
    try {
      const n = await MarketDataProvider.getMarketNews();
      marketNewsOk = n.source === 'indian' || n.source === 'cache';
    } catch (err) {
      log.warn('market news fetch failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 2. Company news — only for triggered symbols in the last cycle.
    //    Cap at 3 per run so news doesn't balloon the budget.
    let companyNewsFetched = 0;
    const picksRec = await redisCacheGet<{ picks: Array<{ symbol: string }> }>(LAST_TRIGGER_PICKS_KEY);
    const candidates = (picksRec?.picks ?? []).map(p => p.symbol);
    const eligible = await filterNotCoolingDown(candidates, 'news');

    const NEWS_CAP_PER_CYCLE = budget.level === 'hard' ? 1 : budget.level === 'soft' ? 2 : 3;
    const selected = eligible.slice(0, NEWS_CAP_PER_CYCLE);

    await boundedAll(selected, 2, async (sym) => {
      const chk = await canSpend('news', 1);
      if (!chk.allowed) return;
      try {
        const resp = await MarketDataProvider.getCompanyNews(sym);
        if (resp.source === 'indian') {
          companyNewsFetched += 1;
          await setCooldown(sym, 'news');
        }
      } catch (err) {
        log.warn('company news fetch failed', {
          symbol: sym,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // 3. Historical refresh — opportunistic, only for Tier 1 symbols,
    //    and only if not already fresh in cache (TTL 24h, handled by
    //    MarketDataProvider.getHistorical).  Budget gated.
    let historicalRefreshed = 0;
    if (budget.level === 'normal') {
      // Pick 2 Tier 1 symbols per cycle, rotating.
      const tier1 = (await import('../schedulerConfig')).getTier(1);
      const rotateIdx = Math.floor((Date.now() / (60 * 60 * 1000))) % Math.max(tier1.length, 1);
      const toRefresh = [tier1[rotateIdx], tier1[(rotateIdx + 1) % tier1.length]].filter(Boolean);
      const eligibleHist = await filterNotCoolingDown(toRefresh, 'hist');

      await boundedAll(eligibleHist, 1, async (sym) => {
        const chk = await canSpend('hist', 1);
        if (!chk.allowed) return;
        try {
          await MarketDataProvider.getHistorical(sym, '1mo');
          await setCooldown(sym, 'hist');
          historicalRefreshed += 1;
        } catch (err) {
          log.warn('historical refresh failed', {
            symbol: sym,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    }

    return {
      marketNewsOk,
      companyNewsFetched,
      historicalRefreshed,
      level: budget.level,
    };
  });
}

// ══════════════════════════════════════════════════════════════════
//  Helpers
// ══════════════════════════════════════════════════════════════════

/** Load batch-universe snapshots from the per-symbol cache. Uses
 *  Redis-backed helpers so cross-process batch writes are visible. */
async function loadBatchUniverseSnapshots(): Promise<Array<MarketSnapshot & {
  yearHigh?: number; yearLow?: number; volumeAvg20d?: number;
}>> {
  const universe = getBatchUniverse();
  const out: Array<MarketSnapshot & { yearHigh?: number; yearLow?: number; volumeAvg20d?: number }> = [];
  await boundedAll(universe, 16, async (sym) => {
    const snap = await redisCacheGet<MarketSnapshot>(`quote:${sym}`);
    if (snap) {
      // yearHigh/Low/volumeAvg20d can be enriched from a separate
      // corporate cache if available; best-effort, never blocks trigger.
      const corp = await redisCacheGet<{ yearHigh?: number; yearLow?: number; volumeAvg20d?: number }>(
        `corp:${sym}`,
      );
      out.push({ ...snap, ...(corp ?? {}) });
    }
  });
  return out;
}

async function loadMoversFromCache(): Promise<MoversResult> {
  const v = await redisCacheGet<MoversResult>('movers:NIFTY500');
  return v ?? { gainers: [], losers: [], mostActive: [] };
}
async function loadShockersFromCache(): Promise<string[]> {
  return (await redisCacheGet<string[]>('movers:price_shockers')) ?? [];
}
async function loadMostActiveFromCache(): Promise<MoversBucket[]> {
  return (await redisCacheGet<MoversBucket[]>('movers:nse_most_active')) ?? [];
}

/** Bounded-concurrency map — keeps the trigger tier from stampeding. */
async function boundedAll<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (item === undefined) return;
      try { await fn(item); }
      catch (err) {
        log.warn('bounded task failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
  await Promise.all(workers);
}

// ══════════════════════════════════════════════════════════════════
//  HEARTBEAT — fast cache-warm probe (every 60s during market hours)
//
//  Spec FIX-DATA-PIPELINE §4: the dashboard expects a non-null
//  `last_pipeline_run` while the market is open. The 10-minute Tier A
//  cron leaves a 0–10 min gap which the freshness probe surfaces as
//  null. The heartbeat closes that gap by:
//    1. Reading the per-symbol cache for the heartbeat universe (free).
//    2. Calling `getBatchLiveSnapshots` only for symbols whose cache
//       is empty/stale — the budget guard already caps the quota cost.
//    3. Bumping the heartbeat key.
//
//  Cost model: with QUOTE_TTL_S=60 and a 60s tick, the second tick
//  is a 100% cache hit and consumes ZERO upstream calls. Worst-case
//  cold-start tick cost = batchUniverse × 1 (still budget-guarded).
// ══════════════════════════════════════════════════════════════════

interface HeartbeatTierDetails {
  cacheHits: number;
  cacheMisses: number;
  upstreamCallsMade: number;
}

export async function runHeartbeatTier(): Promise<TierReport<HeartbeatTierDetails>> {
  return runTier('heartbeat', async () => {
    const universe = getBatchUniverse();
    if (universe.length === 0) {
      return { cacheHits: 0, cacheMisses: 0, upstreamCallsMade: 0 };
    }

    // Cache probe pass — count what's already warm.
    let cacheHits = 0;
    let cacheMisses = 0;
    for (const sym of universe) {
      const v = await redisCacheGet<MarketSnapshot>(`quote:${sym}`);
      if (v && Number.isFinite(v.price) && v.price > 0) cacheHits += 1;
      else cacheMisses += 1;
    }

    // Refresh ONLY the cold cells. getBatchLiveSnapshots is itself
    // cache-first + budget-guarded, so this is the safest live-feed
    // top-up call in the codebase.
    let upstreamCallsMade = 0;
    if (cacheMisses > 0) {
      const r = await MarketDataProvider.getBatchLiveSnapshots(universe);
      upstreamCallsMade = r.batchCallsMade;
      console.log(`[DATA] heartbeat refreshed misses=${cacheMisses} upstream=${upstreamCallsMade}`);
    }

    // Canonical scan-coverage roll-up so the heartbeat dashboard can
    // see in one grep how warm the universe cache is between full
    // batch tiers (which run every 10 min).
    const coveragePct = universe.length > 0
      ? Math.round((cacheHits / universe.length) * 1000) / 10
      : 0;
    console.log('[SCAN_COVERAGE]', {
      stage:        'scheduler.heartbeat',
      universe:     universe.length,
      cache_hits:   cacheHits,
      cache_misses: cacheMisses,
      coverage_pct: coveragePct,
      upstream_calls_made: upstreamCallsMade,
    });
    recordHeartbeatTick({
      universe:     universe.length,
      cache_hits:   cacheHits,
      cache_misses: cacheMisses,
    });
    try {
      const breaker = IndianAPI.indianApiBreakerState();
      console.log('[PROVIDER_HEALTH]', {
        provider:             'IndianAPI',
        stage:                'scheduler.heartbeat',
        breaker_open:         breaker.open,
        breaker_state:        breaker.state,
        breaker_remaining_ms: breaker.remainingMs,
        auth_failed:          breaker.auth_failed,
        cache_coverage_pct:   coveragePct,
      });
    } catch { /* breaker probe is best-effort */ }

    return { cacheHits, cacheMisses, upstreamCallsMade };
  });
}

// Re-export ops handles for admin endpoints / tests.
export { tierOf, budgetSnapshot };
