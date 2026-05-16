// ════════════════════════════════════════════════════════════════
//  F2: Contextual Modifiers News Tests
//
//  Verifies deterministic, conservative modifier behavior:
//    1. bullish direct high-confidence → modest positive modifier
//    2. bearish direct high-confidence → reduces conviction
//    3. high manipulation suspicion → caution/suppression
//    4. low-confidence generic news → limited effect
// ════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { computeContextualModifiers } from '@/lib/signal-engine/context/contextualModifiers';
import type { MacroContext, NewsContext, EventRiskSnapshot, SignalFreshness, FeedbackState } from '@/lib/signal-engine/types/phase4.types';

function defaultMacro(): MacroContext {
  return { marketTone: 'neutral', riskMode: 'neutral', volatilityState: 'normal', sectorLeadership: [], macroEventProximity: 'none' };
}

function defaultEventRisk(): EventRiskSnapshot {
  return { eventRiskScore: 10, eventRiskBand: 'low', eventRiskPenalty: 0, eventTags: ['none'], comment: 'No events' };
}

function defaultFreshness(): SignalFreshness {
  return { ageBars: 0, ageHours: 0, freshnessScore: 100, decayState: 'fresh', urgencyTag: 'normal', priceDriftPct: 0 };
}

function defaultFeedback(): FeedbackState {
  return { strategyRecentWinRate: null, strategyEnvironmentFit: 'moderate', confidenceCalibrationState: 'insufficient_data' };
}

function enrichedBullishNews(): NewsContext {
  return {
    bias: 'positive',
    strength: 0.7,
    freshnessHours: 4,
    sourceConfidence: 0.8,
    eventTags: ['earnings'],
    headline: 'Strong earnings beat',
    symbolImpactScore: 0.75,
    eventRiskScore: 0.2,
    manipulationSuspicion: 0.05,
    noveltyScore: 0.8,
    directnessScore: 0.9,
    sentimentScore: 0.6,
    eventType: 'earnings',
    sourceTier: 'high',
  };
}

function enrichedBearishNews(): NewsContext {
  return {
    bias: 'negative',
    strength: 0.65,
    freshnessHours: 2,
    sourceConfidence: 0.75,
    eventTags: ['regulatory'],
    headline: 'SEBI investigation',
    symbolImpactScore: 0.6,
    eventRiskScore: 0.55,
    manipulationSuspicion: 0.1,
    noveltyScore: 0.85,
    directnessScore: 0.85,
    sentimentScore: -0.6,
    eventType: 'regulatory',
    sourceTier: 'high',
  };
}

function highManipulationNews(): NewsContext {
  return {
    bias: 'positive',
    strength: 0.8,
    freshnessHours: 1,
    sourceConfidence: 0.3,
    eventTags: ['general'],
    headline: 'MASSIVE BREAKOUT GUARANTEED',
    symbolImpactScore: 0.5,
    eventRiskScore: 0.4,
    manipulationSuspicion: 0.7,
    noveltyScore: 0.3,
    directnessScore: 0.6,
    sentimentScore: 0.3,
    eventType: 'general',
    sourceTier: 'low',
  };
}

function weakGenericNews(): NewsContext {
  return {
    bias: 'neutral',
    strength: 0.15,
    freshnessHours: 36,
    sourceConfidence: 0.2,
    eventTags: [],
    headline: 'Market roundup',
  };
}

describe('computeContextualModifiers — news behavior', () => {
  it('bullish direct high-confidence event adds modest positive modifier', () => {
    const result = computeContextualModifiers(
      70, defaultMacro(), enrichedBullishNews(), defaultEventRisk(),
      defaultFreshness(), defaultFeedback(), false,
    );

    expect(result.newsModifier).toBeGreaterThan(0);
    expect(result.newsModifier).toBeLessThanOrEqual(8);
    expect(result.finalAdjustedConfidence).toBeGreaterThan(70);
  });

  it('bearish direct high-confidence event reduces conviction', () => {
    const result = computeContextualModifiers(
      70, defaultMacro(), enrichedBearishNews(), defaultEventRisk(),
      defaultFreshness(), defaultFeedback(), false,
    );

    expect(result.newsModifier).toBeLessThan(0);
    expect(result.finalAdjustedConfidence).toBeLessThan(70);
  });

  it('high manipulation suspicion suppresses aggressive promotion', () => {
    const result = computeContextualModifiers(
      70, defaultMacro(), highManipulationNews(), defaultEventRisk(),
      defaultFreshness(), defaultFeedback(), false,
    );

    // High manipulation should dampen positive modifier significantly
    // Even though bias is positive and strength is high,
    // manipulation suspicion of 0.7 should reduce the modifier
    expect(result.newsModifier).toBeLessThan(4);
  });

  it('low-confidence generic news has limited/zero effect', () => {
    const result = computeContextualModifiers(
      70, defaultMacro(), weakGenericNews(), defaultEventRisk(),
      defaultFreshness(), defaultFeedback(), false,
    );

    expect(result.newsModifier).toBe(0);
    expect(result.finalAdjustedConfidence).toBe(70);
  });

  it('same input always gives same output (deterministic)', () => {
    const news = enrichedBullishNews();
    const r1 = computeContextualModifiers(70, defaultMacro(), news, defaultEventRisk(), defaultFreshness(), defaultFeedback(), false);
    const r2 = computeContextualModifiers(70, defaultMacro(), news, defaultEventRisk(), defaultFreshness(), defaultFeedback(), false);

    expect(r1.newsModifier).toBe(r2.newsModifier);
    expect(r1.finalAdjustedConfidence).toBe(r2.finalAdjustedConfidence);
  });

  it('positive news modifier is capped by event risk penalty', () => {
    const highEventRisk: EventRiskSnapshot = {
      eventRiskScore: 70,
      eventRiskBand: 'high',
      eventRiskPenalty: 7,
      eventTags: ['earnings_within_3_days'],
      comment: 'Earnings approaching',
    };

    const result = computeContextualModifiers(
      70, defaultMacro(), enrichedBullishNews(), highEventRisk,
      defaultFreshness(), defaultFeedback(), false,
    );

    // Positive modifier capped: max(0, 8 - 7) = 1
    expect(result.newsModifier).toBeLessThanOrEqual(1);
  });

  it('total adjustment stays within ±10', () => {
    const extremeMacro: MacroContext = { ...defaultMacro(), marketTone: 'hostile' };
    const result = computeContextualModifiers(
      70, extremeMacro, enrichedBearishNews(),
      { eventRiskScore: 80, eventRiskBand: 'high', eventRiskPenalty: 8, eventTags: ['earnings_within_3_days'], comment: '' },
      { ...defaultFreshness(), decayState: 'stale' },
      { ...defaultFeedback(), strategyEnvironmentFit: 'poor', confidenceCalibrationState: 'overconfident' },
      false,
    );

    expect(result.cappedAdaptiveAdjustment).toBeGreaterThanOrEqual(-10);
    expect(result.cappedAdaptiveAdjustment).toBeLessThanOrEqual(10);
  });
});
