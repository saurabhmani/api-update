// ════════════════════════════════════════════════════════════════
//  Kite Connect — instruments master helpers
//
//  In-process cache only. Does NOT integrate with symbolMapper /
//  securitiesMaster / nifty500Universe (later phase).
// ════════════════════════════════════════════════════════════════

import { getKiteClient } from './client';
import { KiteConfigError } from './errors';
import type { KiteExchange, KiteInstrument } from './types';
import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const GLOBAL_KEY = '__q365_kite_instruments_cache__';
const ACTIVE_STOCKS_KEY = '__q365_active_stocks_instruments__';

interface InstrumentsCache {
  all: KiteInstrument[] | null;
  byExchange: Map<string, KiteInstrument[]>;
  downloadedAt: number | null;
}

function cache(): InstrumentsCache {
  const g = globalThis as unknown as Record<string, InstrumentsCache | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      all: null,
      byExchange: new Map(),
      downloadedAt: null,
    };
  }
  return g[GLOBAL_KEY]!;
}

/** Clear the in-memory instruments cache (tests / forced refresh). */
export function clearInstrumentsCache(): void {
  const c = cache();
  c.all = null;
  c.byExchange.clear();
  c.downloadedAt = null;
  const g = globalThis as unknown as Record<string, Map<string, KiteInstrument> | undefined>;
  g[ACTIVE_STOCKS_KEY] = undefined;
}

function activeStocksBySymbol(): Map<string, KiteInstrument> {
  const g = globalThis as unknown as Record<string, Map<string, KiteInstrument> | undefined>;
  if (g[ACTIVE_STOCKS_KEY]) return g[ACTIVE_STOCKS_KEY]!;
  const out = new Map<string, KiteInstrument>();
  try {
    const jsonPath = resolvePath(process.cwd(), 'src/data/active_stocks.json');
    if (!existsSync(jsonPath)) {
      g[ACTIVE_STOCKS_KEY] = out;
      return out;
    }
    const rows = JSON.parse(readFileSync(jsonPath, 'utf8'));
    if (!Array.isArray(rows)) {
      g[ACTIVE_STOCKS_KEY] = out;
      return out;
    }
    for (const row of rows) {
      const sym = String(row?.tradingsymbol ?? '').trim().toUpperCase();
      const token = Number(row?.instrument_token);
      if (!sym || !Number.isFinite(token) || token <= 0) continue;
      const exchange = String(row?.exchange ?? row?.segment ?? 'NSE').trim().toUpperCase() || 'NSE';
      out.set(`${exchange}:${sym}`, {
        instrument_token: token,
        exchange_token: Number(row?.exchange_token) || 0,
        tradingsymbol: sym,
        name: String(row?.name ?? sym),
        last_price: Number(row?.last_price) || 0,
        expiry: row?.expiry ?? '',
        strike: Number(row?.strike) || 0,
        tick_size: Number(row?.tick_size) || 0.05,
        lot_size: Number(row?.lot_size) || 1,
        instrument_type: String(row?.instrument_type ?? 'EQ'),
        segment: String(row?.segment ?? exchange),
        exchange,
      } as KiteInstrument);
    }
  } catch {
    // Best-effort — Kite dump remains the upstream fallback.
  }
  g[ACTIVE_STOCKS_KEY] = out;
  return out;
}

/**
 * Download the full instruments dump (optionally filtered by exchange).
 * Results are cached in-process for subsequent search / lookup.
 */
export async function downloadInstruments(
  exchange?: KiteExchange | string,
): Promise<KiteInstrument[]> {
  const client = getKiteClient();
  const ex = exchange?.trim().toUpperCase() || undefined;

  const rows = await client.call((kc) =>
    // SDK types Exchange union; cast keeps our layer exchange-agnostic.
    kc.getInstruments(ex as Parameters<typeof kc.getInstruments>[0]),
  );

  const instruments = rows as KiteInstrument[];
  const c = cache();
  c.downloadedAt = Date.now();

  if (ex) {
    c.byExchange.set(ex, instruments);
  } else {
    c.all = instruments;
    // Rebuild per-exchange buckets from the full dump.
    c.byExchange.clear();
    for (const row of instruments) {
      const key = String(row.exchange ?? '').toUpperCase();
      if (!key) continue;
      const bucket = c.byExchange.get(key) ?? [];
      bucket.push(row);
      c.byExchange.set(key, bucket);
    }
  }

  return instruments;
}

async function ensureCache(exchange?: string): Promise<KiteInstrument[]> {
  const c = cache();
  const ex = exchange?.trim().toUpperCase() || undefined;

  if (ex) {
    const hit = c.byExchange.get(ex);
    if (hit && hit.length > 0) return hit;
  } else if (c.all && c.all.length > 0) {
    return c.all;
  }

  return downloadInstruments(ex);
}

function matchesQuery(inst: KiteInstrument, query: string): boolean {
  const q = query.trim().toUpperCase();
  if (!q) return false;
  const symbol = String(inst.tradingsymbol ?? '').toUpperCase();
  const name = String(inst.name ?? '').toUpperCase();
  return symbol.includes(q) || name.includes(q);
}

/**
 * Search cached instruments by tradingsymbol or company name.
 * Auto-downloads the dump on first use when the cache is empty.
 */
export async function searchInstrument(
  query: string,
  options: {
    exchange?: KiteExchange | string;
    limit?: number;
  } = {},
): Promise<KiteInstrument[]> {
  const q = query.trim();
  if (!q) {
    throw new KiteConfigError('searchInstrument requires a non-empty query');
  }

  const limit = Math.max(1, Math.min(500, options.limit ?? 25));
  const universe = await ensureCache(options.exchange);
  const hits: KiteInstrument[] = [];

  for (const inst of universe) {
    if (!matchesQuery(inst, q)) continue;
    hits.push(inst);
    if (hits.length >= limit) break;
  }

  // Prefer exact tradingsymbol prefix matches.
  hits.sort((a, b) => {
    const aq = q.toUpperCase();
    const aSym = String(a.tradingsymbol ?? '').toUpperCase();
    const bSym = String(b.tradingsymbol ?? '').toUpperCase();
    const aExact = aSym === aq ? 0 : aSym.startsWith(aq) ? 1 : 2;
    const bExact = bSym === aq ? 0 : bSym.startsWith(aq) ? 1 : 2;
    return aExact - bExact || aSym.localeCompare(bSym);
  });

  return hits.slice(0, limit);
}

/**
 * Exact tradingsymbol lookup (case-insensitive).
 * Optionally scoped to an exchange (defaults to NSE when omitted).
 */
export async function getInstrumentBySymbol(
  symbol: string,
  exchange: KiteExchange | string = 'NSE',
): Promise<KiteInstrument | null> {
  const sym = symbol.trim().toUpperCase();
  if (!sym) {
    throw new KiteConfigError('getInstrumentBySymbol requires a tradingsymbol');
  }

  const ex = String(exchange ?? 'NSE').trim().toUpperCase() || 'NSE';

  const fromActive = activeStocksBySymbol().get(`${ex}:${sym}`);
  if (fromActive) return fromActive;

  const universe = await ensureCache(ex);

  const exact = universe.find(
    (inst) =>
      String(inst.tradingsymbol ?? '').toUpperCase() === sym
      && String(inst.exchange ?? '').toUpperCase() === ex,
  );
  if (exact) return exact;

  // Fallback: match symbol only within the cached bucket.
  return universe.find(
    (inst) => String(inst.tradingsymbol ?? '').toUpperCase() === sym,
  ) ?? null;
}
