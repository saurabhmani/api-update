/**
 * GET /api/ticker
 *
 * Returns lightweight ticker data for the moving strip.
 * Read priority (fresh → stale):
 *   1. tickStore              — live Kite WS ticks (updated every frame)
 *   2. Kite REST /quote       — one batched call for any gaps / after-hours
 *   3. Redis  stock:{SYMBOL}  — scheduler MarketSnapshot (TTL 60s)
 *   4. MySQL  rankings        — last-resort fallback
 *
 * Returns top 30 ranked symbols with symbol, price, change%.
 * Response is itself cached at Redis key 'ticker:strip' for 30s
 * so repeated browser polls don't fan out to 30 Redis reads each time.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import { cacheGet, cacheSet }        from '@/lib/redis';
import { db }                        from '@/lib/db';
import { getTickStore }              from '@/lib/marketData/tickStore';
import { kite, KiteAuthError }       from '@/lib/marketData/kiteRest';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export interface TickerItem {
  symbol:         string;
  name:           string;
  ltp:            number;
  change_percent: number;
  change_abs:     number;
}

const STRIP_KEY = 'ticker:strip';
const STRIP_TTL = 30;   // seconds — matches component's 30s refresh
const LIMIT     = 30;

export async function GET(_req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  // ── Step 1: Assembled strip cache (fastest path) ───────────────
  // Cache carries the ORIGINAL source label (kite-live / kite / mixed /
  // mysql) alongside items so the browser can see whether the cached
  // payload was Kite-sourced — returning a generic "redis" tag here
  // was misleading because the data itself was already fresh Kite data.
  const stripped = await cacheGet<{ items: TickerItem[]; source: string }>(STRIP_KEY);
  if (stripped?.items?.length) {
    return NextResponse.json({
      items:  stripped.items,
      source: `${stripped.source}+cached`,
      count:  stripped.items.length,
    });
  }

  // ── Step 2: Load universe from rankings ────────────────────────
  let items: TickerItem[] = [];
  let source = 'redis';

  try {
    // Pull the top-scoring row per symbol. Dedup happens in JS so we
    // don't touch only_full_group_by / ONLY_FULL_GROUP_BY / sql_mode
    // inconsistencies between local MySQL and the prod MariaDB build
    // (the MAX()+GROUP BY form tripped on prod with a generic 500).
    // LIMIT is inlined — `LIMIT ?` bound via mysql2 is coerced to a
    // string on some server/driver combinations and refuses the plan.
    const { rows: universe } = await db.query(`
      SELECT r.tradingsymbol                                           AS symbol,
             COALESCE(r.name, r.tradingsymbol)                         AS name,
             COALESCE(r.instrument_key,
               CONCAT('NSE_EQ|', r.tradingsymbol))                     AS instrument_key,
             COALESCE(r.ltp, 0)                                        AS db_ltp,
             COALESCE(r.pct_change, 0)                                 AS db_pct,
             r.score                                                   AS score
      FROM rankings r
      INNER JOIN (
        SELECT tradingsymbol, MAX(score) AS max_score
        FROM rankings
        WHERE score IS NOT NULL
        GROUP BY tradingsymbol
      ) best ON r.tradingsymbol = best.tradingsymbol
            AND r.score        = best.max_score
      ORDER BY r.score DESC
      LIMIT ${LIMIT * 4}
    `);

    // JS-side dedupe — keep the first (highest-score) row per symbol.
    const seen = new Set<string>();
    const deduped: any[] = [];
    for (const row of universe as any[]) {
      const sym = String(row.symbol || '').toUpperCase();
      if (!sym || seen.has(sym)) continue;
      seen.add(sym);
      deduped.push(row);
      if (deduped.length >= LIMIT) break;
    }

    // ── Step 3a: Try live Kite tickStore first ────────────────────
    // The ticker holds a map of symbol → Tick with lastPrice/close
    // that's updated on every WS frame. During market hours this is
    // the freshest source. After hours it still holds today's close
    // if the ticker was running during the session.
    const store = getTickStore();
    type EnrichedSlot = { row: any; sym: string; item: TickerItem | null };
    const slots: EnrichedSlot[] = deduped.map(row => ({
      row,
      sym: String(row.symbol || '').toUpperCase(),
      item: null,
    }));

    let kiteLiveHits = 0;
    for (const slot of slots) {
      const t = store.get(slot.sym);
      if (!t || !t.lastPrice) continue;
      const prevClose = Number(t.close) || 0;
      const lastPrice = Number(t.lastPrice) || 0;
      const changeAbs = t.change != null
        ? Number(t.change)
        : (prevClose > 0 ? lastPrice - prevClose : 0);
      const changePct = t.pChange != null
        ? Number(t.pChange)
        : (prevClose > 0 ? ((lastPrice - prevClose) / prevClose) * 100 : 0);
      slot.item = {
        symbol:         slot.sym,
        name:           String(slot.row.name || slot.sym),
        ltp:            lastPrice,
        change_percent: changePct,
        change_abs:     changeAbs,
      };
      kiteLiveHits += 1;
    }

    // ── Step 3b: Fill gaps with ONE batched Kite REST /quote call ──
    // Kite /quote accepts up to 500 instruments per request. 30 NSE
    // equities is one fast call (~200-400ms). Returns current LTP
    // plus ohlc.close (previous day) so we can compute change_abs
    // correctly even after market hours.
    const missing = slots.filter(s => !s.item).map(s => s.sym);
    if (missing.length) {
      try {
        const instruments = missing.map(s => `NSE:${s}`);
        const quoteMap = await kite.get<Record<string, any>>('/quote', { i: instruments });
        for (const slot of slots) {
          if (slot.item) continue;
          const q = quoteMap?.[`NSE:${slot.sym}`];
          if (!q || !q.last_price) continue;
          const lastPrice = Number(q.last_price) || 0;
          const prevClose = Number(q.ohlc?.close) || 0;
          const changeAbs = q.net_change != null
            ? Number(q.net_change)
            : (prevClose > 0 ? lastPrice - prevClose : 0);
          const changePct = prevClose > 0
            ? ((lastPrice - prevClose) / prevClose) * 100
            : 0;
          slot.item = {
            symbol:         slot.sym,
            name:           String(slot.row.name || slot.sym),
            ltp:            lastPrice,
            change_percent: changePct,
            change_abs:     changeAbs,
          };
        }
      } catch (err: any) {
        if (err instanceof KiteAuthError) {
          console.warn('[/api/ticker] Kite /quote auth failed — falling back to cache', err.message);
        } else {
          console.warn('[/api/ticker] Kite /quote failed — falling back to cache:', err?.message);
        }
      }
    }

    // ── Step 3c: Redis stock:{SYMBOL} then MySQL rankings for the rest ──
    const enriched = await Promise.all(slots.map(async (slot) => {
      if (slot.item) return slot.item;

      const snap = await cacheGet<any>(`stock:${slot.sym}`);
      if (snap && snap.ltp) {
        source = 'mixed';
        return {
          symbol:         slot.sym,
          name:           String(slot.row.name || slot.sym),
          ltp:            Number(snap.ltp)            || 0,
          change_percent: Number(snap.change_percent) || 0,
          change_abs:     Number(snap.change_abs)     || 0,
        } satisfies TickerItem;
      }

      // Redis miss — use MySQL rankings values (stalest)
      source = 'mixed';
      const dbLtp = Number(slot.row.db_ltp) || 0;
      const dbPct = Number(slot.row.db_pct) || 0;
      // Recover change_abs from ltp+pct: pct = (ltp - prev) / prev * 100
      // → prev = ltp * 100 / (100 + pct) → change_abs = ltp - prev
      //                                = (ltp * pct) / (100 + pct)
      return {
        symbol:         slot.sym,
        name:           String(slot.row.name || slot.sym),
        ltp:            dbLtp,
        change_percent: dbPct,
        change_abs:     dbLtp > 0 && dbPct !== 0 && (100 + dbPct) !== 0
          ? (dbLtp * dbPct) / (100 + dbPct)
          : 0,
      } satisfies TickerItem;
    }));

    items = enriched.filter(i => i.ltp > 0 || i.change_percent !== 0);

    // Promote the source label when ALL rows came from Kite (live WS
    // or REST). If any row fell back to Redis/MySQL, `source` has
    // already been downgraded to 'mixed' above.
    if (items.length && source === 'redis') {
      source = kiteLiveHits === items.length ? 'kite-live' : 'kite';
    }
    if (!items.length) source = 'mysql';

  } catch (err: any) {
    console.error('[/api/ticker] DB error:', err?.message, err?.code, err?.sqlMessage);
    return NextResponse.json(
      {
        error:   'Failed to load ticker data',
        details: err?.sqlMessage || err?.message || 'unknown',
        code:    err?.code,
      },
      { status: 500 },
    );
  }

  // ── Step 4: Cache assembled strip (with source label) ─────────
  if (items.length) {
    await cacheSet(STRIP_KEY, { items, source }, STRIP_TTL);
  }

  return NextResponse.json({ items, source, count: items.length });
}
