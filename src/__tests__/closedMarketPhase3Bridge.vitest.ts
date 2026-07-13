import { describe, expect, it } from 'vitest';
import { partitionByTier, isExecutionReady } from '@/lib/signals/signalTierClassifier';

/** Mirrors clearEarlyTagsForMainTable + shapeQ365Row output for Phase-3 rows. */
function phase3ApprovedRow(overrides: Record<string, unknown> = {}) {
  return {
    symbol:               'RELIANCE',
    tradingsymbol:        'RELIANCE',
    direction:            'BUY',
    signal_status:        'APPROVED_SIGNAL',
    classification:       'HIGH_CONVICTION',
    raw_classification:   'HIGH_CONVICTION',
    confidence_score:     78,
    final_score:          80,
    risk_reward:          2.0,
    rr_ratio:             2.0,
    status:               'ACTIVE',
    is_relaxed:           false,
    is_conditional:       false,
    is_scanner_candidate: false,
    is_stale_candidate:   false,
    ...overrides,
  };
}

describe('Phase-3 q365 → main table bridge', () => {
  it('execution-ready when early/scanner tags are cleared', () => {
    const row = phase3ApprovedRow();
    expect(isExecutionReady(row)).toBe(true);
    expect(partitionByTier([row]).approved).toHaveLength(1);
  });

  it('is_relaxed tag routes row away from APPROVED (regression)', () => {
    const row = phase3ApprovedRow({ is_relaxed: true });
    expect(isExecutionReady(row)).toBe(false);
    expect(partitionByTier([row]).approved).toHaveLength(0);
    expect(partitionByTier([row]).developing.length).toBeGreaterThan(0);
  });

  it('NO_TRADE classification is excluded from main table candidacy', () => {
    const row = phase3ApprovedRow({
      classification:     'NO_TRADE',
      raw_classification: 'NO_TRADE',
    });
    expect(isExecutionReady(row)).toBe(false);
  });
});
