/**
 * maturityTracker — cycle-progression contract tests.
 *
 * Locks the fix for the production "Cycle 1 lock" symptom:
 *   • The hard-coded 60-min stale reset clashed with the always-on
 *     hourly full-market scan in bootInProc.ts. Realised
 *     inter-detection elapsed time was usually 60min + drift, so
 *     `minutesSinceLastSeen > 60` tripped on every re-detection and
 *     reset the tracker back to cycle 1. The maturity worker never
 *     got the 3 cycles it needs to promote, and the dashboard kept
 *     rendering scanner candidates with `validation_cycles_passed = 1`.
 *
 * The fix made the threshold env-tunable (TRACKER_STALE_RESET_MIN,
 * default 180) and surfaced a `resetReason` diagnostic. These tests
 * mock @/lib/db with a tiny in-memory shim and drive
 * `upsertTrackerOnDetection` through every branch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── In-memory mock state ────────────────────────────────────────────
interface MockTrackerRow {
  id:                       number;
  symbol:                   string;
  direction:                string;
  first_detected_at:        Date;
  last_seen_at:             Date;
  last_evaluated_at:        Date | null;
  validation_cycles_passed: number;
  maturity_score:           number;
  stage:                    string;
  stable:                   number;
  conviction_level:         string;
  last_signal_id:           number | null;
  promoted_snapshot_id:     number | null;
  stability_history_json:   string;
}

const mockState = {
  rows:    [] as MockTrackerRow[],
  nextId:  1,
};

vi.mock('@/lib/db', () => ({
  db: {
    query: async (sql: string, params: any[] = []) => {
      // SELECT by (symbol, direction)
      if (/^\s*SELECT\b/i.test(sql) && /q365_signal_maturity_tracker/i.test(sql)) {
        const [sym, dir] = params;
        const row = mockState.rows.find(
          (r) => r.symbol === sym && r.direction === dir,
        );
        return { rows: row ? [row] : [] };
      }
      // INSERT
      if (/^\s*INSERT\s+INTO\s+q365_signal_maturity_tracker/i.test(sql)) {
        const [
          symbol, direction, firstDetected, lastSeen,
          lastSignalId, historyJson,
        ] = params;
        const id = mockState.nextId++;
        const row: MockTrackerRow = {
          id,
          symbol, direction,
          first_detected_at: new Date(firstDetected.replace(' ', 'T') + 'Z'),
          last_seen_at:      new Date(lastSeen.replace(' ', 'T') + 'Z'),
          last_evaluated_at: null,
          validation_cycles_passed: 1,
          maturity_score: 0,
          stage: 'candidate',
          stable: 0,
          conviction_level: 'MEDIUM',
          last_signal_id: lastSignalId,
          promoted_snapshot_id: null,
          stability_history_json: historyJson,
        };
        mockState.rows.push(row);
        return { rows: [], insertId: id };
      }
      // UPDATE — reset path or live-bump path. We pattern-match on
      // the SET clause keywords so the mock doesn't have to parse SQL.
      if (/^\s*UPDATE\s+q365_signal_maturity_tracker/i.test(sql)) {
        const id = params[params.length - 1] as number;
        const row = mockState.rows.find((r) => r.id === id);
        if (!row) return { rows: [] };
        if (/validation_cycles_passed\s*=\s*1\b/.test(sql)) {
          // Reset path. Params order matches the SQL:
          //   first_detected_at, last_seen_at, last_signal_id, history, id
          const [first, last, lastSignalId, historyJson] = params;
          row.first_detected_at        = new Date(first.replace(' ', 'T') + 'Z');
          row.last_seen_at             = new Date(last.replace(' ', 'T') + 'Z');
          row.validation_cycles_passed = 1;
          row.maturity_score           = 0;
          row.stage                    = 'candidate';
          row.stable                   = 0;
          row.conviction_level         = 'MEDIUM';
          row.last_signal_id           = lastSignalId;
          row.promoted_snapshot_id     = null;
          row.stability_history_json   = historyJson;
        } else {
          // Bump path. Params order:
          //   last_seen_at, validation_cycles_passed, last_signal_id, history, id
          const [last, cycles, lastSignalId, historyJson] = params;
          row.last_seen_at             = new Date(last.replace(' ', 'T') + 'Z');
          row.validation_cycles_passed = Number(cycles);
          row.last_signal_id           = lastSignalId;
          row.stability_history_json   = historyJson;
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  },
}));

beforeEach(() => {
  mockState.rows   = [];
  mockState.nextId = 1;
  delete process.env.TRACKER_STALE_RESET_MIN;
  vi.useRealTimers();
});

afterEach(() => {
  vi.resetModules();
  vi.useRealTimers();
});

async function loadTracker() {
  return await import('@/lib/signal-engine/repository/maturityTracker');
}

const detection = (overrides: Partial<{
  symbol: string;
  direction: 'BUY' | 'SELL';
  signal_id: number;
}> = {}) => ({
  symbol:      overrides.symbol ?? 'TCS',
  direction:   overrides.direction ?? ('BUY' as 'BUY' | 'SELL'),
  signal_id:   overrides.signal_id ?? 1,
  entry_price: 100,
  stop_loss:   95,
  target1:     115,
  confidence:  72,
  final_score: 78,
  decay_state: 'fresh',
});

describe('getTrackerStaleResetMin — env-tunable threshold', () => {
  // MATURATION_AUDIT_2026-05 — default raised 180 → 360 because the
  // operator was seeing cycles stuck at 1 across multiple scans on
  // sparse pipeline cadences. Tests updated to match the new default.
  it('defaults to 360 minutes when TRACKER_STALE_RESET_MIN is unset', async () => {
    const { getTrackerStaleResetMin, TRACKER_STALE_RESET_DEFAULT_MIN } = await loadTracker();
    expect(TRACKER_STALE_RESET_DEFAULT_MIN).toBe(360);
    expect(getTrackerStaleResetMin()).toBe(360);
  });

  it('honours TRACKER_STALE_RESET_MIN when set', async () => {
    process.env.TRACKER_STALE_RESET_MIN = '90';
    const { getTrackerStaleResetMin } = await loadTracker();
    expect(getTrackerStaleResetMin()).toBe(90);
  });

  it('clamps to floor (30) when env value is too small', async () => {
    process.env.TRACKER_STALE_RESET_MIN = '5';
    const { getTrackerStaleResetMin } = await loadTracker();
    expect(getTrackerStaleResetMin()).toBe(30);
  });

  it('clamps to ceiling (1440) when env value is huge', async () => {
    process.env.TRACKER_STALE_RESET_MIN = '99999';
    const { getTrackerStaleResetMin } = await loadTracker();
    expect(getTrackerStaleResetMin()).toBe(1440);
  });

  it('falls back to default when env value is non-numeric', async () => {
    process.env.TRACKER_STALE_RESET_MIN = 'banana';
    const { getTrackerStaleResetMin } = await loadTracker();
    expect(getTrackerStaleResetMin()).toBe(360);
  });
});

describe('upsertTrackerOnDetection — first detection', () => {
  it('inserts a new tracker at cycle 1 with reason=never_seen', async () => {
    const svc = await loadTracker();
    const r = await svc.upsertTrackerOnDetection(detection());
    expect(r.cycles).toBe(1);
    expect(r.reset).toBe(false);
    expect(r.resetReason).toBe('never_seen');
    expect(r.minutesSinceLastSeen).toBeNull();
    expect(r.staleResetThresholdMin).toBe(360);
    expect(mockState.rows).toHaveLength(1);
    expect(mockState.rows[0].validation_cycles_passed).toBe(1);
  });
});

describe('upsertTrackerOnDetection — re-detection within threshold (cycles bump)', () => {
  it('repeated detection 30 minutes later increments to cycle 2', async () => {
    const svc = await loadTracker();
    const t0 = new Date('2026-05-03T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    await svc.upsertTrackerOnDetection(detection({ signal_id: 1 }));
    vi.setSystemTime(new Date(t0.getTime() + 30 * 60_000));
    const r = await svc.upsertTrackerOnDetection(detection({ signal_id: 2 }));
    expect(r.cycles).toBe(2);
    expect(r.reset).toBe(false);
    expect(r.resetReason).toBe('live');
    expect(r.minutesSinceLastSeen).toBeCloseTo(30, 1);
  });

  it('THIRD detection inside threshold reaches cycle 3 (promotion-eligible)', async () => {
    const svc = await loadTracker();
    const t0 = new Date('2026-05-03T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    await svc.upsertTrackerOnDetection(detection({ signal_id: 1 }));
    vi.setSystemTime(new Date(t0.getTime() + 30 * 60_000));
    await svc.upsertTrackerOnDetection(detection({ signal_id: 2 }));
    vi.setSystemTime(new Date(t0.getTime() + 60 * 60_000));
    const r = await svc.upsertTrackerOnDetection(detection({ signal_id: 3 }));
    expect(r.cycles).toBe(3);
  });
});

describe('upsertTrackerOnDetection — 65min after with TRACKER_STALE_RESET_MIN=180 (no reset)', () => {
  it('does NOT reset when re-detected at 65 minutes under a 180-minute threshold', async () => {
    process.env.TRACKER_STALE_RESET_MIN = '180';
    const svc = await loadTracker();
    const t0 = new Date('2026-05-03T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    await svc.upsertTrackerOnDetection(detection({ signal_id: 1 }));
    vi.setSystemTime(new Date(t0.getTime() + 65 * 60_000));
    const r = await svc.upsertTrackerOnDetection(detection({ signal_id: 2 }));
    expect(r.reset).toBe(false);
    expect(r.cycles).toBe(2);
    expect(r.resetReason).toBe('live');
    expect(r.minutesSinceLastSeen).toBeCloseTo(65, 1);
    expect(r.staleResetThresholdMin).toBe(180);
  });

  it('REGRESSION: under the legacy 60-minute threshold the same call WOULD reset', async () => {
    process.env.TRACKER_STALE_RESET_MIN = '60';
    const svc = await loadTracker();
    const t0 = new Date('2026-05-03T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    await svc.upsertTrackerOnDetection(detection({ signal_id: 1 }));
    vi.setSystemTime(new Date(t0.getTime() + 65 * 60_000));
    const r = await svc.upsertTrackerOnDetection(detection({ signal_id: 2 }));
    expect(r.reset).toBe(true);
    expect(r.resetReason).toBe('stale');
    expect(r.cycles).toBe(1);
  });
});

describe('upsertTrackerOnDetection — beyond threshold (resets)', () => {
  it('resets to cycle 1 with reason=stale when the gap exceeds the threshold', async () => {
    process.env.TRACKER_STALE_RESET_MIN = '180';
    const svc = await loadTracker();
    const t0 = new Date('2026-05-03T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    await svc.upsertTrackerOnDetection(detection({ signal_id: 1 }));
    vi.setSystemTime(new Date(t0.getTime() + 200 * 60_000));
    const r = await svc.upsertTrackerOnDetection(detection({ signal_id: 2 }));
    expect(r.reset).toBe(true);
    expect(r.resetReason).toBe('stale');
    expect(r.cycles).toBe(1);
    expect(r.minutesSinceLastSeen).toBeGreaterThan(180);
  });
});

describe('upsertTrackerOnDetection — promoted tracker (no-op)', () => {
  it('does NOT increment cycles when the tracker is promoted', async () => {
    const svc = await loadTracker();
    await svc.upsertTrackerOnDetection(detection({ signal_id: 1 }));
    // Promote externally — simulate the snapshot-promotion path.
    mockState.rows[0].stage                    = 'promoted';
    mockState.rows[0].validation_cycles_passed = 4;
    const r = await svc.upsertTrackerOnDetection(detection({ signal_id: 2 }));
    expect(r.reset).toBe(false);
    expect(r.cycles).toBe(4);
    expect(r.stage).toBe('promoted');
    // Promoted is a "live" report — not a stale reset event.
    expect(r.resetReason).toBe('live');
  });
});

describe('upsertTrackerOnDetection — terminated tracker resets', () => {
  it('a terminated tracker resets to cycle 1 with reason=terminated', async () => {
    const svc = await loadTracker();
    await svc.upsertTrackerOnDetection(detection({ signal_id: 1 }));
    mockState.rows[0].stage = 'terminated';
    const r = await svc.upsertTrackerOnDetection(detection({ signal_id: 2 }));
    expect(r.reset).toBe(true);
    expect(r.resetReason).toBe('terminated');
    expect(r.cycles).toBe(1);
  });

  it('terminated wins over stale when both apply', async () => {
    process.env.TRACKER_STALE_RESET_MIN = '60';
    const svc = await loadTracker();
    const t0 = new Date('2026-05-03T10:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(t0);
    await svc.upsertTrackerOnDetection(detection({ signal_id: 1 }));
    mockState.rows[0].stage = 'terminated';
    vi.setSystemTime(new Date(t0.getTime() + 200 * 60_000));
    const r = await svc.upsertTrackerOnDetection(detection({ signal_id: 2 }));
    expect(r.reset).toBe(true);
    expect(r.resetReason).toBe('terminated');
  });
});
