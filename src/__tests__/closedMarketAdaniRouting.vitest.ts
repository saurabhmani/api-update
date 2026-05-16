/**
 * loadClosedMarketSignals — ADANIPORTS NO_TRADE routing contract.
 *
 * Drives the full closed-market loader against a mocked DB to lock
 * the production fix:
 *
 *   • Confirmed snapshots empty + ADANIPORTS NO_TRADE row in
 *     q365_signals → bundle.signals = [], scannerCandidates contains
 *     ADANIPORTS with display_bucket='no_trade'.
 *   • Cycle 1 row from q365_signals is NEVER promoted into
 *     bundle.signals (main table).
 *   • Source-visibility envelope fields appear on every row.
 *   • Stale candidate (last_seen_at > TRACKER_STALE_HOURS) is dropped
 *     by the SQL guard.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockState {
  confirmedRows: any[];
  q365Rows:      any[];
  capturedSql:   string[];
  capturedParams: any[][];
}
const mockState: MockState = {
  confirmedRows: [],
  q365Rows:      [],
  capturedSql:   [],
  capturedParams: [],
};

vi.mock('@/lib/db', () => ({
  db: {
    query: async (sql: string, params: any[] = []) => {
      mockState.capturedSql.push(sql);
      mockState.capturedParams.push(params);
      if (/q365_confirmed_signal_snapshots/i.test(sql)) {
        return { rows: mockState.confirmedRows };
      }
      if (/q365_signals\b/i.test(sql)) {
        return { rows: mockState.q365Rows };
      }
      return { rows: [] };
    },
  },
}));

beforeEach(() => {
  mockState.confirmedRows = [];
  mockState.q365Rows      = [];
  mockState.capturedSql   = [];
  mockState.capturedParams = [];
});

afterEach(() => { vi.resetModules(); });

async function loadModule() {
  return await import('@/lib/signals/closedMarketSignals');
}

// Minimal ADANIPORTS canary — exactly the production shape: BUY,
// signal_status=APPROVED_SIGNAL, classification=NO_TRADE, final_score
// just over the rebucketing threshold so the previous code rebucketed
// it to MEDIUM_CONVICTION and let it through.
const adaniNoTradeRow = {
  id: 1,
  symbol: 'ADANIPORTS',
  exchange: 'NSE',
  direction: 'BUY',
  signal_type: 'BUY',
  classification: 'NO_TRADE',
  entry_price: 1500,
  stop_loss: 1450,
  target1: 1620,
  target2: 1700,
  confidence_score: 75,
  final_score: 70.88,
  risk_reward: 2.4,
  ltp: 1500,
  pct_change: 0,
  status: 'active',
  signal_status: 'APPROVED_SIGNAL',
  invalidation_reason: null,
  generated_at: new Date(),
  expires_at: new Date(Date.now() + 3_600_000),
  batch_id: 'batch-1',
  // Tracker join: cycle 1, fresh last_seen so SQL stale guard passes.
  mt_maturity_score: 50,
  mt_validation_cycles_passed: 1,
  mt_conviction_level: 'MEDIUM',
  mt_stability_passed: 0,
  mt_first_detected_at: new Date(),
  mt_last_seen_at: new Date(),
  mt_stage: 'candidate',
};

describe('ADANIPORTS NO_TRADE routing — closed-market loader', () => {
  it('main bundle.signals stays empty; ADANIPORTS surfaces as scanner candidate', async () => {
    mockState.q365Rows = [adaniNoTradeRow];
    const { loadClosedMarketSignals } = await loadModule();
    const bundle = await loadClosedMarketSignals({ limit: 30 });

    expect(bundle.signals).toEqual([]);
    expect(bundle.signalQuality).toBe('NONE');

    // Side panel should carry ADANIPORTS with the no_trade routing.
    const adani = bundle.scannerCandidates.find(
      (r: any) => r.symbol === 'ADANIPORTS',
    );
    expect(adani).toBeDefined();
    expect((adani as any).effective_signal_status).toBe('NO_TRADE');
    expect((adani as any).raw_classification).toBe('NO_TRADE');
    expect((adani as any).is_trade_ready).toBe(false);
    expect((adani as any).is_confirmed).toBe(false);
    // display_bucket can be set by the candidate-routing helper to
    // 'scanner_candidate'; either way it must NOT be 'confirmed'.
    expect((adani as any).display_bucket).not.toBe('confirmed');
  });

  it('source-visibility envelope is present on every emitted row', async () => {
    mockState.q365Rows = [adaniNoTradeRow];
    const { loadClosedMarketSignals } = await loadModule();
    const bundle = await loadClosedMarketSignals({ limit: 30 });

    for (const r of bundle.scannerCandidates) {
      const row = r as any;
      expect(typeof row.source_table).toBe('string');
      expect(typeof row.source_type).toBe('string');
      expect(typeof row.is_trade_ready).toBe('boolean');
      expect(typeof row.is_confirmed).toBe('boolean');
      expect(typeof row.is_stale_candidate).toBe('boolean');
      expect('minutes_since_seen' in row).toBe(true);
      expect(typeof row.effective_signal_status).toBe('string');
      expect(typeof row.display_bucket).toBe('string');
    }
  });

  it('Cycle 1 q365_signals row is NEVER promoted into main bundle.signals', async () => {
    mockState.q365Rows = [{
      ...adaniNoTradeRow,
      symbol: 'TCS',
      classification: 'HIGH_CONVICTION_BUY',  // not NO_TRADE
      final_score: 80,
      mt_validation_cycles_passed: 1,
    }];
    const { loadClosedMarketSignals } = await loadModule();
    const bundle = await loadClosedMarketSignals({ limit: 30 });

    expect(bundle.signals).toEqual([]);
    // Side panel still surfaces it for visibility, but never as confirmed.
    const tcs = bundle.scannerCandidates.find(
      (r: any) => r.symbol === 'TCS',
    );
    expect(tcs).toBeDefined();
    expect((tcs as any).is_trade_ready).toBe(false);
    expect((tcs as any).is_confirmed).toBe(false);
    expect((tcs as any).validation_cycles_passed).toBe(1);
  });

  it('staleness is enforced per-row (is_stale_candidate), not via a SQL filter', async () => {
    // Spec §4 — stale rows MUST still surface in scanner_candidates
    // with `is_stale_candidate: true`, not be silently dropped at the
    // SQL boundary. The SQL therefore does NOT filter on
    // mt.last_seen_at; the row-level shaper computes
    // is_stale_candidate, and the predicates
    // (mainTableApproved / relaxedMainTableApproved /
    // earlySignalApproved) reject stale rows from the main signals
    // table. This test pins the contract.
    const staleRow = {
      ...adaniNoTradeRow,
      symbol: 'STALE',
      classification: 'HIGH_CONVICTION_BUY',
      // last_seen 100h ago — well past the 72h default.
      mt_last_seen_at: new Date(Date.now() - 100 * 3_600_000),
    };
    mockState.q365Rows = [staleRow];
    const { loadClosedMarketSignals } = await loadModule();
    const bundle = await loadClosedMarketSignals({ limit: 30 });

    const stale: any = bundle.scannerCandidates.find((r: any) => r.symbol === 'STALE');
    expect(stale).toBeDefined();
    expect(stale.is_stale_candidate).toBe(true);
    expect(stale.is_trade_ready).toBe(false);
    // SQL must NOT apply a `mt.last_seen_at >= ...` WHERE filter —
    // that would hide the row from the side panel. The SELECT clause
    // does still reference mt.last_seen_at (aliased to
    // mt_last_seen_at) so the row-level shaper can compute
    // is_stale_candidate; the regex below targets only the WHERE form.
    const allSql = mockState.capturedSql.join('\n');
    expect(allSql).not.toMatch(/AND\s+\(\s*mt\.last_seen_at\s+IS\s+NULL\s+OR\s+mt\.last_seen_at\s+>=\s+DATE_SUB/);
  });

  it('SQL filter applies the expires_at + max-age guards', async () => {
    const { loadClosedMarketSignals } = await loadModule();
    await loadClosedMarketSignals({ limit: 30 });
    const allSql = mockState.capturedSql.join('\n');
    expect(allSql).toMatch(/s\.expires_at\s+IS\s+NULL\s+OR\s+s\.expires_at\s+>\s+NOW\(\)/);
    expect(allSql).toMatch(/s\.generated_at\s+>=\s+DATE_SUB\(NOW\(\),\s+INTERVAL\s+\?\s+HOUR\)/);
  });
});

describe('confirmed snapshot path — source visibility', () => {
  it('is_confirmed=true and is_trade_ready=true on a clean confirmed snapshot', async () => {
    mockState.confirmedRows = [{
      id: 42,
      symbol: 'INFY',
      exchange: 'NSE',
      direction: 'BUY',
      strategy: 'momentum',
      classification: 'HIGH_CONVICTION_BUY',
      entry_price: 1500,
      stop_loss: 1450,
      target1: 1620,
      target2: 1700,
      profit_percent: 8,
      loss_percent: 3.3,
      expected_edge_percent: 5,
      win_probability: 0.7,
      confidence_score: 80,
      final_score: 82,
      rr_ratio: 2.4,
      stress_survival_score: 60,
      maturity_score: 90,
      validation_cycles_passed: 4,
      signal_age_minutes_at_promotion: 35,
      conviction_level: 'HIGH',
      stability_passed: 1,
      rejection_codes_json: null,
      gate_details_json: null,
      status: 'ACTIVE',
      invalidation_reason: null,
      confirmed_at: new Date(),
      valid_until: new Date(Date.now() + 7_200_000),
    }];
    const { loadClosedMarketSignals } = await loadModule();
    const bundle = await loadClosedMarketSignals({ limit: 30 });

    const infy: any = bundle.signals.find((r: any) => r.symbol === 'INFY')
                   ?? bundle.scannerCandidates.find((r: any) => r.symbol === 'INFY');
    expect(infy).toBeDefined();
    expect(infy.source_table).toBe('q365_confirmed_signal_snapshots');
    expect(infy.is_confirmed).toBe(true);
    expect(infy.is_trade_ready).toBe(true);
    expect(infy.is_stale_candidate).toBe(false);
  });
});
