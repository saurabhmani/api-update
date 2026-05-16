// ════════════════════════════════════════════════════════════════
//  eliteApproved + applyEliteGate — institutional-grade strict gate
//
//  Spec ELITE-2026-05: only rows passing every floor + every
//  categorical predicate may ship in the main signals[] array.
//  Confirms behaviour for the canonical pass/fail axes.
// ════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  eliteApproved,
  applyEliteGate,
  extractFactorScores,
  ELITE_CONFIDENCE_FLOOR,
  ELITE_FINAL_FLOOR,
  ELITE_RR_FLOOR,
  ELITE_STRESS_FLOOR,
  ELITE_PORTFOLIO_FIT_FLOOR,
  ELITE_LIQUIDITY_FLOOR,
  ELITE_MARKET_REGIME_FLOOR,
  ELITE_DATA_QUALITY_FLOOR,
} from '@/lib/signals/confirmedSignalPolicy';

// A row that passes every elite floor + every categorical predicate.
// Tests mutate fields off this baseline to exercise individual gates.
const baseEliteRow = {
  symbol:                 'RELIANCE',
  direction:              'BUY' as const,
  classification:         'INSTITUTIONAL_HIGH_CONVICTION',
  signal_status:          'APPROVED_SIGNAL',
  status:                 'ACTIVE',
  execution_allowed:      true,
  invalidation_reason:    null,
  live_invalidated:       false,
  live_valid:             true,
  live_validation_state:  'VALID',
  freshness_state:        'fresh',
  decay_state:            'fresh',
  conviction_band:        'high',
  confidence_score:       80,
  final_score:            85,
  rr_ratio:               2.5,
  stress_survival_score:  80,
  portfolio_fit_score:    75,
  liquidity_score:        70,
  market_regime_score:    70,
  data_quality_score:     85,
  stability_passed:       true,
};

describe('eliteApproved', () => {
  it('approves a clean institutional-grade row', () => {
    expect(eliteApproved(baseEliteRow)).toBe(true);
  });

  it('rejects below confidence floor', () => {
    expect(eliteApproved({ ...baseEliteRow, confidence_score: ELITE_CONFIDENCE_FLOOR - 1 })).toBe(false);
  });

  it('rejects below institutional (final) floor', () => {
    expect(eliteApproved({ ...baseEliteRow, final_score: ELITE_FINAL_FLOOR - 1 })).toBe(false);
  });

  it('rejects below risk_reward floor', () => {
    expect(eliteApproved({ ...baseEliteRow, rr_ratio: ELITE_RR_FLOOR - 0.1 })).toBe(false);
  });

  it('rejects below stress survival floor', () => {
    expect(eliteApproved({ ...baseEliteRow, stress_survival_score: ELITE_STRESS_FLOOR - 1 })).toBe(false);
  });

  it('rejects below portfolio_fit floor', () => {
    expect(eliteApproved({ ...baseEliteRow, portfolio_fit_score: ELITE_PORTFOLIO_FIT_FLOOR - 1 })).toBe(false);
  });

  it('rejects below liquidity floor', () => {
    expect(eliteApproved({ ...baseEliteRow, liquidity_score: ELITE_LIQUIDITY_FLOOR - 1 })).toBe(false);
  });

  it('rejects below market_regime floor', () => {
    expect(eliteApproved({ ...baseEliteRow, market_regime_score: ELITE_MARKET_REGIME_FLOOR - 1 })).toBe(false);
  });

  it('rejects below data_quality floor', () => {
    expect(eliteApproved({ ...baseEliteRow, data_quality_score: ELITE_DATA_QUALITY_FLOOR - 1 })).toBe(false);
  });

  it('rejects MEDIUM_CONVICTION classification', () => {
    expect(eliteApproved({ ...baseEliteRow, classification: 'MEDIUM_CONVICTION' })).toBe(false);
  });

  it('rejects VALID_SIGNAL classification (above strict, below elite)', () => {
    expect(eliteApproved({ ...baseEliteRow, classification: 'VALID_SIGNAL' })).toBe(false);
  });

  it('approves HIGH_CONVICTION classification', () => {
    expect(eliteApproved({ ...baseEliteRow, classification: 'HIGH_CONVICTION' })).toBe(true);
  });

  it('rejects when execution_allowed=false', () => {
    expect(eliteApproved({ ...baseEliteRow, execution_allowed: false })).toBe(false);
  });

  it('rejects when live_validation_state != VALID', () => {
    expect(eliteApproved({ ...baseEliteRow, live_validation_state: 'INVALID', live_valid: false })).toBe(false);
  });

  it('rejects when freshness_state=stale', () => {
    expect(eliteApproved({ ...baseEliteRow, freshness_state: 'stale' })).toBe(false);
  });

  it('rejects when decay_state=stale', () => {
    expect(eliteApproved({ ...baseEliteRow, decay_state: 'stale' })).toBe(false);
  });

  it('rejects when decay_state=expired', () => {
    expect(eliteApproved({ ...baseEliteRow, decay_state: 'expired' })).toBe(false);
  });

  it('rejects conviction_band=avoid', () => {
    expect(eliteApproved({ ...baseEliteRow, conviction_band: 'avoid' })).toBe(false);
  });

  it('rejects when invalidation_reason is set', () => {
    expect(eliteApproved({ ...baseEliteRow, invalidation_reason: 'stop_loss_broken' })).toBe(false);
  });

  it('rejects when signal_status != APPROVED_SIGNAL', () => {
    expect(eliteApproved({ ...baseEliteRow, signal_status: 'DEVELOPING_SETUP' })).toBe(false);
  });

  it('audit mode lists every failure cause', () => {
    const detail = eliteApproved(
      {
        ...baseEliteRow,
        confidence_score:  50,
        rr_ratio:          1.0,
        liquidity_score:   30,
      },
      true,
    );
    expect(detail.passed).toBe(false);
    expect(detail.failed.some((r) => r.startsWith('confidence_score'))).toBe(true);
    expect(detail.failed.some((r) => r.startsWith('risk_reward'))).toBe(true);
    expect(detail.failed.some((r) => r.startsWith('liquidity_score'))).toBe(true);
  });
});

describe('applyEliteGate', () => {
  it('returns survivors sorted by final_score, confidence, rr, stress', () => {
    const rows = [
      { ...baseEliteRow, symbol: 'A', final_score: 82, confidence_score: 80, rr_ratio: 2.0, stress_survival_score: 75 },
      { ...baseEliteRow, symbol: 'B', final_score: 90, confidence_score: 85, rr_ratio: 2.5, stress_survival_score: 80 },
      { ...baseEliteRow, symbol: 'C', final_score: 85, confidence_score: 90, rr_ratio: 3.0, stress_survival_score: 90 },
    ];
    const result = applyEliteGate(rows);
    expect(result.enabled).toBe(true);
    expect(result.approved.map((r) => r.symbol)).toEqual(['B', 'C', 'A']);
  });

  it('captures the rejection reasons in `dropped`', () => {
    const rows = [
      { ...baseEliteRow, symbol: 'KEEP' },
      { ...baseEliteRow, symbol: 'DROP', confidence_score: 30 },
    ];
    const result = applyEliteGate(rows);
    expect(result.approved).toHaveLength(1);
    expect(result.approved[0].symbol).toBe('KEEP');
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].symbol).toBe('DROP');
    expect(result.dropped[0].reasons.some((r) => r.startsWith('confidence_score'))).toBe(true);
  });

  it('honours ELITE_GATE=0 bypass', () => {
    process.env.ELITE_GATE = '0';
    try {
      const rows = [
        { ...baseEliteRow, symbol: 'WEAK', confidence_score: 10, final_score: 5 },
      ];
      const result = applyEliteGate(rows);
      expect(result.enabled).toBe(false);
      expect(result.approved).toHaveLength(1);
    } finally {
      delete process.env.ELITE_GATE;
    }
  });

  it('SIGNAL_ELITE_NEVER_EMPTY=0 returns empty when 0 rows qualify', () => {
    process.env.SIGNAL_ELITE_NEVER_EMPTY = '0';
    try {
      const rows = [
        { ...baseEliteRow, symbol: 'WEAK1', final_score: 50 },
        { ...baseEliteRow, symbol: 'WEAK2', confidence_score: 40 },
        { ...baseEliteRow, symbol: 'WEAK3', rr_ratio: 1.0 },
      ];
      const result = applyEliteGate(rows);
      expect(result.approved).toEqual([]);
      expect(result.dropped).toHaveLength(3);
    } finally {
      delete process.env.SIGNAL_ELITE_NEVER_EMPTY;
    }
  });

  it('NEVER-EMPTY default — bypasses with is_relaxed tag when 0 rows pass', () => {
    const rows = [
      { ...baseEliteRow, symbol: 'WEAK1', final_score: 50 },
      { ...baseEliteRow, symbol: 'WEAK2', confidence_score: 40 },
      { ...baseEliteRow, symbol: 'WEAK3', rr_ratio: 1.0 },
    ];
    const result = applyEliteGate(rows) as ReturnType<typeof applyEliteGate> & { bypassed?: boolean };
    expect(result.approved).toHaveLength(3);
    expect(result.bypassed).toBe(true);
    expect(result.dropped).toHaveLength(3);
    for (const r of result.approved) {
      expect((r as { is_relaxed?: boolean }).is_relaxed).toBe(true);
    }
  });
});

describe('extractFactorScores', () => {
  it('flattens the factor_scores JSON blob into top-level fields', () => {
    const row = {
      factor_scores: {
        portfolio_fit: 78,
        liquidity:     65,
        market_regime: 72,
        data_quality:  88,
      },
    };
    const out = extractFactorScores(row);
    expect(out.portfolio_fit_score).toBe(78);
    expect(out.liquidity_score).toBe(65);
    expect(out.market_regime_score).toBe(72);
    expect(out.data_quality_score).toBe(88);
  });

  it('prefers explicit top-level field over factor_scores blob', () => {
    const out = extractFactorScores({
      portfolio_fit_score: 80,
      factor_scores: { portfolio_fit: 50 },
    });
    expect(out.portfolio_fit_score).toBe(80);
  });

  it('derives data_quality_score from execution + live + freshness when blob is missing', () => {
    const out = extractFactorScores({
      execution_allowed:      true,
      live_validation_state:  'VALID',
      freshness_state:        'fresh',
      decay_state:            'fresh',
      status:                 'ACTIVE',
    });
    // 60 base + 20 (live valid) + 10 (fresh freshness) + 10 (fresh decay) = 100
    expect(out.data_quality_score).toBe(100);
  });

  it('derived data_quality_score is 0 when invalidated', () => {
    const out = extractFactorScores({
      execution_allowed:      true,
      invalidation_reason:    'stop_loss_broken',
      status:                 'ACTIVE',
    });
    expect(out.data_quality_score).toBe(0);
  });

  it('derived data_quality_score is 0 when execution_allowed=false', () => {
    const out = extractFactorScores({
      execution_allowed: false,
      status:            'ACTIVE',
    });
    expect(out.data_quality_score).toBe(0);
  });
});
