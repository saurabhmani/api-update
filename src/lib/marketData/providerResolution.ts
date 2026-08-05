/**
 * Capability-aware market-data provider resolution.
 *
 * IndianAPI is the ONLY market-data upstream. Connected brokers
 * (Zerodha/Shoonya/Kite) are never resolved for quotes, historical,
 * fundamentals, or corporate actions. Live ticks are unsupported.
 */

import {
  getUserActiveDataSource,
  type UserActiveDataSource,
} from '@/lib/broker/connections/activeDataSource';
import type { DataSourceBroker } from '@/lib/broker/connections/types';
import { getSystemMarketDataUserId } from '@/lib/marketData/systemFeed';
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

/** @deprecated Brokers are never resolved for market data. Kept for type compat. */
export interface BrokerMarketDataResolution {
  ok: true;
  code: 'resolved';
  provider: DataSourceBroker;
  providerKind: 'broker';
  capability: MarketDataCapability;
  fallbackUsed: false;
  fallbackReason: null;
  active: UserActiveDataSource;
  adapter: import('@/lib/marketData/brokerProvider/types').BrokerMarketDataProvider;
  context: import('@/lib/marketData/brokerProvider/types').BrokerConnectionContext;
  connectedProviders: DataSourceBroker[];
}

export interface IndianApiMarketDataResolution {
  ok: true;
  code: 'resolved';
  provider: 'indianapi';
  providerKind: 'indianapi';
  capability: MarketDataCapability;
  /** Always false — IndianAPI is the primary, not a broker fallback. */
  fallbackUsed: false;
  fallbackReason: null;
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
  /** Ignored — brokers are not initialized for market data. */
  initialize?: boolean;
}

const log = logger.child({ component: 'marketDataProviderResolution' });

function indianApiSupportsCapability(capability: MarketDataCapability): boolean {
  return capability === 'quotes'
    || capability === 'historical_candles'
    || capability === 'fundamentals'
    || capability === 'corporate_actions'
    || capability === 'instruments';
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
): MarketDataResolution {
  const connectedProviders = active?.connectedProviders ?? [];

  if (capability === 'live_ticks') {
    const result: MarketDataResolutionError = {
      ok: false,
      code: 'indianapi_capability_unsupported',
      capability,
      provider: 'indianapi',
      connectedProviders,
      active,
      message:
        'IndianAPI does not support live ticks. Live WebSocket feeds from Kite/Shoonya '
        + 'have been removed from the market-data path.',
    };
    logResolution({
      userId,
      capability,
      provider: 'indianapi',
      fallbackUsed: false,
      reason: result.code,
      connectedProviders,
      level: 'warn',
    });
    return result;
  }

  if (!isIndianApiEnabled()) {
    const result: MarketDataResolutionError = {
      ok: false,
      code: 'indianapi_disabled',
      capability,
      provider: null,
      connectedProviders,
      active,
      message:
        'IndianAPI is the sole market-data upstream but INDIANAPI_ENABLED is not true. '
        + 'Set INDIANAPI_ENABLED=true.',
    };
    logResolution({
      userId,
      capability,
      provider: null,
      fallbackUsed: false,
      reason: result.code,
      connectedProviders,
      level: 'warn',
    });
    return result;
  }

  if (!indianApiCredentialsPresent()) {
    const result: MarketDataResolutionError = {
      ok: false,
      code: 'indianapi_credentials_missing',
      capability,
      provider: 'indianapi',
      connectedProviders,
      active,
      message:
        'IndianAPI credentials are missing. Configure INDIANAPI_API_KEY '
        + '(or INDIANAPI_KEY / INDIAN_API_KEY).',
    };
    logResolution({
      userId,
      capability,
      provider: 'indianapi',
      fallbackUsed: false,
      reason: result.code,
      connectedProviders,
      level: 'warn',
    });
    return result;
  }

  if (!indianApiSupportsCapability(capability)) {
    const result: MarketDataResolutionError = {
      ok: false,
      code: 'indianapi_capability_unsupported',
      capability,
      provider: 'indianapi',
      connectedProviders,
      active,
      message: `IndianAPI does not support ${capability}.`,
    };
    logResolution({
      userId,
      capability,
      provider: 'indianapi',
      fallbackUsed: false,
      reason: result.code,
      connectedProviders,
      level: 'warn',
    });
    return result;
  }

  const result: IndianApiMarketDataResolution = {
    ok: true,
    code: 'resolved',
    provider: 'indianapi',
    providerKind: 'indianapi',
    capability,
    fallbackUsed: false,
    fallbackReason: null,
    active,
    connectedProviders,
  };
  logResolution({
    userId,
    capability,
    provider: result.provider,
    fallbackUsed: false,
    reason: 'indianapi_sole_upstream',
    connectedProviders,
  });
  return result;
}

/** Resolve the system market-data provider (always IndianAPI when configured). */
export async function resolveSystemMarketDataProvider(
  capability: MarketDataCapability,
): Promise<MarketDataResolution> {
  return resolveMarketDataProvider({ userId: getSystemMarketDataUserId(), capability });
}

/**
 * Resolve IndianAPI for supported capabilities. Never resolves to
 * zerodha / shoonya / kite. Optional userId only annotates logs / active
 * broker status for UI; it does not change the market-data provider.
 */
export async function resolveMarketDataProvider(
  input: ResolveMarketDataProviderInput,
): Promise<MarketDataResolution> {
  const userId = input.userId ?? null;
  const capability = input.capability;

  let active: UserActiveDataSource | null = null;
  if (userId != null) {
    try {
      active = await getUserActiveDataSource(userId);
    } catch {
      active = null;
    }
  }

  return indianApiResult(userId, capability, active);
}
