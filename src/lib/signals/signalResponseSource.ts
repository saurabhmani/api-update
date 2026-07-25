/**
 * Signal response provenance — explicit origin for `/api/signals`.
 *
 * Fallback order (closed / degraded):
 *   1. live        — fresh live-generated (market open)
 *   2. cache       — freeze / in-process cache hit
 *   3. persisted   — q365_signals / confirmed snapshots
 *   4. historical  — market-close snapshot / last-session candles
 *   5. none        — no usable rows anywhere
 */

import type { MarketSessionStatus } from '@/lib/marketData/marketSessionService';

export type SignalDataSource =
  | 'live'
  | 'cache'
  | 'persisted'
  | 'historical'
  | 'none';

export interface SignalResponseSource {
  broker: string | null;
  mode: 'live' | 'historical' | 'stale' | 'none';
  marketStatus: MarketSessionStatus;
  dataSource: SignalDataSource;
  isStale: boolean;
  lastTickAt: string | null;
  signalGeneratedAt: string | null;
  tradingDate: string | null;
  ageMs: number | null;
  emptyReason: string | null;
}

export interface BuildSignalSourceInput {
  marketStatus: MarketSessionStatus;
  marketOpen: boolean;
  broker?: string | null;
  /** Closed-path loader source / live freshness data_source */
  closedSignalSource?: string | null;
  hasPersistedSignals: boolean;
  hasMarketCloseSnapshot: boolean;
  servedFromCache?: boolean;
  lastTickAt?: string | null;
  signalGeneratedAt?: string | null;
  tradingDate?: string | null;
  nowMs?: number;
  emptyReason?: string | null;
}

export function mapClosedLoaderToDataSource(input: {
  hasPersistedSignals: boolean;
  hasMarketCloseSnapshot: boolean;
  servedFromCache?: boolean;
  marketOpen: boolean;
}): SignalDataSource {
  if (input.servedFromCache) return 'cache';
  if (input.marketOpen && input.hasPersistedSignals) return 'live';
  if (input.hasPersistedSignals) return 'persisted';
  if (input.hasMarketCloseSnapshot) return 'historical';
  return 'none';
}

export function buildSignalResponseSource(
  input: BuildSignalSourceInput,
): SignalResponseSource {
  const nowMs = input.nowMs ?? Date.now();
  const dataSource = mapClosedLoaderToDataSource({
    hasPersistedSignals: input.hasPersistedSignals,
    hasMarketCloseSnapshot: input.hasMarketCloseSnapshot,
    servedFromCache: input.servedFromCache,
    marketOpen: input.marketOpen,
  });

  const generatedAt = input.signalGeneratedAt ?? null;
  let ageMs: number | null = null;
  if (generatedAt) {
    const t = new Date(generatedAt).getTime();
    if (Number.isFinite(t)) ageMs = Math.max(0, nowMs - t);
  }

  const isStale =
    !input.marketOpen
    || dataSource === 'persisted'
    || dataSource === 'historical'
    || dataSource === 'cache'
    || (ageMs != null && ageMs > 15 * 60_000);

  let mode: SignalResponseSource['mode'] = 'none';
  if (dataSource === 'none') mode = 'none';
  else if (input.marketOpen && dataSource === 'live') mode = 'live';
  else if (isStale) mode = 'stale';
  else mode = 'historical';

  return {
    broker: input.broker ?? null,
    mode,
    marketStatus: input.marketStatus,
    dataSource,
    isStale,
    lastTickAt: input.lastTickAt ?? null,
    signalGeneratedAt: generatedAt,
    tradingDate: input.tradingDate ?? null,
    ageMs,
    emptyReason: dataSource === 'none' ? (input.emptyReason ?? 'no_usable_market_data') : null,
  };
}

/** Prefer the richest non-empty tier for the primary `signals[]` list. */
export function selectPrimaryClosedSignals<T>(tiers: {
  approved: readonly T[];
  highPotential: readonly T[];
  developing: readonly T[];
  scanner: readonly T[];
  watchlist: readonly T[];
}): { rows: T[]; from: 'approved' | 'high_potential' | 'developing' | 'scanner' | 'watchlist' | 'none' } {
  if (tiers.approved.length > 0) {
    return { rows: [...tiers.approved], from: 'approved' };
  }
  if (tiers.highPotential.length > 0) {
    return { rows: [...tiers.highPotential], from: 'high_potential' };
  }
  if (tiers.developing.length > 0) {
    return { rows: [...tiers.developing], from: 'developing' };
  }
  if (tiers.scanner.length > 0) {
    return { rows: [...tiers.scanner], from: 'scanner' };
  }
  if (tiers.watchlist.length > 0) {
    return { rows: [...tiers.watchlist], from: 'watchlist' };
  }
  return { rows: [], from: 'none' };
}

export function hasUsableClosedSignalTiers(tiers: {
  approved: { length: number };
  highPotential: { length: number };
  developing: { length: number };
  scanner: { length: number };
  watchlist: { length: number };
}): boolean {
  return (
    tiers.approved.length > 0
    || tiers.highPotential.length > 0
    || tiers.developing.length > 0
    || tiers.scanner.length > 0
    || tiers.watchlist.length > 0
  );
}
