// ════════════════════════════════════════════════════════════════
//  KiteAdapter — Zerodha Kite Connect vendor adapter (Phase 3)
//
//  Conforms to the same data contract as IndianAPIAdapter so it can
//  later replace IndianAPI inside MarketDataProvider without UI
//  changes. Returns canonical `@/types/market` shapes only.
//
//  NOT wired into MarketDataProvider / marketDataResolver yet.
//  Architecture freeze: MarketDataProvider must not import this module
//  until an intentional dual-run / cutover PR.
//
//  Transport lives in `src/lib/kite/*`. This file only:
//    • resolves symbols → Kite keys / tokens
//    • calls the service layer
//    • maps responses via `./kite/mappers`
//    • throws UnsupportedFeatureError for Kite-missing endpoints
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import {
  getHistoricalData,
  getLTP as kiteGetLtpMap,
  getOHLC as kiteGetOhlcMap,
  getQuote as kiteGetQuote,
  getQuotes as kiteGetQuotes,
  searchInstrument,
  type KiteHistoricalInterval,
} from '@/lib/kite';
import type {
  CorporateIntel,
  DataQuality,
  Fundamentals,
  HistoricalRange,
  HistoricalSeries,
  IndustryPeer,
  MarketSnapshot,
  MoversResult,
  ProviderResponse,
  ProviderSource,
  ProviderSourceType,
  SymbolSearchHit,
} from '@/types/market';
import type {
  GetOptions,
  IMarketDataProvider,
} from '@/providers/interfaces';
import { unsupported, UnsupportedFeatureError } from './UnsupportedFeatureError';
import {
  normalizeAppSymbol,
  resolveKiteInstrument,
  resolveKiteInstruments,
  resolveKiteKey,
  type KiteInstrumentRef,
} from './kite/instrumentLookup';
import {
  mapKiteHistoricalToSeries,
  mapKiteInstrumentToSearchHit,
  mapKiteLtpToSnapshot,
  mapKiteOhlcToSnapshot,
  mapKiteQuoteToLtp,
  mapKiteQuoteToOhlc,
  mapKiteQuoteToSnapshot,
} from './kite/mappers';

const log = logger.child({ adapter: 'Kite' });

/** Same envelope IndianAPIAdapter exposes for batched quotes. */
export interface BatchQuoteResult {
  snapshots: MarketSnapshot[];
  missing: string[];
}

export { UnsupportedFeatureError };

// Kite quote API accepts up to ~500 instruments; keep headroom.
const KITE_BATCH_CHUNK = 400;

// ── Envelope (IMarketDataProvider surface) ─────────────────────────

function wrapResponse<T>(data: T): ProviderResponse<T> {
  const fetched_at = Date.now();
  let vendor_timestamp = fetched_at;
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (typeof obj.timestamp === 'number' && obj.timestamp > 0) {
      vendor_timestamp = obj.timestamp;
    } else if (typeof obj.asOf === 'number' && obj.asOf > 0) {
      vendor_timestamp = obj.asOf;
    } else if (Array.isArray(obj.candles) && obj.candles.length > 0) {
      const last = obj.candles[obj.candles.length - 1] as { t?: number };
      if (typeof last?.t === 'number' && last.t > 0) vendor_timestamp = last.t;
    }
  }

  const source: ProviderSource = 'kite';
  const data_quality: DataQuality = 'near-live';
  const source_type: ProviderSourceType = 'primary';

  return {
    data,
    source,
    data_quality,
    fetched_at,
    trail: [],
    provider_name: 'Kite Connect',
    source_type,
    vendor_timestamp,
    freshness_ms: Math.max(0, fetched_at - vendor_timestamp),
    fallback_reason: null,
  };
}

// ── Supported: live quotes ─────────────────────────────────────────

/**
 * Full market quote for one symbol → MarketSnapshot.
 * Mirrors IndianAPIAdapter.getQuote so MarketDataProvider can swap later.
 */
export async function getQuote(
  symbol: string,
  _signal?: AbortSignal,
): Promise<MarketSnapshot> {
  const sym = normalizeAppSymbol(symbol);
  if (!sym) throw new Error('KiteAdapter.getQuote: symbol is required');

  const key = await resolveKiteKey(sym);
  log.debug('getQuote', { symbol: sym, kiteKey: key });
  const quote = await kiteGetQuote(key);
  return mapKiteQuoteToSnapshot(sym, quote);
}

/** Alias used by IMarketDataProvider naming — same as getQuote. */
export async function getLiveSnapshot(
  symbol: string,
  _opts?: GetOptions,
): Promise<MarketSnapshot> {
  return getQuote(symbol);
}

/**
 * Batch quotes via Kite's native multi-instrument quote API
 * (unlike IndianAPI's emulated /stock fan-out).
 */
export async function getBatchQuotes(
  symbols: string[],
  exchange: 'NSE' | 'BSE' = 'NSE',
  _signal?: AbortSignal,
): Promise<BatchQuoteResult> {
  if (!symbols || symbols.length === 0) return { snapshots: [], missing: [] };

  const clean = [...new Set(symbols.map(normalizeAppSymbol).filter(Boolean))];
  if (clean.length === 0) return { snapshots: [], missing: [] };

  const resolved = await resolveKiteInstruments(clean, exchange);
  const missing: string[] = [];
  const keys: string[] = [];
  const keyToSymbol = new Map<string, string>();

  for (const sym of clean) {
    const ref = resolved.get(sym);
    if (!ref) {
      missing.push(sym);
      continue;
    }
    keys.push(ref.kiteKey);
    keyToSymbol.set(ref.kiteKey, sym);
  }

  if (keys.length === 0) return { snapshots: [], missing };

  const snapshots: MarketSnapshot[] = [];

  for (let i = 0; i < keys.length; i += KITE_BATCH_CHUNK) {
    const chunk = keys.slice(i, i + KITE_BATCH_CHUNK);
    try {
      const raw = await kiteGetQuotes(chunk);
      for (const [kiteKey, quote] of Object.entries(raw)) {
        const sym = keyToSymbol.get(kiteKey.toUpperCase())
          ?? keyToSymbol.get(kiteKey)
          ?? normalizeAppSymbol(kiteKey);
        if (!quote) {
          missing.push(sym);
          continue;
        }
        const snap = mapKiteQuoteToSnapshot(sym, quote);
        if (snap.price > 0) snapshots.push(snap);
        else missing.push(sym);
      }

      // Any key we asked for but Kite omitted.
      for (const k of chunk) {
        const hit = raw[k] ?? raw[k.toUpperCase()];
        if (!hit) {
          const sym = keyToSymbol.get(k) ?? normalizeAppSymbol(k);
          if (!snapshots.some((s) => s.symbol === sym) && !missing.includes(sym)) {
            missing.push(sym);
          }
        }
      }
    } catch (err) {
      log.warn('getBatchQuotes chunk failed', {
        chunkSize: chunk.length,
        error: err instanceof Error ? err.message : String(err),
      });
      for (const k of chunk) {
        const sym = keyToSymbol.get(k) ?? normalizeAppSymbol(k);
        if (!missing.includes(sym)) missing.push(sym);
      }
    }
  }

  return { snapshots, missing: [...new Set(missing)] };
}

/** LTP map → App symbols → last price. */
export async function getLTP(
  symbols: string | string[],
  exchange: 'NSE' | 'BSE' = 'NSE',
): Promise<Record<string, number>> {
  const list = Array.isArray(symbols) ? symbols : [symbols];
  const clean = [...new Set(list.map(normalizeAppSymbol).filter(Boolean))];
  const out: Record<string, number> = {};
  if (clean.length === 0) return out;

  const resolved = await resolveKiteInstruments(clean, exchange);
  const keys: string[] = [];
  const keyToSymbol = new Map<string, string>();
  for (const sym of clean) {
    const ref = resolved.get(sym);
    if (!ref) continue;
    keys.push(ref.kiteKey);
    keyToSymbol.set(ref.kiteKey, sym);
  }
  if (keys.length === 0) return out;

  const raw = await kiteGetLtpMap(keys);
  for (const [kiteKey, row] of Object.entries(raw)) {
    const sym = keyToSymbol.get(kiteKey) ?? keyToSymbol.get(kiteKey.toUpperCase());
    if (!sym || !row) continue;
    out[sym] = mapKiteQuoteToLtp(row);
  }
  return out;
}

/** Single-symbol LTP as a MarketSnapshot (OHLC fields zeroed). */
export async function getLTPSnapshot(symbol: string): Promise<MarketSnapshot> {
  const sym = normalizeAppSymbol(symbol);
  const key = await resolveKiteKey(sym);
  const map = await kiteGetLtpMap([key]);
  const row = map[key] ?? map[Object.keys(map)[0] ?? ''];
  if (!row) throw new Error(`KiteAdapter.getLTPSnapshot: no LTP for ${sym}`);
  return mapKiteLtpToSnapshot(sym, row);
}

/** OHLC map keyed by app symbol. */
export async function getOHLC(
  symbols: string | string[],
  exchange: 'NSE' | 'BSE' = 'NSE',
): Promise<Record<string, ReturnType<typeof mapKiteQuoteToOhlc>>> {
  const list = Array.isArray(symbols) ? symbols : [symbols];
  const clean = [...new Set(list.map(normalizeAppSymbol).filter(Boolean))];
  const out: Record<string, ReturnType<typeof mapKiteQuoteToOhlc>> = {};
  if (clean.length === 0) return out;

  const resolved = await resolveKiteInstruments(clean, exchange);
  const keys: string[] = [];
  const keyToSymbol = new Map<string, string>();
  for (const sym of clean) {
    const ref = resolved.get(sym);
    if (!ref) continue;
    keys.push(ref.kiteKey);
    keyToSymbol.set(ref.kiteKey, sym);
  }
  if (keys.length === 0) return out;

  const raw = await kiteGetOhlcMap(keys);
  for (const [kiteKey, row] of Object.entries(raw)) {
    const sym = keyToSymbol.get(kiteKey) ?? keyToSymbol.get(kiteKey.toUpperCase());
    if (!sym || !row) continue;
    out[sym] = mapKiteQuoteToOhlc(row);
  }
  return out;
}

/** Single-symbol OHLC as MarketSnapshot. */
export async function getOHLCSnapshot(symbol: string): Promise<MarketSnapshot> {
  const sym = normalizeAppSymbol(symbol);
  const key = await resolveKiteKey(sym);
  const map = await kiteGetOhlcMap([key]);
  const row = map[key] ?? map[Object.keys(map)[0] ?? ''];
  if (!row) throw new Error(`KiteAdapter.getOHLCSnapshot: no OHLC for ${sym}`);
  return mapKiteOhlcToSnapshot(sym, row);
}

// ── Supported: historical ──────────────────────────────────────────

interface RangeWindow {
  interval: KiteHistoricalInterval;
  from: Date;
  to: Date;
}

function rangeToKiteWindow(range: HistoricalRange): RangeWindow {
  const to = new Date();
  const from = new Date(to.getTime());

  switch (range) {
    case '1d':
      // Intraday for the current session window (last calendar day).
      from.setDate(from.getDate() - 1);
      return { interval: '5minute', from, to };
    case '5d':
      from.setDate(from.getDate() - 7);
      return { interval: 'day', from, to };
    case '1mo':
      from.setMonth(from.getMonth() - 1);
      return { interval: 'day', from, to };
    case '3mo':
      from.setMonth(from.getMonth() - 3);
      return { interval: 'day', from, to };
    case '6mo':
      from.setMonth(from.getMonth() - 6);
      return { interval: 'day', from, to };
    case '1y':
      from.setFullYear(from.getFullYear() - 1);
      return { interval: 'day', from, to };
    case '5y':
      from.setFullYear(from.getFullYear() - 5);
      return { interval: 'day', from, to };
    default:
      from.setFullYear(from.getFullYear() - 1);
      return { interval: 'day', from, to };
  }
}

export async function getHistorical(
  symbol: string,
  range: HistoricalRange,
  _signal?: AbortSignal,
): Promise<HistoricalSeries> {
  const sym = normalizeAppSymbol(symbol);
  if (!sym) {
    return { symbol: '', range, candles: [] };
  }

  let ref: KiteInstrumentRef;
  try {
    ref = await resolveKiteInstrument(sym);
  } catch (err) {
    log.warn('getHistorical: instrument resolve failed', {
      symbol: sym,
      error: err instanceof Error ? err.message : String(err),
    });
    return { symbol: sym, range, candles: [] };
  }

  const { interval, from, to } = rangeToKiteWindow(range);

  try {
    const candles = await getHistoricalData({
      instrumentToken: ref.instrumentToken,
      interval,
      from,
      to,
      continuous: false,
      oi: false,
    });
    return mapKiteHistoricalToSeries(sym, range, candles);
  } catch (err) {
    log.warn('getHistorical failed', {
      symbol: sym,
      range,
      token: ref.instrumentToken,
      error: err instanceof Error ? err.message : String(err),
    });
    // Match IndianAPIAdapter soft-fail: empty series rather than throw
    // for ordinary upstream issues (auth errors still surface via throw
    // from the service layer when the caller must halt).
    return { symbol: sym, range, candles: [] };
  }
}

// ── Supported: symbol search ───────────────────────────────────────

export async function searchSymbol(
  query: string,
  _signal?: AbortSignal,
): Promise<SymbolSearchHit[]> {
  const q = String(query ?? '').trim();
  if (!q) return [];
  const hits = await searchInstrument(q, { exchange: 'NSE', limit: 50 });
  return hits
    .map(mapKiteInstrumentToSearchHit)
    .filter((h) => Boolean(h.symbol));
}

/** IMarketDataProvider naming. */
export async function searchSymbols(
  query: string,
  _opts?: GetOptions,
): Promise<SymbolSearchHit[]> {
  return searchSymbol(query);
}

// ── Unsupported features ───────────────────────────────────────────

const NO_MOVERS =
  'Kite Connect has no trending / gainers / losers endpoint — use rankings table or IndianAPI';
const NO_CORP =
  'Kite Connect has no corporate / fundamentals endpoints — use IndianAPI or Yahoo fundamentals';
const NO_PEERS =
  'Kite Connect has no industry-peers endpoint';
const NO_NEWS =
  'Kite Connect has no news endpoints — use RSS / IndianAPI news';

export async function getMovers(_signal?: AbortSignal): Promise<MoversResult> {
  return unsupported('getMovers', NO_MOVERS);
}

export async function getCorporateIntel(
  _symbol: string,
  _signal?: AbortSignal,
): Promise<CorporateIntel> {
  return unsupported('getCorporateIntel', NO_CORP);
}

export async function getFundamentals(
  _symbol: string,
  _signal?: AbortSignal,
): Promise<Fundamentals> {
  return unsupported('getFundamentals', NO_CORP);
}

export async function getIndustryPeers(
  _symbol: string,
): Promise<IndustryPeer[]> {
  return unsupported('getIndustryPeers', NO_PEERS);
}

export async function getTrendingSymbols(_signal?: AbortSignal): Promise<string[]> {
  return unsupported('getTrendingSymbols', NO_MOVERS);
}

export async function getPriceShockers(): Promise<string[]> {
  return unsupported('getPriceShockers', NO_MOVERS);
}

export async function getNseMostActive(): Promise<never> {
  return unsupported('getNseMostActive', NO_MOVERS);
}

export async function getBseMostActive(): Promise<never> {
  return unsupported('getBseMostActive', NO_MOVERS);
}

export async function getMarketNews(_signal?: AbortSignal): Promise<never> {
  return unsupported('getMarketNews', NO_NEWS);
}

export async function getCompanyNews(
  _symbol: string,
  _signal?: AbortSignal,
): Promise<never> {
  return unsupported('getCompanyNews', NO_NEWS);
}

export async function getAiCuratedNews(_category?: string): Promise<never> {
  return unsupported('getAiCuratedNews', NO_NEWS);
}

export async function searchMutualFunds(_query: string): Promise<never> {
  return unsupported(
    'searchMutualFunds',
    'Kite Connect mutual-fund APIs are out of scope for the market-data adapter',
  );
}

export async function getMutualFunds(): Promise<never> {
  return unsupported(
    'getMutualFunds',
    'Kite Connect mutual-fund APIs are out of scope for the market-data adapter',
  );
}

export async function get52WeekHighLow(): Promise<never> {
  return unsupported(
    'get52WeekHighLow',
    'Use quote.ohlc + historical high/low, or IndianAPI fiftyTwoWeek endpoint',
  );
}

export async function getCommodities(): Promise<never> {
  return unsupported('getCommodities', 'Not part of equity market-data cutover');
}

export async function getStockTargetPrice(_stockId: string): Promise<never> {
  return unsupported('getStockTargetPrice', NO_CORP);
}

export async function getStockForecasts(..._args: unknown[]): Promise<never> {
  return unsupported('getStockForecasts', NO_CORP);
}

export async function getHistoricalStats(..._args: unknown[]): Promise<never> {
  return unsupported(
    'getHistoricalStats',
    'Corporate filings / announcements are not available via Kite Connect',
  );
}

export async function getUsage(): Promise<never> {
  return unsupported(
    'getUsage',
    'Kite has no /usage quota endpoint — rate limits are HTTP 429 based',
  );
}

export async function getIntraday(_symbols: string | string[]): Promise<never> {
  return unsupported(
    'getIntraday',
    'Use getHistorical(symbol, "1d") which maps to Kite 5-minute candles',
  );
}

// ── IMarketDataProvider object ─────────────────────────────────────

/**
 * Full provider-interface object. Envelope-wrapped for callers that
 * talk to IMarketDataProvider directly. MarketDataProvider itself still
 * uses the bare function exports (IndianAPI pattern) when wired later.
 */
export const KiteAdapter: IMarketDataProvider = {
  async searchSymbols(query: string, _opts?: GetOptions) {
    return wrapResponse(await searchSymbol(query));
  },

  async getLiveSnapshot(symbol: string, _opts?: GetOptions) {
    return wrapResponse(await getQuote(symbol));
  },

  async getQuote(symbol: string, _opts?: GetOptions) {
    return wrapResponse(await getQuote(symbol));
  },

  async getHistorical(symbol: string, range: HistoricalRange, _opts?: GetOptions) {
    return wrapResponse(await getHistorical(symbol, range));
  },

  async getMovers(_opts?: GetOptions) {
    return unsupported('getMovers', NO_MOVERS);
  },

  async getCorporateIntel(symbol: string, _opts?: GetOptions) {
    return unsupported('getCorporateIntel', NO_CORP);
  },

  async getFundamentals(symbol: string, _opts?: GetOptions) {
    return unsupported('getFundamentals', NO_CORP);
  },

  async getIndustryPeers(symbol: string) {
    return unsupported('getIndustryPeers', NO_PEERS);
  },
};

// Compile-time guarantee — must stay assigned to IMarketDataProvider.
const _assertKiteAdapter: IMarketDataProvider = KiteAdapter;
void _assertKiteAdapter;

export default KiteAdapter;
