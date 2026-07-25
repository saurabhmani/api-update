/**
 * Dual master cache from active_stocks.json.
 * Stores BOTH Kite instrument_token and Shoonya exchange_token per instrumentKey.
 * Mappers must pick the correct field — never swap them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { toInstrumentKey } from './normalize';

export interface MasterInstrumentRow {
  instrumentKey: string;
  exchange: string;
  symbol: string;
  instrumentType: string;
  /** Zerodha / Kite instrument_token */
  zerodhaInstrumentToken: number;
  /** Shoonya / Noren exchange token */
  shoonyaExchangeToken: string;
  name: string;
}

interface ActiveRow {
  tradingsymbol?: string;
  exchange?: string;
  segment?: string;
  instrument_type?: string;
  instrument_token?: string | number;
  exchange_token?: string | number;
  name?: string;
}

const GLOBAL_KEY = '__q365_instrument_master_cache__';

interface MasterCache {
  byKey: Map<string, MasterInstrumentRow>;
  loaded: boolean;
}

function cache(): MasterCache {
  const g = globalThis as unknown as Record<string, MasterCache | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { byKey: new Map(), loaded: false };
  }
  return g[GLOBAL_KEY]!;
}

export function clearInstrumentMasterCache(): void {
  const c = cache();
  c.byKey.clear();
  c.loaded = false;
}

export function loadInstrumentMasterCache(): Map<string, MasterInstrumentRow> {
  const c = cache();
  if (c.loaded) return c.byKey;

  try {
    const jsonPath = resolvePath(process.cwd(), 'src/data/active_stocks.json');
    if (!existsSync(jsonPath)) {
      c.loaded = true;
      return c.byKey;
    }
    const rows = JSON.parse(readFileSync(jsonPath, 'utf8')) as ActiveRow[];
    if (!Array.isArray(rows)) {
      c.loaded = true;
      return c.byKey;
    }
    for (const row of rows) {
      const symbol = String(row.tradingsymbol ?? '').trim().toUpperCase();
      if (!symbol) continue;
      const exchange = String(row.exchange ?? row.segment ?? 'NSE').trim().toUpperCase() || 'NSE';
      const instrumentType = String(row.instrument_type ?? 'EQ').trim().toUpperCase() || 'EQ';
      const zerodha = Number(row.instrument_token);
      const shoonya = row.exchange_token;
      if (!Number.isFinite(zerodha) || zerodha <= 0) continue;
      if (shoonya == null || String(shoonya).trim() === '') continue;

      const instrumentKey = toInstrumentKey(exchange, symbol, instrumentType);
      c.byKey.set(instrumentKey, {
        instrumentKey,
        exchange,
        symbol,
        instrumentType,
        zerodhaInstrumentToken: zerodha,
        shoonyaExchangeToken: String(shoonya).trim(),
        name: String(row.name ?? symbol),
      });
    }
  } catch {
    /* empty */
  }

  c.loaded = true;
  return c.byKey;
}

export function getMasterRow(instrumentKey: string): MasterInstrumentRow | null {
  return loadInstrumentMasterCache().get(instrumentKey) ?? null;
}

/** Test helper: inject a row without touching the JSON file. */
export function upsertMasterRowForTests(row: MasterInstrumentRow): void {
  const c = cache();
  c.loaded = true;
  c.byKey.set(row.instrumentKey, row);
}
