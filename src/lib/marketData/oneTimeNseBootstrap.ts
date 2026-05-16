// ════════════════════════════════════════════════════════════════
//  One-time NSE bootstrap (SAFE_NSE_MODE companion)
//
//  Purpose: when the database starts up with NO market data anywhere
//  (cold deploy, brand-new environment, wiped Redis + empty
//  q365_market_close_snapshot), prime the system ONCE with real
//  prices by calling NSE direct in safe mode for ~25 NIFTY top names.
//  After that, the standard resolver flow takes over —
//
//      IndianAPI primary → cache → NSE direct rare fallback
//
//  This module is the ONLY component allowed to call NSE direct
//  proactively. It is gated by THREE independent conditions:
//
//    1. Persistent flag `nse_bootstrap_used` in cache is unset
//    2. q365_market_close_snapshot has zero rows
//    3. Caller hasn't passed `force: true`
//
//  All three must hold for the bootstrap to fire. The flag is set
//  the moment the upstream call begins (not after success) so a
//  crash mid-call still prevents a re-fire — operators can clear
//  the flag manually if needed.
//
//  Market-closed safety: declined unless `force: true` is set,
//  matching the SAFE_NSE_MODE rule "IF market_closed: DO NOT call
//  any API".
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import { cacheGet, cacheSet } from '@/lib/redis';
import { db } from '@/lib/db';
import { fetchNseDirectQuotes } from './providers/nseDirectProvider';
import { cache, quoteCacheKey, QUOTE_TTL_OFFHRS_S } from '@/lib/cache';
import { isMarketOpen } from './marketHours';
import { propagateTicks } from './tickPropagator';
import type { MarketSnapshot } from '@/types/market';

const log = logger.child({ component: 'oneTimeNseBootstrap' });

// ── Config ────────────────────────────────────────────────────────

/** Cache key for the persistent "bootstrap already ran" flag. Lives
 *  in Redis when configured, in-process memory otherwise. The TTL is
 *  generous (1 year) — once set, it stays set until manually cleared
 *  with `clearBootstrapFlag()`. */
const FLAG_KEY = 'nse:bootstrap_used';
const FLAG_TTL_S = 365 * 24 * 3600;

/** Curated NIFTY top names. 25 symbols stays well under both NSE's
 *  per-day soft limit AND the 50-symbol daily cap baked into
 *  fetchNseDirectQuotes — leaves headroom for an emergency rare-path
 *  resolver call later in the day. */
const NIFTY_BOOTSTRAP_SYMBOLS = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
  'SBIN', 'HINDUNILVR', 'ITC', 'LT', 'KOTAKBANK',
  'BHARTIARTL', 'AXISBANK', 'ASIANPAINT', 'BAJFINANCE',
  'MARUTI', 'HCLTECH', 'WIPRO', 'SUNPHARMA',
  'NTPC', 'TITAN', 'POWERGRID', 'NESTLEIND',
  'ULTRACEMCO', 'JSWSTEEL', 'COALINDIA',
];

// ── Public envelope ──────────────────────────────────────────────

export interface BootstrapResponse {
  provider:         'nse';
  bootstrap:        true;
  status:           'completed' | 'skipped' | 'failed';
  message:          string;
  symbolsRequested: number;
  symbolsFetched:   number;
  /** Reason the bootstrap was skipped or failed. null on success. */
  reason:           string | null;
}

// ── Module-level singleton: prevent concurrent bootstraps ─────────

let inFlight: Promise<BootstrapResponse> | null = null;

// ── Flag helpers ──────────────────────────────────────────────────

export async function isBootstrapDone(): Promise<boolean> {
  const v = await cacheGet<boolean>(FLAG_KEY);
  return v === true;
}

async function setBootstrapDone(): Promise<void> {
  await cacheSet(FLAG_KEY, true, FLAG_TTL_S);
}

/** Operator escape hatch — clear the flag so the next call may
 *  bootstrap again. Intentionally not exposed via HTTP; callers wire
 *  it from a script if a re-bootstrap is genuinely needed. */
export async function clearBootstrapFlag(): Promise<void> {
  // cacheSet with TTL=1s effectively clears; redis lib doesn't expose
  // del() in the public surface this module imports.
  await cacheSet(FLAG_KEY, false, 1);
}

// ── DB emptiness probe ────────────────────────────────────────────

async function isDbEmpty(): Promise<boolean> {
  try {
    const { rows } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_market_close_snapshot`,
    );
    return Number((rows as Array<{ c: number }>)[0]?.c ?? 0) === 0;
  } catch (err) {
    // Table missing → treat as empty. The bootstrap will populate it
    // and the schema-ensure path will create the table on next boot.
    log.warn('q365_market_close_snapshot probe failed — treating as empty', {
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

// ── Condition gate ────────────────────────────────────────────────

export async function shouldRunBootstrap(): Promise<{
  should: boolean;
  reason: string;
}> {
  if (await isBootstrapDone()) {
    return { should: false, reason: 'flag_already_set' };
  }
  if (!(await isDbEmpty())) {
    return { should: false, reason: 'db_not_empty' };
  }
  return { should: true, reason: 'cache_and_db_empty' };
}

// ── Persistence ───────────────────────────────────────────────────

/** Write each bootstrap snapshot to q365_market_close_snapshot using
 *  the same column shape the resolver's market-closed gate reads.
 *  ON DUPLICATE KEY UPDATE keeps re-runs idempotent. */
async function persistToSnapshotTable(snapshots: MarketSnapshot[]): Promise<number> {
  if (snapshots.length === 0) return 0;
  // IST date string, matches the writer in marketCloseSnapshot.ts.
  const ist = new Date(Date.now() + 5.5 * 3_600_000);
  const sessionDate = ist.toISOString().slice(0, 10);
  let inserted = 0;
  for (const s of snapshots) {
    try {
      await db.query(
        `INSERT INTO q365_market_close_snapshot
           (symbol, price, change_abs, change_pct, volume,
            open_price, high_price, low_price, prev_close,
            snapshot_ts, snapshot_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           price       = VALUES(price),
           change_abs  = VALUES(change_abs),
           change_pct  = VALUES(change_pct),
           volume      = VALUES(volume),
           open_price  = VALUES(open_price),
           high_price  = VALUES(high_price),
           low_price   = VALUES(low_price),
           prev_close  = VALUES(prev_close),
           snapshot_ts = VALUES(snapshot_ts),
           snapshot_session = VALUES(snapshot_session)`,
        [
          s.symbol.toUpperCase(),
          s.price,
          s.change ?? 0,
          s.changePercent ?? 0,
          s.volume ?? 0,
          s.open ?? 0,
          s.high ?? 0,
          s.low ?? 0,
          s.prevClose ?? 0,
          new Date(Number.isFinite(s.timestamp) && s.timestamp > 0 ? s.timestamp : Date.now()),
          sessionDate,
        ],
      );
      inserted += 1;
    } catch (err) {
      log.warn('snapshot upsert failed', {
        symbol: s.symbol,
        error:  err instanceof Error ? err.message : String(err),
      });
    }
  }
  return inserted;
}

async function persistToQuoteCache(snapshots: MarketSnapshot[]): Promise<void> {
  // Off-hours TTL because bootstrap typically runs during cold boot;
  // if it runs during market hours, the next IndianAPI poll naturally
  // overwrites these entries within QUOTE_TTL_S.
  await Promise.all(snapshots.map((s) =>
    cache.set(quoteCacheKey(s.symbol.toUpperCase()), s, QUOTE_TTL_OFFHRS_S),
  ));
  void propagateTicks(snapshots);
}

// ── Public runner ─────────────────────────────────────────────────

export interface RunOpts {
  /** Override the market-closed and condition gates. Use only for
   *  manual operator-triggered seeds. */
  force?: boolean;
}

/**
 * Run the one-time bootstrap. Idempotent: concurrent callers share
 * the same in-flight promise; subsequent calls after success return
 * `status: 'skipped'` with `reason: 'flag_already_set'`.
 */
export async function runOneTimeBootstrap(opts: RunOpts = {}): Promise<BootstrapResponse> {
  if (inFlight) return inFlight;

  inFlight = (async (): Promise<BootstrapResponse> => {
    // ── Gate 1: market-closed safety ───────────────────────────
    if (!opts.force && !isMarketOpen()) {
      return {
        provider:         'nse',
        bootstrap:        true,
        status:           'skipped',
        message:          'NSE bootstrap declined — market closed (use force=true to override)',
        symbolsRequested: 0,
        symbolsFetched:   0,
        reason:           'market_closed',
      };
    }

    // ── Gate 2: condition check ────────────────────────────────
    if (!opts.force) {
      const { should, reason } = await shouldRunBootstrap();
      if (!should) {
        return {
          provider:         'nse',
          bootstrap:        true,
          status:           'skipped',
          message:          `NSE bootstrap declined — ${reason}`,
          symbolsRequested: 0,
          symbolsFetched:   0,
          reason,
        };
      }
    }

    // ── Set the flag BEFORE the call so a crash mid-fetch still
    //    prevents a re-fire. Operator can clear it manually if needed.
    await setBootstrapDone();

    log.info('ONE-TIME NSE BOOTSTRAP — starting', {
      symbols: NIFTY_BOOTSTRAP_SYMBOLS.length,
      force:   !!opts.force,
    });

    // ── Run the safe-mode NSE fetch ────────────────────────────
    // fetchNseDirectQuotes already enforces the 7s gap, daily cap,
    // 403-trip, exponential backoff, and per-symbol cache. We piggy-
    // back on those guarantees and just persist the result.
    const result = await fetchNseDirectQuotes(NIFTY_BOOTSTRAP_SYMBOLS);

    if (result.snapshots.length === 0) {
      log.error('ONE-TIME NSE BOOTSTRAP — no data returned', {
        errorCode:    result.errorCode,
        errorMessage: result.errorMessage,
        exhausted:    result.exhausted,
      });
      return {
        provider:         'nse',
        bootstrap:        true,
        status:           'failed',
        message:          `NSE bootstrap returned no data: ${result.errorMessage ?? result.errorCode ?? 'unknown'}`,
        symbolsRequested: NIFTY_BOOTSTRAP_SYMBOLS.length,
        symbolsFetched:   0,
        reason:           result.errorCode ?? 'no_data',
      };
    }

    const dbWrites    = await persistToSnapshotTable(result.snapshots);
    await persistToQuoteCache(result.snapshots);

    // Spec-required log line — grep on `ONE_TIME_BOOTSTRAP_COMPLETED`.
    log.info('ONE_TIME_BOOTSTRAP_COMPLETED', {
      symbolsRequested: NIFTY_BOOTSTRAP_SYMBOLS.length,
      symbolsFetched:   result.snapshots.length,
      dbWrites,
      cachedSymbols:    result.cachedSymbols.length,
      freshSymbols:     result.freshSymbols.length,
    });

    return {
      provider:         'nse',
      bootstrap:        true,
      status:           'completed',
      message:          'Initial real data loaded',
      symbolsRequested: NIFTY_BOOTSTRAP_SYMBOLS.length,
      symbolsFetched:   result.snapshots.length,
      reason:           null,
    };
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
