/**
 * Stored-vs-Live signal consistency contract.
 *
 * Pins the RATEGAIN-class bug fix where the main /signals table showed
 * BUY APPROVED but the stock-detail page (live engine) returned
 * REJECTED with "Confidence below threshold". The single source of
 * truth is `revalidateInstrument`:
 *
 *   1. Latest non-invalidated q365_signals row is the displayed signal.
 *   2. Live `generateSignal()` is enrichment + revalidation, never the
 *      replacement BUY/SELL the user sees.
 *   3. Stored APPROVED ∧ live REJECTED → keep stored as displayed but
 *      attach a `revalidation` envelope and persist the invalidation
 *      so the next /api/signals poll drops the row from the main table.
 *
 * The five status branches drive both the UI banner ("Signal Changed
 * / Revalidated") and the persistInvalidation side-effect that
 * eliminates the stored row from the main BUY/SELL list. Each branch
 * is locked here so a future refactor can't silently re-introduce the
 * disagreement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock state ─────────────────────────────────────────────────────
interface StoredRow {
  id: number;
  symbol: string;
  instrument_key: string;
  exchange: string;
  direction: string;
  signal_type: string;
  confidence_score: number;
  signal_status: string;
  invalidation_reason: string | null;
  status: string;
  generated_at: string;
  scenario_tag: string;
  market_regime: string;
  market_stance: string;
  confidence_band: string;
  risk_score: number;
  risk_band: string;
  opportunity_score: number;
  portfolio_fit_score: number;
  regime_alignment: number;
  entry_price: number;
  stop_loss: number;
  target1: number;
  target2: number;
  risk_reward: number;
}

const mockState = {
  storedRows: [] as StoredRow[],
  liveSignal: null as any | null,
  capturedUpdates: [] as Array<{ sql: string; params: any[] }>,
  capturedInserts: [] as Array<{ sql: string; params: any[] }>,
};

vi.mock('@/lib/db', () => ({
  db: {
    query: async (sql: string, params: any[] = []) => {
      // Stored signal SELECT
      if (/^\s*SELECT[\s\S]+FROM\s+q365_signals\b/i.test(sql)) {
        const [ikey, sym] = params;
        const matched = mockState.storedRows.filter(
          (r) => r.instrument_key === ikey || r.symbol === sym,
        );
        return { rows: matched };
      }
      // Reasons SELECT
      if (/q365_signal_reasons/i.test(sql) && /^\s*SELECT/i.test(sql)) {
        return { rows: [] };
      }
      // UPDATE q365_signals
      if (/^\s*UPDATE\s+q365_signals/i.test(sql)) {
        mockState.capturedUpdates.push({ sql, params });
        return { rows: [], affectedRows: 1 };
      }
      // INSERT q365_signal_reasons
      if (/^\s*INSERT\s+INTO\s+q365_signal_reasons/i.test(sql)) {
        mockState.capturedInserts.push({ sql, params });
        return { rows: [], insertId: 1 };
      }
      // Instrument lookup (caller side; not relevant here)
      if (/FROM\s+instruments/i.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
  },
}));

vi.mock('@/lib/signal-engine/live/analyzeInstrument', () => ({
  generateSignal: vi.fn(async () => mockState.liveSignal),
  opportunityScore: (s: any) => Number(s?.opportunity_score ?? 0),
}));

beforeEach(() => {
  mockState.storedRows = [];
  mockState.liveSignal = null;
  mockState.capturedUpdates = [];
  mockState.capturedInserts = [];
});
afterEach(() => { vi.resetModules(); });

// ── Fixtures ──────────────────────────────────────────────────────
function storedBuyApproved(overrides: Partial<StoredRow> = {}): StoredRow {
  return {
    id: 101,
    symbol: 'RATEGAIN',
    instrument_key: 'NSE_EQ|RATEGAIN',
    exchange: 'NSE',
    direction: 'BUY',
    signal_type: 'BUY',
    confidence_score: 72,
    signal_status: 'APPROVED_SIGNAL',
    invalidation_reason: null,
    status: 'active',
    generated_at: new Date().toISOString(),
    scenario_tag: 'TREND_CONTINUATION',
    market_regime: 'BULL',
    market_stance: 'selective',
    confidence_band: 'actionable',
    risk_score: 35,
    risk_band: 'low',
    opportunity_score: 78,
    portfolio_fit_score: 70,
    regime_alignment: 80,
    entry_price: 700,
    stop_loss: 670,
    target1: 760,
    target2: 800,
    risk_reward: 2.0,
    ...overrides,
  };
}

function liveBuyOk() {
  return {
    instrument_key: 'NSE_EQ|RATEGAIN',
    tradingsymbol: 'RATEGAIN',
    exchange: 'NSE',
    direction: 'BUY',
    timeframe: 'swing',
    confidence: 70,
    risk_score: 35,
    opportunity_score: 76,
    portfolio_fit: 70,
    conviction_band: 'actionable',
    market_stance: 'selective',
    regime_alignment: 80,
    rejection_reasons: [],
    rejection_codes: [],
    signal_status: 'APPROVED_SIGNAL',
    final_score: 78,
    classification: 'HIGH_CONVICTION',
    factor_scores_phase4: {} as any,
    soft_warnings: [],
    blocked_by: {} as any,
    risk: 'Medium',
    scenario_tag: 'TREND_CONTINUATION',
    regime: 'BULL',
    entry_price: 700,
    stop_loss: 670,
    target1: 760,
    target2: 800,
    risk_reward: 2.0,
    factor_scores: {} as any,
    reasons: [],
    data_quality: 95,
    generated_at: new Date().toISOString(),
    score_raw: 0.78,
  };
}

function liveBuyRejected() {
  return {
    ...liveBuyOk(),
    confidence: 58,
    signal_status: 'NO_TRADE',
    rejection_reasons: ['Confidence 58 below threshold 60'],
    rejection_codes: ['CONFIDENCE_BELOW_FLOOR'],
    scenario_tag: 'NO_STRATEGY',
  };
}

async function loadModule() {
  return await import('@/lib/signal-engine/live/revalidateInstrument');
}

// ──────────────────────────────────────────────────────────────────
//  Case A — stored APPROVED + live APPROVED, same direction (consistent)
// ──────────────────────────────────────────────────────────────────
describe('revalidateInstrument — consistent', () => {
  it('returns status=consistent, display_source=live, no persist', async () => {
    mockState.storedRows = [storedBuyApproved()];
    mockState.liveSignal = liveBuyOk();
    const { revalidateInstrument } = await loadModule();
    const r = await revalidateInstrument('NSE_EQ|RATEGAIN', 'RATEGAIN', 'NSE');

    expect(r.revalidation.status).toBe('consistent');
    expect(r.revalidation.display_source).toBe('live');
    expect(r.revalidation.live_invalidated).toBe(false);
    expect(r.revalidation.banner).toBeNull();
    expect(r.approved).toBe(true);
    expect((r.signal as any)?.direction).toBe('BUY');
    expect(mockState.capturedUpdates).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────
//  Case B — stored APPROVED + live REJECTED (revalidated, the RATEGAIN bug)
// ──────────────────────────────────────────────────────────────────
describe('revalidateInstrument — stored APPROVED, live REJECTED (RATEGAIN scenario)', () => {
  it('returns status=revalidated, displays the stored BUY, attaches banner', async () => {
    mockState.storedRows = [storedBuyApproved()];
    mockState.liveSignal = liveBuyRejected();
    const { revalidateInstrument } = await loadModule();
    const r = await revalidateInstrument('NSE_EQ|RATEGAIN', 'RATEGAIN', 'NSE');

    expect(r.revalidation.status).toBe('revalidated');
    expect(r.revalidation.display_source).toBe('stored');
    expect(r.revalidation.live_invalidated).toBe(true);
    expect(r.revalidation.banner).toMatch(/Revalidated/);
    // approved=true so the UI keeps showing the BUY chip from stored;
    // the banner is what tells the operator the live engine disagreed.
    expect(r.approved).toBe(true);
    expect((r.signal as any)?.direction).toBe('BUY');
    expect((r.signal as any)?.source).toBe('stored_q365');
    // Live rejection metadata flows through for the UI to render.
    expect(r.rejection_reasons).toEqual(['Confidence 58 below threshold 60']);
    expect(r.rejection_codes).toEqual(['CONFIDENCE_BELOW_FLOOR']);
  });

  it('persists invalidation: q365_signals UPDATE sets invalidation_reason + signal_status=NO_TRADE + status=flagged', async () => {
    mockState.storedRows = [storedBuyApproved()];
    mockState.liveSignal = liveBuyRejected();
    const { revalidateInstrument } = await loadModule();
    await revalidateInstrument('NSE_EQ|RATEGAIN', 'RATEGAIN', 'NSE');

    const updates = mockState.capturedUpdates;
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const update = updates[0];
    expect(update.sql).toMatch(/UPDATE\s+q365_signals/i);
    expect(update.sql).toMatch(/invalidation_reason\s*=\s*\?/i);
    expect(update.sql).toMatch(/signal_status\s*=\s*\?/i);
    expect(update.sql).toMatch(/status\s*=\s*'flagged'/i);
    // Param order from persistInvalidation: [reasonHeader, signal_status, id]
    const [reasonHeader, signalStatus, storedId] = update.params;
    expect(reasonHeader).toMatch(/Live revalidation:.*NO_TRADE.*confidence 58/i);
    expect(signalStatus).toBe('NO_TRADE');
    expect(storedId).toBe(101);
  });

  it('appends rejection rows to q365_signal_reasons so the UI can render the why-list', async () => {
    mockState.storedRows = [storedBuyApproved()];
    mockState.liveSignal = liveBuyRejected();
    const { revalidateInstrument } = await loadModule();
    await revalidateInstrument('NSE_EQ|RATEGAIN', 'RATEGAIN', 'NSE');

    expect(mockState.capturedInserts.length).toBeGreaterThanOrEqual(1);
    const insert = mockState.capturedInserts[0];
    expect(insert.sql).toMatch(/INSERT\s+INTO\s+q365_signal_reasons/i);
    // Params include the storedId, type='rejection', and the live reason text.
    const flat = insert.params.flat ? insert.params.flat() : insert.params;
    expect(flat.join(' ')).toMatch(/rejection/);
    expect(flat.join(' ')).toMatch(/Confidence 58 below threshold 60/);
  });

  it('skips persistInvalidation when persistInvalidation=false (acceptance-test mode)', async () => {
    mockState.storedRows = [storedBuyApproved()];
    mockState.liveSignal = liveBuyRejected();
    const { revalidateInstrument } = await loadModule();
    const r = await revalidateInstrument(
      'NSE_EQ|RATEGAIN', 'RATEGAIN', 'NSE',
      { persistInvalidation: false },
    );
    expect(r.revalidation.status).toBe('revalidated');
    expect(mockState.capturedUpdates).toHaveLength(0);
    expect(mockState.capturedInserts).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────
//  Case C — no stored, live present (live_only)
// ──────────────────────────────────────────────────────────────────
describe('revalidateInstrument — live_only (no stored row)', () => {
  it('approved=true when live engine accepts', async () => {
    mockState.liveSignal = liveBuyOk();
    const { revalidateInstrument } = await loadModule();
    const r = await revalidateInstrument('NSE_EQ|TCS', 'TCS', 'NSE');
    expect(r.revalidation.status).toBe('live_only');
    expect(r.approved).toBe(true);
    expect((r.signal as any)?.direction).toBe('BUY');
    expect(mockState.capturedUpdates).toHaveLength(0);
  });

  it('approved=false when live engine rejects (live_invalidated=true, no stored to flag)', async () => {
    mockState.liveSignal = liveBuyRejected();
    const { revalidateInstrument } = await loadModule();
    const r = await revalidateInstrument('NSE_EQ|TCS', 'TCS', 'NSE');
    expect(r.revalidation.status).toBe('live_only');
    expect(r.revalidation.live_invalidated).toBe(true);
    expect(r.approved).toBe(false);
    // No stored row to invalidate.
    expect(mockState.capturedUpdates).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────
//  Case D — stored present, live engine returned null (stored_only)
// ──────────────────────────────────────────────────────────────────
describe('revalidateInstrument — stored_only (live engine null)', () => {
  it('keeps stored signal displayed, no invalidation persisted', async () => {
    mockState.storedRows = [storedBuyApproved()];
    mockState.liveSignal = null; // live engine couldn't compute
    const { revalidateInstrument } = await loadModule();
    const r = await revalidateInstrument('NSE_EQ|RATEGAIN', 'RATEGAIN', 'NSE');

    expect(r.revalidation.status).toBe('stored_only');
    expect(r.revalidation.live_invalidated).toBe(false);
    expect(r.approved).toBe(true);
    expect((r.signal as any)?.direction).toBe('BUY');
    expect((r.signal as any)?.source).toBe('stored_q365');
    expect(mockState.capturedUpdates).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────
//  Case E — neither stored nor live (no_data)
// ──────────────────────────────────────────────────────────────────
describe('revalidateInstrument — no_data', () => {
  it('returns approved=false, signal=null, no persist', async () => {
    const { revalidateInstrument } = await loadModule();
    const r = await revalidateInstrument('NSE_EQ|UNKNOWN', 'UNKNOWN', 'NSE');
    expect(r.revalidation.status).toBe('no_data');
    expect(r.approved).toBe(false);
    expect(r.signal).toBeNull();
    expect(mockState.capturedUpdates).toHaveLength(0);
  });
});

// ──────────────────────────────────────────────────────────────────
//  Cross-cutting consistency invariant
// ──────────────────────────────────────────────────────────────────
describe('revalidateInstrument — invariant: detail page never returns naked REJECTED for a row the main table promised', () => {
  it('stored APPROVED + live REJECTED → approved=true so UI never shows REJECTED pill', async () => {
    // The MarketDetail UI shows the REJECTED pill only when
    // signalData.approved === false && !isRevalidated. The contract
    // that prevents the disagreement is approved=true in case B.
    mockState.storedRows = [storedBuyApproved()];
    mockState.liveSignal = liveBuyRejected();
    const { revalidateInstrument } = await loadModule();
    const r = await revalidateInstrument('NSE_EQ|RATEGAIN', 'RATEGAIN', 'NSE');
    const isRevalidated = r.revalidation.status === 'revalidated';
    const wouldShowRejectedPill = r.approved === false && !isRevalidated;
    expect(wouldShowRejectedPill).toBe(false);
  });

  it('after revalidation, the SQL gate excludes the row from the main table on the next poll', async () => {
    // The main /signals SQL paths gate on `invalidation_reason IS NULL`
    // (closedMarketSignals.ts and confirmedSignalPolicy.ts predicates).
    // Once persistInvalidation populates that column, the row drops on
    // the next read. We assert the UPDATE actually sets the column to a
    // non-null value so the gate fires.
    mockState.storedRows = [storedBuyApproved()];
    mockState.liveSignal = liveBuyRejected();
    const { revalidateInstrument } = await loadModule();
    await revalidateInstrument('NSE_EQ|RATEGAIN', 'RATEGAIN', 'NSE');
    const update = mockState.capturedUpdates[0];
    const [reasonHeader] = update.params;
    expect(reasonHeader).toBeTruthy();
    expect(typeof reasonHeader).toBe('string');
    expect(String(reasonHeader).length).toBeGreaterThan(0);
  });

  it('only persists when stored.signal_status === APPROVED_SIGNAL (DEVELOPING_SETUP rows do not get flipped)', async () => {
    // A row already in DEVELOPING_SETUP shouldn't be re-flagged — it
    // wasn't promising the user a tradable BUY in the first place.
    mockState.storedRows = [storedBuyApproved({ signal_status: 'DEVELOPING_SETUP' })];
    mockState.liveSignal = liveBuyRejected();
    const { revalidateInstrument } = await loadModule();
    await revalidateInstrument('NSE_EQ|RATEGAIN', 'RATEGAIN', 'NSE');
    expect(mockState.capturedUpdates).toHaveLength(0);
  });
});
