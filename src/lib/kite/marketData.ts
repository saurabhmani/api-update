// ════════════════════════════════════════════════════════════════
//  Kite Connect — market data helpers
//
//  Returns raw Kite response shapes (see `./types`). Does not map
//  into `@/types/market` — that belongs to a later wiring phase.
// ════════════════════════════════════════════════════════════════

import { getKiteClient } from './client';
import { KiteConfigError } from './errors';
import type {
  KiteInstrumentKey,
  KiteLTP,
  KiteLTPMap,
  KiteOHLC,
  KiteOHLCMap,
  KiteQuote,
  KiteQuotesMap,
} from './types';

function normalizeKeys(input: KiteInstrumentKey | KiteInstrumentKey[]): string[] {
  const list = Array.isArray(input) ? input : [input];
  const cleaned = list
    .map((s) => String(s ?? '').trim().toUpperCase())
    .filter(Boolean);
  if (cleaned.length === 0) {
    throw new KiteConfigError('At least one instrument key is required (e.g. "NSE:RELIANCE")');
  }
  return cleaned;
}

/**
 * Full market quote (incl. depth) for a single instrument.
 * Instrument format: `NSE:RELIANCE`.
 */
export async function getQuote(instrument: KiteInstrumentKey): Promise<KiteQuote> {
  const [key] = normalizeKeys(instrument);
  const map = await getQuotes([key]);
  const quote = map[key] ?? map[Object.keys(map)[0] ?? ''];
  if (!quote) {
    throw new KiteConfigError(`No quote returned for instrument ${key}`);
  }
  return quote;
}

/** Full market quotes for one or more instruments. */
export async function getQuotes(
  instruments: KiteInstrumentKey | KiteInstrumentKey[],
): Promise<KiteQuotesMap> {
  const keys = normalizeKeys(instruments);
  const client = getKiteClient();
  const result = await client.call((kc) => kc.getQuote(keys));
  return result as KiteQuotesMap;
}

/** Last traded price for one or more instruments. */
export async function getLTP(
  instruments: KiteInstrumentKey | KiteInstrumentKey[],
): Promise<KiteLTPMap> {
  const keys = normalizeKeys(instruments);
  const client = getKiteClient();
  const result = await client.call((kc) => kc.getLTP(keys));
  return result as KiteLTPMap;
}

/** Convenience: LTP number for a single instrument. */
export async function getLTPValue(instrument: KiteInstrumentKey): Promise<number> {
  const [key] = normalizeKeys(instrument);
  const map = await getLTP([key]);
  const row: KiteLTP | undefined = map[key] ?? map[Object.keys(map)[0] ?? ''];
  if (!row || typeof row.last_price !== 'number') {
    throw new KiteConfigError(`No LTP returned for instrument ${key}`);
  }
  return row.last_price;
}

/** OHLC snapshot for one or more instruments. */
export async function getOHLC(
  instruments: KiteInstrumentKey | KiteInstrumentKey[],
): Promise<KiteOHLCMap> {
  const keys = normalizeKeys(instruments);
  const client = getKiteClient();
  const result = await client.call((kc) => kc.getOHLC(keys));
  return result as KiteOHLCMap;
}

/** Convenience: OHLC block for a single instrument. */
export async function getOHLCFor(
  instrument: KiteInstrumentKey,
): Promise<KiteOHLC> {
  const [key] = normalizeKeys(instrument);
  const map = await getOHLC([key]);
  const row = map[key] ?? map[Object.keys(map)[0] ?? ''];
  if (!row) {
    throw new KiteConfigError(`No OHLC returned for instrument ${key}`);
  }
  return row;
}
