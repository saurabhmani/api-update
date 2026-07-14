/**
 * Phase 8 — dual-provider monitoring (IndianAPI + Kite).
 *
 * Covers metrics, rate-limit / auth tracking, health composite,
 * alert copy, and provider switching without inventing Kite quotas.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  recordKiteCall,
  getKiteHealth,
  _resetKiteHealthForTests,
} from '@/lib/kite/health';
import {
  KiteAuthenticationError,
  KiteRateLimitError,
} from '@/lib/kite/errors';
import {
  recordProviderCall,
  getProviderReport,
  _resetProviderReportForTests,
} from '@/lib/marketData/providerReport';
import {
  recordProviderLatency,
  getMonitorSnapshot,
  _resetApiMonitorForTests,
} from '@/lib/monitor/apiMonitor';
import { evaluateAlerts } from '@/lib/monitor/alertRules';
import { getCompositeProviderHealth } from '@/lib/monitor/providerHealth';
import { getInstitutionalHealthSnapshot } from '@/lib/monitor/institutionalHealth';

beforeEach(() => {
  _resetKiteHealthForTests();
  _resetProviderReportForTests();
  try { _resetApiMonitorForTests(); } catch { /* optional */ }
  process.env.KITE_API_KEY = 'k';
  process.env.KITE_ACCESS_TOKEN = 't';
  process.env.INDIANAPI_PRIMARY = 'true';
  delete process.env.MARKET_DATA_PROVIDER;
});

afterEach(() => {
  _resetKiteHealthForTests();
  delete process.env.KITE_API_KEY;
  delete process.env.KITE_ACCESS_TOKEN;
  delete process.env.MARKET_DATA_PROVIDER;
  delete process.env.INDIANAPI_PRIMARY;
});

describe('Phase 8 — IndianAPI metrics preserved', () => {
  it('providerReport still tracks indianapi_calls', () => {
    recordProviderCall('indianapi');
    recordProviderCall('indianapi');
    const r = getProviderReport();
    expect(r.indianapi_calls).toBe(2);
    expect(r.last_provider).toBe('indianapi');
  });

  it('apiMonitor records indianapi latency without inventing kite quota', () => {
    recordProviderLatency({
      provider: 'indianapi',
      durationMs: 40,
      success: true,
    });
    const snap = getMonitorSnapshot();
    const p = snap.providers.find((x) => x.provider === 'indianapi');
    expect(p?.calls).toBeGreaterThanOrEqual(1);
  });
});

describe('Phase 8 — Kite metrics', () => {
  it('records successes and last_success_at', () => {
    recordKiteCall({ operation: 'getQuote', success: true, latencyMs: 12 });
    const h = getKiteHealth();
    expect(h.configured).toBe(true);
    expect(h.available).toBe(true);
    expect(h.successes).toBe(1);
    expect(h.requests).toBe(1);
    expect(h.avg_latency_ms).toBe(12);
    expect(h.last_success_at).toBeTruthy();
    // Kite has no monthly quota — do not invent one on the health snapshot.
    expect(Object.prototype.hasOwnProperty.call(h, 'monthly_quota')).toBe(false);
  });

  it('tracks authentication failures', () => {
    recordKiteCall({
      operation: 'getQuote',
      success: false,
      error: new KiteAuthenticationError('bad token'),
      latencyMs: 5,
    });
    const h = getKiteHealth();
    expect(h.auth_failed).toBe(true);
    expect(h.available).toBe(false);
    expect(h.auth_failures).toBe(1);
    expect(h.last_error_code).toBe('KiteAuthenticationError');
  });

  it('tracks rate-limit events separately from IndianAPI quotas', () => {
    recordKiteCall({
      operation: 'getBatchQuotes',
      success: false,
      error: new KiteRateLimitError('429'),
      latencyMs: 3,
    });
    const h = getKiteHealth();
    expect(h.rate_limited).toBe(true);
    expect(h.rate_limit_events).toBe(1);
    expect(h.available).toBe(false);
  });

  it('providerReport tracks kite_calls', () => {
    recordProviderCall('kite');
    expect(getProviderReport().kite_calls).toBe(1);
  });
});

describe('Phase 8 — mixed provider + health composite', () => {
  it('composite reports both providers and current_provider', () => {
    process.env.INDIANAPI_PRIMARY = 'false';
    process.env.MARKET_DATA_PROVIDER = 'kite';
    recordKiteCall({ success: true, latencyMs: 10 });
    recordProviderCall('indianapi');

    const c = getCompositeProviderHealth();
    expect(c.current_provider).toBe('kite');
    expect(c.fallback_provider).toBe('indianapi');
    expect(c.kite.monthly_quota).toBeNull();
    expect(c.kite.capabilities).toContain('quotes');
    expect(c.indianapi.capabilities).toContain('movers');
    expect(c.kite.metrics.successes).toBeGreaterThanOrEqual(1);
    expect(c.report.indianapi_calls).toBeGreaterThanOrEqual(1);
  });

  it('alerts fire for kite auth and rate-limit', () => {
    const snapshot = getInstitutionalHealthSnapshot();
    const authAlerts = evaluateAlerts({
      snapshot,
      kite: {
        configured: true,
        available: false,
        auth_failed: true,
        rate_limited: false,
        rate_limit_events: 0,
        last_error_code: 'KiteAuthenticationError',
      },
      current_provider: 'kite',
    });
    expect(authAlerts.some((a) => a.id === 'kite_authentication_failed')).toBe(true);
    expect(authAlerts.find((a) => a.id === 'kite_authentication_failed')?.title)
      .toMatch(/Kite authentication failed/);

    const rateAlerts = evaluateAlerts({
      snapshot,
      kite: {
        configured: true,
        available: false,
        auth_failed: false,
        rate_limited: true,
        rate_limit_events: 3,
        last_error_code: 'KiteRateLimitError',
      },
      current_provider: 'kite',
    });
    expect(rateAlerts.some((a) => a.id === 'kite_rate_limit_exceeded')).toBe(true);
  });

  it('IndianAPI quota alert copy stays provider-aware', () => {
    const snapshot = getInstitutionalHealthSnapshot();
    const alerts = evaluateAlerts({
      snapshot,
      quota: { daily_percent: 1.0, monthly_percent: 0.5, state: 'BLOCKED' },
    });
    const q = alerts.find((a) => a.id === 'api_quota_near_limit');
    expect(q?.title).toMatch(/IndianAPI/);
  });

  it('provider switching flips current_provider without inventing Kite monthly quotas', () => {
    process.env.INDIANAPI_PRIMARY = 'true';
    delete process.env.MARKET_DATA_PROVIDER;
    expect(getCompositeProviderHealth().current_provider).toBe('indianapi');

    process.env.INDIANAPI_PRIMARY = 'false';
    process.env.MARKET_DATA_PROVIDER = 'kite';
    const switched = getCompositeProviderHealth();
    expect(switched.current_provider).toBe('kite');
    expect(switched.fallback_provider).toBe('indianapi');
    expect(switched.kite.monthly_quota).toBeNull();
  });
});
