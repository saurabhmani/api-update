// ════════════════════════════════════════════════════════════════
//  yahooCandles — NEUTRALIZED STUB // @deprecated marker
//
//  @deprecated  Historical candles now flow through IndianAPI
//  (`MarketDataProvider.getHistorical`). Do not import this file
//  in new code.
//
//  The public types (`OhlcBar`, `CandleSource`, `CandleFetchResult`,
//  `YahooCandleOpts`) are preserved so importers compile, but every // @deprecated marker
//  fetch resolves to `{ ok: false, reason: 'yahoo_removed', source: 'yahoo' }`. // @deprecated marker
// ════════════════════════════════════════════════════════════════

export interface OhlcBar {
  ts:     number;
  open:   number;
  high:   number;
  low:    number;
  close:  number;
  volume: number;
}

export type CandleSource = 'yahoo'; // @deprecated marker

export type CandleFetchResult =
  | { ok: true;  candles: OhlcBar[]; source: CandleSource }
  | { ok: false; reason: string;     source: CandleSource };

export interface YahooCandleOpts { // @deprecated marker
  range?:    '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y';
  interval?: '1d' | '1wk' | '1mo';
}

export async function fetchYahooCandles( // @deprecated marker
  _symbol: string,
  _opts: YahooCandleOpts = {}, // @deprecated marker
): Promise<CandleFetchResult> {
  return { ok: false, source: 'yahoo', reason: 'yahoo_removed' }; // @deprecated marker
}
