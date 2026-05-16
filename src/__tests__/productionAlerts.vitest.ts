// ════════════════════════════════════════════════════════════════
//  Production alert rules + Prometheus rendering
//
//  Spec PRODUCTION-ALERTS-2026-05 + PROMETHEUS-2026-05.
// ════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';

import {
  evaluateAlerts,
  summariseAlerts,
  type AlertEvaluationInput,
} from '@/lib/monitor/alertRules';
import {
  resetInstitutionalHealth,
  recordEliteGateRun,
  recordFullScanStart,
  recordFullScanComplete,
  recordFallbackTriggered,
  recordFallbackSuccess,
  recordInvalidPayload,
  getInstitutionalHealthSnapshot,
} from '@/lib/monitor/institutionalHealth';
import { renderPrometheusMetrics } from '@/lib/monitor/prometheus';

function inputBase(): AlertEvaluationInput {
  return {
    snapshot: getInstitutionalHealthSnapshot(),
    candle: {
      candle_age_seconds: 60,
      freshness_quality:  'fresh',
      feed_frozen:        false,
      market_open:        true,
    },
    breaker: { open: false, state: 'closed', auth_failed: false },
  };
}

describe('alertRules', () => {
  beforeEach(() => {
    resetInstitutionalHealth();
  });

  it('healthy state returns no alerts', () => {
    // Drive a successful scan + healthy elite-gate sample so the
    // "no full scan" rule doesn't fire on uptime alone.
    recordFullScanStart({ universe_size: 503 });
    recordFullScanComplete({ ok: true, scanned: 500, approved: 5, rejected: 495, elapsed_ms: 12_000, provider_coverage_pct: 99.4 });
    recordEliteGateRun({ approved: 5, rejected: 95, market_open: true });
    const alerts = evaluateAlerts(inputBase());
    expect(alerts).toEqual([]);
  });

  it('triggers feed_frozen as critical', () => {
    const i = inputBase();
    i.candle = { ...i.candle!, feed_frozen: true, freshness_quality: 'frozen', candle_age_seconds: 18_000 };
    const alerts = evaluateAlerts(i);
    expect(alerts.find((a) => a.id === 'feed_frozen')?.severity).toBe('critical');
  });

  it('breaker_open is critical when no fallback success', () => {
    const i = inputBase();
    i.breaker = { open: true, state: 'open', auth_failed: false };
    const alerts = evaluateAlerts(i);
    const breaker = alerts.find((a) => a.id === 'breaker_open');
    expect(breaker?.severity).toBe('critical');
  });

  it('breaker_open demoted to warning when fallback healthy', () => {
    recordFallbackTriggered('indianapi');
    recordFallbackSuccess('nse_direct');
    const i = inputBase();
    i.snapshot = getInstitutionalHealthSnapshot();
    i.breaker = { open: true, state: 'half_open', auth_failed: false };
    const alerts = evaluateAlerts(i);
    expect(alerts.find((a) => a.id === 'breaker_open')?.severity).toBe('warning');
  });

  it('invalid_payload_spike triggers above floor', () => {
    // Hammer the validator counter past the default floor of 50.
    for (let i = 0; i < 60; i++) recordInvalidPayload('IndianAPI', 'PRICE_NON_POSITIVE');
    const i = inputBase();
    i.snapshot = getInstitutionalHealthSnapshot();
    expect(evaluateAlerts(i).find((a) => a.id === 'invalid_payload_spike')?.severity).toBe('warning');
  });

  it('invalid_payload_spike escalates to critical at 5x floor', () => {
    for (let i = 0; i < 260; i++) recordInvalidPayload('IndianAPI', 'PRICE_NON_POSITIVE');
    const i = inputBase();
    i.snapshot = getInstitutionalHealthSnapshot();
    expect(evaluateAlerts(i).find((a) => a.id === 'invalid_payload_spike')?.severity).toBe('critical');
  });

  it('no_full_scan triggers warning when no scan has run', () => {
    // Force the snapshot to look like uptime exceeds the warning floor.
    const i = inputBase();
    i.snapshot = { ...getInstitutionalHealthSnapshot(), uptime_s: 35 * 60 };
    expect(evaluateAlerts(i).find((a) => a.id === 'no_full_scan')?.severity).toBe('warning');
  });

  it('no_full_scan triggers critical when last scan is old', () => {
    recordFullScanStart({ universe_size: 503 });
    recordFullScanComplete({ ok: true, scanned: 500, approved: 5, rejected: 495 });
    const snap = getInstitutionalHealthSnapshot();
    // Backdate the completion to 100 min ago.
    const old = new Date(Date.now() - 100 * 60_000).toISOString();
    snap.full_scan.last_completed_at = old;
    const i = inputBase();
    i.snapshot = snap;
    expect(evaluateAlerts(i).find((a) => a.id === 'no_full_scan')?.severity).toBe('critical');
  });

  it('scan_coverage_below_floor warns at <90%', () => {
    recordFullScanStart({ universe_size: 503 });
    recordFullScanComplete({ ok: true, scanned: 400, approved: 3, rejected: 397, provider_coverage_pct: 79.5 });
    const i = inputBase();
    i.snapshot = getInstitutionalHealthSnapshot();
    expect(evaluateAlerts(i).find((a) => a.id === 'scan_coverage_below_floor')?.severity).toBe('warning');
  });

  it('elite_zero_output_anomaly fires only past min sample size', () => {
    // Below sample size: no anomaly yet.
    recordEliteGateRun({ approved: 0, rejected: 50, market_open: true });
    let i = inputBase();
    i.snapshot = getInstitutionalHealthSnapshot();
    expect(evaluateAlerts(i).find((a) => a.id === 'elite_zero_output_anomaly')).toBeUndefined();

    // Past 100-row sample with 0 approvals → critical.
    recordEliteGateRun({ approved: 0, rejected: 60, market_open: true });
    i = inputBase();
    i.snapshot = getInstitutionalHealthSnapshot();
    expect(evaluateAlerts(i).find((a) => a.id === 'elite_zero_output_anomaly')?.severity).toBe('critical');
  });

  it('approval_ratio_collapse fires for last-run zero approval', () => {
    // First: a healthy run.
    recordFullScanStart({ universe_size: 503 });
    recordFullScanComplete({ ok: true, scanned: 500 });
    recordEliteGateRun({ approved: 5, rejected: 95, market_open: true });
    // Then: a 0-approved run with a 50+ sample.
    recordEliteGateRun({ approved: 0, rejected: 100, market_open: true });
    const i = inputBase();
    i.snapshot = getInstitutionalHealthSnapshot();
    expect(evaluateAlerts(i).find((a) => a.id === 'approval_ratio_collapse')?.severity).toBe('warning');
  });

  it('summariseAlerts rolls up severity counts', () => {
    const alerts = [
      { id: 'a', severity: 'critical' as const, title: 't', detail: 'd', context: {}, triggered_at: '' },
      { id: 'b', severity: 'warning'  as const, title: 't', detail: 'd', context: {}, triggered_at: '' },
      { id: 'c', severity: 'warning'  as const, title: 't', detail: 'd', context: {}, triggered_at: '' },
    ];
    const s = summariseAlerts(alerts);
    expect(s).toEqual({ critical: 1, warning: 2, info: 0, total: 3, worst_severity: 'critical' });
  });

  it('summariseAlerts returns null worst_severity for empty list', () => {
    expect(summariseAlerts([]).worst_severity).toBeNull();
  });
});

describe('renderPrometheusMetrics', () => {
  beforeEach(() => {
    resetInstitutionalHealth();
  });

  it('emits the namespace prefix on every metric', () => {
    recordEliteGateRun({ approved: 3, rejected: 97 });
    const body = renderPrometheusMetrics({
      snapshot: getInstitutionalHealthSnapshot(),
      instance: 'test-instance',
    });
    expect(body).toMatch(/^# HELP institutional_/m);
    expect(body).toMatch(/institutional_elite_approved_total\{instance="test-instance"\} 3/);
    expect(body).toMatch(/institutional_elite_rejected_total\{instance="test-instance"\} 97/);
  });

  it('emits HELP+TYPE preamble exactly once per metric', () => {
    recordInvalidPayload('IndianAPI', 'PRICE_NON_POSITIVE');
    recordInvalidPayload('NseDirect', 'NETWORK');
    const body = renderPrometheusMetrics({
      snapshot: getInstitutionalHealthSnapshot(),
      instance: 'test-instance',
    });
    const helpCount = (body.match(/^# HELP institutional_provider_invalid_payload_total/gm) ?? []).length;
    expect(helpCount).toBe(1);
    // BOTH providers appear as samples under the same metric.
    expect(body).toMatch(/provider="IndianAPI"/);
    expect(body).toMatch(/provider="NseDirect"/);
  });

  it('emits gauge for feed_frozen', () => {
    const body = renderPrometheusMetrics({
      snapshot: getInstitutionalHealthSnapshot(),
      candle: {
        candle_age_seconds: 18_000,
        freshness_quality:  'frozen',
        feed_frozen:        true,
        market_open:        true,
      },
      instance: 'test-instance',
    });
    expect(body).toMatch(/institutional_candle_feed_frozen\{instance="test-instance"\} 1/);
    expect(body).toMatch(/institutional_candle_age_seconds\{instance="test-instance"\} 18000/);
  });

  it('escapes label values', () => {
    // The freshness quality is a controlled enum, but the helper should
    // still escape arbitrary strings safely.
    const body = renderPrometheusMetrics({
      snapshot: getInstitutionalHealthSnapshot(),
      candle: {
        candle_age_seconds: 0,
        freshness_quality:  'has "quote" and \\backslash',
        feed_frozen:        false,
        market_open:        true,
      },
      instance: 'test-instance',
    });
    // Both " and \ must be escaped per Prometheus spec.
    expect(body).toMatch(/quality="has \\"quote\\" and \\\\backslash"/);
  });

  it('omits metrics with no samples (e.g. no providers seen yet)', () => {
    const body = renderPrometheusMetrics({
      snapshot: getInstitutionalHealthSnapshot(),
      instance: 'test-instance',
    });
    // No providers have been touched yet — the per-provider counters
    // must NOT emit a HELP+TYPE preamble for an empty samples list.
    expect(body).not.toMatch(/^# HELP institutional_provider_invalid_payload_total/m);
  });
});
