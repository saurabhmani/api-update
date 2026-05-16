/**
 * Closed-market dedup + field backfill contract tests
 * (SIGNAL_ENGINE_FIXED_AND_CLEAN §2 + §4).
 */
import { describe, expect, it } from 'vitest';
import {
  dedupeOneSymbolOneSignal,
  backfillBlankFields,
  normalizeClassification,
  computeLivePChange,
  strictValidationFilter,
} from '@/lib/signals/closedMarketSignals';
import type { ConfirmedSignalRow } from '@/lib/signals/signalsResponseMapper';

function row(over: Record<string, unknown>): ConfirmedSignalRow {
  return {
    id: 1, symbol: 'X', tradingsymbol: 'X', direction: 'BUY',
    entry_price: 100, stop_loss: 98, target1: 103, target2: null,
    confidence_score: 70, confidence: 70, final_score: 75,
    classification: 'HIGH_CONVICTION_BUY', signal_status: 'APPROVED_SIGNAL',
    risk_reward: 1.5, rr_ratio: 1.5,
    status: 'ACTIVE', invalidation_reason: null,
    confirmed_at: new Date().toISOString(), valid_until: null,
    livePrice: null, livePChange: null,
    profit_percent: 3, loss_percent: 2,
    expected_edge_percent: 1, win_probability: 65,
    risk_score: null, opportunity_score: null, portfolio_fit_score: null,
    stress_survival_score: null, confidence_band: 'MEDIUM',
    maturity_score: null, validation_cycles_passed: null,
    signal_age_minutes_at_promotion: null, conviction_level: null,
    stability_passed: null, validation_gates_passed: 13,
    rejection_codes: [], rejection_reasons: [],
    live_valid: true,
    ...over,
  } as unknown as ConfirmedSignalRow;
}

describe('dedupeOneSymbolOneSignal — §2', () => {
  it('keeps higher final_score when BUY+SELL exist for the same symbol', () => {
    const buyLow  = row({ id: 1, symbol: 'RELIANCE', direction: 'BUY',  final_score: 70, confidence_score: 75 });
    const sellHi  = row({ id: 2, symbol: 'RELIANCE', direction: 'SELL', final_score: 85, confidence_score: 80 });
    const out = dedupeOneSymbolOneSignal([buyLow, sellHi]);
    expect(out).toHaveLength(1);
    expect(out[0].direction).toBe('SELL');
    expect(out[0].final_score).toBe(85);
  });

  it('breaks ties on confidence then id', () => {
    const a = row({ id: 1, symbol: 'TCS', direction: 'BUY',  final_score: 80, confidence_score: 70 });
    const b = row({ id: 2, symbol: 'TCS', direction: 'SELL', final_score: 80, confidence_score: 75 });
    const out = dedupeOneSymbolOneSignal([a, b]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe(2);  // higher confidence wins
  });

  it('preserves distinct symbols', () => {
    const x = row({ id: 1, symbol: 'X', direction: 'BUY', final_score: 80 });
    const y = row({ id: 2, symbol: 'Y', direction: 'SELL', final_score: 70 });
    const out = dedupeOneSymbolOneSignal([x, y]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((r) => r.symbol))).toEqual(new Set(['X', 'Y']));
  });
});

describe('backfillBlankFields — §4', () => {
  it('fills risk_score from rr_ratio * 20 when null', () => {
    const r = row({ rr_ratio: 2, risk_score: null });
    backfillBlankFields([r]);
    expect((r as { risk_score: number }).risk_score).toBe(40);
  });

  it('fills portfolio_fit_score from min(100, confidence+5) when null', () => {
    // Spec DATA-QUALITY §3 — pfit no longer mirrors final_score; it
    // tracks confidence + 5 instead.
    const r = row({ confidence_score: 70, portfolio_fit_score: null });
    backfillBlankFields([r]);
    expect((r as { portfolio_fit_score: number }).portfolio_fit_score).toBe(75);
  });

  it('fills stress_survival_score from 100 - confidence when null', () => {
    const r = row({ confidence_score: 70, stress_survival_score: null });
    backfillBlankFields([r]);
    expect((r as { stress_survival_score: number }).stress_survival_score).toBe(30);
  });

  it('does not overwrite existing values', () => {
    const r = row({ risk_score: 55, portfolio_fit_score: 60, stress_survival_score: 25, rr_ratio: 2 });
    const { fixed } = backfillBlankFields([r]);
    expect(fixed).toBe(0);
    expect((r as { risk_score: number }).risk_score).toBe(55);
    expect((r as { portfolio_fit_score: number }).portfolio_fit_score).toBe(60);
    expect((r as { stress_survival_score: number }).stress_survival_score).toBe(25);
  });

  it('clamps to [0, 100]', () => {
    const r = row({ rr_ratio: 999, confidence_score: -10, final_score: 200,
                    risk_score: null, portfolio_fit_score: null, stress_survival_score: null });
    backfillBlankFields([r]);
    expect((r as { risk_score: number }).risk_score).toBe(100);
    expect((r as { portfolio_fit_score: number }).portfolio_fit_score).toBe(0);
    expect((r as { stress_survival_score: number }).stress_survival_score).toBe(100);
  });

  it('overwrites portfolio_fit_score = 0 with confidence-based value', () => {
    const r = row({ confidence_score: 70, portfolio_fit_score: 0 });
    backfillBlankFields([r]);
    expect((r as { portfolio_fit_score: number }).portfolio_fit_score).toBe(75);  // min(100, 70+5)
  });
});

describe('normalizeClassification — DATA-QUALITY §2', () => {
  it('buckets by final_score', () => {
    expect(normalizeClassification(80)).toBe('HIGH_CONVICTION');
    expect(normalizeClassification(75)).toBe('HIGH_CONVICTION');
    expect(normalizeClassification(74)).toBe('MEDIUM_CONVICTION');
    expect(normalizeClassification(65)).toBe('MEDIUM_CONVICTION');
    expect(normalizeClassification(64)).toBe('LOW_CONVICTION');
    expect(normalizeClassification(0)).toBe('LOW_CONVICTION');
    expect(normalizeClassification(null)).toBe('LOW_CONVICTION');
  });
});

describe('computeLivePChange — DATA-QUALITY §3', () => {
  it('computes the entry-relative percent move', () => {
    expect(computeLivePChange(110, 100)).toBe(10);     // +10%
    expect(computeLivePChange(95, 100)).toBe(-5);      // -5%
    expect(computeLivePChange(100, 100)).toBe(0);      // flat
  });

  it('returns null for invalid inputs', () => {
    expect(computeLivePChange(null, 100)).toBe(null);
    expect(computeLivePChange(110, null)).toBe(null);
    expect(computeLivePChange(110, 0)).toBe(null);
    expect(computeLivePChange(110, -10)).toBe(null);
  });
});

describe('mainTableApproved — MAIN-TABLE-STRICT §6', () => {
  // Lazy-import so a path issue surfaces here, not in unrelated tests.
  function maturedRow(over: Record<string, unknown> = {}): ConfirmedSignalRow {
    return row({
      classification:           'HIGH_CONVICTION',
      confidence_score:         80,
      final_score:              78,
      rr_ratio:                 2.2,
      risk_reward:              2.2,
      maturity_score:           90,
      validation_cycles_passed: 4,
      stability_passed:         true,
      expected_edge_percent:    3.5,
      ...over,
    });
  }

  it('accepts a fully matured snapshot row', async () => {
    const { mainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(mainTableApproved(maturedRow())).toBe(true);
  });

  it('rejects when maturity_score < 85', async () => {
    const { mainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(mainTableApproved(maturedRow({ maturity_score: 80 }))).toBe(false);
  });

  it('rejects when validation_cycles_passed < 3', async () => {
    const { mainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(mainTableApproved(maturedRow({ validation_cycles_passed: 2 }))).toBe(false);
  });

  it('rejects when stability_passed is false', async () => {
    const { mainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(mainTableApproved(maturedRow({ stability_passed: false }))).toBe(false);
  });

  it('rejects when expected_edge_percent <= 2', async () => {
    const { mainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(mainTableApproved(maturedRow({ expected_edge_percent: 2 }))).toBe(false);
  });

  it('rejects when rr_ratio < 2', async () => {
    const { mainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(mainTableApproved(maturedRow({ rr_ratio: 1.8, risk_reward: 1.8 }))).toBe(false);
  });

  it('rejects when confidence_score < 75', async () => {
    const { mainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(mainTableApproved(maturedRow({ confidence_score: 70 }))).toBe(false);
  });

  it('rejects when final_score < 70', async () => {
    const { mainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(mainTableApproved(maturedRow({ final_score: 68 }))).toBe(false);
  });

  it('rejects when tracker fields are NULL (no defaulting)', async () => {
    const { mainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(mainTableApproved(maturedRow({ maturity_score: null }))).toBe(false);
    expect(mainTableApproved(maturedRow({ validation_cycles_passed: null }))).toBe(false);
    expect(mainTableApproved(maturedRow({ stability_passed: null }))).toBe(false);
    expect(mainTableApproved(maturedRow({ expected_edge_percent: null }))).toBe(false);
  });

  it('rejects when classification is NO_TRADE / DEVELOPING_SETUP / WATCHLIST_ONLY', async () => {
    const { mainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(mainTableApproved(maturedRow({ classification: 'NO_TRADE' }))).toBe(false);
    expect(mainTableApproved(maturedRow({ classification: 'DEVELOPING_SETUP' }))).toBe(false);
    expect(mainTableApproved(maturedRow({ classification: 'WATCHLIST_ONLY' }))).toBe(false);
  });
});

describe('relaxedMainTableApproved — SMART-RELAXED §2', () => {
  function relaxedRow(over: Record<string, unknown> = {}): ConfirmedSignalRow {
    return row({
      classification:           'HIGH_CONVICTION',
      confidence_score:         70,
      final_score:              68,
      rr_ratio:                 1.6,
      risk_reward:              1.6,
      maturity_score:           70,
      validation_cycles_passed: 1,
      stability_passed:         false,
      ...over,
    });
  }

  it('accepts a relaxed row that fails the strict gate', async () => {
    const { relaxedMainTableApproved, mainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    const r = relaxedRow();
    expect(mainTableApproved(r)).toBe(false);          // strict rejects
    expect(relaxedMainTableApproved(r)).toBe(true);    // relaxed accepts
  });

  it('rejects when classification is NO_TRADE (hard floor)', async () => {
    const { relaxedMainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(relaxedMainTableApproved(relaxedRow({ classification: 'NO_TRADE' }))).toBe(false);
  });

  it('rejects when confidence_score < 65', async () => {
    const { relaxedMainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(relaxedMainTableApproved(relaxedRow({ confidence_score: 60 }))).toBe(false);
  });

  it('rejects when rr_ratio < 1.5 (hard floor)', async () => {
    const { relaxedMainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(relaxedMainTableApproved(relaxedRow({ rr_ratio: 1.4, risk_reward: 1.4 }))).toBe(false);
  });

  it('rejects when maturity < 65 or cycles < 1', async () => {
    const { relaxedMainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(relaxedMainTableApproved(relaxedRow({ maturity_score: 60 }))).toBe(false);
    expect(relaxedMainTableApproved(relaxedRow({ validation_cycles_passed: 0 }))).toBe(false);
  });

  it('does NOT require stability_passed (unlike strict)', async () => {
    const { relaxedMainTableApproved, mainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    const r = relaxedRow({ stability_passed: false, maturity_score: 90, validation_cycles_passed: 5,
                            confidence_score: 80, final_score: 78, rr_ratio: 2.5, expected_edge_percent: 4 });
    // Strict still rejects because stability_passed=false; relaxed accepts.
    expect(mainTableApproved(r)).toBe(false);
    expect(relaxedMainTableApproved(r)).toBe(true);
  });
});

describe('earlySignalApproved — SMART-RELAXED-EARLY (tier 3)', () => {
  function bootstrapRow(over: Record<string, unknown> = {}): ConfirmedSignalRow {
    // Mirrors what scripts/bootstrapNseData.ts inserts: no maturity
    // tracker data, but all hard-floor fields populated.
    return row({
      classification:           'HIGH_CONVICTION',
      confidence_score:         62,
      final_score:              68,
      rr_ratio:                 1.6,
      risk_reward:              1.6,
      maturity_score:           null,
      validation_cycles_passed: null,
      stability_passed:         null,
      ...over,
    });
  }

  it('accepts a bootstrap row that fails BOTH strict and relaxed gates', async () => {
    const { earlySignalApproved, mainTableApproved, relaxedMainTableApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    const r = bootstrapRow();
    expect(mainTableApproved(r)).toBe(false);          // strict rejects (no tracker)
    expect(relaxedMainTableApproved(r)).toBe(false);   // relaxed also rejects (no tracker)
    expect(earlySignalApproved(r)).toBe(true);         // tier 3 accepts
  });

  it('rejects when classification is NO_TRADE (hard floor)', async () => {
    const { earlySignalApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(earlySignalApproved(bootstrapRow({ classification: 'NO_TRADE' }))).toBe(false);
  });

  it('rejects when confidence_score < 60 (hard floor)', async () => {
    const { earlySignalApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(earlySignalApproved(bootstrapRow({ confidence_score: 55 }))).toBe(false);
  });

  it('rejects when rr_ratio < 1.5 (hard floor)', async () => {
    const { earlySignalApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(earlySignalApproved(bootstrapRow({ rr_ratio: 1.3, risk_reward: 1.3 }))).toBe(false);
  });

  it('rejects when final_score < 65', async () => {
    const { earlySignalApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(earlySignalApproved(bootstrapRow({ final_score: 60 }))).toBe(false);
  });

  it('does NOT require any tracker fields', async () => {
    const { earlySignalApproved } = await import('@/lib/signals/confirmedSignalPolicy');
    expect(earlySignalApproved(bootstrapRow({
      maturity_score: null, validation_cycles_passed: null, stability_passed: null,
    }))).toBe(true);
  });
});

describe('strictValidationFilter — DATA-QUALITY §4', () => {
  it('keeps a clean row', () => {
    const r = row({
      entry_price: 100, stop_loss: 98, target1: 103,
      confidence_score: 70, final_score: 75, rr_ratio: 1.6,
      classification: 'HIGH_CONVICTION',
    });
    const out = strictValidationFilter([r]);
    expect(out.rows).toHaveLength(1);
    expect(out.rejected).toBe(0);
  });

  it('drops missing entry / stop / target', () => {
    const noEntry = row({ entry_price: 0 });
    const noStop  = row({ stop_loss: 0 });
    const noTgt   = row({ target1: 0 });
    const out = strictValidationFilter([noEntry, noStop, noTgt]);
    expect(out.rows).toHaveLength(0);
    expect(out.rejected).toBe(3);
  });

  it('drops rows below floors (conf < 60, final < 65, rr < 1.5)', () => {
    const lowConf  = row({ confidence_score: 55 });
    const lowFinal = row({ final_score: 60 });
    const lowRr    = row({ rr_ratio: 1.2, risk_reward: 1.2 });
    const out = strictValidationFilter([lowConf, lowFinal, lowRr]);
    expect(out.rows).toHaveLength(0);
    expect(out.rejected).toBe(3);
  });

  it('drops legacy NO_TRADE rows', () => {
    const r = row({
      entry_price: 100, stop_loss: 98, target1: 103,
      confidence_score: 70, final_score: 80, rr_ratio: 2.0,
      classification: 'NO_TRADE',
    });
    const out = strictValidationFilter([r]);
    expect(out.rows).toHaveLength(0);
    expect(out.rejected).toBe(1);
  });
});
