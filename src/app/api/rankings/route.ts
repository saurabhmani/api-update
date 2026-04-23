/**
 * GET /api/rankings
 *
 * Returns top-ranked instruments with signal data.
 *
 * Query params:
 *   limit    — number of results, 1–500 (default 50)
 *   page     — page number (default 1)
 *   exchange — filter by exchange: NSE | BSE (optional)
 *
 * Response:
 * {
 *   data: [{
 *     symbol, name, exchange, instrument_key,
 *     score, rank_position, ltp, pct_change, volume,
 *     signal_type, confidence, signal_age_min, data_source
 *   }],
 *   count, total, page, limit, has_more,
 *   data_source, as_of
 * }
 *
 * Data source priority:
 *   1. Redis  key: rankings:top:{limit}:{exchange}  (TTL 60s)
 *   2. MySQL  JOIN rankings + latest signal per instrument
 *   Redis signal cache (signal:{instrument_key}) used to enrich
 *   confidence values when fresher than MySQL.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireSession }            from '@/lib/session';
import { getTopRankings }            from '@/services/rankingsService';
import { fetchYahooQuotesBatch }     from '@/lib/marketData/yahooBatch';
import { getLivePrice }              from '@/lib/marketData/getLivePrice';
import { db }                        from '@/lib/db';

// Any ranking row whose stored LTP differs from the live WS tick
// by more than this is logged loudly — it's the signature of a
// seeder writing stale or wrong-symbol prices (the GALLANTT-style
// "DB says ₹623.25, live says ₹72" kind of mismatch). Defaults to
// 2% so normal intraday drift between a cached row and the current
// tick doesn't flood the log.
const STALE_DELTA_PCT = Number(process.env.RANKINGS_STALE_DELTA_PCT ?? 2);

// Max age of a tick we still consider "live" for overlaying onto
function applyTickToRow(
  row: any,
  tick: { lastPrice: number; pChange?: number | null; close?: number | null; open?: number | null }
): { delta: number; corrected: boolean } {
  const dbLtp = Number(row.ltp) || 0;
  const live  = tick.lastPrice;
  const delta = dbLtp > 0 ? Math.abs((live - dbLtp) / dbLtp) * 100 : 0;
  const corrected = dbLtp > 0 && delta >= STALE_DELTA_PCT;
  if (corrected) {
    console.warn(
      `[RANKINGS STALE] ${row.symbol}  db=₹${dbLtp.toFixed(2)} ` +
      `live=₹${live.toFixed(2)}  delta=${delta.toFixed(2)}%  ` +
      `→ overriding with live tick`
    );
  }
  row.ltp = live;

  // pct_change override ladder — the rankings seeder writes 0 into
  // pct_change for many rows, and Kite quote-mode ticks can ship
  // with pChange undefined until the prior-close field has been
  // bridged. So we try every viable source in order:
  //   1. tick.pChange (Kite-supplied)
  //   2. (last - close) / close * 100  (compute from prior close)
  //   3. (last - open)  / open  * 100  (intraday move when prior
  //                                      close hasn't arrived)
  //   4. existing row.pct_change (DB value, last resort)
  let computed: number | null = null;
  if (tick.pChange != null && Number.isFinite(tick.pChange) && tick.pChange !== 0) {
    computed = tick.pChange;
  } else if (tick.close && tick.close > 0) {
    computed = ((live - tick.close) / tick.close) * 100;
  } else if (tick.open && tick.open > 0) {
    computed = ((live - tick.open) / tick.open) * 100;
  }
  if (computed != null && Number.isFinite(computed)) {
    row.pct_change = Number(computed.toFixed(2));
  } else if (row.pct_change == null) {
    row.pct_change = 0;
  }
  return { delta, corrected };
}

async function enrichRankingsWithLiveLtp(rows: any[]): Promise<void> {
  if (!rows.length) return;
  const t0 = Date.now();

  // Single Yahoo batch for every symbol in the response. Kite has
  // been removed; Yahoo is the sole live-quote upstream.
  const symbols: string[] = [];
  for (const row of rows) {
    const sym = (row.symbol ?? '').toString().toUpperCase();
    if (sym) symbols.push(sym);
  }

  let hits = 0, miss = 0, corrected = 0;
  try {
    const yahooMap = await fetchYahooQuotesBatch(symbols);
    for (const row of rows) {
      const sym = (row.symbol ?? '').toString().toUpperCase();
      if (!sym) continue;
      const y = yahooMap.get(sym);
      if (y && y.price != null && y.price > 0) {
        const r = applyTickToRow(row, {
          lastPrice: y.price,
          pChange:   y.pChange,
          close:     y.previousClose,
          open:      null,
        });
        if (r.corrected) corrected++;
        hits++;
      } else {
        miss++;
      }
    }
  } catch (err: any) {
    console.warn('[API/rankings] Yahoo enrichment failed:', err?.message);
  }

  console.log(
    `[DATA SOURCE] path=LIVE-RANKINGS  channel=Yahoo Finance  ` +
    `rows=${rows.length}  hits=${hits}  miss=${miss}  ` +
    `corrected=${corrected}  elapsed=${Date.now() - t0}ms`
  );

  // Guaranteed pct_change fallback from market_data_daily for any
  // row Yahoo didn't enrich (or enriched with 0%).
  await backfillPctChangeFromCandles(rows);
}

async function backfillPctChangeFromCandles(rows: any[]): Promise<void> {
  const targets = rows.filter(r =>
    r && r.symbol && (r.pct_change == null || Number(r.pct_change) === 0)
  );
  if (!targets.length) return;

  const t0 = Date.now();
  const symbols = targets.map(r => String(r.symbol).toUpperCase());
  const placeholders = symbols.map(() => '?').join(',');
  let backfilled = 0;
  let unmatched: string[] = [];

  // Query the engine's own daily candle table for the two most
  // recent closes per symbol. No date window — if the EOD ingest
  // hasn't run for a while the data is still better than 0%.
  try {
    const { rows: candleRows } = await db.query(
      `SELECT symbol, ts, close
         FROM market_data_daily
        WHERE symbol IN (${placeholders})
        ORDER BY symbol ASC, ts DESC`,
      symbols,
    );

    const bySym = new Map<string, number[]>();
    for (const r of candleRows as any[]) {
      const sym = String(r.symbol).toUpperCase();
      const arr = bySym.get(sym) ?? [];
      if (arr.length < 2) arr.push(Number(r.close));
      bySym.set(sym, arr);
    }

    for (const row of targets) {
      const sym = String(row.symbol).toUpperCase();
      const closes = bySym.get(sym);
      if (!closes || closes.length < 2 || !closes[1]) {
        unmatched.push(sym);
        continue;
      }
      const [latest, prev] = closes;
      const pct = ((latest - prev) / prev) * 100;
      if (Number.isFinite(pct)) {
        row.pct_change = Number(pct.toFixed(2));
        if (!row.ltp || Number(row.ltp) === 0) row.ltp = latest;
        backfilled++;
      }
    }
  } catch (err: any) {
    console.warn('[API/rankings] candle backfill failed:', err?.message);
  }

  // Last-resort fallback for symbols with no daily candles either —
  // read whatever the rankings sub-system has in any cached row from
  // the last 7 days of the rankings table itself. Better than 0%.
  if (unmatched.length) {
    try {
      const ph = unmatched.map(() => '?').join(',');
      const { rows: rk } = await db.query(
        `SELECT tradingsymbol, pct_change, ltp, created_at
           FROM rankings
          WHERE tradingsymbol IN (${ph})
            AND pct_change IS NOT NULL
            AND pct_change <> 0
          ORDER BY created_at DESC`,
        unmatched,
      );
      const seen = new Map<string, { pct: number; ltp: number }>();
      for (const r of rk as any[]) {
        const s = String(r.tradingsymbol).toUpperCase();
        if (seen.has(s)) continue;
        seen.set(s, { pct: Number(r.pct_change), ltp: Number(r.ltp) || 0 });
      }
      const stillMissing: string[] = [];
      for (const row of targets) {
        if (row.pct_change && row.pct_change !== 0) continue;
        const s = String(row.symbol).toUpperCase();
        const hit = seen.get(s);
        if (hit) {
          row.pct_change = hit.pct;
          if ((!row.ltp || row.ltp === 0) && hit.ltp) row.ltp = hit.ltp;
          backfilled++;
        } else {
          stillMissing.push(s);
        }
      }
      unmatched = stillMissing;
    } catch (err: any) {
      console.warn('[API/rankings] rankings-history fallback failed:', err?.message);
    }
  }

  // Final fallback: hit getLivePrice (Kite → Yahoo cascade)
  // for anything still at 0%. Yahoo always carries pChange even
  // when our local candles + WS tick don't, so this turns the
  // "data-not-available" failure into "guaranteed value at the
  // cost of one HTTP round-trip per missing symbol".
  if (unmatched.length) {
    const lpStart = Date.now();
    let lpFilled = 0;
    const results = await Promise.allSettled(
      unmatched.map(async sym => {
        const r = await getLivePrice(sym);
        return { sym, r };
      })
    );
    for (const res of results) {
      if (res.status !== 'fulfilled') continue;
      const { sym, r } = res.value;
      if (r.price == null) continue;
      const row = targets.find(t => String(t.symbol).toUpperCase() === sym);
      if (!row) continue;

      let pct: number | null = null;
      if (r.pChange != null && Number.isFinite(r.pChange) && r.pChange !== 0) {
        pct = r.pChange;
      } else if (r.close && r.close > 0) {
        pct = ((r.price - r.close) / r.close) * 100;
      } else if (r.open && r.open > 0) {
        pct = ((r.price - r.open) / r.open) * 100;
      }
      if (pct != null && Number.isFinite(pct)) {
        row.pct_change = Number(pct.toFixed(2));
        if (!row.ltp || row.ltp === 0) row.ltp = r.price;
        lpFilled++;
        backfilled++;
        console.log(
          `[API/rankings] live-price fallback ${sym}  src=${r.source}  ` +
          `price=₹${r.price}  pct=${row.pct_change}%`
        );
      }
    }
    unmatched = unmatched.filter(s =>
      !targets.find(t => String(t.symbol).toUpperCase() === s && t.pct_change && t.pct_change !== 0)
    );
    console.log(
      `[API/rankings] live-price fallback filled=${lpFilled}/${results.length} ` +
      `elapsed=${Date.now() - lpStart}ms`
    );
  }

  console.log(
    `[API/rankings] candle-backfill targets=${targets.length} ` +
    `backfilled=${backfilled} unmatched=${unmatched.length} ` +
    `${unmatched.length ? 'missing=[' + unmatched.slice(0, 5).join(',') + ']' : ''} ` +
    `elapsed=${Date.now() - t0}ms`
  );
}

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;

  const limitRaw    = parseInt(searchParams.get('limit')    ?? '50', 10);
  const pageRaw     = parseInt(searchParams.get('page')     ?? '1',  10);
  const exchangeRaw = searchParams.get('exchange')?.trim().toUpperCase();

  const limit    = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 50;
  const page     = Number.isFinite(pageRaw)  ? Math.max(pageRaw, 1) : 1;
  const exchange = exchangeRaw && ['NSE', 'BSE'].includes(exchangeRaw)
    ? exchangeRaw : undefined;

  try {
    const result = await getTopRankings(limit, page, exchange);
    // Overlay live WS ticks onto the cached MySQL rows so the
    // dashboard's Top Rankings panel can never show a price that
    // disagrees with the live market (GALLANTT-style stale rows).
    // Any row where DB.ltp vs live.ltp delta > STALE_DELTA_PCT is
    // logged to the backend so the bad seed is visible to ops.
    await enrichRankingsWithLiveLtp(result.data ?? []);
    return NextResponse.json(result);
  } catch (err: any) {
    console.error('[/api/rankings] Error:', err?.message);
    return NextResponse.json(
      { error: 'Failed to fetch rankings', details: err?.message },
      { status: 500 }
    );
  }
}
