/**
 * Phase 9 — Product A Manual Signal Experience
 */
import { describe, expect, it } from 'vitest';
import {
  buildProductASignalCard,
  assertProductACardInvariants,
  PRODUCT_A_SIGNAL_CONTRACT_VERSION,
} from '@/lib/signals/productASignalContract';
import {
  buildWhyNotTradeReasons,
  translateRejectionToSubscriberCopy,
} from '@/lib/signals/whyNotTrade';
import {
  computeManualPositionSizing,
  formatTradePlanCopy,
  isProhibitedAction,
  PRODUCT_A_PROHIBITED_ACTIONS,
} from '@/lib/signals/manualExecutionSupport';
import {
  buildProductAScarcityMessage,
  enrichEmptyStateMessage,
} from '@/lib/signals/productAScarcity';
import {
  buildStrategyTransparencyBlock,
  wilsonConfidenceInterval,
  performanceSourceBadgeText,
} from '@/lib/signals/strategyTransparency';
import { buildEmptyStateMessage } from '@/lib/signals/signalTierClassifier';

describe('Phase 9 product A signal contract', () => {
  it('builds a canonical elite card with trade geometry', () => {
    const card = buildProductASignalCard({
      id: 42,
      symbol: 'RELIANCE',
      direction: 'BUY',
      strategy: 'fibonacci_pullback',
      confidence_score: 82,
      evidence_sample_size: 40,
      final_score: 85,
      institutional_score: 85,
      maturity_score: 70,
      entry_price: 100,
      stop_loss: 95,
      target1: 110,
      target2: 115,
      target3: 120,
      risk_reward: 2.0,
      livePrice: 101,
      status: 'ACTIVE',
      signal_status: 'APPROVED_SIGNAL',
      classification: 'INSTITUTIONAL_HIGH_CONVICTION',
      execution_allowed: true,
      generated_at: '2026-07-14T10:00:00Z',
      valid_until: '2026-07-15T10:00:00Z',
      regime: 'Bullish',
      sector: 'Energy',
      is_elite: true,
      audit_snapshot_id: 42,
    });
    expect(card.contractVersion).toBe(PRODUCT_A_SIGNAL_CONTRACT_VERSION);
    expect(card.signalState).toBe('elite');
    expect(card.executionAllowed).toBe(true);
    expect(card.target3).toBe(120);
    expect(card.reproducible).toBe(true);
    expect(assertProductACardInvariants(card)).toEqual([]);
    expect(card.prohibitedActions).toContain('place_order');
  });

  it('never marks expired/invalidated as actionable', () => {
    const expired = buildProductASignalCard({
      symbol: 'TCS',
      status: 'EXPIRED',
      execution_allowed: true,
      classification: 'HIGH_CONVICTION',
      is_elite: true,
      entry_price: 10,
      stop_loss: 9,
      target1: 12,
    });
    expect(expired.signalState).toBe('expired');
    expect(expired.executionAllowed).toBe(false);
    expect(assertProductACardInvariants(expired)).toEqual([]);

    const invalidated = buildProductASignalCard({
      symbol: 'INFY',
      live_invalidated: true,
      invalidation_reason: 'Stop breached',
      execution_allowed: true,
      is_elite: true,
    });
    expect(invalidated.signalState).toBe('invalidated');
    expect(invalidated.executionAllowed).toBe(false);
  });
});

describe('Phase 9 why-not-trade', () => {
  it('translates technical noise away from subscribers', () => {
    expect(translateRejectionToSubscriberCopy('Error: ECONNREFUSED at Object.query')).toMatch(/quality gates/i);
    expect(translateRejectionToSubscriberCopy('REJECTED_LOW_RR')).toMatch(/Reward-risk/i);
  });

  it('emits concise beyond-entry and low-RR reasons', () => {
    const reasons = buildWhyNotTradeReasons({
      signalState: 'watchlist',
      executionAllowed: false,
      distanceFromEntryR: 1.4,
      rewardRisk: 1.0,
      missingFactors: ['Waiting for reaction confirmation at 61.8% retracement'],
    });
    expect(reasons.some((r) => /1\.4R beyond/i.test(r.message))).toBe(true);
    expect(reasons.some((r) => /Reward-risk/i.test(r.message))).toBe(true);
  });
});

describe('Phase 9 manual execution support', () => {
  it('sizes illustratively and blocks prohibited actions', () => {
    const sizing = computeManualPositionSizing({
      capitalInr: 100_000,
      entry: 100,
      stopLoss: 95,
      riskPct: 1,
    });
    expect(sizing.riskAmountInr).toBe(1000);
    expect(sizing.illustrativeQuantity).toBe(200);
    expect(sizing.note).toMatch(/never places broker orders/i);
    for (const a of PRODUCT_A_PROHIBITED_ACTIONS) {
      expect(isProhibitedAction(a)).toBe(true);
    }
    expect(formatTradePlanCopy({
      symbol: 'X',
      direction: 'BUY',
      entry: 1,
      stop: 0.9,
      target1: 1.2,
      target2: 1.3,
      target3: 1.4,
      rewardRisk: 2,
      validUntil: null,
    })).toMatch(/Manual execution only/);
  });
});

describe('Phase 9 scarcity', () => {
  it('handles zero elite gracefully without relax language', () => {
    const msg = buildProductAScarcityMessage({
      eliteCount: 0,
      actionableCount: 0,
      watchlistCount: 3,
    });
    expect(msg?.title).toMatch(/No elite setup/i);
    expect(msg?.subtitle).toMatch(/3 opportunit/i);
    expect(msg?.subtitle).not.toMatch(/relax|synthetic|fallback fill/i);

    const empty = buildEmptyStateMessage(
      {
        approved: [],
        developing: [{ symbol: 'A' } as never],
        scannerCandidates: [{ symbol: 'B' } as never],
        watchlist: [{ symbol: 'C' } as never],
        riskRestricted: [],
      },
      0,
    );
    expect(empty).toMatch(/No elite setup/i);
    expect(enrichEmptyStateMessage(null, {
      eliteCount: 0,
      actionableCount: 0,
      watchlistCount: 0,
    })).toMatch(/intentional/i);
  });
});

describe('Phase 9 strategy transparency', () => {
  it('labels sources and returns Wilson CI', () => {
    expect(performanceSourceBadgeText('backtest')).toMatch(/Backtested/i);
    expect(performanceSourceBadgeText('observed')).toMatch(/Live observed/i);
    const ci = wilsonConfidenceInterval(55, 100);
    expect(ci.lower).toBeGreaterThan(0.4);
    expect(ci.upper).toBeLessThan(0.7);
    const block = buildStrategyTransparencyBlock({
      resolvedSampleCount: 100,
      winRate: 55,
      expectancyR: 0.4,
      profitFactor: 1.5,
      maxDrawdownPct: -12,
      avgMfe: 2.1,
      avgMae: -1.2,
      healthLabel: 'STABLE',
      performanceSource: 'observed',
      lastCalibrationDate: '2026-07-14T00:00:00Z',
    });
    expect(block.sourcesClearlyLabelled).toBe(true);
    expect(block.oosWinRateCi.lower).toBeLessThan(block.oosWinRate);
  });
});
