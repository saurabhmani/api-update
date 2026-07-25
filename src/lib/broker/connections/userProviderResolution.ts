/**
 * Phase 11 — Explicit user live-provider resolution.
 *
 * Never uses MARKET_DATA_PROVIDER or silent kite/yahoo defaults for
 * user-facing broker selection.
 *
 * Outcomes:
 *   ok              → use this broker adapter only
 *   not_connected   → no active broker
 *   needs_selection → connected brokers but none selected
 *   zerodha_error   → Zerodha is active but unavailable
 *   shoonya_error   → Shoonya is active but unavailable
 */

import type { DataSourceBroker } from '@/lib/broker/connections/types';
import {
  getUserActiveDataSource,
  type UserActiveDataSource,
} from '@/lib/broker/connections/activeDataSource';
import { getBrokerMarketDataProvider } from '@/lib/marketData/brokerProvider';
import type {
  BrokerConnectionContext,
  BrokerMarketDataProvider,
} from '@/lib/marketData/brokerProvider/types';
import { BrokerMarketDataError } from '@/lib/marketData/brokerProvider/types';

export type UserLiveResolutionCode =
  | 'ok'
  | 'not_connected'
  | 'needs_selection'
  | 'zerodha_error'
  | 'shoonya_error';

export type UserFacingProviderStatus =
  | UserLiveResolutionCode
  | 'fresh'
  | 'delayed'
  | 'stale'
  | 'waiting_for_data'
  | 'connecting'
  | 'connected'
  | 'closed_market'
  | 'login_required'
  | 'error';

export interface UserLiveResolutionOk {
  ok: true;
  code: 'ok';
  provider: DataSourceBroker;
  active: UserActiveDataSource;
  adapter: BrokerMarketDataProvider;
  ctx: BrokerConnectionContext;
}

export interface UserLiveResolutionErr {
  ok: false;
  code: Exclude<UserLiveResolutionCode, 'ok'>;
  provider: DataSourceBroker | null;
  active: UserActiveDataSource;
  message: string;
}

export type UserLiveResolution = UserLiveResolutionOk | UserLiveResolutionErr;

export function brokerErrorCode(broker: DataSourceBroker): 'zerodha_error' | 'shoonya_error' {
  return broker === 'shoonya' ? 'shoonya_error' : 'zerodha_error';
}

/**
 * Resolve the authenticated user's live data provider explicitly.
 * Does not read MARKET_DATA_PROVIDER. Does not fall through to another broker.
 */
export async function resolveUserLiveProvider(
  userId: number,
): Promise<UserLiveResolution> {
  const active = await getUserActiveDataSource(userId);

  if (active.needsSelection) {
    return {
      ok: false,
      code: 'needs_selection',
      provider: null,
      active,
      message: 'Select an active data source before requesting live market data',
    };
  }

  if (!active.provider || !active.isConnected) {
    return {
      ok: false,
      code: 'not_connected',
      provider: active.provider,
      active,
      message: 'No active broker connection — connect Zerodha or Shoonya on /data-source',
    };
  }

  const provider = active.provider;
  const adapter = getBrokerMarketDataProvider(provider);
  const ctx: BrokerConnectionContext = {
    userId,
    connectionId: active.connectionId ?? undefined,
  };

  try {
    await adapter.connect(ctx);
    const connected = await adapter.isConnected(ctx);
    if (!connected) {
      return {
        ok: false,
        code: brokerErrorCode(provider),
        provider,
        active,
        message: `${provider} session is not connected`,
      };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: brokerErrorCode(provider),
      provider,
      active,
      message: `${provider} unavailable: ${msg.slice(0, 160)}`,
    };
  }

  return { ok: true, code: 'ok', provider, active, adapter, ctx };
}

/** Map adapter failures to zerodha_error / shoonya_error (never cross-broker). */
export function mapBrokerFetchError(
  broker: DataSourceBroker,
  err: unknown,
): { code: 'zerodha_error' | 'shoonya_error' | 'login_required'; message: string } {
  if (err instanceof BrokerMarketDataError) {
    if (err.code === 'session_expired' || err.code === 'not_connected') {
      return { code: 'login_required', message: err.message };
    }
    return { code: brokerErrorCode(broker), message: err.message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: brokerErrorCode(broker), message };
}
