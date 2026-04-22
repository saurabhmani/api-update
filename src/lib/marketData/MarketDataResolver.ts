// ════════════════════════════════════════════════════════════════
//  MarketDataResolver — the SINGLE entry point for live-price reads
//
//  Contract (strict, non-negotiable):
//
//    resolvePrice(symbol) → {
//      symbol,
//      price:  number | null,    // null if no valid source
//      source: 'kite' | 'yahoo' | null,
//      fresh:  boolean,          // true only when Kite tick ≤3s old
//      ts:     number | null,    // ms epoch of the underlying frame
//      quality: 'HIGH' | 'MEDIUM' | 'LOW',
//      pChange: number | null,
//    }
//
//  Rules:
//    • NEVER returns entry_price / ltp / last-known-anything as a
//      live price. A caller that wants an entry snapshot must read
//      q365_signals.ltp directly — this module refuses to fabricate.
//    • Kite primary (in-memory tick cache, ≤3s).
//    • Yahoo fallback (15-min delayed). Never mixed with Kite in
//      the same response field — `source` is authoritative.
//    • Only two upstreams exist in this system: Kite and Yahoo.
//
//  Logging (structured, grep-friendly):
//    [RESOLVER] symbol=X source=kite fresh=true ts=... quality=HIGH
//    [RESOLVER] symbol=X fallback=yahoo price=...  quality=MEDIUM
//    [RESOLVER] symbol=X NO_DATA kite=miss yahoo=miss quality=LOW
//
//  Quality levels:
//    HIGH   = fresh Kite tick (<3s)                   — source='kite'
//    MEDIUM = Yahoo (15-min delayed, still valid)     — source='yahoo'
//    LOW    = no price anywhere                        — source=null
// ════════════════════════════════════════════════════════════════

// Kite + Yahoo access now flows through MarketDataProvider; the
// previous direct imports from './kiteTicker' and './priceCache'
// were removed along with the inline Kite/Yahoo layers. Keeping this
// comment as a breadcrumb for anyone grepping for the old symbols.

export type Source  = 'kite' | 'yahoo' | null;
export type Quality = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ResolvedPrice {
  symbol:  string;
  price:   number | null;
  source:  Source;
  fresh:   boolean;
  ts:      number | null;
  pChange: number | null;
  quality: Quality;
}

const VERBOSE = process.env.RESOLVER_LOG !== '0';

function logResolver(line: string): void {
  if (!VERBOSE) return;
  console.log(line);
}

/**
 * The single canonical live-price accessor. Every caller that wants
 * "what is this symbol trading at right now?" should use this and
 * nothing else — no direct `tryGetLiveTick`, no direct Yahoo hit.
 *
 * Returns a strict shape: price=null / source=null when no upstream
 * has data, never a substituted entry snapshot.
 */
export async function resolvePrice(symbol: string): Promise<ResolvedPrice> {
  const sym = String(symbol ?? '').trim().toUpperCase();
  if (!sym) {
    logResolver(`[RESOLVER] symbol=<empty> NO_DATA quality=LOW`);
    return {
      symbol: '',
      price:  null, source: null, fresh: false, ts: null,
      pChange: null, quality: 'LOW',
    };
  }

  // Delegate to getLivePrice — the single canonical live-price
  // path. It guarantees unconditional Yahoo fallback when Kite
  // misses, so this resolver never has to reimplement the policy.
  // We map its PriceResponse shape onto the strict ResolvedPrice
  // contract (quality/fresh/ts normalised) so existing ~7 callers
  // see byte-identical output.
  //
  // Lazy require avoids a circular import at module-load time.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getLivePrice } = require('./getLivePrice') as typeof import('./getLivePrice');

  try {
    const resp = await getLivePrice(sym);
    const s = resp.source;
    if (s === 'none' || resp.price == null) {
      logResolver(`[RESOLVER] symbol=${sym} NO_DATA (kite+yahoo both missed) quality=LOW`);
      return {
        symbol: sym, price: null, source: null, fresh: false,
        ts: null, pChange: null, quality: 'LOW',
      };
    }
    const mappedSource: Source = s === 'kite' ? 'kite' : 'yahoo';
    const fresh   = s === 'kite' && !resp.stale;
    const quality: Quality = fresh ? 'HIGH' : 'MEDIUM';
    logResolver(
      `[RESOLVER] symbol=${sym} source=${mappedSource} fresh=${fresh} ` +
      `price=${resp.price} quality=${quality}`,
    );
    return {
      symbol:  sym,
      price:   resp.price,
      source:  mappedSource,
      fresh,
      ts:      resp.ageMs != null ? Date.now() - resp.ageMs : Date.now(),
      pChange: resp.pChange ?? null,
      quality,
    };
  } catch (err) {
    logResolver(
      `[RESOLVER] symbol=${sym} NO_DATA error=${err instanceof Error ? err.message : String(err)} quality=LOW`,
    );
    return {
      symbol: sym, price: null, source: null, fresh: false,
      ts: null, pChange: null, quality: 'LOW',
    };
  }
}

/**
 * Bulk variant. Resolves an array of symbols in parallel with a
 * bounded concurrency so Yahoo fallback doesn't stampede the
 * upstream. Returns results in the same order as the input.
 */
export async function resolvePrices(
  symbols: string[],
  opts: { concurrency?: number } = {},
): Promise<ResolvedPrice[]> {
  const conc = Math.max(1, Math.min(opts.concurrency ?? 10, 32));
  const out: ResolvedPrice[] = new Array(symbols.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= symbols.length) return;
      out[i] = await resolvePrice(symbols[i]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(conc, symbols.length) }, worker),
  );
  return out;
}

/** Aggregate quality for a batch of resolutions. Used by routes to
 *  surface a single `[DATA_QUALITY]` line per request. */
export function summarizeQuality(resolved: ResolvedPrice[]): {
  high: number; medium: number; low: number; kiteRatio: number;
} {
  let high = 0, medium = 0, low = 0;
  for (const r of resolved) {
    if (r.quality === 'HIGH')   high++;
    else if (r.quality === 'MEDIUM') medium++;
    else low++;
  }
  const total = resolved.length;
  const kiteRatio = total > 0 ? Math.round((high / total) * 100) : 0;
  return { high, medium, low, kiteRatio };
}
