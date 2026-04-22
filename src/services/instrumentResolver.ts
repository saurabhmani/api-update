// ════════════════════════════════════════════════════════════════
//  Instrument Resolver — Canonical Identity Mapping
//
//  PRD Rule: All engines MUST use instrumentId internally.
//  Ticker is for display and external APIs ONLY.
//
//  This service is the SOLE bridge between the ticker-based world
//  (legacy DB, external APIs, UI) and the instrumentId-based world
//  (institutional services, decision orchestrator, audit).
//
//  Usage:
//    const ref = await resolve('RELIANCE');
//    // ref = { instrumentId: 42, ticker: 'RELIANCE', exchange: 'NSE', ... }
//    // Pass ref.instrumentId to all services
//    // Use ref.ticker only for display/external APIs
//
//  Caching:
//    - In-process Map (zero latency, populated on first use)
//    - Redis (cross-process, 10min TTL)
//    - MySQL instruments table (source of truth)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/redis';
import { logger } from '@/lib/logger';

const log = logger.child({ service: 'instrumentResolver' });

// ── Types ───────────────────────────────────────────────────────

export interface InstrumentRef {
  instrumentId: number;
  ticker: string;              // tradingsymbol (display only)
  exchange: string;
  instrumentKey: string;       // e.g. NSE_EQ|RELIANCE
  isin: string | null;
  sector: string | null;
  name: string | null;
  assetType: string;
}

// ── Cache ───────────────────────────────────────────────────────

const _byTicker = new Map<string, InstrumentRef>();
const _byId     = new Map<number, InstrumentRef>();
let _loaded = false;
const REDIS_KEY = 'instruments:resolver';
const REDIS_TTL = 600; // 10 minutes

// ── Load ────────────────────────────────────────────────────────

async function ensureLoaded(): Promise<void> {
  if (_loaded && _byTicker.size > 0) return;

  // Try Redis first
  const cached = await cacheGet<InstrumentRef[]>(REDIS_KEY);
  if (cached && cached.length > 0) {
    for (const ref of cached) {
      _byTicker.set(ref.ticker.toUpperCase(), ref);
      _byId.set(ref.instrumentId, ref);
    }
    _loaded = true;
    return;
  }

  // Load from DB
  try {
    const { rows } = await db.query(`
      SELECT id, tradingsymbol, exchange, instrument_key, isin,
             COALESCE(sector, 'Other') AS sector, name,
             COALESCE(asset_type, instrument_type, 'EQ') AS asset_type
      FROM instruments
      WHERE is_active = 1
      ORDER BY tradingsymbol
    `);

    const refs: InstrumentRef[] = [];
    for (const r of rows as any[]) {
      const ref: InstrumentRef = {
        instrumentId: r.id,
        ticker: r.tradingsymbol,
        exchange: r.exchange ?? 'NSE',
        instrumentKey: r.instrument_key ?? `NSE_EQ|${r.tradingsymbol}`,
        isin: r.isin ?? null,
        sector: r.sector ?? null,
        name: r.name ?? null,
        assetType: r.asset_type ?? 'EQ',
      };
      refs.push(ref);
      _byTicker.set(ref.ticker.toUpperCase(), ref);
      _byId.set(ref.instrumentId, ref);
    }

    _loaded = true;
    if (refs.length > 0) {
      await cacheSet(REDIS_KEY, refs, REDIS_TTL);
    }
    log.info('Instrument resolver loaded', { count: refs.length });
  } catch (err) {
    log.warn('Instrument resolver load failed', { error: (err as Error).message });
  }
}

// ── Public API ──────────────────────────────────────────────────

/**
 * Resolve a ticker to a full InstrumentRef.
 * Returns null if the instrument is not found in the active universe.
 */
export async function resolveByTicker(ticker: string): Promise<InstrumentRef | null> {
  await ensureLoaded();
  const ref = _byTicker.get(ticker.toUpperCase());
  if (ref) return ref;

  // Cache miss — try direct DB lookup (handles recently synced instruments)
  try {
    const { rows } = await db.query(
      `SELECT id, tradingsymbol, exchange, instrument_key, isin,
              COALESCE(sector, 'Other') AS sector, name,
              COALESCE(asset_type, instrument_type, 'EQ') AS asset_type
       FROM instruments WHERE tradingsymbol = ? AND is_active = 1 LIMIT 1`,
      [ticker.toUpperCase()],
    );
    if (!rows.length) return null;
    const r = rows[0] as any;
    const ref: InstrumentRef = {
      instrumentId: r.id,
      ticker: r.tradingsymbol,
      exchange: r.exchange ?? 'NSE',
      instrumentKey: r.instrument_key ?? `NSE_EQ|${r.tradingsymbol}`,
      isin: r.isin ?? null,
      sector: r.sector ?? null,
      name: r.name ?? null,
      assetType: r.asset_type ?? 'EQ',
    };
    _byTicker.set(ref.ticker.toUpperCase(), ref);
    _byId.set(ref.instrumentId, ref);
    return ref;
  } catch {
    return null;
  }
}

/**
 * Resolve an instrumentId to a full InstrumentRef.
 */
export async function resolveById(instrumentId: number): Promise<InstrumentRef | null> {
  await ensureLoaded();
  const ref = _byId.get(instrumentId);
  if (ref) return ref;

  try {
    const { rows } = await db.query(
      `SELECT id, tradingsymbol, exchange, instrument_key, isin,
              COALESCE(sector, 'Other') AS sector, name,
              COALESCE(asset_type, instrument_type, 'EQ') AS asset_type
       FROM instruments WHERE id = ? LIMIT 1`,
      [instrumentId],
    );
    if (!rows.length) return null;
    const r = rows[0] as any;
    const ref: InstrumentRef = {
      instrumentId: r.id,
      ticker: r.tradingsymbol,
      exchange: r.exchange ?? 'NSE',
      instrumentKey: r.instrument_key ?? `NSE_EQ|${r.tradingsymbol}`,
      isin: r.isin ?? null,
      sector: r.sector ?? null,
      name: r.name ?? null,
      assetType: r.asset_type ?? 'EQ',
    };
    _byTicker.set(ref.ticker.toUpperCase(), ref);
    _byId.set(ref.instrumentId, ref);
    return ref;
  } catch {
    return null;
  }
}

/**
 * Resolve a ticker OR instrumentId to an InstrumentRef.
 * Accepts both forms — the caller doesn't need to know which it has.
 */
export async function resolve(
  tickerOrId: string | number,
): Promise<InstrumentRef | null> {
  if (typeof tickerOrId === 'number') return resolveById(tickerOrId);
  // If it looks like a number string, try ID first
  const asNum = Number(tickerOrId);
  if (Number.isInteger(asNum) && asNum > 0) {
    const byId = await resolveById(asNum);
    if (byId) return byId;
  }
  return resolveByTicker(tickerOrId);
}

/**
 * Batch resolve — used by services that process multiple instruments.
 * Returns a Map keyed by the input (ticker or id).
 */
export async function resolveBatch(
  tickers: string[],
): Promise<Map<string, InstrumentRef>> {
  await ensureLoaded();
  const result = new Map<string, InstrumentRef>();
  const misses: string[] = [];

  for (const t of tickers) {
    const upper = t.toUpperCase();
    const ref = _byTicker.get(upper);
    if (ref) {
      result.set(upper, ref);
    } else {
      misses.push(upper);
    }
  }

  // Batch-fetch misses
  if (misses.length > 0) {
    try {
      const placeholders = misses.map(() => '?').join(',');
      const { rows } = await db.query(
        `SELECT id, tradingsymbol, exchange, instrument_key, isin,
                COALESCE(sector, 'Other') AS sector, name,
                COALESCE(asset_type, instrument_type, 'EQ') AS asset_type
         FROM instruments WHERE tradingsymbol IN (${placeholders}) AND is_active = 1`,
        misses,
      );
      for (const r of rows as any[]) {
        const ref: InstrumentRef = {
          instrumentId: r.id,
          ticker: r.tradingsymbol,
          exchange: r.exchange ?? 'NSE',
          instrumentKey: r.instrument_key ?? `NSE_EQ|${r.tradingsymbol}`,
          isin: r.isin ?? null,
          sector: r.sector ?? null,
          name: r.name ?? null,
          assetType: r.asset_type ?? 'EQ',
        };
        _byTicker.set(ref.ticker.toUpperCase(), ref);
        _byId.set(ref.instrumentId, ref);
        result.set(ref.ticker.toUpperCase(), ref);
      }
    } catch {}
  }

  return result;
}

/**
 * Get the instrumentId for a ticker. Returns 0 if not found.
 * Convenience shorthand for the common case.
 */
export async function tickerToId(ticker: string): Promise<number> {
  const ref = await resolveByTicker(ticker);
  return ref?.instrumentId ?? 0;
}

/**
 * Get the ticker for an instrumentId. Returns '' if not found.
 */
export async function idToTicker(instrumentId: number): Promise<string> {
  const ref = await resolveById(instrumentId);
  return ref?.ticker ?? '';
}

/**
 * Invalidate the in-process cache. Call after instrument sync.
 */
export function invalidateCache(): void {
  _byTicker.clear();
  _byId.clear();
  _loaded = false;
}
