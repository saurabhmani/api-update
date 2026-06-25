/**
 * Budget expansion acceptance — audit pass + degradation ladder (Scenarios A–D).
 */
import { describe, expect, it } from 'vitest';
import './loadEnv';
import {
  PROJECTED_BUDGET_CEILING,
  evaluateAuditBudget,
} from '../../scripts/auditApiUsageCore';
import {
  classify,
  maxDeepForLevel,
  triggerMultForLevel,
} from '@/lib/marketData/apiBudgetGuard';
import { CONFIG } from '@/lib/marketData/schedulerConfig';
import { INDIANAPI_MONTHLY_LIMIT } from '@/providers/adapters/indianApiUsageTracker';
import { resolveIndianApiTransportCapacity } from '@/providers/adapters/IndianAPIAdapter';

describe('budget expansion — Scenarios A–D', () => {
  it('Scenario A — projected usage 84,160/month passes audit and stays normal', () => {
    expect(evaluateAuditBudget(84_160)).toBe('pass');
    expect(84_160).toBeLessThan(PROJECTED_BUDGET_CEILING);
    expect(84_160).toBeLessThan(INDIANAPI_MONTHLY_LIMIT);
    expect(classify(84_160)).toBe('normal');
    expect(maxDeepForLevel('normal')).toBe(CONFIG.maxDeepFetchesPerCycle);
    expect(triggerMultForLevel('normal')).toBe(1.0);
  });

  it('Scenario B — usage above 85,000/month enters budget reduction (soft) mode', () => {
    expect(CONFIG.budget.monthlySoftCap).toBe(85_000);
    expect(classify(85_000)).toBe('soft');
    expect(classify(85_001)).toBe('soft');
    expect(maxDeepForLevel('soft')).toBe(4);
    expect(triggerMultForLevel('soft')).toBe(1.2);
  });

  it('Scenario C — usage above 95,000/month activates critical (hard) mode', () => {
    expect(CONFIG.budget.monthlyHardLimit).toBe(95_000);
    expect(classify(95_000)).toBe('hard');
    expect(classify(95_001)).toBe('hard');
    expect(maxDeepForLevel('hard')).toBe(2);
    expect(triggerMultForLevel('hard')).toBe(1.3);
  });

  it('Scenario D — usage above 100,000/month activates freeze protection', () => {
    expect(CONFIG.budget.monthlyFreeze).toBe(100_000);
    expect(INDIANAPI_MONTHLY_LIMIT).toBe(100_000);
    expect(classify(100_000)).toBe('freeze');
    expect(classify(100_001)).toBe('freeze');
    expect(maxDeepForLevel('freeze')).toBe(0);
    expect(triggerMultForLevel('freeze')).toBe(999);
  });
});

describe('budget expansion — deliverable checklist', () => {
  it('Budget Config Applied — .env.local ladder matches runtime CONFIG', () => {
    expect(CONFIG.budget.monthlySoftTarget).toBe(65_000);
    expect(CONFIG.budget.monthlySoftCap).toBe(85_000);
    expect(CONFIG.budget.monthlyHardLimit).toBe(95_000);
    expect(CONFIG.budget.monthlyFreeze).toBe(100_000);
    expect(CONFIG.budget.dailySoftCap).toBe(4_500);
  });

  it('Audit Ceiling Updated — CI gate at 95K', () => {
    expect(PROJECTED_BUDGET_CEILING).toBe(95_000);
  });

  it('HTTP Agent Scaled — batch=200 raises maxSockets to 200', () => {
    const { httpAgentMaxSockets } = resolveIndianApiTransportCapacity(
      process.env.INDIANAPI_EMULATED_BATCH_MAX,
    );
    expect(httpAgentMaxSockets).toBe(200);
  });

  it('Throughput Increased — candle cap=250 yields 800 calls/day refresh band', async () => {
    const { computeMonthlyProjection } = await import('../../scripts/auditApiUsageCore');
    const projection = computeMonthlyProjection({
      ...process.env,
      CANDLE_MAX_PER_CYCLE: '250',
    });
    const candlePath = projection.paths.find((p) =>
      p.name.includes('15-min candle refresh'),
    );
    expect(candlePath?.perDay).toBe(800);
  });

  it('Budget Controls Active — degradation ladder thresholds wired', () => {
    expect(classify(CONFIG.budget.monthlySoftCap - 1)).toBe('normal');
    expect(classify(CONFIG.budget.monthlySoftCap)).toBe('soft');
    expect(classify(CONFIG.budget.monthlyHardLimit)).toBe('hard');
    expect(classify(CONFIG.budget.monthlyFreeze)).toBe('freeze');
  });
});
