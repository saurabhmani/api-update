// ════════════════════════════════════════════════════════════════
//  Institutional health counters + candle freshness gate
//
//  Spec INSTITUTIONAL-HEALTH-2026-05 + CANDLE-FRESHNESS-2026-05.
// ════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';

import {
  recordInvalidPayload,
  recordFallbackTriggered,
  recordFallbackSuccess,
  recordFallbackFailed,
  recordEliteGateRun,
  recordFullScanStart,
  recordFullScanComplete,
  recordHeartbeatTick,
  getInstitutionalHealthSnapshot,
  resetInstitutionalHealth,
} from '@/lib/monitor/institutionalHealth';

import {
  classifyCandleFreshness,
} from '@/lib/marketData/candleFreshness';

describe('institutionalHealth counters', () => {
  beforeEach(() => {
    resetInstitutionalHealth();
  });

  it('records invalid payload + rejected_symbol per provider', () => {
    recordInvalidPayload('IndianAPI', 'PRICE_NON_POSITIVE');
    recordInvalidPayload('IndianAPI', 'VOLUME_ZERO_DURING_MARKET_HOURS');
    recordInvalidPayload('NseDirect', 'PRICE_NON_POSITIVE');
    const s = getInstitutionalHealthSnapshot();
    const indian = s.providers.find((p) => p.name === 'IndianAPI');
    const nse    = s.providers.find((p) => p.name === 'NseDirect');
    expect(indian?.invalid_payload).toBe(2);
    expect(indian?.rejected_symbol).toBe(2);
    expect(indian?.last_invalid_reason).toBe('VOLUME_ZERO_DURING_MARKET_HOURS');
    expect(nse?.invalid_payload).toBe(1);
  });

  it('tracks fallback chain transitions', () => {
    recordFallbackTriggered('indianapi');
    recordFallbackSuccess('nse_direct');
    recordFallbackTriggered('indianapi');
    recordFallbackFailed('nse_direct', 'NSE_NO_DATA');
    const s = getInstitutionalHealthSnapshot();
    const indian = s.providers.find((p) => p.name === 'indianapi');
    const nse    = s.providers.find((p) => p.name === 'nse_direct');
    expect(indian?.fallback_triggered).toBe(2);
    expect(nse?.fallback_success).toBe(1);
    expect(nse?.fallback_failed).toBe(1);
  });

  it('elite-gate counters accumulate + expose approved_ratio', () => {
    recordEliteGateRun({ approved: 5, rejected: 95, stale_blocked: 10, decay_applied: 30, market_open: true });
    recordEliteGateRun({ approved: 3, rejected: 197 });
    const s = getInstitutionalHealthSnapshot();
    expect(s.elite.approved_total).toBe(8);
    expect(s.elite.rejected_total).toBe(292);
    expect(s.elite.stale_blocked_total).toBe(10);
    expect(s.elite.decay_applied_total).toBe(30);
    expect(s.elite.last_approved).toBe(3);
    expect(s.approved_ratio).toBeCloseTo(8 / 300, 3);
  });

  it('full-scan counters track starts/completes/failures', () => {
    recordFullScanStart({ universe_size: 503 });
    recordFullScanComplete({ ok: true, scanned: 500, approved: 5, rejected: 495, elapsed_ms: 12_000, provider_coverage_pct: 99.4 });
    recordFullScanStart({ universe_size: 503 });
    recordFullScanComplete({ ok: false });
    const s = getInstitutionalHealthSnapshot();
    expect(s.full_scan.starts).toBe(2);
    expect(s.full_scan.completes).toBe(1);
    expect(s.full_scan.failures).toBe(1);
    expect(s.full_scan.last_universe).toBe(503);
  });

  it('heartbeat counter records cache stats', () => {
    recordHeartbeatTick({ universe: 20, cache_hits: 18, cache_misses: 2 });
    const s = getInstitutionalHealthSnapshot();
    expect(s.heartbeat.ticks).toBe(1);
    expect(s.heartbeat.last_universe).toBe(20);
    expect(s.heartbeat.last_cache_hits).toBe(18);
  });

  it('approved_ratio is null until first run', () => {
    const s = getInstitutionalHealthSnapshot();
    expect(s.approved_ratio).toBeNull();
  });
});

describe('classifyCandleFreshness', () => {
  const now = 1_700_000_000_000;

  it('returns unknown when no candle ts', () => {
    const r = classifyCandleFreshness({ latest_candle_ms: null, market_open: true, now_ms: now });
    expect(r.freshness_quality).toBe('unknown');
    expect(r.feed_frozen).toBe(false);
  });

  it('market open: candle 2 min old → fresh', () => {
    const r = classifyCandleFreshness({
      latest_candle_ms: now - 2 * 60_000, market_open: true, now_ms: now,
    });
    expect(r.freshness_quality).toBe('fresh');
  });

  it('market open: candle 20 min old → aging', () => {
    const r = classifyCandleFreshness({
      latest_candle_ms: now - 20 * 60_000, market_open: true, now_ms: now,
    });
    expect(r.freshness_quality).toBe('aging');
  });

  it('market open: candle 2h old → stale', () => {
    const r = classifyCandleFreshness({
      latest_candle_ms: now - 2 * 3_600_000, market_open: true, now_ms: now,
    });
    expect(r.freshness_quality).toBe('stale');
  });

  it('market open: candle 5h old → frozen', () => {
    const r = classifyCandleFreshness({
      latest_candle_ms: now - 5 * 3_600_000, market_open: true, now_ms: now,
    });
    expect(r.freshness_quality).toBe('frozen');
    expect(r.feed_frozen).toBe(true);
  });

  it('market closed: candle 12h old → fresh (off-hours bands)', () => {
    const r = classifyCandleFreshness({
      latest_candle_ms: now - 12 * 3_600_000, market_open: false, now_ms: now,
    });
    expect(r.freshness_quality).toBe('aging');
  });

  it('market closed: candle 4 days old → frozen', () => {
    const r = classifyCandleFreshness({
      latest_candle_ms: now - 96 * 3_600_000, market_open: false, now_ms: now,
    });
    expect(r.freshness_quality).toBe('frozen');
    expect(r.feed_frozen).toBe(true);
  });

  it('candle_age_seconds is computed', () => {
    const r = classifyCandleFreshness({
      latest_candle_ms: now - 90, market_open: true, now_ms: now,
    });
    expect(r.candle_age_seconds).toBe(0); // <1s rounds to 0
    const r2 = classifyCandleFreshness({
      latest_candle_ms: now - 12_500, market_open: true, now_ms: now,
    });
    expect(r2.candle_age_seconds).toBe(13);
  });
});
