// ════════════════════════════════════════════════════════════════
//  Route handlers — business logic, kept transport-agnostic so the
//  same functions work behind a plain HTTP server today and behind
//  Express / Fastify / gRPC tomorrow.
//
//  Every handler:
//    • Receives an already-ensured correlation id
//    • Calls MarketDataProvider (single source of market truth)
//    • Publishes bus events on success
//    • Returns a ServiceResponse envelope
// ════════════════════════════════════════════════════════════════

import MarketDataProvider from '@/providers/MarketDataProvider';
import type {
  GetSnapshotResponse,
  GetHistoricalResponse,
  ServiceResponse,
  HealthResponse,
} from '@contracts/api';
import type { HistoricalRange } from '@/types/market';
import { StaleDataError } from '@/types/market';
import { makeEvent } from '@contracts/events';
import { bus } from '@eventbus/bus';

const VALID_RANGES: HistoricalRange[] = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '5y'];

export interface SnapshotParams {
  symbol: string;
  signalCritical?: boolean;
  forceRefresh?: boolean;
}

export async function handleSnapshot(
  params: SnapshotParams,
  correlationId: string,
  log: (level: string, msg: string, meta?: Record<string, unknown>) => void,
): Promise<ServiceResponse<GetSnapshotResponse['data']> & { source?: string; data_quality?: string; fetched_at?: number; trail?: unknown }> {
  if (!params.symbol || typeof params.symbol !== 'string') {
    return { ok: false, error: 'symbol required', code: 'BAD_REQUEST', correlation_id: correlationId };
  }
  try {
    const resp = await MarketDataProvider.getLiveSnapshot(params.symbol, {
      signalCritical: !!params.signalCritical,
      forceRefresh: !!params.forceRefresh,
    });

    // Fire event — alerting + signal services listen for this.
    await bus.publish(makeEvent('market.snapshot.updated', {
      symbol: resp.data.symbol,
      snapshot: resp.data,
      source: resp.source,
      data_quality: resp.data_quality,
    }, correlationId));

    log('info', 'snapshot served', { symbol: resp.data.symbol, source: resp.source, quality: resp.data_quality });

    // Flatten provider envelope into ServiceOk so the gateway sees
    // both the `ok` discriminator AND the Phase-1 envelope fields.
    return {
      ok: true,
      data: resp.data,
      source: resp.source,
      data_quality: resp.data_quality,
      fetched_at: resp.fetched_at,
      trail: resp.trail,
      correlation_id: correlationId,
    };
  } catch (err) {
    if (err instanceof StaleDataError) {
      return { ok: false, error: err.message, code: 'STALE', correlation_id: correlationId };
    }
    log('error', 'snapshot failed', { symbol: params.symbol, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: 'internal error', code: 'INTERNAL', correlation_id: correlationId };
  }
}

export interface HistoricalParams {
  symbol: string;
  range?: string;
}

export async function handleHistorical(
  params: HistoricalParams,
  correlationId: string,
  log: (level: string, msg: string, meta?: Record<string, unknown>) => void,
): Promise<ServiceResponse<GetHistoricalResponse['data']>> {
  if (!params.symbol) {
    return { ok: false, error: 'symbol required', code: 'BAD_REQUEST', correlation_id: correlationId };
  }
  const range = (params.range ?? '1mo') as HistoricalRange;
  if (!VALID_RANGES.includes(range)) {
    return { ok: false, error: `invalid range: ${range}`, code: 'BAD_REQUEST', correlation_id: correlationId };
  }
  try {
    const resp = await MarketDataProvider.getHistorical(params.symbol, range);
    log('info', 'historical served', { symbol: params.symbol, range, points: resp.data.candles.length, source: resp.source });
    return { ok: true, data: resp.data, correlation_id: correlationId };
  } catch (err) {
    if (err instanceof StaleDataError) {
      return { ok: false, error: err.message, code: 'STALE', correlation_id: correlationId };
    }
    log('error', 'historical failed', { symbol: params.symbol, range, error: err instanceof Error ? err.message : String(err) });
    return { ok: false, error: 'internal error', code: 'INTERNAL', correlation_id: correlationId };
  }
}

const SERVICE_NAME = 'market-ingestion';
const SERVICE_VERSION = '0.1.0';
const startedAt = Date.now();

export function handleHealth(): HealthResponse {
  const health = MarketDataProvider.getProviderHealth();
  const anyOpen = health.some(h => h.state === 'open');
  const anyHalfOpen = health.some(h => h.state === 'half-open');
  const status: HealthResponse['status'] = anyOpen ? 'degraded' : anyHalfOpen ? 'degraded' : 'ok';
  return {
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    status,
    uptime_sec: Math.round((Date.now() - startedAt) / 1000),
    dependencies: Object.fromEntries(health.map(h => [h.provider, h.state === 'closed' ? 'ok' : h.state === 'open' ? 'down' : 'degraded'])) as HealthResponse['dependencies'],
  };
}
