/**
 * Data Sync Service — Quantorus365
 *
 * 1. syncRankingsFromNse    — live movers feed → rankings table
 *                             Falls back to NIFTY 50 + Yahoo Finance when the live feed is blocked
 * 2. syncInstrumentsFromCdn — public CDN instrument master (no auth)
 *
 * No broker OAuth. All sources are public or internal DB.
 */
import { db } from '@/lib/db';
import { fetchGainersLosers, fetchInstrumentsJson } from '@/services/marketQuote';
import { getMarketSnapshot } from './marketDataService';

// ── NIFTY 50 fallback universe ────────────────────────────────────
const NIFTY50 = [
  'RELIANCE','TCS','HDFCBANK','INFY','ICICIBANK','HINDUNILVR','ITC','SBIN',
  'BHARTIARTL','KOTAKBANK','BAJFINANCE','LT','AXISBANK','ASIANPAINT','MARUTI',
  'NESTLEIND','HCLTECH','WIPRO','ULTRACEMCO','POWERGRID','NTPC','ONGC',
  'SUNPHARMA','TITAN','ADANIENT','ADANIPORTS','BAJAJFINSV','BPCL','BRITANNIA',
  'CIPLA','COALINDIA','DIVISLAB','DRREDDY','EICHERMOT','GRASIM','HEROMOTOCO',
  'HINDALCO','INDUSINDBK','JSWSTEEL','LTIM','M&M','ONGC','SBILIFE',
  'SHRIRAMFIN','TATACONSUM','TATAMOTORS','TATASTEEL','TECHM','VEDL','ZOMATO',
];

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

async function seedRankingsFromYahoo(): Promise<{ inserted: number; message: string }> {
  console.log('[DataSync] live movers unavailable — seeding rankings from NIFTY 50 + Yahoo Finance');
  try { await db.query(`DELETE FROM rankings`); } catch { /* ignore */ }

  let inserted = 0;
  let pos = 0;
  const BATCH = 5;
  for (let i = 0; i < NIFTY50.length; i += BATCH) {
    const chunk = NIFTY50.slice(i, i + BATCH);
    await Promise.all(chunk.map(async sym => {
      const key  = `NSE_EQ|${sym}`;
      const snap = await getMarketSnapshot(sym, key);
      const ltp  = snap?.ltp ?? 0;
      const pct  = snap?.change_percent ?? 0;
      const vol  = snap?.volume ?? 0;
      const score = Math.min(100, Math.max(0, 50 + pct * 2));
      pos++;
      try {
        await db.query(
          `INSERT INTO rankings (instrument_key,tradingsymbol,name,exchange,score,rank_position,pct_change,ltp,volume)
           VALUES (?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE score=VALUES(score),ltp=VALUES(ltp),pct_change=VALUES(pct_change),volume=VALUES(volume)`,
          [key, sym, sym, 'NSE', score, pos, pct, ltp, vol]
        );
        inserted++;
      } catch { /* skip */ }
    }));
  }
  return { inserted, message: `Rankings seeded from Yahoo Finance: ${inserted} NIFTY 50 symbols.` };
}

export async function syncRankingsFromNse(): Promise<{ inserted: number; message: string }> {
  const gainers = await fetchGainersLosers('gainers');
  if (!gainers.length) return seedRankingsFromYahoo();

  const slice = gainers.slice(0, 60).map(g => g as Record<string, unknown>);
  const keyMap = new Map<string, string>();
  try {
    const syms = Array.from(new Set(slice.map(g => pickSymbol(g)).filter(Boolean)));
    if (syms.length) {
      const ph = syms.map(() => '?').join(',');
      const { rows } = await db.query(
        `SELECT instrument_key, tradingsymbol FROM instruments WHERE exchange='NSE' AND tradingsymbol IN (${ph})`, syms
      );
      for (const r of rows as any[]) if (r.tradingsymbol && r.instrument_key) keyMap.set(r.tradingsymbol.toUpperCase(), r.instrument_key);
    }
  } catch {}

  const prepared: any[] = [];
  let pos = 0;
  for (const g of slice) {
    const sym = pickSymbol(g);
    if (!sym || sym.length > 40) continue;
    pos++;
    const pct = pickPct(g);
    const vol = parseInt(String((g as any).trade_quantity ?? (g as any).totalTradedVolume ?? 0), 10);
    prepared.push({
      instrument_key: keyMap.get(sym) || `NSE_EQ|${sym}`,
      tradingsymbol: sym, name: pickName(g, sym), exchange: 'NSE',
      score: Math.min(100, Math.max(0, 50 + pct * 2)),
      pct_change: pct, ltp: pickLtp(g), rank_position: pos,
      volume: Number.isFinite(vol) ? vol : null,
    });
  }

  if (!prepared.length) return { inserted: 0, message: 'No valid symbols from live movers feed.' };
  try { await db.query(`DELETE FROM rankings`); } catch (e: any) {
    if (e?.code === 'ER_NO_SUCH_TABLE') return { inserted: 0, message: 'rankings table missing — run migrations.' };
    throw e;
  }
  for (const r of prepared) {
    await db.query(
      `INSERT INTO rankings (instrument_key,tradingsymbol,name,exchange,score,rank_position,pct_change,ltp,volume) VALUES (?,?,?,?,?,?,?,?,?)`,
      [r.instrument_key,r.tradingsymbol,r.name,r.exchange,r.score,r.rank_position,r.pct_change,r.ltp,r.volume]
    );
  }
  return { inserted: prepared.length, message: `Rankings updated: ${prepared.length} symbols from live movers feed.` };
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
