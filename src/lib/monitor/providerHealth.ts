// ════════════════════════════════════════════════════════════════
//  providerHealth — composite dual-provider ops snapshot (Phase 8)
//
//  Aggregates IndianAPI (quota / breaker / usage) + Kite (auth /
//  rate-limit / availability) for health & usage routes without
//  changing provider selection behaviour.
// ════════════════════════════════════════════════════════════════

import { getMarketDataProvider } from '@/lib/marketData/providerFlags';
import { getApiUsage } from '@/providers/adapters/indianApiUsageTracker';
import {
  indianApiBreakerState,
  indianApiQueueGauge,
} from '@/providers/adapters/IndianAPIAdapter';
import type { QuotaReport } from '@/lib/monitor/apiQuota';
import { getKiteHealth, type KiteHealthSnapshot } from '@/lib/kite/health';
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
  'quotes', 'batch_quotes', 'historical', 'movers', 'trending',
  'news', 'corporate', 'search',
];

const KITE_CAPS: ProviderCapability[] = [
  'quotes', 'batch_quotes', 'historical', 'search',
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

export interface CompositeProviderHealth {
  current_provider: string;
  fallback_provider: string | null;
  indianapi: {
    usage: ReturnType<typeof getApiUsage>;
    quota: QuotaReport | null;
    breaker: ReturnType<typeof indianApiBreakerState> | null;
    queue: ReturnType<typeof indianApiQueueGauge> | null;
    capabilities: ProviderCapability[];
    metrics: ProviderMetricsBlock;
  };
  kite: KiteHealthSnapshot & {
    capabilities: ProviderCapability[];
    /** Explicit: Kite has no monthly plan quota in this app. */
    monthly_quota: null;
    metrics: ProviderMetricsBlock;
  };
  report: ReturnType<typeof getProviderReport>;
  monitor_providers: ReturnType<typeof getMonitorSnapshot>['providers'];
}

function safeProbe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

function indianMetrics(): ProviderMetricsBlock {
  const snap = getMonitorSnapshot();
  const p = snap.providers.find((x) => x.provider === 'indianapi');
  const report = getProviderReport();
  return {
    provider: 'indianapi',
    requests: p?.calls ?? report.indianapi_calls,
    successes: Math.max(0, (p?.calls ?? 0) - (p?.errors ?? 0)),
    failures: p?.errors ?? 0,
    avg_latency_ms: p?.avgLatencyMs ?? 0,
    fallback_count: report.fallback_triggered ? 1 : 0,
    last_success_at: p?.lastCallAt ?? report.last_updated_at,
    last_error_code: p?.lastErrorCode ?? report.last_error,
  };
}

function kiteMetrics(k: KiteHealthSnapshot): ProviderMetricsBlock {
  return {
    provider: 'kite',
    requests: k.requests,
    successes: k.successes,
    failures: k.failures,
    avg_latency_ms: k.avg_latency_ms,
    auth_failures: k.auth_failures,
    rate_limit_events: k.rate_limit_events,
    last_success_at: k.last_success_at,
    last_error_code: k.last_error_code,
  };
}

/**
 * Read-only composite used by health/usage/debug routes.
 * Never throws; individual probes soft-fail.
 */
export function getCompositeProviderHealth(): CompositeProviderHealth {
  const current = getMarketDataProvider();
  const kite = getKiteHealth();
  const fallback =
    current === 'kite' ? 'indianapi'
      : current === 'indianapi' ? (kite.configured ? 'kite|cache|nse|yahoo' : 'cache|nse|yahoo')
        : null;

  const usage = safeProbe(() => getApiUsage(), null);

  return {
    current_provider: current,
    fallback_provider: fallback,
    indianapi: {
      usage: usage ?? ({
        date: '',
        month: '',
        daily: 0,
        monthly: 0,
        daily_limit: 0,
        monthly_limit: 0,
        daily_remaining: 0,
        monthly_remaining: 0,
        daily_percent: 0,
        monthly_percent: 0,
        daily_exceeded: false,
        monthly_exceeded: false,
        last_call_at: null,
        per_run_active: false,
        per_run_count: 0,
        per_run_limit: 0,
        per_run_remaining: 0,
        per_run_exceeded: false,
      } satisfies ReturnType<typeof getApiUsage>),
      quota: null,
      breaker: safeProbe(() => indianApiBreakerState(), null),
      queue: safeProbe(() => indianApiQueueGauge(), null),
      capabilities: INDIANAPI_CAPS,
      metrics: indianMetrics(),
    },
    kite: {
      ...kite,
      capabilities: KITE_CAPS,
      monthly_quota: null,
      metrics: kiteMetrics(kite),
    },
    report: getProviderReport(),
    monitor_providers: getMonitorSnapshot().providers,
  };
}
