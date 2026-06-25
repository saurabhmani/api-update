import { describe, it, expect } from 'vitest';
import { normalizeSignalReasons } from '@/lib/signals/normalizeReasons';

describe('signalReasonEngine helpers', () => {
  it('normalizes confirmation reasons from mixed input', () => {
    const result = normalizeSignalReasons({
      confirmationReasons: ['Volume expanded', 'Volume expanded', ''],
      reason: 'bullish_breakout setup',
    });
    expect(result.confirmationReasons).toContain('Volume expanded');
    expect(result.confirmationReasons.length).toBe(1);
  });

  it('merges rejection and missing requirement buckets', () => {
    const result = normalizeSignalReasons({
      rejectionReasons: ['Low confidence'],
      missingApprovalFactors: ['Portfolio fit below threshold'],
    });
    expect(result.rejectionReasons).toContain('Low confidence');
    expect(result.missingRequirements).toContain('Portfolio fit below threshold');
  });
});
