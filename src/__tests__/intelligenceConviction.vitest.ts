import { describe, expect, it } from 'vitest';
import { normalizeConvictionBand } from '@/lib/signal-engine/repository/readSignals';

describe('normalizeConvictionBand', () => {
  it('maps engine Actionable label to actionable', () => {
    expect(normalizeConvictionBand('Actionable', 64)).toBe('actionable');
  });

  it('promotes APPROVED VALID_SIGNAL from Avoid band using institutional score', () => {
    expect(normalizeConvictionBand('Avoid', 44, {
      classification: 'VALID_SIGNAL',
      finalScore: 69.9,
      signalStatus: 'APPROVED_SIGNAL',
    })).toBe('actionable');
  });

  it('maps HIGH_CONVICTION classification to high_conviction', () => {
    expect(normalizeConvictionBand('Watchlist', 62, {
      classification: 'HIGH_CONVICTION',
      signalStatus: 'APPROVED_SIGNAL',
    })).toBe('high_conviction');
  });

  it('keeps scanner Avoid as reject when not approved', () => {
    expect(normalizeConvictionBand('Avoid', 40, {
      classification: 'DEVELOPING_SETUP',
      signalStatus: 'DEVELOPING_SETUP',
    })).toBe('reject');
  });
});
