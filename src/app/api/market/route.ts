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
import { DEFAULT_PHASE1_CONFIG }      from '@/lib/signal-engine/constants/signalEngine.constants';
import { fetchYahooQuotesBatch }      from '@/lib/marketData/yahooBatch'; // @deprecated marker

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

// ── Search helper: filter the static signal-engine universe ─────
//
// This is a deliberate "always-available" fallback. The preceding
// search layers (instruments table, NSE Redis cache, rankings) all
// depend on something having populated them — on a fresh install
// those are all empty and the search returned zero rows for every
// query. The engine's configured universe is ~245 liquid NSE
// equities that we KNOW are tradeable, so it's a safe last resort
// that keeps the page usable. Also includes the handful of Indian
// indices users search by ticker (NIFTY / BANKNIFTY / etc.) which
// never live in the equities path.
const STATIC_INDEX_ROWS: Array<{ instrument_key: string; exchange: string; tradingsymbol: string; name: string }> = [
  { instrument_key: 'NSE_INDEX|NIFTY 50',           exchange: 'NSE', tradingsymbol: 'NIFTY',      name: 'NIFTY 50' },
  { instrument_key: 'NSE_INDEX|NIFTY BANK',         exchange: 'NSE', tradingsymbol: 'BANKNIFTY',  name: 'NIFTY BANK' },
  { instrument_key: 'NSE_INDEX|NIFTY FIN SERVICE',  exchange: 'NSE', tradingsymbol: 'FINNIFTY',   name: 'NIFTY Financial Services' },
  { instrument_key: 'NSE_INDEX|NIFTY MID SELECT',   exchange: 'NSE', tradingsymbol: 'MIDCPNIFTY', name: 'NIFTY Midcap Select' },
  { instrument_key: 'NSE_INDEX|NIFTY IT',           exchange: 'NSE', tradingsymbol: 'NIFTYIT',    name: 'NIFTY IT' },
  { instrument_key: 'BSE_INDEX|SENSEX',             exchange: 'BSE', tradingsymbol: 'SENSEX',     name: 'BSE SENSEX' },
  { instrument_key: 'NSE_INDEX|INDIA VIX',          exchange: 'NSE', tradingsymbol: 'INDIAVIX',   name: 'India VIX' },
];

function searchStaticUniverse(q: string, limit: number) {
  const qUp  = q.toUpperCase();
  const qLow = q.toLowerCase();

  const indexHits = STATIC_INDEX_ROWS
    .filter(r => r.tradingsymbol.includes(qUp) || r.name.toLowerCase().includes(qLow))
    .map(r => ({
      ...r,
      instrument_type: 'INDEX',
      expiry: null, strike: null, option_type: null,
    }));

  const eqHits = DEFAULT_PHASE1_CONFIG.universe
    .filter(sym => sym.toUpperCase().includes(qUp))
    .map(sym => ({
      instrument_key:  `NSE_EQ|${sym}`,
      exchange:        'NSE',
      tradingsymbol:   sym,
      name:            sym,
      instrument_type: 'EQ',
      expiry: null, strike: null, option_type: null,
    }));

  const merged = [...indexHits, ...eqHits];

  // Prefix matches first, then alphabetical.
  merged.sort((a, b) => {
    const aExact = a.tradingsymbol.toUpperCase().startsWith(qUp) ? 0 : 1;
    const bExact = b.tradingsymbol.toUpperCase().startsWith(qUp) ? 0 : 1;
    return aExact - bExact || a.tradingsymbol.localeCompare(b.tradingsymbol);
  });

  return merged.slice(0, limit);
}

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

  // ── Yahoo-direct bulk LTP (live prices, no stale cache) ─────── // @deprecated marker
  // Bypasses the Kite/Redis path used by action=ltp and goes // @deprecated marker
  // straight to Yahoo's v7/quote batch endpoint (with parallel // @deprecated marker
  // v8/chart fallback). One HTTP call covers up to ~100 symbols,
  // so polling 200+ symbols is cheap. Response is keyed by the
  // same instrument_key format the page already consumes, so the
  // client just swaps the endpoint.
  if (action === 'yahoo-ltp') { // @deprecated marker
    const keysParam = searchParams.get('keys')    || '';
    const symParam  = searchParams.get('symbols') || '';
    const keys      = keysParam.split(',').map(k => k.trim()).filter(Boolean);
    const extraSyms = symParam.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);

    // Accept either NSE_EQ|SYMBOL keys or bare symbol strings; index
    // rows carry 'NSE_INDEX|...' keys that Yahoo's .NS path can't // @deprecated marker
    // resolve, so we drop them upfront. The top-of-page indices
    // strip gets its prices from action=indices already.
    const symFromKeys: string[] = [];
    for (const k of keys) {
      if (k.startsWith('NSE_INDEX|') || k.startsWith('BSE_INDEX|')) continue;
      const sym = (k.split('|')[1] ?? k).toUpperCase();
      if (sym) symFromKeys.push(sym);
    }
    const allSyms = [...new Set([...symFromKeys, ...extraSyms])];
    if (allSyms.length === 0) return NextResponse.json({ data: {}, count: 0 });
    if (allSyms.length > 500)  return NextResponse.json({ error: 'Max 500 symbols' }, { status: 400 });

    const quotes = await fetchYahooQuotesBatch(allSyms); // @deprecated marker
    const data: Record<string, Tick> = {};
    const nowIso = new Date().toISOString();
    for (const [sym, q] of quotes.entries()) {
      const key = `NSE_EQ|${sym}`;
      data[key] = {
        instrument_key: key,
        ltp:        q.price   ?? 0,
        net_change: q.change  ?? 0,
        pct_change: q.pChange ?? 0,
        volume:     0,
        oi:         0,
        ts:         q.marketTime ? new Date(q.marketTime).toISOString() : nowIso,
      };
    }
    const res = NextResponse.json({ data, count: Object.keys(data).length, source: 'yahoo' }); // @deprecated marker
    res.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    return res;
  }

  // ── Full list (for "all stocks" view on /market) ──────────────
  // Returns the entire static universe + known indices in one
  // response. The page filters client-side as the user types, so
  // there's no per-keystroke API round-trip and no dependency on
  // any DB table being populated.
  if (action === 'list') {
    const limit = parseInt(searchParams.get('limit') || '1000');
    const results = searchStaticUniverse('', limit);
    return NextResponse.json({ results, count: results.length, source: 'universe' });
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

    // ── Layer 4: Direct live quote fetch (exact symbol only) ──
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

    // ── Layer 5: Static universe fallback (always available) ──
    // When nothing else is populated, match against the signal
    // engine's configured universe + known indices. No live prices;
    // the UI fetches LTP separately via /api/market?action=ltp.
    const staticHits = searchStaticUniverse(q, limit);
    if (staticHits.length > 0) {
      return NextResponse.json({ results: staticHits, count: staticHits.length, source: 'universe' });
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
