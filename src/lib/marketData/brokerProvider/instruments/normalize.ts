/**
 * Broker-neutral instrument identity + provider-specific token maps.
 *
 * Never pass Kite instrument_token into Shoonya, or Shoonya tokens into Kite.
 */

import type {
  BrokerInstrumentType,
  BrokerMarketExchange,
  BrokerProviderName,
  NormalizedInstrument,
  NormalizedInstrumentInput,
} from '../types';
import { BrokerMarketDataError } from '../types';

export interface ParsedInstrumentKey {
  exchange: string;
  segment: string;
  symbol: string;
  instrumentType: BrokerInstrumentType;
}

/** Build warehouse-style key: NSE_EQ|RELIANCE, NSE_INDEX|NIFTY 50, NFO|…. */
export function toInstrumentKey(
  exchange: BrokerMarketExchange | string,
  symbol: string,
  instrumentType: string = 'EQ',
): string {
  const ex = String(exchange ?? 'NSE').trim().toUpperCase() || 'NSE';
  const sym = String(symbol ?? '').trim().toUpperCase();
  const type = String(instrumentType ?? 'EQ').trim().toUpperCase() || 'EQ';
  if (!sym) {
    throw new BrokerMarketDataError(
      'zerodha',
      'instrument_unresolved',
      'Cannot build instrumentKey without a symbol',
    );
  }

  if (ex === 'NSE' || ex === 'BSE') {
    if (type === 'INDEX') return `${ex}_INDEX|${sym}`;
    if (type === 'FUT' || type === 'CE' || type === 'PE') {
      // Equity options on NSE/BSE are rare in this product; prefer NFO/BFO.
      return `${ex}|${sym}`;
    }
    return `${ex}_EQ|${sym}`;
  }

  if (ex === 'NFO' || ex === 'BFO' || ex === 'CDS' || ex === 'MCX') {
    return `${ex}|${sym}`;
  }

  return `${ex}|${sym}`;
}

/**
 * Parse `NSE_EQ|RELIANCE`, `BSE_EQ|…`, `NSE_INDEX|NIFTY 50`, `NFO|NIFTY25JULFUT`.
 */
export function parseInstrumentKey(instrumentKey: string): ParsedInstrumentKey {
  const raw = String(instrumentKey ?? '').trim().toUpperCase();
  const pipe = raw.indexOf('|');
  if (pipe <= 0 || pipe === raw.length - 1) {
    throw new BrokerMarketDataError(
      'zerodha',
      'instrument_unresolved',
      `Invalid instrumentKey "${instrumentKey}"`,
    );
  }
  const left = raw.slice(0, pipe);
  const symbol = raw.slice(pipe + 1).trim();
  if (!symbol) {
    throw new BrokerMarketDataError(
      'zerodha',
      'instrument_unresolved',
      `Invalid instrumentKey "${instrumentKey}" — empty symbol`,
    );
  }

  if (left.endsWith('_EQ')) {
    const exchange = left.slice(0, -3);
    return { exchange, segment: left, symbol, instrumentType: 'EQ' };
  }
  if (left.endsWith('_INDEX')) {
    const exchange = left.slice(0, -6);
    return { exchange, segment: left, symbol, instrumentType: 'INDEX' };
  }

  // NFO / BFO / CDS / MCX / plain NSE| (legacy)
  let instrumentType: BrokerInstrumentType = 'EQ';
  if (left === 'NFO' || left === 'BFO') {
    if (symbol.endsWith('CE')) instrumentType = 'CE';
    else if (symbol.endsWith('PE')) instrumentType = 'PE';
    else if (symbol.includes('FUT') || /FUT$/i.test(symbol)) instrumentType = 'FUT';
    else instrumentType = 'FUT';
  } else if (left === 'NSE' || left === 'BSE') {
    instrumentType = 'EQ';
  }

  return {
    exchange: left,
    segment: left,
    symbol,
    instrumentType,
  };
}

/**
 * Canonicalize loose caller input into a NormalizedInstrument.
 * Does not accept broker tokens.
 */
export function normalizeInstrument(
  input: NormalizedInstrumentInput | NormalizedInstrument,
  brokerForErrors: BrokerProviderName = 'zerodha',
): NormalizedInstrument {
  if (input.instrumentKey?.trim()) {
    const parsed = parseInstrumentKey(input.instrumentKey);
    return {
      instrumentKey: toInstrumentKey(
        parsed.exchange,
        parsed.symbol,
        input.instrumentType ?? parsed.instrumentType,
      ),
      exchange: (input.exchange?.toString().trim().toUpperCase() || parsed.exchange) as BrokerMarketExchange,
      symbol: (input.symbol?.toString().trim().toUpperCase() || parsed.symbol),
      instrumentType: (input.instrumentType as BrokerInstrumentType | undefined)
        ?? parsed.instrumentType,
      name: input.name ?? null,
    };
  }

  const symbol = String(input.symbol ?? '').trim().toUpperCase();
  const exchange = String(input.exchange ?? 'NSE').trim().toUpperCase() || 'NSE';
  const instrumentType = String(input.instrumentType ?? 'EQ').trim().toUpperCase() || 'EQ';

  if (!symbol) {
    throw new BrokerMarketDataError(
      brokerForErrors,
      'instrument_unresolved',
      'Instrument requires instrumentKey or symbol',
    );
  }

  const instrumentKey = toInstrumentKey(exchange, symbol, instrumentType);
  return {
    instrumentKey,
    exchange,
    symbol,
    instrumentType: instrumentType as BrokerInstrumentType,
    name: input.name ?? null,
  };
}

export function instrumentKeyFromNormalized(inst: NormalizedInstrumentInput): string {
  return normalizeInstrument(inst).instrumentKey;
}

/** Kite REST instrument key: `NSE:RELIANCE` (not a token). */
export function toKiteInstrumentKey(
  exchange: BrokerMarketExchange | string,
  symbol: string,
): string {
  const ex = String(exchange ?? 'NSE').trim().toUpperCase() || 'NSE';
  const sym = String(symbol ?? '').trim().toUpperCase();
  return `${ex}:${sym}`;
}

/** Shoonya subscription key: `NSE|2885` (exchange + Shoonya token only). */
export function toShoonyaScripKey(exchange: string, token: string | number): string {
  return `${String(exchange).trim().toUpperCase()}|${String(token).trim()}`;
}
