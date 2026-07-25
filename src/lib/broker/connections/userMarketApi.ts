/**
 * Phase 9/11 — user-facing market API helpers.
 *
 * Flow: authenticate → resolveUserLiveProvider → adapter → normalize → respond
 * Never uses MARKET_DATA_PROVIDER. Never exposes tokens.
 * Never silently returns another provider's live data.
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
import type {
  BrokerConnectionContext,
  BrokerMarketDataProvider,
  NormalizedInstrument,
} from '@/lib/marketData/brokerProvider/types';
import { normalizeInstrument } from '@/lib/marketData/brokerProvider/instruments/normalize';
import {
  getLiveFeedStateFor,
  type LiveFeedStatus,
} from '@/lib/marketData/liveFeedState';
import {
  resolveUserLiveProvider,
  type UserFacingProviderStatus,
  type UserLiveResolutionCode,
} from '@/lib/broker/connections/userProviderResolution';

const NO_STORE = { 'Cache-Control': 'no-store' } as const;

export type ProviderResponseStatus =
  | LiveFeedStatus
  | UserLiveResolutionCode
  | 'needs_selection'
  | UserFacingProviderStatus;

export interface UserMarketDataContext {
  user: SessionUser;
  active: UserActiveDataSource;
  providerName: DataSourceBroker;
  provider: BrokerMarketDataProvider;
  ctx: BrokerConnectionContext;
  /** Keyed feed freshness status for this user+provider. */
  status: LiveFeedStatus;
}

/** Envelope shape for user-facing market responses. */
export interface ProviderDataEnvelope<T> {
  provider: DataSourceBroker | null;
  status: ProviderResponseStatus;
  data: T;
  /** When warehouse/Yahoo is used deliberately — never mutates selected source. */
  dataOrigin?: string;
  fallbackUsed?: boolean;
  fallbackSource?: string;
}

export function providerDataJson<T>(
  provider: DataSourceBroker | null,
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
    provider: DataSourceBroker | null;
    status: ProviderResponseStatus;
    dataOrigin?: string;
    liveEnrichmentOrigin?: string | null;
    fallbackUsed?: boolean;
    fallbackSource?: string;
    provenanceNote?: string;
  },
): T & {
  provider: DataSourceBroker | null;
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

export async function resolveUserFeedMeta(userId: number): Promise<{
  provider: DataSourceBroker | null;
  status: ProviderResponseStatus;
  active: UserActiveDataSource;
}> {
  const active = await getUserActiveDataSource(userId);
  if (active.needsSelection) {
    return { provider: null, status: 'needs_selection', active };
  }
  if (!active.provider || !active.isConnected) {
    return { provider: active.provider, status: 'not_connected', active };
  }
  const feed = getLiveFeedStateFor({
    userId: String(userId),
    provider: active.provider,
  });
  return { provider: active.provider, status: feed.status, active };
}

/**
 * Full gate for market-data fetches that require an active broker adapter.
 * Uses resolveUserLiveProvider — never MARKET_DATA_PROVIDER.
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

  const resolution = await resolveUserLiveProvider(user.id);

  if (resolution.ok === false) {
    const http =
      resolution.code === 'needs_selection' ? 409
        : resolution.code === 'not_connected' ? 403
          : 502;
    return providerDataJson(
      resolution.provider,
      resolution.code,
      {
        error: resolution.message,
        code: resolution.code,
        redirectTo:
          resolution.code === 'needs_selection'
            ? '/data-source?reason=select_data_source'
            : resolution.code === 'not_connected'
              ? '/data-source'
              : undefined,
        connectedProviders: resolution.active.connectedProviders,
      },
      { status: http },
    );
  }

  const feed = getLiveFeedStateFor({
    userId: String(user.id),
    provider: resolution.provider,
  });

  return {
    user,
    active: resolution.active,
    providerName: resolution.provider,
    provider: resolution.adapter,
    ctx: resolution.ctx,
    status: feed.status,
  };
}

/** Session-only resolve (no hard gate) for status enrichment. */
export async function resolveOptionalUserMarketMeta(): Promise<
  | {
      user: SessionUser;
      provider: DataSourceBroker | null;
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
  userId: number | string,
  provider: DataSourceBroker,
): LiveFeedStatus {
  return getLiveFeedStateFor({
    userId: String(userId),
    provider,
  }).status;
}

/** Classify warehouse / Yahoo chart fills without misrepresenting the broker. */
export function labelCandleDataOrigin(source: string): {
  dataOrigin: string;
  fallbackUsed: boolean;
  fallbackSource?: string;
} {
  const s = source.toLowerCase();
  if (s === 'zerodha' || s === 'kite' || s === 'shoonya') {
    return {
      dataOrigin: s === 'shoonya' ? 'shoonya_live' : 'zerodha_live',
      fallbackUsed: false,
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
