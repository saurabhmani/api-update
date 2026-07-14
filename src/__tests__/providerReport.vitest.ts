/**
 * providerReport — kite / nse / yahoo counters (no legacy_vendor_calls).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetProviderReportForTests,
  getProviderReport,
  recordProviderCall,
} from '@/lib/marketData/providerReport';

describe('providerReport', () => {
  beforeEach(() => _resetProviderReportForTests());

  it('bumps kite_calls and sets last_provider', () => {
    recordProviderCall('kite');
    const r = getProviderReport();
    expect(r.kite_calls).toBe(1);
    expect(r.last_provider).toBe('kite');
    expect((r as { legacy_vendor_calls?: number }).legacy_vendor_calls).toBeUndefined();
  });

  it('records fallback without inventing legacy_vendor counters', () => {
    recordProviderCall('yahoo', { fallback: true, error: 'kite_miss' });
    const r = getProviderReport();
    expect(r.yahoo_calls).toBe(1);
    expect(r.fallback_triggered).toBe(true);
    expect(r.last_error).toBe('kite_miss');
  });
});
