/**
 * GET /api/market
 *
 * Actions:  search | suggest | ltp | quotes
 * Resources: indices | quote
 *
 * Search priority:
 *   1. instruments table  (populated after admin instruments sync)
 *   2. rankings table     (top 60 live movers synced live)
 *   3. Universe cache     (all NIFTY 500 stocks with company names — always fresh)
 *   4. Live quote fetch   (single symbol exact-match fallback)
 */
import { NextRequest, NextResponse }  from 'next/server';
import { requireSession }             from '@/lib/session';
import { db }                         from '@/lib/db';
import { cacheGet }                   from '@/lib/redis';
import { fetchQuote,
         fetchQuoteFull,
         fetchMultipleQuotes,
         fetchGainersLosers,
         fetchIndices }               from '@/services/marketQuote';
import type { MarketSnapshot }        from '@/services/marketDataService';
import type { Tick }                  from '@/types';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

// ── Search helper: filter NIFTY 500 Redis cache by query ─────────
function searchUniverseCache(stocks: any[], q: string, exchange: string | null, limit: number) {
  const qUp   = q.toUpperCase();
  const qLow  = q.toLowerCase();

  const matched = stocks.filter(s => {
    const sym  = String(s.symbol  ?? s.sym           ?? '').toUpperCase();
    const name = String(s.symbolName ?? s.companyName ?? s.meta?.companyName ?? '').toLowerCase();
    const symMatch  = sym.startsWith(qUp) || sym.includes(qUp);
    const nameMatch = name.includes(qLow);
    if (!symMatch && !nameMatch) return false;
    if (exchange && s.identifier) {
      // Cache holds one exchange only; skip if BSE/FO filter requested
      if (!String(s.identifier ?? '').toUpperCase().includes(exchange)) return false;
    }
    return true;
  });

  // Exact symbol prefix first
  matched.sort((a, b) => {
    const aS = String(a.symbol ?? '').toUpperCase();
    const bS = String(b.symbol ?? '').toUpperCase();
    const aExact = aS.startsWith(qUp) ? 0 : 1;
    const bExact = bS.startsWith(qUp) ? 0 : 1;
    return aExact - bExact || aS.localeCompare(bS);
  });

  return matched.slice(0, limit).map(s => ({
    instrument_key:  String(s.identifier ?? `NSE_EQ|${s.symbol ?? ''}`),
    exchange:        'NSE',
    tradingsymbol:   String(s.symbol      ?? s.sym ?? '').toUpperCase(),
    name:            String(s.symbolName  ?? s.companyName ?? s.meta?.companyName ?? s.symbol ?? ''),
    instrument_type: 'EQ',
    expiry:          null,
    strike:          null,
    option_type:     null,
    ltp:             Number(s.ltp ?? s.lastPrice ?? s.ltP ?? 0) || 0,
    pct_change:      Number(s.pChange ?? s.perChange ?? 0) || 0,
  }));
}

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const action   = searchParams.get('action') || 'search';
  const resource = searchParams.get('resource');
  const force    = searchParams.get('force') === '1' || searchParams.get('refresh') === '1';

  // ── Resource: indices ─────────────────────────────────────────
  if (resource === 'indices') {
    const indices = await fetchIndices({ bypassCache: force });
    const res = NextResponse.json({
      indices,
      fetched_at: Date.now(),
      source: force ? 'live' : 'cached',
    });
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res;
  }

  // ── Resource: quote ───────────────────────────────────────────
  if (resource === 'quote') {
    const symbol = searchParams.get('symbol');
    if (!symbol) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
    const result = await fetchQuoteFull(symbol.toUpperCase(), { bypassCache: force });
    if (!result) return NextResponse.json({ error: 'Quote not available' }, { status: 503 });
    const { quote, fetchedAt } = result;
    const meta = {
      companyName: quote.symbol,
      industry: null, sector: null, macro: null, isin: null,
      listingDate: null, faceValue: null, issuedSize: null,
      lowerCP: null, upperCP: null, priceBand: null,
      surveillance: null, survDesc: null,
      isFNO: false, derivatives: null, slb: null, lastUpdateTime: null,
      pe: null, sectorPe: null, forwardPe: null, eps: null, beta: null,
      pbRatio: null, dividendYield: null, roe: null, debtToEquity: null,
      marketCap: null, avgVolume: null,
      week52High: quote.fiftyTwoWeekHigh ?? null,
      week52Low:  quote.fiftyTwoWeekLow  ?? null,
    };
    const res = NextResponse.json({ quote, meta, fetched_at: fetchedAt, last_updated: null, source: force ? 'live' : 'cached' });
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res;
  }

  // ── Search / Suggest ──────────────────────────────────────────
  if (action === 'search' || action === 'suggest') {
    const q        = searchParams.get('q')        || '';
    const exchange = searchParams.get('exchange') || null;
    const limit    = action === 'suggest' ? 8 : parseInt(searchParams.get('limit') || '100');

    if (q.length < 2) return NextResponse.json({ results: [] });

    const qUpper = q.toUpperCase();

    // ── Layer 1: instruments table (full master after admin sync) ──
    try {
      let instSql = `
        SELECT instrument_key, exchange, tradingsymbol, name,
               instrument_type, expiry, strike, option_type
        FROM instruments
        WHERE is_active = TRUE
          AND (tradingsymbol LIKE ? OR name LIKE ?)
      `;
      const instP: any[] = [`${qUpper}%`, `%${q}%`];
      if (exchange) { instSql += ` AND exchange = ?`; instP.push(exchange); }
      instSql += ` ORDER BY CASE WHEN tradingsymbol LIKE ? THEN 0 ELSE 1 END, tradingsymbol LIMIT ?`;
      instP.push(`${qUpper}%`, limit);

      const { rows } = await db.query(instSql, instP);
      if ((rows as any[]).length > 0) {
        return NextResponse.json({ results: rows, count: (rows as any[]).length, source: 'instruments' });
      }
    } catch { /* table may not exist yet */ }

    // ── Layer 2: Redis universe cache (all 500 stocks + company names) ──
    const nse500 = await cacheGet<any>('nse:/equity-stockIndices?index=NIFTY%20500');
    const stocks500: any[] = nse500?.data ?? [];

    if (stocks500.length > 0) {
      const hits = searchUniverseCache(stocks500, q, exchange, limit);
      if (hits.length > 0) {
        return NextResponse.json({ results: hits, count: hits.length, source: 'cache' });
      }
    }

    // ── Layer 3: rankings table (top 60 movers from DB) ──
    try {
      const exFilter = exchange ? ` AND r.exchange = '${exchange.replace(/['"]/g, '')}'` : '';
      const rankSql  = `
        SELECT
          COALESCE(r.instrument_key, CONCAT('NSE_EQ|', r.tradingsymbol)) AS instrument_key,
          COALESCE(r.exchange, 'NSE') AS exchange,
          r.tradingsymbol,
          COALESCE(r.name, r.tradingsymbol) AS name,
          'EQ' AS instrument_type,
          NULL  AS expiry,
          NULL  AS strike,
          NULL  AS option_type
        FROM rankings r
        INNER JOIN (
          SELECT tradingsymbol, MAX(score) AS max_score
          FROM rankings GROUP BY tradingsymbol
        ) best ON r.tradingsymbol = best.tradingsymbol AND r.score = best.max_score
        WHERE (r.tradingsymbol LIKE ? OR r.name LIKE ?)${exFilter}
        GROUP BY r.tradingsymbol
        ORDER BY CASE WHEN r.tradingsymbol LIKE ? THEN 0 ELSE 1 END, r.tradingsymbol
        LIMIT ?
      `;
      const { rows } = await db.query(rankSql, [`${qUpper}%`, `%${q}%`, `${qUpper}%`, limit]);
      if ((rows as any[]).length > 0) {
        return NextResponse.json({ results: rows, count: (rows as any[]).length, source: 'rankings' });
      }
    } catch { /* rankings table may be empty */ }

    // ── Layer 4: Direct live quote fetch (exact symbol only, last resort) ──
    // Only attempt if the query looks like a trading symbol (short, no spaces)
    if (q.length <= 20 && !q.includes(' ')) {
      try {
        const quote = await fetchQuote(qUpper);
        if (quote) {
          const result = [{
            instrument_key:  `NSE_EQ|${quote.symbol}`,
            exchange:        'NSE',
            tradingsymbol:   quote.symbol,
            name:            quote.symbol,
            instrument_type: 'EQ',
            expiry:          null,
            strike:          null,
            option_type:     null,
            ltp:             quote.lastPrice,
            pct_change:      quote.pChange,
          }];
          return NextResponse.json({ results: result, count: 1, source: 'live' });
        }
      } catch { /* resolver unavailable */ }
    }

    return NextResponse.json({ results: [], count: 0 });
  }

  // ── LTP — read from Redis stock cache, live fallback ─────────
  if (action === 'ltp') {
    const keysParam = searchParams.get('keys') || '';
    const keys      = keysParam.split(',').map(k => k.trim()).filter(Boolean);
    if (!keys.length) return NextResponse.json({ error: 'keys required' }, { status: 400 });
    if (keys.length > 500) return NextResponse.json({ error: 'Max 500 keys' }, { status: 400 });

    const result: Record<string, Tick> = {};
    const missingSymbols: string[] = [];

    for (const key of keys) {
      const sym = key.split('|')[1] ?? key;
      const snap = await cacheGet<MarketSnapshot>(`stock:${sym.toUpperCase()}`);
      if (snap?.ltp) {
        result[key] = {
          instrument_key: key,
          ltp:        snap.ltp,
          net_change: snap.change_abs,
          pct_change: snap.change_percent,
          volume:     snap.volume,
          oi:         snap.oi,
          ts:         new Date(snap.timestamp).toISOString(),
        };
      } else {
        missingSymbols.push(sym);
      }
    }

    // Also try pulling LTP from the universe cache before hitting the live resolver
    if (missingSymbols.length > 0) {
      const nse500 = await cacheGet<any>('nse:/equity-stockIndices?index=NIFTY%20500');
      const stocks500: any[] = nse500?.data ?? [];
      if (stocks500.length > 0) {
        const stillMissing: string[] = [];
        for (const sym of missingSymbols) {
          const s = stocks500.find((st: any) => String(st.symbol ?? '').toUpperCase() === sym.toUpperCase());
          if (s) {
            const key = `NSE_EQ|${sym}`;
            result[key] = {
              instrument_key: key,
              ltp:        Number(s.ltp ?? s.lastPrice ?? s.ltP ?? 0),
              net_change: Number(s.change ?? s.netChange ?? 0),
              pct_change: Number(s.pChange ?? s.perChange ?? 0),
              volume:     Number(s.totalTradedVolume ?? s.tradedQuantity ?? 0),
              oi:         0,
              ts:         new Date().toISOString(),
            };
          } else {
            stillMissing.push(sym);
          }
        }
        // Only hit the live resolver for truly missing ones
        if (stillMissing.length > 0) {
          const quotes = await fetchMultipleQuotes(stillMissing);
          for (const [sym, q] of Object.entries(quotes)) {
            const key = `NSE_EQ|${sym}`;
            result[key] = {
              instrument_key: key,
              ltp:        q.lastPrice,
              net_change: q.change,
              pct_change: q.pChange,
              volume:     q.totalTradedVolume,
              oi:         0,
              ts:         new Date().toISOString(),
            };
          }
        }
      } else {
        const quotes = await fetchMultipleQuotes(missingSymbols);
        for (const [sym, q] of Object.entries(quotes)) {
          const key = `NSE_EQ|${sym}`;
          result[key] = {
            instrument_key: key,
            ltp:        q.lastPrice,
            net_change: q.change,
            pct_change: q.pChange,
            volume:     q.totalTradedVolume,
            oi:         0,
            ts:         new Date().toISOString(),
          };
        }
      }
    }

    return NextResponse.json({ data: result, count: Object.keys(result).length });
  }

  // ── Quotes (full snapshot) ─────────────────────────────────────
  if (action === 'quotes') {
    const symbolsParam = searchParams.get('symbols') || '';
    const symbols      = symbolsParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    if (!symbols.length) return NextResponse.json({ error: 'symbols required' }, { status: 400 });

    const result: Record<string, any> = {};

    // No hard cap — iterate the full symbol list the caller supplied.
    for (const sym of symbols) {
      const snap = await cacheGet<MarketSnapshot>(`stock:${sym}`);
      if (snap) { result[sym] = snap; continue; }
      const q = await fetchQuote(sym);
      if (q) {
        result[sym] = {
          symbol:         q.symbol,
          ltp:            q.lastPrice,
          change_percent: q.pChange,
          change_abs:     q.change,
          open:           q.open,
          high:           q.dayHigh,
          low:            q.dayLow,
          close:          q.previousClose,
          volume:         q.totalTradedVolume,
          week52_high:    q.fiftyTwoWeekHigh,
          week52_low:     q.fiftyTwoWeekLow,
          vwap:           q.vwap,
          source:         'live',
        };
      }
    }

    return NextResponse.json({ data: result });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
