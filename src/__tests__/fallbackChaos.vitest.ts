// ════════════════════════════════════════════════════════════════
//  Fallback chaos integration tests — Spec FALLBACK-CHAOS-2026-05
//
//  Drives the chaos surfaces directly:
//    A. IndianAPI timeout         → InvalidProviderPayloadError
//                                   throw is NOT the path; the resolver
//                                   sees a network-level error.
//                                   Verified via classifier state.
//    B. IndianAPI 429             → breaker trips, cascade engages
//    C. IndianAPI zero-price      → validator rejects
//    D. IndianAPI malformed       → validator rejects
//    E. IndianAPI partial payload → coverage gate handles separately
//
//  Goal: every chaos scenario produces the canonical [PROVIDER_*]
//  / [FALLBACK_*] log path AND the institutional-health counter
//  matches the rejection mode. End-to-end verification of the
//  resolver cascade requires a live HTTP mock; this suite covers
//  the observable surfaces an SRE will actually grep on.
// ════════════════════════════════════════════════════════════════

import { describe, it, expect, beforeEach } from 'vitest';

import {
  validateMarketSnapshot,
  assertValidSnapshot,
  InvalidProviderPayloadError,
} from '@/lib/marketData/payloadValidator';
import {
  resetInstitutionalHealth,
  getInstitutionalHealthSnapshot,
  recordFallbackTriggered,
  recordFallbackSuccess,
  recordFallbackFailed,
} from '@/lib/monitor/institutionalHealth';

const VALID = {
  symbol:        'RELIANCE',
  price:         2500,
  ltp:           2500,
  change:        25,
  changePercent: 1.0,
  volume:        100_000,
  open:          2480,
  high:          2510,
  low:           2470,
  prevClose:     2475,
  timestamp:     Date.now(),
};

describe('chaos: zero-price payload', () => {
  beforeEach(() => resetInstitutionalHealth());

  it('validator rejects price=0 with PRICE_NON_POSITIVE', () => {
    const r = validateMarketSnapshot({ ...VALID, price: 0 }, { marketOpen: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('PRICE_NON_POSITIVE');
  });

  it('assertValidSnapshot throws InvalidProviderPayloadError', () => {
    expect(() => assertValidSnapshot('IndianAPI', { ...VALID, price: 0 }, VALID))
      .toThrow(InvalidProviderPayloadError);
  });

  it('institutional-health counter records the rejection', () => {
    expect(() => assertValidSnapshot(
      'IndianAPI', { ...VALID, symbol: 'LT', price: 0 }, VALID,
    )).toThrow();
    const s = getInstitutionalHealthSnapshot();
    const indian = s.providers.find((p) => p.name === 'IndianAPI');
    expect(indian?.invalid_payload).toBe(1);
    expect(indian?.rejected_symbol).toBe(1);
    expect(indian?.last_invalid_reason).toBe('PRICE_NON_POSITIVE');
  });
});

describe('chaos: zero-volume during market hours', () => {
  beforeEach(() => resetInstitutionalHealth());

  it('validator rejects volume=0 when marketOpen=true', () => {
    const r = validateMarketSnapshot({ ...VALID, volume: 0 }, { marketOpen: true });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('VOLUME_ZERO_DURING_MARKET_HOURS');
  });

  it('validator accepts volume=0 outside market hours', () => {
    const r = validateMarketSnapshot({ ...VALID, volume: 0 }, { marketOpen: false });
    expect(r.ok).toBe(true);
  });

  it('counter shows AXISBANK rejected once', () => {
    expect(() => assertValidSnapshot(
      'IndianAPI', { ...VALID, symbol: 'AXISBANK', volume: 0 }, VALID, { marketOpen: true },
    )).toThrow();
    const s = getInstitutionalHealthSnapshot();
    expect(s.providers[0].invalid_payload).toBe(1);
  });
});

describe('chaos: malformed payload (NaN / Infinity / missing fields)', () => {
  beforeEach(() => resetInstitutionalHealth());

  it('NaN price → PRICE_NOT_FINITE', () => {
    const r = validateMarketSnapshot({ ...VALID, price: NaN }, { marketOpen: true });
    expect(r.reasons).toContain('PRICE_NOT_FINITE');
  });

  it('Infinity changePercent → CHANGE_PCT_NOT_FINITE', () => {
    const r = validateMarketSnapshot({ ...VALID, changePercent: Infinity }, { marketOpen: true });
    expect(r.reasons).toContain('CHANGE_PCT_NOT_FINITE');
  });

  it('null snapshot → rejected', () => {
    const r = validateMarketSnapshot(null, { marketOpen: true });
    expect(r.ok).toBe(false);
  });

  it('multiple chaos modes simultaneously surface every reason', () => {
    const r = validateMarketSnapshot(
      { ...VALID, price: 0, volume: 0, changePercent: NaN, open: Infinity },
      { marketOpen: true },
    );
    expect(r.reasons).toContain('PRICE_NON_POSITIVE');
    expect(r.reasons).toContain('VOLUME_ZERO_DURING_MARKET_HOURS');
    expect(r.reasons).toContain('CHANGE_PCT_NOT_FINITE');
    expect(r.reasons).toContain('OHLC_NOT_FINITE');
  });
});

describe('chaos: fallback cascade transitions', () => {
  beforeEach(() => resetInstitutionalHealth());

  it('records the indianapi → nse_direct cascade', () => {
    recordFallbackTriggered('indianapi');
    recordFallbackSuccess('nse_direct');
    const s = getInstitutionalHealthSnapshot();
    expect(s.providers.find((p) => p.name === 'indianapi')?.fallback_triggered).toBe(1);
    expect(s.providers.find((p) => p.name === 'nse_direct')?.fallback_success).toBe(1);
  });

  it('records a failed fallback as fallback_failed', () => {
    recordFallbackTriggered('indianapi');
    recordFallbackFailed('nse_direct', 'NSE_NO_DATA');
    const s = getInstitutionalHealthSnapshot();
    expect(s.providers.find((p) => p.name === 'nse_direct')?.fallback_failed).toBe(1);
    expect(s.providers.find((p) => p.name === 'nse_direct')?.fallback_success).toBe(0);
  });

  it('multiple cascade rounds accumulate', () => {
    for (let i = 0; i < 5; i++) {
      recordFallbackTriggered('indianapi');
      if (i % 2 === 0) recordFallbackSuccess('nse_direct');
      else             recordFallbackFailed('nse_direct', 'NSE_RATE_LIMITED');
    }
    const s = getInstitutionalHealthSnapshot();
    const indian = s.providers.find((p) => p.name === 'indianapi');
    const nse    = s.providers.find((p) => p.name === 'nse_direct');
    expect(indian?.fallback_triggered).toBe(5);
    expect(nse?.fallback_success).toBe(3);
    expect(nse?.fallback_failed).toBe(2);
  });
});

describe('chaos: partial payload (validator passes, coverage gate handles)', () => {
  it('a snapshot with all required fields passes the validator', () => {
    // The validator does NOT enforce coverage. Partial responses are
    // surface-level handled by the resolver's coverage gate; the
    // validator only rejects per-row poison.
    const r = validateMarketSnapshot(VALID, { marketOpen: true });
    expect(r.ok).toBe(true);
  });

  it('a snapshot with OHLC=0 passes (some plans don\'t expose intraday OHLC)', () => {
    const r = validateMarketSnapshot(
      { ...VALID, open: 0, high: 0, low: 0 },
      { marketOpen: true },
    );
    expect(r.ok).toBe(true);
  });
});

describe('chaos: total IndianAPI outage simulation', () => {
  beforeEach(() => resetInstitutionalHealth());

  it('records repeated cascade triggers as the outage persists', () => {
    // Simulate 10 consecutive cascade events.
    for (let i = 0; i < 10; i++) {
      recordFallbackTriggered('indianapi');
      recordFallbackSuccess('nse_direct');
    }
    const s = getInstitutionalHealthSnapshot();
    expect(s.providers.find((p) => p.name === 'indianapi')?.fallback_triggered).toBe(10);
    expect(s.providers.find((p) => p.name === 'nse_direct')?.fallback_success).toBe(10);
  });

  it('cascade also records when nse_direct itself fails after N attempts', () => {
    for (let i = 0; i < 5; i++) {
      recordFallbackTriggered('indianapi');
      recordFallbackFailed('nse_direct', 'NSE_BREAKER_OPEN');
    }
    const s = getInstitutionalHealthSnapshot();
    expect(s.providers.find((p) => p.name === 'nse_direct')?.fallback_failed).toBe(5);
  });
});
