/**
 * providerHealth — composite ops snapshot (IndianAPI warehouse).
 * No Kite/Shoonya SDK probes.
 */

import {
  getMarketDataProvider,
  getPrimaryFallbackProvider,
  indianApiCredentialsPresent,
  isIndianApiEnabled,
} from '@/lib/marketData/providerFlags';
import { getProviderReport } from '@/lib/marketData/providerReport';
import { getMonitorSnapshot } from '@/lib/monitor/apiMonitor';

export type ProviderCapability =
  | 'quotes'
  | 'batch_quotes'
  | 'historical'
  | 'movers'
  | 'trending'
  | 'news'
  | 'corporate'
  | 'search';

const INDIANAPI_CAPS: ProviderCapability[] = [
  'quotes', 'batch_quotes', 'historical', 'corporate', 'search',
];

const YAHOO_CAPS: ProviderCapability[] = [
  'quotes', 'batch_quotes', 'historical', 'news', 'search',
];

const NSE_CAPS: ProviderCapability[] = [
  'quotes', 'batch_quotes', 'historical',
];

export interface ProviderMetricsBlock {
  provider: string;
  requests: number;
  successes: number;
  failures: number;
  avg_latency_ms: number;
  auth_failures?: number;
  rate_limit_events?: number;
  fallback_count?: number;
  last_success_at: string | null;
  last_error_code: string | null;
}

export interface SoftProviderPlaceholder {
  status: 'placeholder';
  capabilities: ProviderCapability[];
  metrics: ProviderMetricsBlock;
}

export interface CompositeProviderHealth {
  current_provider: string;
  fallback_provider: string | null;
  indianapi: {
    enabled: boolean;
    credentialsConfigured: boolean;
    capabilities: ProviderCapability[];
    monthly_quota: null;
    metrics: ProviderMetricsBlock;
  };
  yahoo: SoftProviderPlaceholder;
  nse: SoftProviderPlaceholder;
  report: ReturnType<typeof getProviderReport>;
  monitor_providers: ReturnType<typeof getMonitorSnapshot>['providers'];
}

function monitorMetrics(provider: string): ProviderMetricsBlock {
  const snap = getMonitorSnapshot();
  const p = snap.providers.find((x) => x.provider === provider);
  const report = getProviderReport();
  const callKey = `${provider}_calls` as keyof typeof report;
  const reportCalls = typeof report[callKey] === 'number' ? (report[callKey] as number) : 0;
  return {
    provider,
    requests: p?.calls ?? reportCalls,
    successes: Math.max(0, (p?.calls ?? 0) - (p?.errors ?? 0)),
    failures: p?.errors ?? 0,
    avg_latency_ms: p?.avgLatencyMs ?? 0,
    fallback_count: report.fallback_triggered ? 1 : 0,
    last_success_at: p?.lastCallAt ?? report.last_updated_at,
    last_error_code: p?.lastErrorCode ?? report.last_error,
  };
}

export function getCompositeProviderHealth(): CompositeProviderHealth {
  const current = getMarketDataProvider();

  return {
    current_provider: current,
    fallback_provider: getPrimaryFallbackProvider(current),
    indianapi: {
      enabled: isIndianApiEnabled(),
      credentialsConfigured: indianApiCredentialsPresent(),
      capabilities: INDIANAPI_CAPS,
      monthly_quota: null,
      metrics: monitorMetrics('indianapi'),
    },
    yahoo: {
      status: 'placeholder',
      capabilities: YAHOO_CAPS,
      metrics: monitorMetrics('yahoo'),
    },
    nse: {
      status: 'placeholder',
      capabilities: NSE_CAPS,
      metrics: monitorMetrics('nse'),
    },
    report: getProviderReport(),
    monitor_providers: getMonitorSnapshot().providers,
  };
}
