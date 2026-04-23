/**
 * GET /api/ticker
 *
 * Returns lightweight ticker data for the moving strip.
 * Read path (post-Kite-removal):
 *   1. Redis strip cache (30s TTL)     — serves most hits
 *   2. rankings table → top N symbols  — provides the symbol universe
 *   3. fetchYahooQuotesBatch(symbols)  — ONE HTTP call fills LTPs
 *   4. rankings.ltp / pct_change       — last-resort DB fallback
 *
 * Returns top 30 ranked symbols with symbol, name, ltp, change%.
 * Cached at Redis key 'ticker:strip' for 30s so repeated polls don't
 * fan out.
 */

import { NextRequest, NextResponse }   from 'next/server';
import { requireSession }              from '@/lib/session';
import { cacheGet, cacheSet }          from '@/lib/redis';
import { db }                          from '@/lib/db';
import { fetchYahooQuotesBatch }       from '@/lib/marketData/yahooBatch';

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
const STRIP_TTL = 30;
const LIMIT     = 30;

export async function GET(_req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  // ── Step 1: assembled strip cache ─────────────────────────────
  const stripped = await cacheGet<{ items: TickerItem[]; source: string }>(STRIP_KEY);
  if (stripped?.items?.length) {
    return NextResponse.json({
      items:  stripped.items,
      source: `${stripped.source}+cached`,
      count:  stripped.items.length,
    });
  }

  let items: TickerItem[] = [];
  let source = 'yahoo';

  try {
    // ── Step 2: universe from rankings ─────────────────────────
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

    const seen = new Set<string>();
    const deduped: any[] = [];
    for (const row of universe as any[]) {
      const sym = String(row.symbol || '').toUpperCase();
      if (!sym || seen.has(sym)) continue;
      seen.add(sym);
      deduped.push(row);
      if (deduped.length >= LIMIT) break;
    }

    // ── Step 3: single Yahoo batch call ────────────────────────
    const symbols = deduped.map(r => String(r.symbol || '').toUpperCase()).filter(Boolean);
    const yahooMap = symbols.length > 0
      ? await fetchYahooQuotesBatch(symbols)
      : new Map();

    let yahooHits = 0;
    items = deduped.map(row => {
      const sym = String(row.symbol || '').toUpperCase();
      const y = yahooMap.get(sym);
      if (y && y.price != null && y.price > 0) {
        yahooHits += 1;
        return {
          symbol:         sym,
          name:           String(row.name || sym),
          ltp:            y.price,
          change_percent: y.pChange ?? 0,
          change_abs:     y.change  ?? 0,
        } satisfies TickerItem;
      }
      // ── Step 4: fallback to DB rankings values ──────────────
      const dbLtp = Number(row.db_ltp) || 0;
      const dbPct = Number(row.db_pct) || 0;
      return {
        symbol:         sym,
        name:           String(row.name || sym),
        ltp:            dbLtp,
        change_percent: dbPct,
        change_abs:     dbLtp > 0 && dbPct !== 0 && (100 + dbPct) !== 0
          ? (dbLtp * dbPct) / (100 + dbPct)
          : 0,
      } satisfies TickerItem;
    }).filter(i => i.ltp > 0 || i.change_percent !== 0);

    source = yahooHits === items.length && items.length > 0
      ? 'yahoo'
      : yahooHits > 0 ? 'yahoo+db' : 'db';
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

  if (items.length) {
    await cacheSet(STRIP_KEY, { items, source }, STRIP_TTL);
  }

  return NextResponse.json({ items, source, count: items.length });
}
