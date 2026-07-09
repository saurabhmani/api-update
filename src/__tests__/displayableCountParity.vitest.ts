// Path D regression guard — displayable approved count parity.
//
// The "Dashboard shows 18, Signals shows 4" bug happened because three
// layers each computed the approved count differently:
//   • /api/signals   → counters.approvedTotal
//   • /api/dashboard → signalSummary.approvedTotal
//   • /signals page  → validRows.length
//
// All three must derive their count from the ONE shared filter in
// src/lib/signals/filterDisplayableApproved.ts. This suite checks:
//   1. behavior — a realistic fixture set produces the expected
//      displayable count and BUY/SELL split, matching what the API
//      counter computation ships;
//   2. wiring — the three layers actually import the shared filter
//      (source-level assertion; intentional contract so a refactor
//      cannot silently reintroduce a divergent inline copy).

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import {
  filterDisplayableApproved,
  countDisplayableApproved,
} from '@/lib/signals/filterDisplayableApproved';

type FixtureRow = Record<string, unknown>;

// Realistic mixed pool: 8 server-approved rows, only 3 displayable.
const approvedPool: FixtureRow[] = [
  // Displayable — clean strict rows.
  { symbol: 'RELIANCE', direction: 'BUY',  execution_allowed: true },
  { symbol: 'TCS',      direction: 'SELL', execution_allowed: true },
  { symbol: 'INFY',     direction: 'BUY',  execution_allowed: true, tradeability_status: 'tradeable' },
  // Vetoed — one per veto class.
  { symbol: 'HDFC',     direction: 'BUY',  is_relaxed: true },
  { symbol: 'SBIN',     direction: 'SELL', is_conditional: true },
  { symbol: 'WIPRO',    direction: 'BUY',  live_invalidated: true },
  { symbol: 'ITC',      direction: 'SELL', execution_allowed: false },
  { symbol: 'ONGC',     direction: 'BUY',  conviction_band: 'avoid' },
];

// Mirrors the counter computation in /api/signals and /api/dashboard.
function computeApiCounters(rows: FixtureRow[], signalQuality: string | null) {
  const displayable = filterDisplayableApproved(rows, signalQuality);
  return {
    approvedTotal: displayable.length,
    approvedBuy:   displayable.filter((r) => String(r.direction ?? '').toUpperCase() === 'BUY').length,
    approvedSell:  displayable.filter((r) => String(r.direction ?? '').toUpperCase() === 'SELL').length,
  };
}

describe('displayable count parity — Path D regression guard', () => {
  it('fixture pool: 8 approved → 3 displayable (2 BUY / 1 SELL)', () => {
    const counters = computeApiCounters(approvedPool, 'STRICT');
    expect(counters).toEqual({ approvedTotal: 3, approvedBuy: 2, approvedSell: 1 });
  });

  it('countDisplayableApproved matches filterDisplayableApproved length', () => {
    expect(countDisplayableApproved(approvedPool, 'STRICT'))
      .toBe(filterDisplayableApproved(approvedPool, 'STRICT').length);
  });

  it('relaxed signal quality zeroes the displayable count for every layer', () => {
    const counters = computeApiCounters(approvedPool, 'RELAXED');
    expect(counters.approvedTotal).toBe(0);
  });

  it('counter computation is deterministic across repeated calls (API parity)', () => {
    const a = computeApiCounters(approvedPool, 'STRICT');
    const b = computeApiCounters([...approvedPool], 'STRICT');
    expect(a).toEqual(b);
  });
});

describe('displayable filter wiring — all three layers use the shared module', () => {
  const root = process.cwd();
  const read = (rel: string) => readFileSync(path.join(root, rel), 'utf8');

  it('/api/signals route imports filterDisplayableApproved for counters', () => {
    const src = read('src/app/api/signals/route.ts');
    expect(src).toContain("filterDisplayableApproved");
    expect(src).toMatch(/approvedTotal:\s*(closedDisplayableApproved|displayableApproved)\.length/);
  });

  it('/api/dashboard route imports filterDisplayableApproved for signalSummary', () => {
    const src = read('src/app/api/dashboard/route.ts');
    expect(src).toContain("filterDisplayableApproved");
    expect(src).toMatch(/approvedTotal:\s*displayableApproved\.length/);
  });

  it('signals page imports the shared filter (no divergent inline copy)', () => {
    const src = read('src/app/signals/page.tsx');
    expect(src).toContain("from '@/lib/signals/filterDisplayableApproved'");
    expect(src).toContain('filterDisplayableApproved');
    expect(src).toContain('getDisplayableApprovedVetoReasons');
  });
});
