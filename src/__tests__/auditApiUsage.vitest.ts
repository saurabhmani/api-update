/**
 * auditApiUsage — compile + CI ceiling (Tests 2.1–2.3).
 */
import { describe, expect, it } from 'vitest';
import {
  PROJECTED_BUDGET_CEILING,
  computeMonthlyProjection,
  evaluateAuditBudget,
} from '../../scripts/auditApiUsageCore';

describe('auditApiUsage — CI budget gate', () => {
  it('2.1 — audit modules compile and export ceiling constants', () => {
    expect(PROJECTED_BUDGET_CEILING).toBe(95_000);
    expect(typeof computeMonthlyProjection).toBe('function');
    expect(typeof evaluateAuditBudget).toBe('function');
  });

  it('2.2 — projected usage 84,160/month passes the 95K ceiling', () => {
    expect(evaluateAuditBudget(84_160)).toBe('pass');
    expect(84_160).toBeLessThan(PROJECTED_BUDGET_CEILING);

    // Representative steady-state profile (batch 94, TTL=900s, cap=250) also passes.
    const projection = computeMonthlyProjection({
      ...process.env,
      CANDLE_MAX_PER_CYCLE: '250',
      INDIANAPI_EMULATED_BATCH_MAX: '94',
      CACHE_TTL_LIVE_PRICE_MS: '900000',
    });
    expect(projection.monthlyProjection).toBeLessThan(PROJECTED_BUDGET_CEILING);
    expect(evaluateAuditBudget(projection.monthlyProjection)).toBe('pass');
  });

  it('2.3 — projected usage 96,000/month fails the 95K ceiling', () => {
    expect(evaluateAuditBudget(96_000)).toBe('fail');
    expect(96_000).toBeGreaterThan(PROJECTED_BUDGET_CEILING);
  });
});
