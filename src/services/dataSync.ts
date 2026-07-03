/**
 * Data Sync Service — Quantorus365
 *
 * 1. syncRankingsFromNse    — q365_universe batch quotes → rankings table
 *                             (IndianAPI via resolveBatch). Intraday movers
 *                             from IndianAPI /trending overlay % when available.
 * 2. syncInstrumentsFromCdn — public CDN instrument master (no auth)
 *
 * No broker OAuth. All sources are public or internal DB.
 */
import { db } from '@/lib/db';
import { fetchGainersLosers, fetchInstrumentsJson } from '@/services/marketQuote';
import { initOnce } from '@/lib/marketData/nifty500Universe';
import { fetchYahooQuotesBatch } from '@/lib/marketData/yahooBatch';
import { getMovers } from '@/providers/MarketDataProvider';
import { StaleDataError } from '@/types/market';
import type { MoversBucket } from '@/types/market';

/** Max symbols written per sync — defaults to full NIFTY500 universe. */
function rankingsSyncMaxSymbols(): number {
  const raw = Number(process.env.RANKINGS_SYNC_MAX_SYMBOLS ?? 500);
  if (!Number.isFinite(raw) || raw <= 0) return 500;
  return Math.min(1000, Math.max(50, Math.floor(raw)));
}

function pickSymbol(g: Record<string, unknown>): string {
  const raw = g.symbol ?? g.sym ?? g.tradingSymbol ??
    (g.meta as any)?.symbol ?? (g.meta as any)?.tradingsymbol;
  return String(raw ?? '').toUpperCase().trim();
}
function pickPct(g: Record<string, unknown>): number {
  const v = g.pChange ?? g.perChange ?? g.percent_change ??
    g.net_change ?? (g as any).netChange ?? (g as any).change;
  const n = parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}
function pickLtp(g: Record<string, unknown>): number {
  const v = g.ltp ?? g.lastPrice ?? g.last_price ?? g.close ?? (g as any).ltP;
  const n = parseFloat(String(v ?? 0));
  return Number.isFinite(n) ? n : 0;
}
function pickName(g: Record<string, unknown>, sym: string): string {
  return String(g.symbolName ?? g.companyName ?? g.name ?? g.symbol ?? sym);
}

/** IndianAPI /trending movers — used to overlay fresher intraday % on universe rows. */
async function loadMoversOverlay(): Promise<Map<string, { pct: number; ltp: number }>> {
  const map = new Map<string, { pct: number; ltp: number }>();
  try {
    let data;
    try {
      data = (await getMovers()).data;
    } catch (err) {
      if (err instanceof StaleDataError) {
        data = (err.response.data as { gainers?: MoversBucket[]; losers?: MoversBucket[]; mostActive?: MoversBucket[] });
      } else {
        throw err;
      }
    }
    const add = (b: MoversBucket) => {
      const sym = String(b.symbol ?? '').toUpperCase().trim();
      if (!sym) return;
      const ltp = Number(b.price);
      const pct = Number(b.changePercent);
      if (!Number.isFinite(ltp) || ltp <= 0) return;
      map.set(sym, { ltp, pct: Number.isFinite(pct) ? pct : 0 });
    };
    for (const b of data?.gainers ?? []) add(b);
    for (const b of data?.losers ?? []) add(b);
    for (const b of data?.mostActive ?? []) add(b);
  } catch (err: unknown) {
    console.warn('[DataSync] movers overlay unavailable:', (err as Error)?.message);
  }
  return map;
}

/** Last two EOD closes per symbol from market_data_daily. */
async function batchLookupDailyPct(
  symbols: string[],
): Promise<Map<string, { pct: number; ltp: number }>> {
  const out = new Map<string, { pct: number; ltp: number }>();
  if (!symbols.length) return out;
  const BATCH = 200;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const chunk = symbols.slice(i, i + BATCH);
    const ph = chunk.map(() => '?').join(',');
    try {
      const { rows } = await db.query<{ symbol: string; close: string | number }>(
        `SELECT symbol, close FROM market_data_daily
          WHERE symbol IN (${ph})
          ORDER BY symbol ASC, ts DESC`,
        chunk,
      );
      const bySym = new Map<string, number[]>();
      for (const r of rows) {
        const sym = String(r.symbol).toUpperCase();
        const arr = bySym.get(sym) ?? [];
        if (arr.length < 2) arr.push(Number(r.close));
        bySym.set(sym, arr);
      }
      for (const [sym, closes] of bySym) {
        if (closes.length < 2 || !closes[1]) continue;
        const latest = closes[0];
        const prev   = closes[1];
        if (!Number.isFinite(latest) || !Number.isFinite(prev) || prev === 0) continue;
        out.set(sym, { pct: ((latest - prev) / prev) * 100, ltp: latest });
      }
    } catch { /* non-fatal */ }
  }
  return out;
}

async function loadInstrumentKeyMap(syms: string[]): Promise<Map<string, string>> {
  const keyMap = new Map<string, string>();
  if (!syms.length) return keyMap;
  const BATCH = 100;
  for (let i = 0; i < syms.length; i += BATCH) {
    const chunk = syms.slice(i, i + BATCH);
    const ph = chunk.map(() => '?').join(',');
    try {
      const { rows } = await db.query(
        `SELECT instrument_key, tradingsymbol FROM instruments
          WHERE exchange='NSE' AND tradingsymbol IN (${ph})`,
        chunk,
      );
      for (const r of rows as Array<{ tradingsymbol?: string; instrument_key?: string }>) {
        if (r.tradingsymbol && r.instrument_key) {
          keyMap.set(String(r.tradingsymbol).toUpperCase(), r.instrument_key);
        }
      }
    } catch { /* non-fatal */ }
  }
  return keyMap;
}

interface PreparedRanking {
  instrument_key: string;
  tradingsymbol:  string;
  name:           string;
  exchange:       string;
  score:          number;
  pct_change:     number;
  ltp:            number;
  volume:         number | null;
}

/** Batch-quote the tradeable universe and populate rankings. */
async function seedRankingsFromUniverse(
  moversOverlay: Map<string, { pct: number; ltp: number }>,
): Promise<{ inserted: number; message: string }> {
  const maxSymbols = rankingsSyncMaxSymbols();
  const { symbols } = await initOnce();
  const universe = symbols.slice(0, maxSymbols);
  console.log(
    `[DataSync] seeding rankings from q365_universe (${universe.length} symbols, max=${maxSymbols})`,
  );

  const prepared: PreparedRanking[] = [];
  const QUOTE_CHUNK = 50;
  const needsDaily: string[] = [];

  for (let i = 0; i < universe.length; i += QUOTE_CHUNK) {
    const chunk = universe.slice(i, i + QUOTE_CHUNK);
    const quoteMap = await fetchYahooQuotesBatch(chunk);
    for (const sym of chunk) {
      const mover = moversOverlay.get(sym);
      const q     = quoteMap.get(sym);
      let ltp = mover?.ltp ?? q?.price ?? 0;
      let pct = mover?.pct ?? q?.pChange ?? 0;
      if (!ltp || ltp <= 0) {
        needsDaily.push(sym);
        continue;
      }
      if (!pct || pct === 0) needsDaily.push(sym);
      prepared.push({
        instrument_key: `NSE_EQ|${sym}`,
        tradingsymbol:  sym,
        name:           sym,
        exchange:       'NSE',
        score:          Math.min(100, Math.max(0, 50 + pct * 2)),
        pct_change:     pct,
        ltp,
        volume:         null,
      });
    }
  }

  if (needsDaily.length) {
    const dailyMap = await batchLookupDailyPct([...new Set(needsDaily)]);
    for (const row of prepared) {
      if (row.pct_change && row.pct_change !== 0) continue;
      const daily = dailyMap.get(row.tradingsymbol);
      if (!daily) continue;
      row.pct_change = daily.pct;
      if (!row.ltp || row.ltp === 0) row.ltp = daily.ltp;
      row.score = Math.min(100, Math.max(0, 50 + row.pct_change * 2));
    }
    // Symbols that had no batch quote at all — insert from daily candles only.
    const preparedSyms = new Set(prepared.map(r => r.tradingsymbol));
    for (const sym of needsDaily) {
      if (preparedSyms.has(sym)) continue;
      const daily = dailyMap.get(sym);
      if (!daily) continue;
      prepared.push({
        instrument_key: `NSE_EQ|${sym}`,
        tradingsymbol:  sym,
        name:           sym,
        exchange:       'NSE',
        score:          Math.min(100, Math.max(0, 50 + daily.pct * 2)),
        pct_change:     daily.pct,
        ltp:            daily.ltp,
        volume:         null,
      });
    }
  }

  prepared.sort((a, b) => b.score - a.score || Math.abs(b.pct_change) - Math.abs(a.pct_change));

  const keyMap = await loadInstrumentKeyMap(prepared.map(r => r.tradingsymbol));
  for (const row of prepared) {
    row.instrument_key = keyMap.get(row.tradingsymbol) || row.instrument_key;
  }

  try { await db.query(`DELETE FROM rankings`); } catch (e: unknown) {
    const err = e as { code?: string };
    if (err?.code === 'ER_NO_SUCH_TABLE') {
      return { inserted: 0, message: 'rankings table missing — run migrations.' };
    }
  }

  let inserted = 0;
  let pos = 0;
  for (const r of prepared) {
    pos++;
    try {
      await db.query(
        `INSERT INTO rankings (instrument_key,tradingsymbol,name,exchange,score,rank_position,pct_change,ltp,volume)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [r.instrument_key, r.tradingsymbol, r.name, r.exchange, r.score, pos, r.pct_change, r.ltp, r.volume],
      );
      inserted++;
    } catch { /* skip */ }
  }

  return {
    inserted,
    message: `Rankings updated: ${inserted} symbols from q365_universe (IndianAPI batch, max ${maxSymbols}).`,
  };
}

/** Build rankings rows directly from IndianAPI movers when the list is large enough. */
async function seedRankingsFromMovers(
  movers: Record<string, unknown>[],
): Promise<{ inserted: number; message: string } | null> {
  const maxSymbols = rankingsSyncMaxSymbols();
  const slice = movers
    .slice(0, maxSymbols)
    .map(g => g as Record<string, unknown>);
  if (slice.length < 80) return null;

  const syms = Array.from(new Set(slice.map(g => pickSymbol(g)).filter(Boolean)));
  const keyMap = await loadInstrumentKeyMap(syms);

  const prepared: PreparedRanking[] = [];
  let pos = 0;
  for (const g of slice) {
    const sym = pickSymbol(g);
    if (!sym || sym.length > 40) continue;
    pos++;
    const pct = pickPct(g);
    const ltp = pickLtp(g);
    if (!ltp || ltp <= 0) continue;
    prepared.push({
      instrument_key: keyMap.get(sym) || `NSE_EQ|${sym}`,
      tradingsymbol:  sym,
      name:           pickName(g, sym),
      exchange:       'NSE',
      score:          Math.min(100, Math.max(0, 50 + pct * 2)),
      pct_change:     pct,
      ltp,
      volume:         (() => {
        const vol = parseInt(String((g as any).trade_quantity ?? (g as any).totalTradedVolume ?? 0), 10);
        return Number.isFinite(vol) ? vol : null;
      })(),
    });
  }

  if (prepared.length < 80) return null;

  try { await db.query(`DELETE FROM rankings`); } catch (e: unknown) {
    const err = e as { code?: string };
    if (err?.code === 'ER_NO_SUCH_TABLE') {
      return { inserted: 0, message: 'rankings table missing — run migrations.' };
    }
  }

  let inserted = 0;
  let rank = 0;
  for (const r of prepared) {
    rank++;
    try {
      await db.query(
        `INSERT INTO rankings (instrument_key,tradingsymbol,name,exchange,score,rank_position,pct_change,ltp,volume)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [r.instrument_key, r.tradingsymbol, r.name, r.exchange, r.score, rank, r.pct_change, r.ltp, r.volume],
      );
      inserted++;
    } catch { /* skip */ }
  }

  return {
    inserted,
    message: `Rankings updated: ${inserted} symbols from IndianAPI movers.`,
  };
}

export async function syncRankingsFromNse(): Promise<{ inserted: number; message: string }> {
  const moversOverlay = await loadMoversOverlay();

  // Combine gainers + losers for the legacy movers-only fast path.
  const [gainers, losers] = await Promise.all([
    fetchGainersLosers('gainers'),
    fetchGainersLosers('losers'),
  ]);
  const seen = new Set<string>();
  const combined: Record<string, unknown>[] = [];
  for (const g of [...gainers, ...losers]) {
    const sym = pickSymbol(g as Record<string, unknown>);
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    combined.push(g as Record<string, unknown>);
  }
  combined.sort((a, b) => Math.abs(pickPct(b)) - Math.abs(pickPct(a)));

  const moversResult = await seedRankingsFromMovers(combined);
  const result = moversResult ?? await seedRankingsFromUniverse(moversOverlay);

  if (result.inserted > 0) {
    const { bustRankingsCache } = await import('@/services/rankingsService');
    await bustRankingsCache().catch(() => {});
  }
  return result;
}

type ExchangeKey = 'NSE' | 'BSE' | 'NSE_FO';

function segmentFilter(ex: ExchangeKey) {
  if (ex === 'NSE') return (r: any) => String(r.segment||'').toUpperCase()==='NSE_EQ' && String(r.instrument_type||'').toUpperCase()==='EQ';
  if (ex === 'BSE') return (r: any) => String(r.segment||'').toUpperCase()==='BSE_EQ' && String(r.instrument_type||'').toUpperCase()==='EQ';
  return (r: any) => String(r.segment||'').toUpperCase().includes('NSE_FO');
}

export async function syncInstrumentsFromCdn(ex: ExchangeKey): Promise<{ inserted: number; message: string }> {
  const all = await fetchInstrumentsJson(ex);
  if (!all.length) return { inserted: 0, message: `Could not download instruments for ${ex}.` };

  const filter = segmentFilter(ex);
  let rows = all.filter(r => filter(r)) as any[];
  if (rows.length < 100 && ex === 'NSE') rows = all.filter(r => String(r.exchange||'').toUpperCase()==='NSE' && String(r.instrument_type||'').toUpperCase()==='EQ');
  if (rows.length < 100 && ex === 'BSE') rows = all.filter(r => String(r.exchange||'').toUpperCase()==='BSE' && String(r.instrument_type||'').toUpperCase()==='EQ');
  if (ex === 'NSE_FO') rows = rows.slice(0, 25_000);

  let inserted = 0;
  const BATCH = 40;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vals: string[] = []; const params: unknown[] = [];
    for (const row of chunk) {
      const key = String(row.instrument_key||'').trim();
      const sym = String(row.tradingsymbol||row.trading_symbol||'').trim();
      if (!key || !sym) continue;
      vals.push('(?,?,?,?,?,1)');
      params.push(key, String(row.exchange||ex).toUpperCase(), sym, String(row.name||sym).slice(0,255), String(row.instrument_type||'EQ').slice(0,30));
    }
    if (!vals.length) continue;
    try {
      await db.query(`INSERT INTO instruments (instrument_key,exchange,tradingsymbol,name,instrument_type,is_active) VALUES ${vals.join(',')} ON DUPLICATE KEY UPDATE tradingsymbol=VALUES(tradingsymbol),name=VALUES(name),instrument_type=VALUES(instrument_type),is_active=VALUES(is_active)`, params);
      inserted += vals.length;
    } catch (e: any) {
      if (e?.code === 'ER_NO_SUCH_TABLE') return { inserted: 0, message: 'instruments table missing — run migrations.' };
      throw e;
    }
  }
  return { inserted, message: `Synced ${inserted} ${ex} instruments.` };
}


export async function syncSignalsPlaceholder(): Promise<{ message: string }> {
  return { message: 'Signals use live quote data. Sync rankings first, then signals are computed on demand.' };
}
