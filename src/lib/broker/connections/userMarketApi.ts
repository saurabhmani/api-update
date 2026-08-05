/**
 * User-facing market API helpers — IndianAPI warehouse mode.
 *
 * Auth → session only. Market data is served from Redis/DB warehouse
 * (populated by IndianAPI ingestion). Broker OAuth is not required and
 * never used for quotes/candles.
 */

import { NextResponse } from 'next/server';
import {
  getUserActiveDataSource,
  type UserActiveDataSource,
} from '@/lib/broker/connections/activeDataSource';
import type { DataSourceBroker } from '@/lib/broker/connections/types';
import type { SessionUser } from '@/lib/session';
import { requireSession } from '@/lib/session';
import { AuthenticationError } from '@/lib/errors';
import type { NormalizedInstrument } from '@/lib/marketData/brokerProvider/types';
import { normalizeInstrument } from '@/lib/marketData/brokerProvider/instruments/normalize';
import {
  indianApiCredentialsPresent,
  isIndianApiEnabled,
} from '@/lib/marketData/providerFlags';
import type { UserFacingProviderStatus } from '@/lib/broker/connections/userProviderResolution';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export type MarketDataProviderLabel = DataSourceBroker | 'indianapi';

export type ProviderResponseStatus =
  | UserFacingProviderStatus
  | 'indianapi_ready'
  | 'indianapi_not_configured'
  | 'not_connected'
  | 'needs_selection'
  | 'fresh'
  | 'delayed'
  | 'stale'
  | 'waiting_for_data'
  | 'connecting'
  | 'connected'
  | 'closed_market'
  | 'login_required'
  | 'error';

export interface UserMarketDataContext {
  user: SessionUser;
  active: UserActiveDataSource;
  /** Always indianapi for market-data routes. */
  providerName: 'indianapi';
  status: ProviderResponseStatus;
}

/** Envelope shape for user-facing market responses. */
export interface ProviderDataEnvelope<T> {
  provider: MarketDataProviderLabel | null;
  status: ProviderResponseStatus;
  data: T;
  dataOrigin?: string;
  fallbackUsed?: boolean;
  fallbackSource?: string;
}

export function providerDataJson<T>(
  provider: MarketDataProviderLabel | null,
  status: ProviderResponseStatus,
  data: T,
  init?: {
    status?: number;
    headers?: Record<string, string>;
    dataOrigin?: string;
    fallbackUsed?: boolean;
    fallbackSource?: string;
  },
): NextResponse {
  const body: ProviderDataEnvelope<T> = {
    provider,
    status,
    data,
    ...(init?.dataOrigin != null ? { dataOrigin: init.dataOrigin } : {}),
    ...(init?.fallbackUsed != null ? { fallbackUsed: init.fallbackUsed } : {}),
    ...(init?.fallbackSource != null ? { fallbackSource: init.fallbackSource } : {}),
  };
  return NextResponse.json(body, {
    status: init?.status ?? 200,
    headers: { ...NO_STORE, ...(init?.headers ?? {}) },
  });
}

/** Stamp provider metadata onto an existing payload (signals/dashboard). */
export function withProviderMeta<T extends Record<string, unknown>>(
  payload: T,
  meta: {
    provider: MarketDataProviderLabel | null;
    status: ProviderResponseStatus;
    dataOrigin?: string;
    liveEnrichmentOrigin?: string | null;
    fallbackUsed?: boolean;
    fallbackSource?: string;
    provenanceNote?: string;
  },
): T & {
  provider: MarketDataProviderLabel | null;
  status: typeof meta.status;
  dataOrigin?: string;
  liveEnrichmentOrigin?: string | null;
  fallbackUsed?: boolean;
  fallbackSource?: string;
} {
  return {
    ...payload,
    provider: meta.provider,
    status: meta.status,
    ...(meta.dataOrigin != null ? { dataOrigin: meta.dataOrigin } : {}),
    ...(meta.liveEnrichmentOrigin !== undefined
      ? { liveEnrichmentOrigin: meta.liveEnrichmentOrigin }
      : {}),
    ...(meta.fallbackUsed != null ? { fallbackUsed: meta.fallbackUsed } : {}),
    ...(meta.fallbackSource != null ? { fallbackSource: meta.fallbackSource } : {}),
    ...(meta.provenanceNote ? { provenanceNote: meta.provenanceNote } : {}),
  };
}

function indianApiStatus(): ProviderResponseStatus {
  if (isIndianApiEnabled() && indianApiCredentialsPresent()) return 'indianapi_ready';
  if (indianApiCredentialsPresent()) return 'connected';
  return 'indianapi_not_configured';
}

export async function resolveUserFeedMeta(userId: number): Promise<{
  provider: MarketDataProviderLabel | null;
  status: ProviderResponseStatus;
  active: UserActiveDataSource;
}> {
  const active = await getUserActiveDataSource(userId);
  return {
    provider: 'indianapi',
    status: indianApiStatus(),
    active,
  };
}

/**
 * Session gate for market-data fetches. Does not require a broker connection.
 */
export async function resolveUserMarketDataContext(): Promise<
  UserMarketDataContext | NextResponse
> {
  let user: SessionUser;
  try {
    user = await requireSession();
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { error: 'Unauthorized', code: 'unauthorized' },
        { status: 401, headers: NO_STORE },
      );
    }
    throw err;
  }

  const active = await getUserActiveDataSource(user.id);
  return {
    user,
    active,
    providerName: 'indianapi',
    status: indianApiStatus(),
  };
}

/** Session-only resolve (no hard gate) for status enrichment. */
export async function resolveOptionalUserMarketMeta(): Promise<
  | {
      user: SessionUser;
      provider: MarketDataProviderLabel | null;
      status: ProviderResponseStatus;
    }
  | NextResponse
> {
  try {
    const user = await requireSession();
    const meta = await resolveUserFeedMeta(user.id);
    return { user, provider: meta.provider, status: meta.status };
  } catch (err) {
    if (err instanceof AuthenticationError) {
      return NextResponse.json(
        { error: 'Unauthorized', code: 'unauthorized' },
        { status: 401, headers: NO_STORE },
      );
    }
    throw err;
  }
}

export function isMarketApiGateResponse(value: unknown): value is NextResponse {
  return value instanceof NextResponse;
}

/** Build a NormalizedInstrument from symbol or instrumentKey query input. */
export function instrumentFromQuery(raw: string): NormalizedInstrument {
  const s = raw.trim().toUpperCase();
  if (s.includes('|')) {
    return normalizeInstrument({ instrumentKey: s });
  }
  if (s.includes(':')) {
    const [ex, sym] = s.split(':', 2);
    return normalizeInstrument({
      exchange: (ex || 'NSE').toUpperCase(),
      symbol: (sym || '').toUpperCase(),
      instrumentType: 'EQ',
    });
  }
  return normalizeInstrument({
    exchange: 'NSE',
    symbol: s,
    instrumentType: 'EQ',
  });
}

export function refreshFeedStatus(
  _userId: number | string,
  _provider?: MarketDataProviderLabel | DataSourceBroker,
): ProviderResponseStatus {
  return indianApiStatus();
}

/** Classify candle origins without implying live broker ticks. */
export function labelCandleDataOrigin(source: string): {
  dataOrigin: string;
  fallbackUsed: boolean;
  fallbackSource?: string;
} {
  const s = source.toLowerCase();
  if (s === 'indianapi' || s === 'cache') {
    return { dataOrigin: 'indianapi_warehouse', fallbackUsed: false };
  }
  if (s === 'zerodha' || s === 'kite' || s === 'shoonya') {
    // Legacy stored source labels — treat as warehouse historical.
    return {
      dataOrigin: 'legacy_broker_source',
      fallbackUsed: true,
      fallbackSource: s,
    };
  }
  if (s === 'yahoo' || s.includes('yahoo')) {
    return {
      dataOrigin: 'fallback',
      fallbackUsed: true,
      fallbackSource: 'yahoo',
    };
  }
  return {
    dataOrigin: 'database',
    fallbackUsed: true,
    fallbackSource: source || 'warehouse',
  };
}
