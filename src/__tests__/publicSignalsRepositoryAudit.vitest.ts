/**
 * Production audit — public signals repository formatting & SQL safety.
 */
import { describe, expect, it } from 'vitest';
import { formatPublicTimestamp } from '@/lib/signals/public/publicSignalsRepository';

describe('publicSignalsRepository audit', () => {
  it('formatPublicTimestamp returns IST offset (+05:30)', () => {
    const formatted = formatPublicTimestamp(new Date('2026-06-01T04:30:00.000Z'));
    expect(formatted).toMatch(/\+05:30$/);
    expect(formatted).toContain('2026-06-01T10:00:00');
  });

  it('formatPublicTimestamp handles MySQL datetime strings', () => {
    const formatted = formatPublicTimestamp('2026-06-01 10:00:00');
    expect(formatted).toBe('2026-06-01T10:00:00+05:30');
  });
});
