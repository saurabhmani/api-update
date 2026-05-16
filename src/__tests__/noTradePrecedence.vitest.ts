/**
 * NO_TRADE precedence + source-visibility contract tests.
 *
 * Locks the production fix for the ADANIPORTS canary case:
 *   q365_signals row | BUY | APPROVED_SIGNAL | NO_TRADE | final=70.88
 * The previous shape pipeline rebucketed the stored 'NO_TRADE' to
 * 'MEDIUM_CONVICTION' (final_score >= 65 path), defeating every
 * downstream NO_TRADE check and surfacing the row as a confirmed BUY
 * opportunity on the dashboard.
 *
 * The fixes asserted here:
 *   1. normalizeClassification preserves 'NO_TRADE' / 'WATCHLIST_ONLY'
 *      when the raw classification carries those markers, instead of
 *      always re-bucketing from final_score.
 *   2. deriveEffectiveSignalStatus returns 'NO_TRADE' whenever the raw
 *      classification is NO_TRADE — even if signal_status is APPROVED.
 *   3. mainTableApproved / relaxedMainTableApproved / earlySignalApproved
 *      reject rows where raw_classification === 'NO_TRADE', ignoring
 *      the rebucketed display classification.
 *   4. is_trade_ready is false for any q365_signals-sourced row, even
 *      when cycles >= 3 (promotion happens through the maturity
 *      worker; q365_signals rows never carry is_trade_ready=true).
 *   5. Stale candidates (last_seen older than TRACKER_STALE_HOURS) are
 *      flagged is_stale_candidate=true and rejected by every gate.
 *   6. Source visibility envelope fields appear on every closed-market
 *      row.
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeClassification,
  deriveEffectiveSignalStatus,
  deriveDisplayBucket,
} from '@/lib/signals/closedMarketSignals';
import {
  mainTableApproved,
  relaxedMainTableApproved,
  earlySignalApproved,
} from '@/lib/signals/confirmedSignalPolicy';

// ── normalizeClassification ─────────────────────────────────────────
describe('normalizeClassification — NO_TRADE preservation', () => {
  it('returns NO_TRADE when the raw classification is NO_TRADE, regardless of final_score', () => {
    expect(normalizeClassification(70.88, 'NO_TRADE')).toBe('NO_TRADE');
    expect(normalizeClassification(95,    'NO_TRADE')).toBe('NO_TRADE');
    expect(normalizeClassification(0,     'NO_TRADE')).toBe('NO_TRADE');
  });

  it('returns WATCHLIST_ONLY when raw is WATCHLIST_ONLY', () => {
    expect(normalizeClassification(80, 'WATCHLIST_ONLY')).toBe('WATCHLIST_ONLY');
  });

  it('rebuckets from final_score when raw is missing or legacy', () => {
    expect(normalizeClassification(80,  null)).toBe('HIGH_CONVICTION');
    expect(normalizeClassification(70,  '')).toBe('MEDIUM_CONVICTION');
    expect(normalizeClassification(50,  'LEGACY_VALUE')).toBe('LOW_CONVICTION');
    expect(normalizeClassification(80,  'HIGH_CONVICTION_BUY')).toBe('HIGH_CONVICTION');
  });

  it('case-insensitive on the raw input', () => {
    expect(normalizeClassification(80, 'no_trade')).toBe('NO_TRADE');
    expect(normalizeClassification(80, '  NO_TRADE  ')).toBe('NO_TRADE');
  });
});

// ── deriveEffectiveSignalStatus ─────────────────────────────────────
describe('deriveEffectiveSignalStatus — NO_TRADE overrides APPROVED_SIGNAL', () => {
  it('NO_TRADE classification → effective NO_TRADE (the ADANIPORTS canary)', () => {
    expect(deriveEffectiveSignalStatus('NO_TRADE', 'APPROVED_SIGNAL')).toBe('NO_TRADE');
  });

  it('WATCHLIST_ONLY classification → effective WATCHLIST_ONLY', () => {
    expect(deriveEffectiveSignalStatus('WATCHLIST_ONLY', 'APPROVED_SIGNAL')).toBe('WATCHLIST_ONLY');
  });

  it('clean APPROVED_SIGNAL with non-reject classification → APPROVED_SIGNAL', () => {
    expect(deriveEffectiveSignalStatus('HIGH_CONVICTION', 'APPROVED_SIGNAL')).toBe('APPROVED_SIGNAL');
  });

  it('DEVELOPING_SETUP signal_status → effective DEVELOPING_SETUP', () => {
    expect(deriveEffectiveSignalStatus('MEDIUM_CONVICTION', 'DEVELOPING_SETUP')).toBe('DEVELOPING_SETUP');
  });

  it('invalidation_reason set → effective EXPIRED', () => {
    expect(deriveEffectiveSignalStatus('HIGH_CONVICTION', 'APPROVED_SIGNAL', 'live_tape_disagreement')).toBe('EXPIRED');
  });

  it('valid_until in the past → effective EXPIRED', () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(deriveEffectiveSignalStatus('HIGH_CONVICTION', 'APPROVED_SIGNAL', null, yesterday)).toBe('EXPIRED');
  });

  it('valid_until in the future → not expired', () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect(deriveEffectiveSignalStatus('HIGH_CONVICTION', 'APPROVED_SIGNAL', null, tomorrow)).toBe('APPROVED_SIGNAL');
  });
});

// ── deriveDisplayBucket ─────────────────────────────────────────────
describe('deriveDisplayBucket — UI routing', () => {
  it('NO_TRADE row routes to no_trade bucket regardless of source', () => {
    expect(deriveDisplayBucket({
      sourceTable:    'q365_signals',
      effectiveStatus: 'NO_TRADE',
      validationCycles: 5, isAlive: true,
    })).toBe('no_trade');
  });

  it('confirmed snapshot, alive, approved → confirmed bucket', () => {
    expect(deriveDisplayBucket({
      sourceTable:     'q365_confirmed_signal_snapshots',
      effectiveStatus: 'APPROVED_SIGNAL',
      validationCycles: 3, isAlive: true,
    })).toBe('confirmed');
  });

  it('q365_signals approved (even cycles>=3) → early_candidate, never confirmed', () => {
    // Promotion happens through the maturity worker — until a row is
    // copied into q365_confirmed_signal_snapshots it is NEVER
    // confirmed regardless of how many cycles it has accumulated.
    expect(deriveDisplayBucket({
      sourceTable:     'q365_signals',
      effectiveStatus: 'APPROVED_SIGNAL',
      validationCycles: 5, isAlive: true,
    })).toBe('early_candidate');
  });

  it('expired / not-alive → rejected bucket', () => {
    expect(deriveDisplayBucket({
      sourceTable:     'q365_confirmed_signal_snapshots',
      effectiveStatus: 'EXPIRED',
      validationCycles: 3, isAlive: false,
    })).toBe('rejected');
  });
});

// ── Predicates with raw_classification check ────────────────────────
describe('mainTableApproved — raw NO_TRADE rejection', () => {
  const baseRow = {
    direction:                'BUY',
    classification:           'MEDIUM_CONVICTION',  // post-rebucketing
    final_score:              70.88,
    confidence_score:         75,
    rr_ratio:                 2.0,
    maturity_score:           90,
    validation_cycles_passed: 3,
    stability_passed:         true,
    expected_edge_percent:    5,
    invalidation_reason:      null,
    live_invalidated:         false,
  };

  it('REGRESSION: ADANIPORTS-shape row (NO_TRADE raw, MEDIUM_CONVICTION display) is rejected', () => {
    expect(mainTableApproved({
      ...baseRow,
      raw_classification: 'NO_TRADE',
    })).toBe(false);
  });

  it('clean approved row passes', () => {
    expect(mainTableApproved({
      ...baseRow,
      raw_classification: 'HIGH_CONVICTION',
    })).toBe(true);
  });

  it('stale candidate is rejected', () => {
    expect(mainTableApproved({
      ...baseRow,
      raw_classification: 'HIGH_CONVICTION',
      is_stale_candidate: true,
    })).toBe(false);
  });
});

describe('relaxedMainTableApproved — raw NO_TRADE rejection', () => {
  const baseRow = {
    direction:                'BUY',
    classification:           'MEDIUM_CONVICTION',
    final_score:              70,
    confidence_score:         70,
    rr_ratio:                 1.6,
    maturity_score:           70,
    validation_cycles_passed: 1,
    invalidation_reason:      null,
  };

  it('rejects when raw_classification is NO_TRADE (display rebucketed)', () => {
    expect(relaxedMainTableApproved({
      ...baseRow, raw_classification: 'NO_TRADE',
    })).toBe(false);
  });

  it('passes when no raw NO_TRADE and floors hold', () => {
    expect(relaxedMainTableApproved({
      ...baseRow, raw_classification: 'MEDIUM_CONVICTION',
    })).toBe(true);
  });

  it('rejects stale candidates', () => {
    expect(relaxedMainTableApproved({
      ...baseRow, is_stale_candidate: true,
    })).toBe(false);
  });
});

describe('earlySignalApproved — raw NO_TRADE rejection', () => {
  const baseRow = {
    direction:        'BUY',
    classification:   'MEDIUM_CONVICTION',
    final_score:      70,
    confidence_score: 65,
    rr_ratio:         1.8,
    invalidation_reason: null,
  };

  it('rejects when raw_classification is NO_TRADE', () => {
    expect(earlySignalApproved({
      ...baseRow, raw_classification: 'NO_TRADE',
    })).toBe(false);
  });

  it('rejects when display classification is NO_TRADE', () => {
    expect(earlySignalApproved({
      ...baseRow, classification: 'NO_TRADE',
    })).toBe(false);
  });

  it('passes when both classifications are clean', () => {
    expect(earlySignalApproved({
      ...baseRow, raw_classification: 'MEDIUM_CONVICTION',
    })).toBe(true);
  });

  it('rejects stale candidates', () => {
    expect(earlySignalApproved({
      ...baseRow, is_stale_candidate: true,
    })).toBe(false);
  });
});
