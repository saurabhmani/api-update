/**
 * Phase 11 — User live-provider resolution (broker ticks retired).
 *
 * Live broker WebSocket/REST quotes are unsupported. Market data uses
 * the IndianAPI warehouse. This module always returns an unsupported /
 * not_connected outcome so residual callers fail closed without loading SDKs.
 */

import type { DataSourceBroker } from '@/lib/broker/connections/types';
import {
  getUserActiveDataSource,
  type UserActiveDataSource,
} from '@/lib/broker/connections/activeDataSource';
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
  adapter: never;
  ctx: never;
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

export async function resolveUserLiveProvider(
  userId: number,
): Promise<UserLiveResolution> {
  const active = await getUserActiveDataSource(userId);
  return {
    ok: false,
    code: 'not_connected',
    provider: active.provider,
    active,
    message:
      'Live broker ticks are unsupported — market data uses the IndianAPI warehouse. '
      + 'Broker WebSocket feeds (Zerodha/Shoonya) have been retired.',
  };
}

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
