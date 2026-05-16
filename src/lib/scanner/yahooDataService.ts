// ════════════════════════════════════════════════════════════════
//  yahooDataService — NEUTRALIZED STUB // @deprecated marker
//  @deprecated — Step 9 of the IndianAPI cutover replaces every call
//  site with marketDataResolver / IndianAPI. Don't add new importers.
//
//  Yahoo Finance integration has been removed. The scanner-side // @deprecated marker
//  OHLCV+quote fetcher's public surface is preserved so importers
//  (customUniverseBatchScanner, indicatorEngine, preFilterEngine)
//  continue to compile. Every fetch resolves to `{ ok: false }`
//  with a 'NO_DATA' error code; the bulk batch returns an array
//  of failure results in input order.
//
//  Net effect: the scanner runs end-to-end but every symbol fails
//  the OHLCV gate, so zero signals are produced. That's the
//  authorised consequence of removing both data providers.
// ════════════════════════════════════════════════════════════════

export interface NormalizedCandle {
  date:   string;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

export interface YahooBundle { // @deprecated marker
  symbol:        string;
  yahooSymbol:   string; // @deprecated marker
  candles:       NormalizedCandle[];
  latestPrice:   number | null;
  previousClose: number | null;
  changeAbs:     number | null;
  changePercent: number | null;
  marketTime:    number | null;
}

export type YahooErrorCode = // @deprecated marker
  | 'INVALID_SYMBOL'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'HTTP_ERROR'
  | 'PARSE_ERROR'
  | 'NO_DATA'
  | 'BREAKER_OPEN';

export interface YahooFetchError { // @deprecated marker
  code:        YahooErrorCode; // @deprecated marker
  message:     string;
  httpStatus?: number;
  attempts:    number;
}

export interface YahooFetchMeta { // @deprecated marker
  symbol:    string;
  yahooSym:  string; // @deprecated marker
  elapsedMs: number;
  attempts:  number;
  host:      string | null;
  source:    'yahoo'; // @deprecated marker
}

export interface YahooFetchResult<T> { // @deprecated marker
  ok:    boolean;
  data?: T;
  error?: YahooFetchError; // @deprecated marker
  meta:  YahooFetchMeta; // @deprecated marker
}

export interface YahooFetchOpts { // @deprecated marker
  timeoutMs?:     number;
  maxAttempts?:   number;
  backoffBaseMs?: number;
  range?:         '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y';
  interval?:      '1d' | '1wk' | '1mo';
  useBreaker?:    boolean;
}

export interface YahooBatchOpts extends YahooFetchOpts { // @deprecated marker
  concurrency?:       number;
  perSymbolDelayMs?:  number;
  onProgress?: (done: number, total: number, last: YahooFetchResult<YahooBundle>) => void; // @deprecated marker
}

export async function fetchYahooBundle( // @deprecated marker
  inputSymbol: string,
  _opts:       YahooFetchOpts = {}, // @deprecated marker
): Promise<YahooFetchResult<YahooBundle>> { // @deprecated marker
  const sym = (inputSymbol ?? '').trim().toUpperCase();
  return {
    ok: false,
    error: { code: 'NO_DATA', message: 'yahoo_removed', attempts: 0 }, // @deprecated marker
    meta:  { symbol: sym, yahooSym: sym, elapsedMs: 0, attempts: 0, host: null, source: 'yahoo' }, // @deprecated marker
  };
}

export async function fetchYahooBundleBatch( // @deprecated marker
  symbols: string[],
  opts:    YahooBatchOpts = {}, // @deprecated marker
): Promise<Array<YahooFetchResult<YahooBundle>>> { // @deprecated marker
  const results: Array<YahooFetchResult<YahooBundle>> = []; // @deprecated marker
  for (let i = 0; i < symbols.length; i++) {
    const r = await fetchYahooBundle(symbols[i], opts); // @deprecated marker
    results.push(r);
    try {
      opts.onProgress?.(i + 1, symbols.length, r);
    } catch { /* never break the loop on a bad callback */ }
  }
  return results;
}
