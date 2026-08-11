import { describe, expect, it } from 'vitest';
import { runMaintenanceForDate } from '@/lib/maintenance/orchestrator';
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
    this.rows.set(this.key(input.jobName, input.tradingDate), { runId: input.runId, jobName: input.jobName,
      tradingDate: input.tradingDate, status: input.result.status, retryCount: 0 });
  }
  async fail(input: any) {
    this.rows.set(this.key(input.jobName, input.tradingDate), { runId: input.runId, jobName: input.jobName,
      tradingDate: input.tradingDate, status: 'failed', retryCount: input.retryCount, lastError: input.error });
  }
  async skip(input: any) {
    this.rows.set(this.key(input.jobName, input.tradingDate), { runId: input.runId, jobName: input.jobName,
      tradingDate: input.tradingDate, status: 'skipped', retryCount: 0, lastError: input.reason });
  }
  async getForDate(date: string) { return Array.from(this.rows.values()).filter((row) => row.tradingDate === date); }
}

function stages(events: string[], fail?: MaintenanceStageName): MaintenanceStage[] {
  const names: MaintenanceStageName[] = ['market_data', 'market_data_coverage', 'universe', 'signals', 'risk_geometry', 'manipulation'];
  return names.map((name, index) => ({ name, dependencies: index ? [names[index - 1]] : [], maxAttempts: 2,
    async run({ attempt }) { events.push(`${name}:${attempt}`); if (name === fail) throw new Error('boom'); return { status: 'succeeded' }; } }));
}

describe('daily maintenance orchestrator', () => {
  it('executes dependency order', async () => {
    const events: string[] = [];
    const result = await runMaintenanceForDate('2026-08-10', { store: new MemoryStore(), stages: stages(events), retryDelayMs: 0 });
    expect(result.status).toBe('succeeded');
    expect(events.map((event) => event.split(':')[0])).toEqual(['market_data', 'market_data_coverage', 'universe', 'signals', 'risk_geometry', 'manipulation']);
  });

  it('blocks downstream stages after a failed prerequisite and retries the failure', async () => {
    const events: string[] = [];
    const result = await runMaintenanceForDate('2026-08-10', { store: new MemoryStore(), stages: stages(events, 'signals'), retryDelayMs: 0 });
    expect(events.filter((event) => event.startsWith('signals'))).toHaveLength(2);
    expect(events.some((event) => event.startsWith('risk_geometry'))).toBe(false);
    expect(result.stages.find((stage) => stage.jobName === 'manipulation')?.status).toBe('skipped');
  });

  it('is idempotent for a completed trading date', async () => {
    const store = new MemoryStore();
    const events: string[] = [];
    await runMaintenanceForDate('2026-08-10', { store, stages: stages(events), retryDelayMs: 0 });
    await runMaintenanceForDate('2026-08-10', { store, stages: stages(events), retryDelayMs: 0 });
    expect(events).toHaveLength(6);
  });

  it('coalesces a concurrent invocation through the persistent claim', async () => {
    const store = new MemoryStore();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const one: MaintenanceStage[] = [{ name: 'market_data', dependencies: [], async run() { await gate; return { status: 'succeeded' }; } }];
    const first = runMaintenanceForDate('2026-08-10', { store, stages: one, runIdFactory: () => 'one' });
    await Promise.resolve();
    const second = await runMaintenanceForDate('2026-08-10', { store, stages: one, runIdFactory: () => 'two' });
    expect(second.status).toBe('busy');
    release();
    await first;
  });
});
