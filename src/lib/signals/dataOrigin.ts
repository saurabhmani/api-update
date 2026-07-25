/**
 * Phase 10 — Signal data-origin classification.
 *
 * Signal paths fall into four buckets:
 *
 * 1. Live / broker-driven
 *    - enrichWithLiveLtp (user active broker quotes)
 *    - liveSignalRecalc ticks (when keyed to user broker)
 *    - revalidateInstrument live recompute enrichment
 *
 * 2. Poll-driven
 *    - /api/signals list enrich on each request
 *    - /api/signals/stream enrichment
 *    - rescoreActiveSignals / confirmedSnapshotLifecycle (system jobs)
 *
 * 3. Candle-database-driven (broker-neutral warehouse)
 *    - Phase 4 generatePhase4Signals (market_data_daily)
 *    - Closed-market signal loader
 *    - Maturity promotion from stored q365_signals
 *
 * 4. Scheduled / background
 *    - dailyScanSchedule, cron:signal-generation
 *    - candle EOD ingest → scheduled_ingestion
 *    - market-close snapshot
 *
 * Rules:
 *  - Live signals for a Zerodha user → Zerodha-originated normalized data
 *  - Live signals for a Shoonya user → Shoonya-originated normalized data
 *  - Historical / evening signals may use the common candle warehouse
 *  - Never claim Shoonya/Zerodha live when data came from Yahoo/Kite/DB
 *  - Fallback only when explicitly configured and visible
 */

import type { DataSourceBroker } from '@/lib/broker/connections/types';

export type DataOrigin =
  | 'zerodha_live'
  | 'shoonya_live'
  | 'database'
  | 'scheduled_ingestion'
  | 'fallback';

/** Path classification for operators / API docs. */
export type SignalPathKind =
  | 'live_broker'
  | 'poll'
  | 'candle_database'
  | 'scheduled_background';

export const SIGNAL_PATH_CATALOG: ReadonlyArray<{
  id: string;
  kind: SignalPathKind;
  entry: string;
  defaultOrigin: DataOrigin;
  notes: string;
}> = [
  {
    id: 'phase4_scan',
    kind: 'candle_database',
    entry: 'generatePhase4Signals / run-signal-engine',
    defaultOrigin: 'database',
    notes: 'Broker-neutral warehouse candles (market_data_daily)',
  },
  {
    id: 'daily_scan_schedule',
    kind: 'scheduled_background',
    entry: 'dailyScanSchedule',
    defaultOrigin: 'database',
    notes: 'Scheduled Phase 4 scans; EOD candle update is scheduled_ingestion',
  },
  {
    id: 'cron_signal_generation',
    kind: 'scheduled_background',
    entry: 'scheduler cron:signal-generation',
    defaultOrigin: 'database',
    notes: 'Background Phase 4 over warehouse',
  },
  {
    id: 'maturity_promotion',
    kind: 'scheduled_background',
    entry: 'signalMaturity worker',
    defaultOrigin: 'database',
    notes: 'Promotes stored rows; no live quotes',
  },
  {
    id: 'closed_market_loader',
    kind: 'candle_database',
    entry: 'loadClosedMarketSignals',
    defaultOrigin: 'database',
    notes: 'Last-close warehouse signals when market closed / empty live set',
  },
  {
    id: 'list_live_enrichment',
    kind: 'poll',
    entry: 'enrichWithLiveLtp via /api/signals',
    defaultOrigin: 'zerodha_live',
    notes: 'Per-request LTP from user active broker; never silent Yahoo',
  },
  {
    id: 'sse_enrichment',
    kind: 'poll',
    entry: '/api/signals/stream',
    defaultOrigin: 'zerodha_live',
    notes: 'Same enrich path as list',
  },
  {
    id: 'instrument_revalidate',
    kind: 'live_broker',
    entry: 'revalidateInstrument',
    defaultOrigin: 'database',
    notes: 'Stored row is database; live recompute enrichment is broker when available',
  },
  {
    id: 'live_signal_recalc',
    kind: 'live_broker',
    entry: 'liveSignalRecalc',
    defaultOrigin: 'zerodha_live',
    notes: 'Tick-driven; must use keyed broker ticks when multi-tenant',
  },
  {
    id: 'snapshot_lifecycle',
    kind: 'scheduled_background',
    entry: 'confirmedSnapshotLifecycle',
    defaultOrigin: 'scheduled_ingestion',
    notes: 'System job; LTP via system feed owner only',
  },
  {
    id: 'candle_eod_ingest',
    kind: 'scheduled_background',
    entry: 'candle refresh / EOD update',
    defaultOrigin: 'scheduled_ingestion',
    notes: 'Writes common warehouse used by Phase 4',
  },
];

export function liveOriginForBroker(broker: DataSourceBroker): DataOrigin {
  return broker === 'shoonya' ? 'shoonya_live' : 'zerodha_live';
}

export function originFromLiveSource(
  liveSource: string | null | undefined,
): DataOrigin | null {
  const s = String(liveSource ?? '').toLowerCase();
  if (s === 'zerodha' || s === 'zerodha_live' || s === 'kite') {
    // 'kite' alone is ambiguous — only map when already stamped zerodha_live
    if (s === 'kite') return null;
    return 'zerodha_live';
  }
  if (s === 'shoonya' || s === 'shoonya_live') return 'shoonya_live';
  if (s === 'database' || s === 'warehouse' || s === 'mysql') return 'database';
  if (s === 'scheduled_ingestion' || s === 'ingest') return 'scheduled_ingestion';
  if (s === 'yahoo' || s === 'fallback' || s === 'nse_direct' || s === 'cache') {
    return 'fallback';
  }
  return null;
}

/**
 * Explicit opt-in for system-resolver fallback on signal live enrichment.
 * Default OFF — never silently claim broker live from Yahoo/Kite cascade.
 */
export function isSignalLiveFallbackEnabled(): boolean {
  const raw = (process.env.SIGNALS_LIVE_FALLBACK ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export interface SignalDataProvenance {
  /** Primary origin of the signal rows themselves (usually database). */
  generation: DataOrigin;
  /** Origin of livePrice enrichment for this response, if any. */
  liveEnrichment: DataOrigin | null;
  /** True when fallback was used and configured. */
  fallbackUsed: boolean;
  /** Human-readable note for operators / UI. */
  note: string;
}

export function buildSignalProvenance(input: {
  generation?: DataOrigin;
  liveEnrichment?: DataOrigin | null;
  fallbackUsed?: boolean;
  marketOpen?: boolean;
}): SignalDataProvenance {
  const generation = input.generation ?? 'database';
  const liveEnrichment = input.liveEnrichment ?? null;
  const fallbackUsed = Boolean(input.fallbackUsed);
  let note: string;
  if (liveEnrichment === 'zerodha_live') {
    note = 'Live prices from the user\'s Zerodha connection; signal rows from the candle warehouse.';
  } else if (liveEnrichment === 'shoonya_live') {
    note = 'Live prices from the user\'s Shoonya connection; signal rows from the candle warehouse.';
  } else if (liveEnrichment === 'fallback') {
    note = 'Live prices used an explicitly enabled fallback cascade (not the user\'s broker).';
  } else if (generation === 'database') {
    note = input.marketOpen === false
      ? 'Broker-neutral warehouse / last-close signals (market closed or no live enrich).'
      : 'Signal rows from the common candle warehouse; no live broker prices on this response.';
  } else {
    note = `generation=${generation}`;
  }
  return { generation, liveEnrichment, fallbackUsed, note };
}

/** Dominant live enrichment origin across rows. */
export function dominantLiveOrigin(
  rows: Array<{ liveSource?: string | null; livePrice?: number | null }>,
): DataOrigin | null {
  const counts: Partial<Record<DataOrigin, number>> = {};
  for (const row of rows) {
    if (row.livePrice == null || !(row.livePrice > 0)) continue;
    const o = originFromLiveSource(row.liveSource);
    if (!o) continue;
    counts[o] = (counts[o] ?? 0) + 1;
  }
  let best: DataOrigin | null = null;
  let n = 0;
  for (const [k, v] of Object.entries(counts) as Array<[DataOrigin, number]>) {
    if (v > n) {
      best = k;
      n = v;
    }
  }
  return best;
}
