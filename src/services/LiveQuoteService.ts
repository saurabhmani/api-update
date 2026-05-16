// ════════════════════════════════════════════════════════════════
//  LiveQuoteService — the ONLY helper engines should use for quotes
//
//  Rationale for existence:
//    Callers frequently want the price number or the Quote shape —
//    not the full ProviderResponse wrapper. This service keeps the
//    provider invocation in ONE place while giving ergonomic helpers
//    to engines that don't care about source/quality.
//
//  Engines that DO care about quality (signals, alerts) should still
//  call MarketDataProvider.getLiveSnapshot directly and inspect the
//  envelope — the helpers below are for read-only UI-ish paths.
// ════════════════════════════════════════════════════════════════

import MarketDataProvider from '@/providers/MarketDataProvider';
import type { MarketSnapshot, ProviderResponse, ProviderSource } from '@/types/market';
import { writeSnapshot, writeSnapshotBatch, dualWriteEnabled } from './repos/dualWriteSnapshotRepo';
import { logger } from '@/lib/logger';
import {
  validateMarketSnapshot,
  logProviderInvalidPayload,
} from '@/lib/marketData/payloadValidator';

const log = logger.child({ service: 'LiveQuoteService' });

export async function getSnapshot(symbol: string): Promise<ProviderResponse<MarketSnapshot>> {
  return MarketDataProvider.getLiveSnapshot(symbol);
}

export async function getSnapshotStrict(symbol: string): Promise<MarketSnapshot> {
  const resp = await MarketDataProvider.getLiveSnapshot(symbol, { signalCritical: true });
  return resp.data;
}

export async function getPrice(symbol: string): Promise<number> {
  const resp = await MarketDataProvider.getLiveSnapshot(symbol);
  return resp.data.price;
}

export async function getPriceMap(symbols: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const CONCURRENCY = 4;
  const queue = [...symbols];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) {
        const sym = queue.shift();
        if (!sym) return;
        try {
          const resp = await MarketDataProvider.getLiveSnapshot(sym);
          out[sym.toUpperCase()] = resp.data.price;
        } catch {
          /* skip — absence is handled by caller */
        }
      }
    }),
  );
  return out;
}

// ── Write path (Phase-2 PG + optional MySQL dual-write) ────────────
//
// Fetch-and-persist is the scheduler's hot loop: one call, one snapshot
// in both stores. Skip the write when the envelope is 'stale' (we'd be
// echoing our own DB value back at ourselves — a pointless round-trip
// that pollutes updated_at timestamps).

export async function persistSnapshot(
  resp: ProviderResponse<MarketSnapshot>,
): Promise<void> {
  if (resp.source === 'db' || resp.data_quality === 'stale') return;
  // Spec PROVIDER-NORMALIZE-2026-05 — defence-in-depth. The adapter
  // validators already gate IndianAPI / NSE outputs, but persistSnapshot
  // is also called from older paths (batchScheduler.wrapBatchResponse,
  // route-side enrichers) that may not have been re-routed through the
  // adapter validators. Re-validate at the persistence boundary so a
  // bad row never lands in market.snapshots_current / Postgres.
  const validation = validateMarketSnapshot(resp.data, {
    allowZeroVolume: resp.data_quality === 'fallback-delayed' || resp.data_quality === 'cached-fresh',
  });
  if (!validation.ok) {
    logProviderInvalidPayload(
      resp.provider_name ?? 'unknown',
      resp.data.symbol,
      validation.reasons,
      resp.data,
    );
    return; // refuse to persist
  }
  await writeSnapshot({
    ...resp.data,
    source: resp.source as ProviderSource,
    dataQuality: resp.data_quality,
  });
}

export async function fetchAndPersist(symbol: string): Promise<ProviderResponse<MarketSnapshot>> {
  const resp = await MarketDataProvider.getLiveSnapshot(symbol);
  try {
    await persistSnapshot(resp);
  } catch (err) {
    // Never let a persistence failure bubble up and break the read
    // path — the caller got fresh data; logging is enough.
    log.warn('persistSnapshot failed', {
      symbol: resp.data.symbol,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return resp;
}

export async function persistSnapshotBatch(
  responses: ProviderResponse<MarketSnapshot>[],
): Promise<number> {
  // Spec PROVIDER-NORMALIZE-2026-05 — same defence-in-depth as
  // persistSnapshot. Drop invalid payloads before the bulk write so
  // a single bad row in a 200-snapshot batch can't poison the table.
  const rows = responses
    .filter(r => r.source !== 'db' && r.data_quality !== 'stale')
    .filter(r => {
      const v = validateMarketSnapshot(r.data, {
        allowZeroVolume: r.data_quality === 'fallback-delayed' || r.data_quality === 'cached-fresh',
      });
      if (!v.ok) {
        logProviderInvalidPayload(
          r.provider_name ?? 'unknown',
          r.data.symbol,
          v.reasons,
          r.data,
        );
        return false;
      }
      return true;
    })
    .map(r => ({
      ...r.data,
      source: r.source as ProviderSource,
      dataQuality: r.data_quality,
    }));
  if (rows.length === 0) return 0;
  return writeSnapshotBatch(rows);
}

export function isDualWriteEnabled(): boolean {
  return dualWriteEnabled();
}
