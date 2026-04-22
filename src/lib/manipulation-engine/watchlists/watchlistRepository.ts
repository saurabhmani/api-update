// ════════════════════════════════════════════════════════════════
//  Phase 3 — Watchlist Persistence
//
//  Reads/writes the q365_manipulation_watchlists and history tables.
//  All write paths go through `applyWatchlistChanges` so the audit
//  trail in *_history is always in sync with current state.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type {
  WatchlistEntry, WatchlistType, WatchlistChangeRecord,
} from '../types';
import type { WatchlistChange } from './watchlistEvaluator';

export async function loadWatchlistForSymbol(symbol: string): Promise<WatchlistEntry[]> {
  const { rows } = await db.query<any>(
    `SELECT * FROM q365_manipulation_watchlists WHERE symbol = ?`,
    [symbol],
  );
  return (rows ?? []).map(rowToEntry);
}

export async function loadWatchlist(type: WatchlistType): Promise<WatchlistEntry[]> {
  const { rows } = await db.query<any>(
    `SELECT * FROM q365_manipulation_watchlists
     WHERE watchlist_type = ?
     ORDER BY score_at_add DESC, added_at DESC`,
    [type],
  );
  return (rows ?? []).map(rowToEntry);
}

export async function loadAllWatchlists(): Promise<Record<WatchlistType, WatchlistEntry[]>> {
  const types: WatchlistType[] = ['suspicious_symbols', 'high_risk_operator', 'event_cluster'];
  const result = {} as Record<WatchlistType, WatchlistEntry[]>;
  for (const t of types) result[t] = await loadWatchlist(t);
  return result;
}

export async function applyWatchlistChanges(changes: WatchlistChange[]): Promise<void> {
  for (const c of changes) {
    if (c.changeType === 'added' || c.changeType === 'refreshed') {
      await db.query(
        `INSERT INTO q365_manipulation_watchlists
          (symbol, watchlist_type, score_at_add, band_at_add, reason, cooling_off_until)
         VALUES (?, ?, ?, ?, ?, NULL)
         ON DUPLICATE KEY UPDATE
           score_at_add = VALUES(score_at_add),
           band_at_add  = VALUES(band_at_add),
           reason       = VALUES(reason),
           cooling_off_until = NULL`,
        [c.symbol, c.watchlistType, c.score ?? 0, c.band ?? 'low', c.reason],
      );
    } else if (c.changeType === 'downgraded') {
      // Set cooling_off_until from the reason string suffix (date) — caller
      // already encoded it. Re-derive defensively if missing.
      const m = /until (\d{4}-\d{2}-\d{2})/.exec(c.reason);
      const until = m ? m[1] : null;
      await db.query(
        `UPDATE q365_manipulation_watchlists
         SET cooling_off_until = ?
         WHERE symbol = ? AND watchlist_type = ?`,
        [until, c.symbol, c.watchlistType],
      );
    } else if (c.changeType === 'removed') {
      await db.query(
        `DELETE FROM q365_manipulation_watchlists
         WHERE symbol = ? AND watchlist_type = ?`,
        [c.symbol, c.watchlistType],
      );
    }

    // Always log the change to history.
    await db.query(
      `INSERT INTO q365_manipulation_watchlist_history
        (symbol, watchlist_type, change_type, score, band, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [c.symbol, c.watchlistType, c.changeType, c.score, c.band, c.reason],
    );
  }
}

export async function loadWatchlistHistory(
  symbol?: string,
  type?: WatchlistType,
  limit = 200,
): Promise<WatchlistChangeRecord[]> {
  const conds: string[] = [];
  const params: any[] = [];
  if (symbol) { conds.push('symbol = ?'); params.push(symbol); }
  if (type)   { conds.push('watchlist_type = ?'); params.push(type); }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const safe = Math.max(1, Math.min(limit, 1000));
  const { rows } = await db.query<any>(
    `SELECT * FROM q365_manipulation_watchlist_history
     ${where}
     ORDER BY changed_at DESC
     LIMIT ${safe}`,
    params,
  );
  return (rows ?? []).map((r: any) => ({
    id: r.id,
    symbol: r.symbol,
    watchlistType: r.watchlist_type,
    changeType: r.change_type,
    score: r.score != null ? Number(r.score) : null,
    band: r.band ?? null,
    reason: r.reason ?? null,
    changedAt: r.changed_at,
  }));
}

function rowToEntry(r: any): WatchlistEntry {
  return {
    id: r.id,
    symbol: r.symbol,
    watchlistType: r.watchlist_type,
    scoreAtAdd: Number(r.score_at_add),
    bandAtAdd: r.band_at_add,
    reason: r.reason ?? null,
    addedAt: r.added_at,
    coolingOffUntil: r.cooling_off_until
      ? (typeof r.cooling_off_until === 'string'
          ? r.cooling_off_until
          : new Date(r.cooling_off_until).toISOString().split('T')[0])
      : null,
  };
}
