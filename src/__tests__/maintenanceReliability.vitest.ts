import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  evaluateManipulationSessionHealth,
  getExpectedManipulationScanSession,
} from '@/lib/manipulation-engine/expectedManipulationSession';
import { parseIsoDateOnly } from '@/lib/dates/isoDateOnly';
import { runMaintenanceForDate } from '@/lib/maintenance/orchestrator';
import { findMaintenanceDatesToRun } from '@/lib/maintenance/scheduler';
import { runMaintenanceBootCatchUp } from '@/lib/maintenance/bootCatchUp';
import type {
  JobRunStore, MaintenanceRunRecord, MaintenanceStage, MaintenanceStageName, StageResult,
} from '@/lib/maintenance/types';

class MemoryStore implements JobRunStore {
  rows = new Map<string, MaintenanceRunRecord>();
  claims = 0;
  private key(name: MaintenanceStageName, date: string) { return `${date}:${name}`; }
  async claim({ runId, jobName, tradingDate }: any) {
    this.claims++;
    const key = this.key(jobName, tradingDate);
    const row = this.rows.get(key);
    if (row?.status === 'succeeded') return 'completed' as const;
    if (row?.status === 'running') return 'busy' as const;
    this.rows.set(key, { runId, jobName, tradingDate, status: 'running', retryCount: 0 });
    return 'claimed' as const;
  }
  async finish(input: { runId: string; jobName: MaintenanceStageName; tradingDate: string; result: StageResult }) {
    this.rows.set(this.key(input.jobName, input.tradingDate), {
      runId: input.runId, jobName: input.jobName, tradingDate: input.tradingDate,
      status: input.result.status, retryCount: 0,
    });
  }
  async fail(input: any) {
    this.rows.set(this.key(input.jobName, input.tradingDate), {
      runId: input.runId, jobName: input.jobName, tradingDate: input.tradingDate,
      status: 'failed', retryCount: input.retryCount, lastError: input.error,
    });
  }
  async skip(input: any) {
    this.rows.set(this.key(input.jobName, input.tradingDate), {
      runId: input.runId, jobName: input.jobName, tradingDate: input.tradingDate,
      status: 'skipped', retryCount: 0, lastError: input.reason,
    });
  }
  async getForDate(date: string) {
    return Array.from(this.rows.values()).filter((row) => row.tradingDate === date);
  }
}

/** Aug 11 2026 22:28 IST — production restart after missed 20:30 window */
const AUG11_2228_IST = new Date('2026-08-11T16:58:00.000Z').getTime();
/** Aug 12 2026 09:00 IST — next morning, candles advanced */
const AUG12_0900_IST = new Date('2026-08-12T03:30:00.000Z').getTime();
/** Aug 12 2026 21:00 IST — after maintenance due */
const AUG12_2100_IST = new Date('2026-08-12T15:30:00.000Z').getTime();
/** Aug 15 2026 Saturday 10:00 IST */
const SAT_1000_IST = new Date('2026-08-15T04:30:00.000Z').getTime();
/** Aug 15 2026 Independence Day holiday (in builtin list) — use Aug 15 is actually Saturday in 2026. Aug 15 is Saturday AND holiday? Builtin has 2026-08-15 Independence Day */
const HOLIDAY_IST = new Date('2026-08-15T04:30:00.000Z').getTime();

describe('maintenance reliability — Aug 11 incident regression', () => {
  describe('Test G — MySQL DATE timezone', () => {
    it('preserves 2026-08-11 from Date object in IST process context', () => {
      const jsDate = new Date('2026-08-10T18:30:00.000Z');
      expect(parseIsoDateOnly('2026-08-11')).toBe('2026-08-11');
      expect(parseIsoDateOnly('2026-08-11T13:35:00.000Z')).toBe('2026-08-11');
      expect(parseIsoDateOnly(jsDate)).not.toBe('2026-08-10');
    });
  });

  describe('Test C — next morning candle advance', () => {
    it('does not stale Aug 11 scan when new-day candle exists before maintenance', () => {
      const health = evaluateManipulationSessionHealth({
        latestSnapshotSessionDate: '2026-08-11',
        snapshotCount30d:          900,
        nowMs:                     AUG12_0900_IST,
      });
      expect(health.isStale).toBe(false);
      expect(health.status).toBe('FRESH');
    });
  });

  describe('Test D — manipulation genuinely missed', () => {
    it('is stale after maintenance window when scan session is behind', () => {
      const health = evaluateManipulationSessionHealth({
        latestSnapshotSessionDate: '2026-08-11',
        snapshotCount30d:          900,
        nowMs:                     AUG12_2100_IST,
      });
      expect(health.isStale).toBe(true);
      expect(health.status).toBe('STALE');
    });
  });

  describe('Test E — weekend', () => {
    it('does not require new scan on Saturday when Friday scan exists', () => {
      const expected = getExpectedManipulationScanSession(SAT_1000_IST);
      expect(expected.lifecyclePhase).toBe('weekend');
      expect(expected.scanDue).toBe(false);
      const health = evaluateManipulationSessionHealth({
        latestSnapshotSessionDate: '2026-08-14',
        snapshotCount30d:          500,
        nowMs:                     SAT_1000_IST,
      });
      expect(health.isStale).toBe(false);
    });
  });

  describe('Test F — exchange holiday', () => {
    it('does not false-stale on Independence Day when prior session scan exists', () => {
      const expected = getExpectedManipulationScanSession(HOLIDAY_IST);
      expect(['weekend', 'holiday']).toContain(expected.lifecyclePhase);
      const health = evaluateManipulationSessionHealth({
        latestSnapshotSessionDate: '2026-08-14',
        snapshotCount30d:          500,
        nowMs:                     HOLIDAY_IST,
      });
      expect(health.isStale).toBe(false);
    });
  });

  describe('Test J — concurrent catch-up', () => {
    it('second invocation gets busy while first stage holds claim', async () => {
      const store = new MemoryStore();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const stages: MaintenanceStage[] = [{
        name: 'market_data', dependencies: [], async run() { await gate; return { status: 'succeeded' }; },
      }];
      const first = runMaintenanceForDate('2026-08-11', { store, stages, runIdFactory: () => 'run-a' });
      await Promise.resolve();
      const second = await runMaintenanceForDate('2026-08-11', { store, stages, runIdFactory: () => 'run-b' });
      expect(second.status).toBe('busy');
      release();
      await first;
    });
  });

  describe('Test B — restart after successful maintenance', () => {
    it('does not re-execute stages when health_snapshot succeeded', async () => {
      const store = new MemoryStore();
      const events: string[] = [];
      const stages: MaintenanceStage[] = [{
        name: 'health_snapshot', dependencies: [], async run() {
          events.push('ran');
          return { status: 'succeeded' };
        },
      }];
      store.rows.set('2026-08-11:health_snapshot', {
        runId: 'prior', jobName: 'health_snapshot', tradingDate: '2026-08-11',
        status: 'succeeded', retryCount: 0,
      });
      await runMaintenanceForDate('2026-08-11', { store, stages });
      expect(events).toHaveLength(0);
    });
  });
});

describe('Test A — boot catch-up after missed 20:30 window', () => {
  it('runs scheduled maintenance for pending dates', async () => {
    const scheduler = await import('@/lib/maintenance/scheduler');
    const findSpy = vi.spyOn(scheduler, 'findMaintenanceDatesToRun').mockResolvedValue(['2026-08-11']);
    const runSpy = vi.spyOn(scheduler, 'runScheduledMaintenance').mockResolvedValue([{
      tradingDate: '2026-08-11', runId: 'catchup-1', status: 'succeeded', stages: [],
    }]);

    const dbMod = await import('@/lib/db');
    const dbSpy = vi.spyOn(dbMod.db, 'query').mockResolvedValue({ rows: [] });

    const results = await runMaintenanceBootCatchUp({ reason: 'scheduler-boot', maxDates: 2 });
    expect(results).toHaveLength(1);
    expect(runSpy).toHaveBeenCalledWith({ lookbackTradingDays: 7, maxDates: 2 });

    findSpy.mockRestore();
    runSpy.mockRestore();
    dbSpy.mockRestore();
  });
});

describe('Test H — nightly backtest stage export', () => {
  it('exports durable producer for maintenance DAG', async () => {
    const mod = await import('@/lib/maintenance/nightlyBacktestStage');
    expect(typeof mod.runNightlyBacktestForTradingDate).toBe('function');
    expect(typeof mod.defaultNightlyBacktestEndDate).toBe('function');
  });
});

describe('Test I — missed daily report in maintenance stages', () => {
  it('includes daily_report stage in production DAG', async () => {
    const { createProductionMaintenanceStages } = await import('@/lib/maintenance/productionStages');
    const names = createProductionMaintenanceStages().map((s) => s.name);
    expect(names).toContain('daily_report');
    expect(names).toContain('nightly_backtest');
    expect(names.indexOf('nightly_backtest')).toBeLessThan(names.indexOf('daily_report'));
  });
});
