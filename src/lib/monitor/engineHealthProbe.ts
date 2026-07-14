import { db } from '@/lib/db';
import { classifyCandleFreshness } from '@/lib/marketData/candleFreshness';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { getInstitutionalHealthSnapshot } from '@/lib/monitor/institutionalHealth';
import { indianApiBreakerState } from '@/providers/adapters/IndianAPIAdapter';
import { isExpectedDailySessionGap } from '@/lib/signals/engineHealthMap';
import type { EngineHealthStatus } from '@/types/dashboard';
import { getMarketDataProvider } from '@/lib/marketData/providerFlags';
import { getKiteHealth } from '@/lib/kite/health';

export interface EngineHealthProbeResult {
  status:      EngineHealthStatus;
  marketOpen:  boolean;
  message:     string | null;
}

function safeProbe<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch { return fallback; }
}

async function isCandleFeedFrozen(marketOpen: boolean): Promise<boolean> {
  let latestMs: number | null = null;
  try {
    const r = await db.query(
      `SELECT UNIX_TIMESTAMP(MAX(ts)) AS ts FROM market_data_daily`,
    );
    const ts = (r.rows[0] as { ts?: number | string | null })?.ts;
    if (ts != null) {
      const n = Number(ts);
      if (Number.isFinite(n)) latestMs = n * 1000;
    }
  } catch {
    return false;
  }
  const report = classifyCandleFreshness({
    latest_candle_ms: latestMs,
    market_open:      marketOpen,
    candle_source:    'daily',
  });
  const ageMin = report.candle_age_seconds != null
    ? Math.round(report.candle_age_seconds / 60)
    : null;
  const expectedGap = isExpectedDailySessionGap({
    freshnessMode:    report.freshness_mode,
    staleMinutes:     ageMin,
    feedFrozen:       report.feed_frozen,
    freshnessQuality: report.freshness_quality,
    feedStaleHigh:    report.feed_frozen,
  });
  return report.feed_frozen && !expectedGap;
}

/**
 * Lightweight engine-health probe for public monitors and load balancers.
 * Mirrors the institutional pipeline checks without session-gated upstreams.
 */
export async function probeEngineHealthStatus(): Promise<EngineHealthProbeResult> {
  const market = getMarketStatus();
  const snapshot = getInstitutionalHealthSnapshot();
  const breaker = safeProbe(() => indianApiBreakerState(), null);
  const kite = safeProbe(() => getKiteHealth(), null);
  const current = safeProbe(() => getMarketDataProvider(), 'indianapi');

  const [candleFrozen] = await Promise.all([
    isCandleFeedFrozen(market.isOpen),
  ]);

  const fallbackHealthy = snapshot.providers.some((p) => p.fallback_success > 0)
    || snapshot.providers.every((p) => !p.fallback_triggered);
  const breakerOpen = breaker?.open === true;
  const kitePrimaryBroken =
    current === 'kite'
    && kite?.configured === true
    && kite.available === false
    && !fallbackHealthy;
  const lastScanOk =
    snapshot.full_scan.completes > 0
    && snapshot.full_scan.last_completed_at != null;
  const totalApproved = snapshot.elite.approved_total + snapshot.elite.rejected_total;
  const approvedRatioBad =
    totalApproved >= 100 && (snapshot.approved_ratio ?? 0) < 0.001;

  if (candleFrozen) {
    return {
      status:     'DEGRADED',
      marketOpen: market.isOpen,
      message:    'Candle feed frozen',
    };
  }
  if (breakerOpen && !fallbackHealthy) {
    return {
      status:     'DEGRADED',
      marketOpen: market.isOpen,
      message:    'IndianAPI unavailable — circuit breaker open',
    };
  }
  if (kitePrimaryBroken) {
    return {
      status:     'DEGRADED',
      marketOpen: market.isOpen,
      message: kite?.auth_failed
        ? 'Kite authentication failed'
        : kite?.rate_limited
          ? 'Kite rate limit exceeded'
          : 'Kite unavailable',
    };
  }
  if (approvedRatioBad) {
    return {
      status:     'DEGRADED',
      marketOpen: market.isOpen,
      message:    'Signal approval ratio critically low',
    };
  }
  if (!lastScanOk && snapshot.full_scan.starts > 0) {
    return {
      status:     'WARNING',
      marketOpen: market.isOpen,
      message:    'Last full scan did not complete successfully',
    };
  }

  return {
    status:     'HEALTHY',
    marketOpen: market.isOpen,
    message:    null,
  };
}
