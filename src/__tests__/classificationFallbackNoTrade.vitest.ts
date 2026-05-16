/**
 * classification fallback — NO_TRADE poisoning regression.
 *
 * Pins the bug fix where `deriveClassificationFromScore` /
 * `classificationFromFinalScore` returned 'NO_TRADE' as the lowest band.
 * Combined with `toNumber(null) === 0`, every approved row whose DB
 * `classification` AND `final_score` columns were both NULL got stamped
 * NO_TRADE in the API response, and the dashboard's Class column
 * displayed the generic "No Trade" pill on otherwise-tradeable BUY
 * signals.
 *
 * Contract: NO_TRADE must NEVER be synthesized from a missing column —
 * it can only come from an explicit engine decision on the raw row.
 */
import { describe, expect, it } from 'vitest';
import { fromDbRow } from '@/lib/signal-engine/repository/phase11Serialization';

describe('phase11Serialization.fromDbRow — classification fallback', () => {
  function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 1,
      symbol: 'TCS',
      direction: 'BUY',
      generated_at: new Date(),
      ...overrides,
    };
  }

  it('NULL classification + NULL final_score does NOT fall back to NO_TRADE', () => {
    const out = fromDbRow(row({ classification: null, final_score: null }));
    expect(out.classification).not.toBe('NO_TRADE');
    // The floor is DEVELOPING_SETUP — lowest legitimate tradeable bucket.
    expect(out.classification).toBe('DEVELOPING_SETUP');
  });

  it('NULL classification + final_score=0 does NOT fall back to NO_TRADE', () => {
    const out = fromDbRow(row({ classification: null, final_score: 0 }));
    expect(out.classification).not.toBe('NO_TRADE');
    expect(out.classification).toBe('DEVELOPING_SETUP');
  });

  it('NULL classification + final_score below 30 does NOT fall back to NO_TRADE', () => {
    const out = fromDbRow(row({ classification: null, final_score: 15 }));
    expect(out.classification).not.toBe('NO_TRADE');
    expect(out.classification).toBe('DEVELOPING_SETUP');
  });

  it('NULL classification + non-finite final_score (NaN) does NOT poison with NO_TRADE', () => {
    const out = fromDbRow(row({ classification: null, final_score: 'not-a-number' }));
    expect(out.classification).not.toBe('NO_TRADE');
    expect(out.classification).toBe('DEVELOPING_SETUP');
  });

  it('explicit NO_TRADE classification IS preserved (engine decision wins)', () => {
    const out = fromDbRow(row({ classification: 'NO_TRADE', final_score: 70 }));
    expect(out.classification).toBe('NO_TRADE');
  });

  it('high final_score still maps to its real bucket (regression guard)', () => {
    expect(fromDbRow(row({ classification: null, final_score: 92 })).classification)
      .toBe('INSTITUTIONAL_HIGH_CONVICTION');
    expect(fromDbRow(row({ classification: null, final_score: 82 })).classification)
      .toBe('HIGH_CONVICTION');
    expect(fromDbRow(row({ classification: null, final_score: 60 })).classification)
      .toBe('VALID_SIGNAL');
    expect(fromDbRow(row({ classification: null, final_score: 35 })).classification)
      .toBe('DEVELOPING_SETUP');
  });
});
