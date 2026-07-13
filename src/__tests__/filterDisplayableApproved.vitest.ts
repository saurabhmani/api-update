import { describe, expect, it } from 'vitest';
import {
  filterDisplayableApproved,
  getDisplayableApprovedVetoReasons,
  isDisplayableApproved,
} from '@/lib/signals/filterDisplayableApproved';

describe('filterDisplayableApproved', () => {
  const strictRow = {
    direction: 'BUY',
    execution_allowed: true,
    live_invalidated: false,
  };

  it('keeps strict execution-ready rows', () => {
    expect(isDisplayableApproved(strictRow, 'STRICT')).toBe(true);
    expect(filterDisplayableApproved([strictRow], 'STRICT')).toHaveLength(1);
  });

  it('vetoes relaxed, conditional, and scanner rows', () => {
    expect(getDisplayableApprovedVetoReasons({ ...strictRow, is_relaxed: true })).toContain('is_relaxed');
    expect(getDisplayableApprovedVetoReasons({ ...strictRow, is_conditional: true })).toContain('is_conditional');
    expect(getDisplayableApprovedVetoReasons({ ...strictRow, is_scanner_candidate: true })).toContain('scanner_candidate');
  });

  it('vetoes invalidated and blocked tradeability', () => {
    expect(getDisplayableApprovedVetoReasons({ ...strictRow, live_invalidated: true })).toContain('live_invalidated=true');
    expect(getDisplayableApprovedVetoReasons({ ...strictRow, invalidation_reason: 'stale' })).toContain('invalidated:stale');
    expect(getDisplayableApprovedVetoReasons({ ...strictRow, tradeability_status: 'blocked' })).toContain('tradeability=blocked');
    expect(getDisplayableApprovedVetoReasons({ ...strictRow, conviction_band: 'avoid' })).toContain('conviction_band=avoid');
  });

  it('vetoes all rows when signal quality is relaxed', () => {
    expect(isDisplayableApproved(strictRow, 'RELAXED')).toBe(false);
    expect(filterDisplayableApproved([strictRow, { ...strictRow, direction: 'SELL' }], 'RELAXED')).toHaveLength(0);
  });
});
