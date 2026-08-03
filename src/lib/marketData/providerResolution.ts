/**
 * Capability-aware market-data provider resolution.
 *
 * A connected broker always wins for the capability it supports. IndianAPI is
 * deliberately a configuration-backed default only when no usable broker can
 * serve the requested capability; it is never a silent recovery path for a
 * broker session or adapter failure.
 */

import {
  getUserActiveDataSource,
  type UserActiveDataSource,
} from '@/lib/broker/connections/activeDataSource';
import type { DataSourceBroker } from '@/lib/broker/connections/types';
import { getBrokerMarketDataProvider } from '@/lib/marketData/brokerProvider';
import type {
  BrokerConnectionContext,
  BrokerMarketDataProvider,
} from '@/lib/marketData/brokerProvider/types';
import { getSystemMarketDataUserId } from '@/lib/marketData/connectionManager/systemFeed';
import { indianApiCredentialsPresent, isIndianApiEnabled } from '@/lib/marketData/providerFlags';
import { logger } from '@/lib/logger';

export type MarketDataCapability =
  | 'quotes'
  | 'historical_candles'
  | 'instruments'
  | 'fundamentals'
  | 'corporate_actions'
  | 'live_ticks';

export type MarketDataResolutionCode =
  | 'resolved'
  | 'no_connected_provider'
  | 'provider_credentials_expired'
  | 'provider_selection_required'
  | 'provider_initialization_failed'
  | 'provider_capability_unsupported'
  | 'indianapi_disabled'
  | 'indianapi_credentials_missing'
  | 'indianapi_capability_unsupported';

export interface BrokerMarketDataResolution {
  ok: true;
  code: 'resolved';
  provider: DataSourceBroker;
  providerKind: 'broker';
  capability: MarketDataCapability;
  fallbackUsed: false;
  fallbackReason: null;
  active: UserActiveDataSource;
  adapter: BrokerMarketDataProvider;
  context: BrokerConnectionContext;
  connectedProviders: DataSourceBroker[];
}

export interface IndianApiMarketDataResolution {
  ok: true;
  code: 'resolved';
  provider: 'indianapi';
  providerKind: 'indianapi';
  capability: MarketDataCapability;
  fallbackUsed: true;
  fallbackReason: 'no_connected_provider' | 'provider_capability_unsupported';
  active: UserActiveDataSource | null;
  connectedProviders: DataSourceBroker[];
}

export interface MarketDataResolutionError {
  ok: false;
  code: Exclude<MarketDataResolutionCode, 'resolved'>;
  capability: MarketDataCapability;
  provider: DataSourceBroker | 'indianapi' | null;
  connectedProviders: DataSourceBroker[];
  active: UserActiveDataSource | null;
  message: string;
}

export type MarketDataResolution =
  | BrokerMarketDataResolution
  | IndianApiMarketDataResolution
  | MarketDataResolutionError;

export interface ResolveMarketDataProviderInput {
  userId?: number | null;
  capability: MarketDataCapability;
  /** Verify a selected broker session before returning it. Defaults to true. */
  initialize?: boolean;
}

const log = logger.child({ component: 'marketDataProviderResolution' });

function brokerSupportsCapability(_broker: DataSourceBroker, capability: MarketDataCapability): boolean {
  return capability === 'quotes'
    || capability === 'historical_candles'
    || capability === 'instruments'
    || capability === 'live_ticks';
}

function indianApiSupportsCapability(capability: MarketDataCapability): boolean {
  return capability === 'quotes'
    || capability === 'historical_candles'
    || capability === 'fundamentals'
    || capability === 'corporate_actions';
}

function logResolution(input: {
  userId: number | null;
  capability: MarketDataCapability;
  provider: string | null;
  fallbackUsed: boolean;
  reason: string;
  connectedProviders: DataSourceBroker[];
  level?: 'info' | 'warn';
}): void {
  log[input.level ?? 'info']('Market-data provider resolved', {
    userId: input.userId,
    capability: input.capability,
    provider: input.provider,
    fallback: input.fallbackUsed,
    reason: input.reason,
    connectedProviders: input.connectedProviders,
  });
}

function indianApiResult(
  userId: number | null,
  capability: MarketDataCapability,
  active: UserActiveDataSource | null,
  reason: 'no_connected_provider' | 'provider_capability_unsupported',
): MarketDataResolution {
  const connectedProviders = active?.connectedProviders ?? [];
  if (!isIndianApiEnabled()) {
    const result: MarketDataResolutionError = {
      ok: false, code: 'indianapi_disabled', capability, provider: null,
      connectedProviders, active,
      message: 'No connected market-data provider and IndianAPI is disabled. Set INDIANAPI_ENABLED=true to enable the default fallback.',
    };
    logResolution({ userId, capability, provider: null, fallbackUsed: false, reason: result.code, connectedProviders, level: 'warn' });
    return result;
  }
  if (!indianApiCredentialsPresent()) {
    const result: MarketDataResolutionError = {
      ok: false, code: 'indianapi_credentials_missing', capability, provider: 'indianapi',
      connectedProviders, active,
      message: 'No connected market-data provider and IndianAPI credentials are missing. Configure INDIANAPI_API_KEY.',
    };
    logResolution({ userId, capability, provider: 'indianapi', fallbackUsed: false, reason: result.code, connectedProviders, level: 'warn' });
    return result;
  }
  if (!indianApiSupportsCapability(capability)) {
    const result: MarketDataResolutionError = {
      ok: false, code: 'indianapi_capability_unsupported', capability, provider: 'indianapi',
      connectedProviders, active,
      message: `IndianAPI is configured but does not support ${capability}. Connect a provider that supports this capability.`,
    };
    logResolution({ userId, capability, provider: 'indianapi', fallbackUsed: false, reason: result.code, connectedProviders, level: 'warn' });
    return result;
  }
  const result: IndianApiMarketDataResolution = {
    ok: true, code: 'resolved', provider: 'indianapi', providerKind: 'indianapi', capability,
    fallbackUsed: true, fallbackReason: reason, active, connectedProviders,
  };
  logResolution({ userId, capability, provider: result.provider, fallbackUsed: true, reason, connectedProviders });
  return result;
}

/** Resolve the configured system user's provider, or IndianAPI when none is connected. */
export async function resolveSystemMarketDataProvider(
  capability: MarketDataCapability,
): Promise<MarketDataResolution> {
  return resolveMarketDataProvider({ userId: getSystemMarketDataUserId(), capability });
}

/**
 * Resolve a provider without creating records or calling external APIs.
 * Broker initialization checks only the selected connection; failures are not
 * treated as permission to silently switch to IndianAPI.
 */
export async function resolveMarketDataProvider(
  input: ResolveMarketDataProviderInput,
): Promise<MarketDataResolution> {
  const userId = input.userId ?? null;
  const capability = input.capability;
  if (userId == null) return indianApiResult(null, capability, null, 'no_connected_provider');

  const active = await getUserActiveDataSource(userId);
  const connectedProviders = active.connectedProviders;
  if (active.needsSelection) {
    const result: MarketDataResolutionError = {
      ok: false, code: 'provider_selection_required', capability, provider: null,
      connectedProviders, active,
      message: 'Multiple connected providers require an active data-source selection before market data can be fetched.',
    };
    logResolution({ userId, capability, provider: null, fallbackUsed: false, reason: result.code, connectedProviders, level: 'warn' });
    return result;
  }
  if (!active.provider || !active.isConnected) {
    if (active.reason === 'expired') {
      const result: MarketDataResolutionError = {
        ok: false, code: 'provider_credentials_expired', capability, provider: active.provider,
        connectedProviders, active,
        message: 'A connected market-data provider requires reauthentication. Reconnect it on /data-source before retrying.',
      };
      logResolution({ userId, capability, provider: active.provider, fallbackUsed: false, reason: result.code, connectedProviders, level: 'warn' });
      return result;
    }
    return indianApiResult(userId, capability, active, 'no_connected_provider');
  }
  if (!brokerSupportsCapability(active.provider, capability)) {
    return indianApiResult(userId, capability, active, 'provider_capability_unsupported');
  }

  const adapter = getBrokerMarketDataProvider(active.provider);
  const context: BrokerConnectionContext = { userId, connectionId: active.connectionId ?? undefined };
  if (input.initialize !== false) {
    try {
      await adapter.connect(context);
      if (!(await adapter.isConnected(context))) {
        throw new Error('provider session is not connected');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'provider initialization failed';
      const result: MarketDataResolutionError = {
        ok: false, code: 'provider_initialization_failed', capability, provider: active.provider,
        connectedProviders, active,
        message: `${active.provider} is connected but could not be initialized: ${message.slice(0, 160)}`,
      };
      logResolution({ userId, capability, provider: active.provider, fallbackUsed: false, reason: result.code, connectedProviders, level: 'warn' });
      return result;
    }
  }
  const result: BrokerMarketDataResolution = {
    ok: true, code: 'resolved', provider: active.provider, providerKind: 'broker', capability,
    fallbackUsed: false, fallbackReason: null, active, adapter, context, connectedProviders,
  };
  logResolution({ userId, capability, provider: result.provider, fallbackUsed: false, reason: active.reason, connectedProviders });
  return result;
}
