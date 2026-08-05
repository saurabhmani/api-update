/**
 * Candle warehouse ingest configuration — IndianAPI-only.
 *
 * Connected brokers (Zerodha/Shoonya/Kite) are not used for warehouse
 * candle ingest. fetchConnectedBrokerDailyCandles returns unsupported.
 */

import type { DataSourceBroker } from '@/lib/broker/connections/types';
import type { HistoricalRange } from '@/types/market';
import type { Candle } from '@/lib/signal-engine';

export interface CandleIngestFetchResult {
  ok: boolean;
  candles: Candle[];
  errorCode: string | null;
  errorMessage: string | null;
  rawBarCount: number;
  validBarCount: number;
  provider: 'kite' | 'shoonya' | 'indianapi' | null;
  warehouseSource: 'kite' | 'shoonya' | 'indianapi';
}

export interface CandleIngestBroker {
  userId: number;
  broker: DataSourceBroker;
  connectionId: string | null;
  reason: 'system_user_active' | 'system_user_sole' | 'any_connected_primary' | 'any_connected_sole';
}

export interface CandleIngestConfiguration {
  ok: boolean;
  ingest: CandleIngestBroker | null;
  provider: 'kite' | 'shoonya' | 'indianapi' | null;
  message: string;
}

function envFlagOn(name: string, defaultOn = true): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return defaultOn;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** Connected-broker candle ingest is OFF (IndianAPI-only). */
export function isConnectedBrokerCandleIngestEnabled(): boolean {
  return envFlagOn('CANDLE_INGEST_USE_CONNECTED_BROKER', false);
}

export function historicalRangeToWindow(range: HistoricalRange): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to.getTime());
  switch (range) {
    case '1d':
      from.setUTCDate(from.getUTCDate() - 1);
      break;
    case '5d':
      from.setUTCDate(from.getUTCDate() - 5);
      break;
    case '1mo':
      from.setUTCMonth(from.getUTCMonth() - 1);
      break;
    case '3mo':
      from.setUTCMonth(from.getUTCMonth() - 3);
      break;
    case '6mo':
      from.setUTCMonth(from.getUTCMonth() - 6);
      break;
    case '5y':
      from.setUTCFullYear(from.getUTCFullYear() - 5);
      break;
    case '1y':
    default:
      from.setUTCFullYear(from.getUTCFullYear() - 1);
      break;
  }
  return { from, to };
}

/**
 * @deprecated Brokers are not used for candle ingest.
 */
export async function resolveCandleIngestBroker(): Promise<CandleIngestBroker> {
  throw new Error(
    'Connected-broker candle ingest is disabled — IndianAPI is the sole warehouse upstream. '
    + 'Set INDIANAPI_ENABLED=true and INDIANAPI_API_KEY.',
  );
}

/** True when ingest can proceed via IndianAPI. */
export async function ensureCandleIngestConfigured(): Promise<CandleIngestConfiguration> {
  const { resolveSystemMarketDataProvider } = await import(
    '@/lib/marketData/providerResolution'
  );
  const resolved = await resolveSystemMarketDataProvider('historical_candles');
  if (resolved.ok === false) {
    return { ok: false, ingest: null, provider: null, message: resolved.message };
  }
  if (resolved.providerKind === 'indianapi') {
    return {
      ok: true,
      ingest: null,
      provider: 'indianapi',
      message: 'IndianAPI warehouse upstream (sole market-data source)',
    };
  }
  return {
    ok: false,
    ingest: null,
    provider: null,
    message: 'Connected brokers are not used for candle ingest — configure IndianAPI',
  };
}

/**
 * Broker daily candles — unsupported. Use fetchUpstreamDailyCandles / IndianAPI.
 */
export async function fetchConnectedBrokerDailyCandles(
  _symbol: string,
  _range: HistoricalRange = '1y',
  _ingest?: CandleIngestBroker,
): Promise<CandleIngestFetchResult> {
  return {
    ok: false,
    candles: [],
    errorCode: 'UNSUPPORTED_CAPABILITY',
    errorMessage:
      'Connected-broker candle fetch is retired — use IndianAPI warehouse ingestion',
    rawBarCount: 0,
    validBarCount: 0,
    provider: null,
    warehouseSource: 'indianapi',
  };
}
