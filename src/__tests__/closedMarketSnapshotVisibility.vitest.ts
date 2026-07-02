import { describe, expect, it } from 'vitest';
import {
  isAliveForClosedMarket,
  mainTableApproved,
  relaxedMainTableApproved,
} from '@/lib/signals/confirmedSignalPolicy';

describe('closed-market snapshot visibility', () => {
  const baseRow = {
    symbol:              'DABUR',
    direction:           'BUY' as const,
    classification:      'VALID_SIGNAL',
    raw_classification:  'VALID_SIGNAL',
    signal_status:       'APPROVED_SIGNAL',
    confidence_score:    64,
    final_score:         70.5,
    rr_ratio:            1.5,
    expected_edge_percent: 1.25,
    maturity_score:      63.5,
    validation_cycles_passed: 5,
    stability_passed:    true,
    is_relaxed:          false,
    is_stale_candidate:  false,
  };

  it('treats validity_window_elapsed as alive off-hours', () => {
    const row = {
      ...baseRow,
      invalidation_reason: 'validity_window_elapsed',
      status:              'EXPIRED',
    };
    expect(isAliveForClosedMarket(row)).toBe(true);
    expect(isAliveForClosedMarket({ ...row, invalidation_reason: 'stop_loss_broken' })).toBe(false);
  });

  it('admits soft-expired confirmed snapshots via relaxed main-table gate', () => {
    const row = {
      ...baseRow,
      invalidation_reason: 'validity_window_elapsed',
      status:              'EXPIRED',
    };
    expect(mainTableApproved(row, { closedMarket: true })).toBe(true);
    expect(relaxedMainTableApproved(row, { closedMarket: true })).toBe(true);
  });
});
