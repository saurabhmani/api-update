// ════════════════════════════════════════════════════════════════
//  Market-closed confidence decay
//
//  Spec MARKET-CLOSED-DECAY-2026-05: when the market is closed, stored
//  elite approvals lose conviction with age. After 6h of grace, decay
//  starts; after 24h the row is 'aging'; after 72h it is 'stale'; past
//  72h it is 'expired'. Decay is applied to confidence + final_score
//  so the elite gate naturally drops aged rows.
// ════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

import {
  applyMarketClosedDecay as applyMarketClosedDecayUntyped,
  applyMarketClosedDecayBulk,
} from '@/lib/signals/confirmedSignalPolicy';

// Cast wrapper — the generic signature returns the narrow input type,
// which doesn't carry the decay_* output fields. Tests need to read
// those, so widen the return type for assertion convenience.
const applyMarketClosedDecay = applyMarketClosedDecayUntyped as (
  row: Record<string, unknown>,
  opts: { marketOpen: boolean; now?: number },
) => Record<string, any>;

const baseRow = {
  symbol:               'RELIANCE',
  direction:            'BUY' as const,
  classification:       'INSTITUTIONAL_HIGH_CONVICTION',
  signal_status:        'APPROVED_SIGNAL',
  status:               'ACTIVE',
  execution_allowed:    true,
  confidence_score:     85,
  final_score:          88,
  rr_ratio:             2.5,
  stress_survival_score: 80,
};

function rowAt(hoursAgo: number) {
  return {
    ...baseRow,
    confirmed_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  };
}

describe('applyMarketClosedDecay', () => {
  it('is a no-op when the market is open', () => {
    const r = rowAt(48);
    const out = applyMarketClosedDecay(r, { marketOpen: true });
    expect(out.confidence_score).toBe(85);
    expect(out.final_score).toBe(88);
    expect(out.decay_applied).toBeUndefined();
  });

  it('is a no-op within the 6h grace window', () => {
    const r = rowAt(2);
    const out = applyMarketClosedDecay(r, { marketOpen: false });
    expect(out.confidence_score).toBe(85);
    expect(out.final_score).toBe(88);
    expect(out.decay_state).toBe('fresh');
    expect(out.decay_applied).toBe(false);
  });

  it('applies linear decay between 6h and 24h (aging band)', () => {
    const r = rowAt(12);
    const out = applyMarketClosedDecay(r, { marketOpen: false });
    // 6h into decay × 0.5/h = 3pts
    expect(out.decay_state).toBe('aging');
    expect(out.confidence_score).toBe(82);
    expect(out.final_score).toBe(85);
    expect(out.decay_applied).toBe(true);
    expect(out.decay_points).toBe(3);
  });

  it('decays a 24h-old row to ~76 confidence (still above 75 floor)', () => {
    const r = rowAt(24);
    const out = applyMarketClosedDecay(r, { marketOpen: false });
    // 18h × 0.5 = 9pts
    expect(out.confidence_score).toBe(76);
    expect(out.final_score).toBe(79);
    expect(out.decay_state).toBe('aging');
  });

  it('stamps decay_state=stale at 25h (just past aging band)', () => {
    const r = rowAt(25);
    const out = applyMarketClosedDecay(r, { marketOpen: false });
    expect(out.decay_state).toBe('stale');
    // 18h × 0.5 + 1h × 0.75 = 9.75
    expect(out.confidence_score).toBe(75.3);
    expect(out.final_score).toBe(78.3);
  });

  it('decays a 48h-old row past the elite confidence floor', () => {
    const r = rowAt(48);
    const out = applyMarketClosedDecay(r, { marketOpen: false });
    // 18h × 0.5 + 24h × 0.75 = 9 + 18 = 27pts
    expect(out.confidence_score).toBeLessThan(75);
    expect(out.final_score).toBeLessThan(80);
    expect(out.decay_state).toBe('stale');
  });

  it('expires rows older than 72h', () => {
    const r = rowAt(96);
    const out = applyMarketClosedDecay(r, { marketOpen: false });
    expect(out.decay_state).toBe('expired');
    // Hard expiry — score floored to 0
    expect(out.confidence_score).toBe(0);
    expect(out.final_score).toBe(0);
  });

  it('returns the row unchanged when no timestamp is available', () => {
    const out = applyMarketClosedDecay({ ...baseRow }, { marketOpen: false });
    expect(out.confidence_score).toBe(85);
  });

  it('bulk variant counts each band', () => {
    const rows = [
      rowAt(2),    // fresh
      rowAt(12),   // aging
      rowAt(48),   // stale
      rowAt(96),   // expired
      rowAt(0.5),  // fresh
    ];
    const r = applyMarketClosedDecayBulk(rows, { marketOpen: false });
    expect(r.bands.fresh).toBe(2);
    expect(r.bands.aging).toBe(1);
    expect(r.bands.stale).toBe(1);
    expect(r.bands.expired).toBe(1);
  });

  it('decay_age_hours is rounded to 1 decimal', () => {
    const r = rowAt(7.55);
    const out = applyMarketClosedDecay(r, { marketOpen: false });
    expect(typeof out.decay_age_hours).toBe('number');
    // Allow tiny clock-jitter rounding either side of 7.5/7.6
    expect(out.decay_age_hours).toBeGreaterThan(7.4);
    expect(out.decay_age_hours).toBeLessThan(7.7);
  });
});
