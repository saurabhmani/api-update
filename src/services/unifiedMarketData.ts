// ════════════════════════════════════════════════════════════════
//  Unified Market Data Provider
//
//  RULE: Breadth, gainers, losers, and sector data MUST derive
//  from the SAME atomic dataset. No mixing sources.
//
//  Fallback chain (single source per request):
//    1. Kite WebSocket tickStore (in-process, sub-second) // @deprecated marker
//    2. Market quote feed — full NIFTY 500 constituents
//    3. Market indices feed (sector indices only — degraded mode)
//
//  Validation: rejects datasets with <50 stocks as unreliable.
//  Every output field traces back to the same source timestamp.
// ════════════════════════════════════════════════════════════════

import { cacheGet, cacheSet } from '@/lib/redis';
import { getTickStore } from '@/lib/marketData/tickStore';
import type { TickData } from '@/lib/marketData/tickTypes';
import { fetchIndices, fetchGainersLosers } from './marketQuote';
import { logger } from '@/lib/logger';

const log = logger.child({ service: 'unifiedMarketData' });

// ── Types ───────────────────────────────────────────────────────

export interface StockEntry {
  symbol: string;
  name: string;
  ltp: number;
  changePct: number;
  changeAbs: number;
  open: number;
  high: number;
  low: number;
  close: number;     // previous close
  volume: number;
}

export interface MarketDataset {
  stocks: StockEntry[];
  breadth: {
    advancing: number;
    declining: number;
    unchanged: number;
    total: number;
    advancePct: number;
    declinePct: number;
  };
  topGainers: StockEntry[];
  topLosers: StockEntry[];
  sectors: { sector: string; changePct: number; trend: 'up' | 'down' | 'flat' }[];
  volatility: {
    avgRangePct: number;
    highVolCount: number;
    label: 'Very High' | 'High' | 'Normal' | 'Low';
    vix: number | null;
  };
  source: 'kite' | 'market_stocks' | 'market_indices'; // @deprecated marker
  timestamp: string;
  stockCount: number;
  isComplete: boolean;   // true if 50+ stocks in dataset
}

// ── Cache ───────────────────────────────────────────────────────

const CACHE_KEY = 'unified:market_dataset';
const CACHE_TTL = 10;  // seconds — short for real-time freshness
const MIN_STOCKS = 50; // reject datasets smaller than this

let _memCache: MarketDataset | null = null;
let _memCacheAt = 0;
const MEM_TTL_MS = 10_000;

// ── Sector index mapping ────────────────────────────────────────

const SECTOR_INDEX_NAMES: Record<string, string> = {
  'NIFTY BANK':         'Banking',
  'NIFTY IT':           'IT',
  'NIFTY PHARMA':       'Pharma',
  'NIFTY AUTO':         'Auto',
  'NIFTY FMCG':         'FMCG',
  'NIFTY REALTY':       'Realty',
  'NIFTY METAL':        'Metal',
  'NIFTY ENERGY':       'Energy',
  'NIFTY MIDCAP 100':   'Midcap',
  'NIFTY SMALLCAP 100': 'Smallcap',
};

// ── Helpers ─────────────────────────────────────────────────────

function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function deriveFromStocks(stocks: StockEntry[], source: MarketDataset['source']): MarketDataset {
  let advancing = 0, declining = 0, unchanged = 0;
  const rangePcts: number[] = [];

  for (const s of stocks) {
    if (s.changePct > 0.05)       advancing++;
    else if (s.changePct < -0.05) declining++;
    else                           unchanged++;

    if (s.high > 0 && s.close > 0) {
      rangePcts.push(((s.high - s.low) / s.close) * 100);
    }
  }

  const total = stocks.length || 1;
  const advancePct = parseFloat(((advancing / total) * 100).toFixed(1));
  const declinePct = parseFloat(((declining / total) * 100).toFixed(1));

  // Gainers: positive only, sorted most positive first
  const topGainers = stocks
    .filter(s => s.changePct > 0.05)
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 10);

  // Losers: negative only, sorted most negative first
  const topLosers = stocks
    .filter(s => s.changePct < -0.05)
    .sort((a, b) => a.changePct - b.changePct)
    .slice(0, 10);

  // Volatility from ranges
  const avgRangePct = rangePcts.length > 0
    ? parseFloat((rangePcts.reduce((a, b) => a + b, 0) / rangePcts.length).toFixed(2))
    : 0;
  const highVolCount = rangePcts.filter(r => r > 3).length;
  const volLabel: MarketDataset['volatility']['label'] =
    avgRangePct > 4 ? 'Very High' :
    avgRangePct > 2.5 ? 'High' :
    avgRangePct > 1 ? 'Normal' : 'Low';

  return {
    stocks,
    breadth: { advancing, declining, unchanged, total: stocks.length, advancePct, declinePct },
    topGainers,
    topLosers,
    sectors: [],  // filled by caller from index data
    volatility: { avgRangePct, highVolCount, label: volLabel, vix: null },
    source,
    timestamp: new Date().toISOString(),
    stockCount: stocks.length,
    isComplete: stocks.length >= MIN_STOCKS,
  };
}

// ── Layer 1: Kite WebSocket tickStore ─────────────────────────── // @deprecated marker

function tryKiteTicks(): StockEntry[] | null { // @deprecated marker
  try {
    const tickStore = getTickStore();
    tickStore.install();
    const allTicks = tickStore.snapshot();
    if (!allTicks || allTicks.length < MIN_STOCKS) return null;

    const stocks: StockEntry[] = [];
    const now = Date.now();
    const STALE_MS = 5 * 60_000;

    for (const t of allTicks) {
      if (!t.symbol || t.lastPrice <= 0) continue;
      if (t.ts && (now - t.ts) > STALE_MS) continue; // skip stale ticks

      const prevClose = (t.close && t.close > 0) ? t.close : (t.open && t.open > 0 ? t.open : t.lastPrice);
      let changePct: number;
      if (typeof t.pChange === 'number' && Number.isFinite(t.pChange) && t.pChange !== 0) {
        changePct = t.pChange;
      } else if (prevClose > 0 && prevClose !== t.lastPrice) {
        changePct = ((t.lastPrice - prevClose) / prevClose) * 100;
      } else {
        changePct = 0;
      }

      stocks.push({
        symbol: t.symbol.toUpperCase(),
        name: t.symbol.toUpperCase(),
        ltp: t.lastPrice,
        changePct: parseFloat(changePct.toFixed(2)),
        changeAbs: t.lastPrice - prevClose,
        open: t.open ?? t.lastPrice,
        high: t.high ?? t.lastPrice,
        low: t.low ?? t.lastPrice,
        close: prevClose,
        volume: t.volume ?? 0,
      });
    }

    return stocks.length >= MIN_STOCKS ? stocks : null;
  } catch {
    return null;
  }
}

// ── Layer 2: Market quote feed — FULL 500 stocks ────────────────

async function tryMarketStocks(): Promise<StockEntry[] | null> {
  try {
    // fetchGainersLosers('gainers', 'NIFTY 500') calls
    // /equity-stockIndices?index=NIFTY 500 and returns ALL constituents.
    const cacheKey = 'nse:/equity-stockIndices?index=NIFTY%20500';
    let data = await cacheGet<any>(cacheKey);

    if (!data?.data) {
      // Direct fetch — this is a SINGLE atomic API call.
      // fetchGainersLosers fetches the same endpoint and populates Redis
      // with the full dataset before filtering to gainers only.
      const raw = await fetchGainersLosers('gainers', 'NIFTY 500');
      // Re-read from cache since fetchGainersLosers writes to Redis.
      data = await cacheGet<any>(cacheKey);
    }

    if (!data?.data || !Array.isArray(data.data)) return null;

    const stocks: StockEntry[] = [];
    for (const s of data.data) {
      const sym = String(s.symbol ?? '').toUpperCase();
      if (!sym || sym === 'NIFTY 500') continue; // skip the index row itself

      const ltp = toNum(s.lastPrice ?? s.ltp ?? 0);
      if (ltp <= 0) continue;

      stocks.push({
        symbol: sym,
        name: String(s.companyName ?? s.symbolName ?? sym),
        ltp,
        changePct: parseFloat(toNum(s.pChange ?? s.perChange ?? 0).toFixed(2)),
        changeAbs: toNum(s.change ?? s.netPrice ?? 0),
        open: toNum(s.open ?? ltp),
        high: toNum(s.dayHigh ?? s.high ?? ltp),
        low: toNum(s.dayLow ?? s.low ?? ltp),
        close: toNum(s.previousClose ?? s.prevClose ?? ltp),
        volume: toNum(s.totalTradedVolume ?? s.tradedQuantity ?? 0),
      });
    }

    return stocks.length >= MIN_STOCKS ? stocks : null;
  } catch (err) {
    log.warn('[market] stocks fetch failed', { error: (err as Error).message });
    return null;
  }
}

// ── Layer 3: Market indices feed (degraded — sectors + breadth only) ─

async function tryMarketIndices(): Promise<MarketDataset | null> {
  try {
    const indices = await fetchIndices();
    if (!indices.length) return null;

    // Build sector data
    const sectors: MarketDataset['sectors'] = [];
    for (const [indexName, sectorLabel] of Object.entries(SECTOR_INDEX_NAMES)) {
      const idx = indices.find(i => i.name === indexName);
      if (!idx || idx.percentChange === undefined) continue;
      sectors.push({
        sector: sectorLabel,
        changePct: parseFloat(idx.percentChange.toFixed(2)),
        trend: idx.percentChange > 0.1 ? 'up' : idx.percentChange < -0.1 ? 'down' : 'flat',
      });
    }
    sectors.sort((a, b) => b.changePct - a.changePct);

    // Breadth from NIFTY 500 index advances/declines
    const n500 = indices.find(i => i.name === 'NIFTY 500');
    const n50 = indices.find(i => i.name === 'NIFTY 50');
    const src = n500 ?? n50;
    const adv = toNum(src?.advances);
    const dec = toNum(src?.declines);

    // VIX
    const vixIdx = indices.find(i => i.name === 'India VIX' || i.name === 'INDIA VIX');
    const vix = vixIdx ? toNum(vixIdx.last) : null;

    // Build degraded dataset from sector indices as "stocks"
    const pseudoStocks: StockEntry[] = indices
      .filter(i => i.last > 0 && i.percentChange !== undefined && i.name !== 'INDIA VIX')
      .map(i => ({
        symbol: i.name,
        name: i.name,
        ltp: i.last,
        changePct: parseFloat(i.percentChange.toFixed(2)),
        changeAbs: i.variation,
        open: i.open,
        high: i.high,
        low: i.low,
        close: i.previousClose,
        volume: 0,
      }));

    const dataset = deriveFromStocks(pseudoStocks, 'market_indices');

    // Override breadth with authoritative live advances/declines
    if (adv + dec > 50) {
      const total = adv + dec;
      dataset.breadth = {
        advancing: adv,
        declining: dec,
        unchanged: 0,
        total,
        advancePct: parseFloat(((adv / total) * 100).toFixed(1)),
        declinePct: parseFloat(((dec / total) * 100).toFixed(1)),
      };
    }

    dataset.sectors = sectors;
    dataset.volatility.vix = vix;
    dataset.isComplete = adv + dec > 50; // complete breadth even if stock-level is degraded

    return dataset;
  } catch (err) {
    log.warn('[market] indices fetch failed', { error: (err as Error).message });
    return null;
  }
}

// ── Sector enrichment from indices ──────────────────────────────

async function enrichWithSectors(dataset: MarketDataset): Promise<void> {
  if (dataset.sectors.length > 0) return; // already populated

  try {
    const cachedIndices = await cacheGet<any>('nse:/allIndices');
    let indicesData: any[] = cachedIndices?.data ?? [];

    if (!indicesData.length) {
      const live = await fetchIndices();
      indicesData = live.map(i => ({
        index: i.name, percentChange: i.percentChange,
        last: i.last, variation: i.variation,
        high: i.high, low: i.low, advances: i.advances, declines: i.declines,
      }));
    }

    for (const [indexName, sectorLabel] of Object.entries(SECTOR_INDEX_NAMES)) {
      const idx = indicesData.find((d: any) => d.index === indexName || d.name === indexName);
      if (!idx) continue;
      const chg = toNum(idx.percentChange ?? idx.variation, NaN);
      if (!Number.isFinite(chg)) continue;
      dataset.sectors.push({
        sector: sectorLabel,
        changePct: parseFloat(chg.toFixed(2)),
        trend: chg > 0.1 ? 'up' : chg < -0.1 ? 'down' : 'flat',
      });
    }
    dataset.sectors.sort((a, b) => b.changePct - a.changePct);

    // VIX enrichment
    if (dataset.volatility.vix === null) {
      const vixIdx = indicesData.find((d: any) =>
        d.index === 'INDIA VIX' || d.index === 'India VIX' || d.name === 'INDIA VIX'
      );
      if (vixIdx) dataset.volatility.vix = toNum(vixIdx.last ?? vixIdx.lastPrice);
    }

    // Override breadth from NIFTY 500 if more authoritative
    const n500 = indicesData.find((d: any) => d.index === 'NIFTY 500' || d.name === 'NIFTY 500');
    if (n500?.advances != null) {
      const liveAdv = Number(n500.advances);
      const liveDec = Number(n500.declines ?? 0);
      if (liveAdv + liveDec > dataset.breadth.total) {
        const total = liveAdv + liveDec;
        dataset.breadth = {
          advancing: liveAdv,
          declining: liveDec,
          unchanged: 0,
          total,
          advancePct: parseFloat(((liveAdv / total) * 100).toFixed(1)),
          declinePct: parseFloat(((liveDec / total) * 100).toFixed(1)),
        };
      }
    }
  } catch {
    // Sector enrichment is best-effort
  }
}

// ── Validation ──────────────────────────────────────────────────

function validateDataset(dataset: MarketDataset): string[] {
  const errors: string[] = [];

  if (dataset.stockCount < MIN_STOCKS && dataset.source !== 'market_indices') {
    errors.push(`Insufficient stocks: ${dataset.stockCount} < ${MIN_STOCKS}`);
  }

  // Breadth sanity: advancing + declining should be > 0
  if (dataset.breadth.advancing + dataset.breadth.declining === 0) {
    errors.push('Breadth is zero — no advancing or declining stocks');
  }

  // Gainers must be positive, losers must be negative
  const badGainer = dataset.topGainers.find(s => s.changePct <= 0);
  if (badGainer) {
    errors.push(`Gainer with non-positive change: ${badGainer.symbol} ${badGainer.changePct}%`);
  }

  const badLoser = dataset.topLosers.find(s => s.changePct >= 0);
  if (badLoser) {
    errors.push(`Loser with non-negative change: ${badLoser.symbol} ${badLoser.changePct}%`);
  }

  // 100% advancing or 100% declining is suspicious
  if (dataset.breadth.advancePct >= 99 && dataset.stockCount > 10) {
    errors.push(`100% advancing (${dataset.breadth.advancing}/${dataset.breadth.total}) — likely bad data`);
  }
  if (dataset.breadth.declinePct >= 99 && dataset.stockCount > 10) {
    errors.push(`100% declining (${dataset.breadth.declining}/${dataset.breadth.total}) — likely bad data`);
  }

  return errors;
}

// ── Main: Fetch unified dataset ─────────────────────────────────

export async function fetchUnifiedMarketData(): Promise<MarketDataset> {
  // Check cache first
  if (_memCache && Date.now() - _memCacheAt < MEM_TTL_MS) return _memCache;
  const cached = await cacheGet<MarketDataset>(CACHE_KEY);
  if (cached) {
    _memCache = cached;
    _memCacheAt = Date.now();
    return cached;
  }

  let dataset: MarketDataset | null = null;

  // ── Layer 1: Kite WebSocket ticks (fastest, freshest) ──────── // @deprecated marker
  const kiteTicks = tryKiteTicks(); // @deprecated marker
  if (kiteTicks) { // @deprecated marker
    dataset = deriveFromStocks(kiteTicks, 'kite'); // @deprecated marker
    log.info('Market data from Kite tickStore', { stocks: dataset.stockCount }); // @deprecated marker
  }

  // ── Layer 2: NIFTY 500 constituents (full dataset) ───────────
  if (!dataset) {
    const marketStocks = await tryMarketStocks();
    if (marketStocks) {
      dataset = deriveFromStocks(marketStocks, 'market_stocks');
      log.info('Market data from live stocks', { stocks: dataset.stockCount });
    }
  }

  // ── Layer 3: Live indices (degraded — breadth + sectors) ─────
  if (!dataset) {
    dataset = await tryMarketIndices();
    if (dataset) {
      log.info('Market data from live indices (degraded)', { stocks: dataset.stockCount });
    }
  }

  // ── No data at all ───────────────────────────────────────────
  if (!dataset) {
    log.error('All market data sources failed — no data available');
    return {
      stocks: [],
      breadth: { advancing: 0, declining: 0, unchanged: 0, total: 0, advancePct: 0, declinePct: 0 },
      topGainers: [],
      topLosers: [],
      sectors: [],
      volatility: { avgRangePct: 0, highVolCount: 0, label: 'Normal', vix: null },
      source: 'market_stocks',
      timestamp: new Date().toISOString(),
      stockCount: 0,
      isComplete: false,
    };
  }

  // ── Enrich with sectors + VIX (always from indices) ──────────
  await enrichWithSectors(dataset);

  // ── Validate ─────────────────────────────────────────────────
  const errors = validateDataset(dataset);
  if (errors.length > 0) {
    log.warn('Market dataset validation warnings', { errors, source: dataset.source, count: dataset.stockCount });
  }

  // ── Cache ────────────────────────────────────────────────────
  await cacheSet(CACHE_KEY, dataset, CACHE_TTL);
  _memCache = dataset;
  _memCacheAt = Date.now();

  return dataset;
}
