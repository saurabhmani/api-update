// ════════════════════════════════════════════════════════════════
//  dynamicSubscriptionSync — keep the Kite subscription narrow
//
//  The old bootTicker subscribed all ~2700 NSE EQ symbols on start.
//  That burns ticker quota (Kite caps 3000/connection), saturates
//  the client WS with frames for symbols the UI never shows, and
//  drowns out the actionable rows.
//
//  This module flips that: we subscribe ONLY what the UI is likely
//  to display — active signals + a small buffer. On every sync we:
//    1. Pull the current "hot universe" (active + watchlist signal
//       symbols, capped at SYNC_CAP).
//    2. Diff against the ticker's current subscription set.
//    3. subscribeSymbols() for newcomers, unsubscribeSymbols() for
//       rows that fell off the list.
//
//  Safe under HMR: the timer handle is stashed on globalThis.
//
//  Resync cadence defaults to 30s — slow enough not to thrash Kite,
//  fast enough that a fresh pipeline run reaches the live feed
//  within one cycle.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getTicker, type TickMode } from './kiteTicker';

const GLOBAL_KEY = '__q365_dyn_sub_sync__';

// Sizing: 50 rows shown on the signals page, 100 buffer for
// recently-closed signals and instrument deep-searches from /search.
// Keep under 200 so WS UNIVERSE stays in the target band.
const SYNC_CAP = Math.max(50, Math.min(200,
  Number(process.env.DYN_SUB_CAP) || 150));

// Spec requires every-10s subscription reconciliation so a freshly
// generated signal reaches the live feed inside one cycle and any
// drift between the desired and on-wire set self-heals immediately.
// Floor is 5s — anything tighter would thrash Kite without benefit.
const SYNC_INTERVAL_MS = Math.max(5_000,
  Number(process.env.DYN_SUB_INTERVAL_MS) || 10_000);

const MODE: TickMode = (() => {
  const raw = String(process.env.KITE_TICKER_MODE ?? 'full').toLowerCase();
  return raw === 'ltp' || raw === 'quote' || raw === 'full'
    ? (raw as TickMode)
    : 'full';
})();

interface SyncState {
  timer: NodeJS.Timeout | null;
  lastRunAt: number | null;
  lastSymbols: Set<string>;
  running: boolean;
  /**
   * Symbol → expires-at (ms epoch). Populated when a browser view
   * requests a live feed for a symbol that isn't in the q365_signals
   * hot universe. loadHotUniverse() unions this with the DB set so
   * the next sync SUBSCRIBES it and doesn't UNSUBSCRIBE it the cycle
   * after. Entries auto-expire via the TTL — if the user navigates
   * away and stops heartbeating, the symbol falls out naturally.
   */
  viewDemand: Map<string, number>;
}

function getState(): SyncState {
  const g = globalThis as unknown as Record<string, SyncState | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      timer:       null,
      lastRunAt:   null,
      lastSymbols: new Set(),
      running:     false,
      viewDemand:  new Map(),
    };
  }
  const s = g[GLOBAL_KEY]!;
  // Back-fill viewDemand if this state was created by an older build
  // that didn't have the field (HMR across versions).
  if (!s.viewDemand) s.viewDemand = new Map();
  return s;
}

// Default view-demand TTL — 2× the client heartbeat interval so a
// single missed heartbeat doesn't tear the subscription down.
const VIEW_DEMAND_TTL_MS = Math.max(
  30_000,
  Number(process.env.VIEW_DEMAND_TTL_MS) || 120_000,
);

/**
 * Mark a set of symbols as demanded by a browser view. loadHotUniverse()
 * will union them into the desired subscription set until the TTL
 * expires. Safe to call repeatedly (a re-call refreshes the TTL).
 */
export function markViewDemand(symbols: string[], ttlMs = VIEW_DEMAND_TTL_MS): void {
  if (!Array.isArray(symbols) || symbols.length === 0) return;
  const state = getState();
  const expiresAt = Date.now() + ttlMs;
  for (const s of symbols) {
    const up = String(s ?? '').trim().toUpperCase();
    if (up) state.viewDemand.set(up, expiresAt);
  }
}

/** Return the set of non-expired view-demand symbols. */
export function getActiveViewDemand(): Set<string> {
  const state = getState();
  const now = Date.now();
  const out = new Set<string>();
  // Also prune expired entries so the Map doesn't grow unbounded
  // when users navigate a lot.
  for (const [sym, exp] of state.viewDemand.entries()) {
    if (exp > now) out.add(sym);
    else state.viewDemand.delete(sym);
  }
  return out;
}

/**
 * Query the database for the symbols the UI will show right now.
 * Currently: active/watchlist rows in q365_signals, top N by
 * confidence_score (with opportunity_score as tiebreaker). Matches
 * the server-side ranking in /api/signals?action=all.
 */
async function loadHotUniverse(): Promise<string[]> {
  try {
    // GROUP BY + MAX(...) is equivalent to DISTINCT for the symbol set
    // but compatible with MySQL's ONLY_FULL_GROUP_BY sql_mode. The raw
    // DISTINCT + ORDER BY form fails on prod MySQL with:
    //   "Expression #1 of ORDER BY clause is not in SELECT list..."
    // because after DISTINCT you no longer have confidence_score
    // available to order by unambiguously (two rows with the same
    // symbol can have different scores).
    const { rows } = await db.query(
      `SELECT symbol,
              MAX(confidence_score)  AS max_confidence,
              MAX(opportunity_score) AS max_opportunity
       FROM q365_signals
       WHERE status IN ('active','watchlist','flagged')
       GROUP BY symbol
       ORDER BY max_confidence DESC, max_opportunity DESC
       LIMIT ?`,
      [SYNC_CAP],
    );
    const out: string[] = [];
    for (const r of rows as Array<{ symbol: string }>) {
      const s = String(r.symbol ?? '').trim().toUpperCase();
      if (s) out.push(s);
    }
    return out;
  } catch (err) {
    console.warn(
      `[dynSubSync] loadHotUniverse failed: ${(err as Error).message}`,
    );
    return [];
  }
}

export async function syncNow(): Promise<{
  target:    number;
  added:     number;
  removed:   number;
  onWire:    number;
}> {
  const state = getState();
  if (state.running) {
    return { target: 0, added: 0, removed: 0, onWire: state.lastSymbols.size };
  }
  state.running = true;
  try {
    const t0 = Date.now();
    const dbHot = await loadHotUniverse();
    const demand = getActiveViewDemand();
    // Union q365_signals hot set with live browser view-demand. Cap
    // the total so a runaway tab doesn't blow the Kite 3000/conn limit.
    const desiredSet = new Set<string>(dbHot);
    for (const s of demand) desiredSet.add(s);
    const desired = Array.from(desiredSet);
    if (desired.length > SYNC_CAP) desired.length = SYNC_CAP;

    const toAdd:    string[] = [];
    const toRemove: string[] = [];
    for (const s of desired) if (!state.lastSymbols.has(s)) toAdd.push(s);
    for (const s of state.lastSymbols) if (!desiredSet.has(s)) toRemove.push(s);

    const ticker = getTicker();

    if (toAdd.length > 0) {
      // subscribeSymbols is additive — already-subscribed tokens are
      // a no-op, so we can hand it just the newcomers.
      await ticker.subscribeSymbols(toAdd, MODE).catch((err) => {
        console.warn(`[dynSubSync] subscribe failed: ${(err as Error).message}`);
      });
    }
    // ADDITIVE-ONLY MODE (default):
    // bootTicker now subscribes the FULL universe baseline on connect,
    // so the dynSubSync's role is reduced to layering view-demand
    // symbols on top. Unsubscribing here would strip the baseline
    // every cycle and cause the "only partial stocks loaded" symptom
    // the operator reported. Flip DYN_SUB_UNSUBSCRIBE=1 in .env.local
    // if you want the historical narrow-subscription behavior back.
    const unsubEnabled = process.env.DYN_SUB_UNSUBSCRIBE === '1';
    if (toRemove.length > 0 && unsubEnabled) {
      await ticker.unsubscribeSymbols(toRemove).catch((err) => {
        console.warn(`[dynSubSync] unsubscribe failed: ${(err as Error).message}`);
      });
    }

    // In additive-only mode, lastSymbols must include everything we've
    // ever asked for so that a symbol which drops out of the hot set
    // doesn't get re-added on the next cycle (subscribe is cheap but
    // churning a log line every 10s for the same 150 rows is noise).
    // If unsubscribe is enabled, lastSymbols tracks the desired set.
    state.lastSymbols = unsubEnabled
      ? desiredSet
      : new Set<string>([...state.lastSymbols, ...desiredSet]);
    state.lastRunAt = Date.now();
    const onWire = ticker.getStatus().subscribed;

    const effectiveRemoved = unsubEnabled ? toRemove.length : 0;
    console.log(
      `[dynSubSync] tick  ${Date.now() - t0}ms  ` +
      `target=${desired.length}  db=${dbHot.length}  demand=${demand.size}  ` +
      `added=${toAdd.length}  removed=${effectiveRemoved}  onWire=${onWire}  ` +
      `mode=${unsubEnabled ? 'diff' : 'additive'}`,
    );
    return { target: desired.length, added: toAdd.length, removed: effectiveRemoved, onWire };
  } finally {
    state.running = false;
  }
}

export function startDynamicSubscriptionSync(): void {
  const state = getState();
  if (state.timer) return;
  console.log(
    `[dynSubSync] ✓ starting  interval=${SYNC_INTERVAL_MS}ms  cap=${SYNC_CAP}  mode=${MODE}`,
  );
  // Run once immediately so the subscription is narrow from the
  // first tick onward, without waiting a full interval.
  syncNow().catch((err) => {
    console.warn(`[dynSubSync] initial sync failed: ${(err as Error).message}`);
  });
  state.timer = setInterval(() => {
    syncNow().catch((err) => {
      console.warn(`[dynSubSync] interval sync failed: ${(err as Error).message}`);
    });
  }, SYNC_INTERVAL_MS);
}

export function stopDynamicSubscriptionSync(): void {
  const state = getState();
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

export function getSyncState(): { lastRunAt: number | null; lastSymbols: string[] } {
  const state = getState();
  return {
    lastRunAt:   state.lastRunAt,
    lastSymbols: [...state.lastSymbols],
  };
}
