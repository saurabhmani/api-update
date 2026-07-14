// ════════════════════════════════════════════════════════════════
//  Kite instrument lookup — app symbol → tradingsymbol → token
//
//  Standalone from `symbolMapper` (intentionally — Phase 3 must not
//  modify the removed vendor symbol mapper). Uses Phase-2
//  `downloadInstruments` / `getInstrumentBySymbol` / `searchInstrument`.
// ════════════════════════════════════════════════════════════════

import {
  getInstrumentBySymbol,
  searchInstrument,
  type KiteExchange,
  type KiteInstrument,
} from '@/lib/kite';
import { KiteConfigError } from '@/lib/kite/errors';

export interface KiteInstrumentRef {
  /** Canonical app symbol (e.g. RELIANCE). */
  symbol: string;
  /** Exchange segment used for the Kite key. */
  exchange: string;
  /** Kite / exchange tradingsymbol. */
  tradingsymbol: string;
  /** Numeric instrument token for historical / ticker APIs. */
  instrumentToken: number;
  /** Quote API key — `NSE:RELIANCE`. */
  kiteKey: string;
  /** Raw instrument row when available. */
  instrument: KiteInstrument | null;
}

const DEFAULT_EXCHANGE: KiteExchange = 'NSE';

/**
 * Strip common vendor prefixes/suffixes so "NSE:RELIANCE", "RELIANCE.NS",
 * and "RELIANCE" all resolve to the same lookup key.
 * Does not call the shared removed vendor symbolMapper.
 */
export function normalizeAppSymbol(raw: string): string {
  let s = String(raw ?? '').trim().toUpperCase();
  if (!s) return '';
  if (s.includes('|')) s = s.split('|').pop()!.trim();
  if (s.includes(':')) s = s.split(':').pop()!.trim();
  s = s.replace(/\.(NS|BO|BSE|NSE)$/i, '');
  return s;
}

export function toKiteInstrumentKey(
  symbol: string,
  exchange: string = DEFAULT_EXCHANGE,
): string {
  const sym = normalizeAppSymbol(symbol);
  const ex = String(exchange || DEFAULT_EXCHANGE).trim().toUpperCase() || DEFAULT_EXCHANGE;
  if (!sym) throw new KiteConfigError('Cannot build Kite instrument key from empty symbol');
  return `${ex}:${sym}`;
}

function tokenFromInstrument(inst: KiteInstrument): number {
  const n = Number(inst.instrument_token);
  if (!Number.isFinite(n) || n <= 0) {
    throw new KiteConfigError(
      `Instrument ${inst.tradingsymbol} has invalid instrument_token=${String(inst.instrument_token)}`,
    );
  }
  return n;
}

function toRef(inst: KiteInstrument, fallbackSymbol?: string): KiteInstrumentRef {
  const tradingsymbol = String(inst.tradingsymbol ?? '').trim().toUpperCase();
  const exchange = String(inst.exchange ?? DEFAULT_EXCHANGE).trim().toUpperCase() || DEFAULT_EXCHANGE;
  const symbol = fallbackSymbol
    ? normalizeAppSymbol(fallbackSymbol)
    : tradingsymbol;
  return {
    symbol,
    exchange,
    tradingsymbol,
    instrumentToken: tokenFromInstrument(inst),
    kiteKey: `${exchange}:${tradingsymbol}`,
    instrument: inst,
  };
}

/**
 * Resolve a single app symbol to a Kite instrument reference.
 * Defaults to NSE equity.
 */
export async function resolveKiteInstrument(
  symbol: string,
  exchange: KiteExchange | string = DEFAULT_EXCHANGE,
): Promise<KiteInstrumentRef> {
  const sym = normalizeAppSymbol(symbol);
  if (!sym) {
    throw new KiteConfigError('resolveKiteInstrument requires a non-empty symbol');
  }
  const ex = String(exchange || DEFAULT_EXCHANGE).trim().toUpperCase() || DEFAULT_EXCHANGE;

  const exact = await getInstrumentBySymbol(sym, ex);
  if (exact) return toRef(exact, sym);

  // Fuzzy fallback — useful when the instruments dump is exchange-scoped
  // differently or the ticker is an index / renamed equity.
  const hits = await searchInstrument(sym, { exchange: ex, limit: 10 });
  const preferred =
    hits.find((h) => String(h.tradingsymbol).toUpperCase() === sym)
    ?? hits.find((h) => String(h.instrument_type).toUpperCase() === 'EQ')
    ?? hits[0];

  if (!preferred) {
    throw new KiteConfigError(
      `No Kite instrument found for ${ex}:${sym} — download instruments or check the symbol`,
    );
  }
  return toRef(preferred, sym);
}

/**
 * Batch resolve. Missing symbols are omitted from the map (callers
 * put them into `missing[]`).
 */
export async function resolveKiteInstruments(
  symbols: string[],
  exchange: KiteExchange | string = DEFAULT_EXCHANGE,
): Promise<Map<string, KiteInstrumentRef>> {
  const out = new Map<string, KiteInstrumentRef>();
  const unique = [...new Set(symbols.map(normalizeAppSymbol).filter(Boolean))];

  // Sequential lookups reuse the in-process instruments cache after the
  // first download; parallelising here only burns CPU on Map contention.
  for (const sym of unique) {
    try {
      const ref = await resolveKiteInstrument(sym, exchange);
      out.set(sym, ref);
    } catch {
      // omit — caller treats absence as missing
    }
  }
  return out;
}

/** Resolve only the Kite quote key (`NSE:RELIANCE`) without requiring a token. */
export async function resolveKiteKey(
  symbol: string,
  exchange: KiteExchange | string = DEFAULT_EXCHANGE,
): Promise<string> {
  try {
    const ref = await resolveKiteInstrument(symbol, exchange);
    return ref.kiteKey;
  } catch {
    // Fallback: construct the conventional key even if the dump miss.
    // Quote APIs still accept NSE:SYMBOL for listed equities.
    return toKiteInstrumentKey(symbol, exchange);
  }
}
