// ════════════════════════════════════════════════════════════════
//  F3: Dexter Narrative Tests
//
//  Verifies Dexter produces meaningfully different narratives:
//    1. Direct symbol catalyst vs sector macro news
//    2. Warns when manipulation suspicion is high
//    3. Does not overstate weak/low-confidence news
// ════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { buildDexterNarrative } from '@/lib/signal-engine/dexter/buildDexterNarrative';
import type { Phase4SignalEnvelope, NewsContext } from '@/lib/signal-engine/types/phase4.types';

function makeBaseEnvelope(newsOverrides: Partial<NewsContext> = {}): Phase4SignalEnvelope {
  const news: NewsContext = {
    bias: 'neutral',
    strength: 0,
    freshnessHours: 999,
    sourceConfidence: 0,
    eventTags: [],
    headline: null,
    ...newsOverrides,
  };
  return {
    symbol: 'INFY',
    signalType: 'breakout_momentum',
    signalSubtype: 'primary',
    marketRegime: 'Bullish',
    confidenceScore: 72,
    adjustedConfidenceScore: 74,
    confidenceBand: 'Actionable',
    riskScore: 35,
    tradePlan: { entryZoneLow: 1500, entryZoneHigh: 1520, stopLoss: 1460, target1: 1580, target2: 1640, target3: 0, rrTarget1: 2.0, rrTarget2: 3.0, rrTarget3: 0, initialRiskPerUnit: 40, entryType: 'breakout_confirmation' } as any,
    positionSizing: { positionSizeUnits: 10 } as any,
    portfolioFit: { fitScore: 70 } as any,
    executionReadiness: { approvalDecision: 'approved' } as any,
    macroContext: { marketTone: 'constructive', riskMode: 'moderate_risk_on', volatilityState: 'normal', sectorLeadership: ['IT'], macroEventProximity: 'none' },
    newsContext: news,
    eventRisk: { eventRiskScore: 15, eventRiskBand: 'low', eventRiskPenalty: 1, eventTags: ['none'], comment: 'No events' },
    contextualModifiers: { newsModifier: 0, macroModifier: 2, eventRiskPenalty: -1, sectorNarrativeModifier: 3, strategyFitModifier: 0, freshnessPenalty: 0, feedbackCalibrationModifier: 0, rawTotal: 4, cappedAdaptiveAdjustment: 4, originalConfidence: 72, finalAdjustedConfidence: 76 },
    aiExplanation: { summary: 'Test', whyNow: '', decisionNarrative: '', traderGuidance: ['Monitor entry'], riskHighlights: ['Stop at 1460'], whatWouldInvalidate: ['Close below 1460'], whyNotOversize: '' },
    traderNarrative: { shortSummary: '', fullNarrative: '', guidanceBullets: [], invalidationSummary: '' },
    freshness: { ageBars: 0, ageHours: 1, freshnessScore: 98, decayState: 'fresh', urgencyTag: 'normal', priceDriftPct: 0 },
    feedbackState: { strategyRecentWinRate: 0.55, strategyEnvironmentFit: 'good', confidenceCalibrationState: 'well_calibrated' },
    lifecycleStatus: 'active',
    // Phase-4 scoring (test fixture — values chosen to land VALID_SIGNAL)
    final_score: 72,
    classification: 'VALID_SIGNAL',
    factor_scores: {
      strategy_quality: 75, trend_alignment: 72, momentum: 70,
      volume_confirmation: 65, risk_reward: 67, liquidity: 60,
      market_regime: 70, portfolio_fit: 70,
    },
    reasons: ['Breakout detected'],
    warnings: [],
    generatedAt: new Date().toISOString(),
  };
}

describe('Dexter narrative — enriched news differentiation', () => {
  it('describes direct symbol catalyst differently from no-news', () => {
    const directNews = makeBaseEnvelope({
      bias: 'positive',
      strength: 0.7,
      freshnessHours: 2,
      sourceConfidence: 0.8,
      eventTags: ['earnings'],
      headline: 'INFY Q3 beats estimates',
      symbolImpactScore: 0.75,
      eventRiskScore: 0.2,
      manipulationSuspicion: 0.05,
      directnessScore: 0.9,
      noveltyScore: 0.8,
      sentimentScore: 0.6,
      eventType: 'earnings',
      sourceTier: 'high',
    });
    directNews.contextualModifiers = { ...directNews.contextualModifiers, newsModifier: 4 };

    const noNews = makeBaseEnvelope();

    const directDexter = buildDexterNarrative(directNews);
    const noNewsDexter = buildDexterNarrative(noNews);

    // Direct catalyst narrative should mention the event type
    expect(directDexter.explanation.newsImpact.toLowerCase()).toContain('direct');
    expect(directDexter.explanation.newsImpact.toLowerCase()).toContain('earnings');

    // No-news narrative should say no significant news
    expect(noNewsDexter.explanation.newsImpact.toLowerCase()).toContain('no significant');

    // Verdicts should differ
    expect(directDexter.verdict).not.toBe(noNewsDexter.verdict);
  });

  it('distinguishes sector macro news from direct catalyst', () => {
    const sectorNews = makeBaseEnvelope({
      bias: 'positive',
      strength: 0.5,
      freshnessHours: 6,
      sourceConfidence: 0.6,
      eventTags: ['sector_move'],
      headline: 'IT sector rallies',
      symbolImpactScore: 0.4,
      eventRiskScore: 0.15,
      manipulationSuspicion: 0.05,
      directnessScore: 0.25, // low directness = sector-level
      noveltyScore: 0.5,
      sentimentScore: 0.3,
      eventType: 'sector_move',
      sourceTier: 'medium',
    });

    const dexter = buildDexterNarrative(sectorNews);

    // Should describe as sector-wide context, not a direct catalyst
    expect(dexter.explanation.newsImpact.toLowerCase()).toMatch(/sector|market-wide/);
    // Should NOT describe it as a "direct catalyst" (it's sector-level)
    expect(dexter.explanation.newsImpact.toLowerCase()).not.toContain('direct catalyst');
  });

  it('warns when manipulation suspicion is high', () => {
    const hypeNews = makeBaseEnvelope({
      bias: 'positive',
      strength: 0.85,
      freshnessHours: 1,
      sourceConfidence: 0.3,
      eventTags: ['general'],
      headline: 'MASSIVE BREAKOUT INCOMING',
      symbolImpactScore: 0.5,
      eventRiskScore: 0.4,
      manipulationSuspicion: 0.7,
      directnessScore: 0.5,
      noveltyScore: 0.2,
      sentimentScore: 0.4,
      eventType: 'general',
      sourceTier: 'low',
    });

    const dexter = buildDexterNarrative(hypeNews);

    // Should warn about manipulation
    const allText = `${dexter.explanation.newsImpact} ${dexter.explanation.cautionReason ?? ''} ${dexter.verdict}`.toLowerCase();
    expect(allText).toMatch(/manipulation|hype|caution/);
  });

  it('produces structured reasoning with conflict check and action stance', () => {
    const directNews = makeBaseEnvelope({
      bias: 'positive',
      strength: 0.7,
      freshnessHours: 2,
      sourceConfidence: 0.8,
      eventTags: ['earnings'],
      headline: 'INFY Q3 beats estimates',
      symbolImpactScore: 0.75,
      eventRiskScore: 0.2,
      manipulationSuspicion: 0.05,
      directnessScore: 0.9,
      noveltyScore: 0.8,
      sentimentScore: 0.6,
      eventType: 'earnings',
      sourceTier: 'high',
    });
    directNews.contextualModifiers = { ...directNews.contextualModifiers, newsModifier: 4 };

    const dexter = buildDexterNarrative(directNews);

    // New structured fields must be present
    expect(dexter.explanation.technicalContext).toBeTruthy();
    expect(dexter.explanation.conflictCheck).toBeTruthy();
    expect(dexter.explanation.newsAlignment).toBeDefined();
    expect(dexter.explanation.riskView).toBeTruthy();
    expect(dexter.explanation.stanceReasoning).toBeTruthy();
    expect(dexter.actionStance).toBeDefined();

    // Bullish technical + bullish news = confirms
    expect(dexter.explanation.newsAlignment).toBe('confirms_technical');
    expect(dexter.explanation.conflictCheck.toLowerCase()).toContain('confirms');
  });

  it('detects conflict when news opposes technical setup', () => {
    const conflictingNews = makeBaseEnvelope({
      bias: 'negative',
      strength: 0.6,
      freshnessHours: 3,
      sourceConfidence: 0.7,
      eventTags: ['regulatory'],
      headline: 'SEBI investigation',
      symbolImpactScore: 0.5,
      eventRiskScore: 0.5,
      manipulationSuspicion: 0.1,
      directnessScore: 0.8,
      noveltyScore: 0.7,
      sentimentScore: -0.5,
      eventType: 'regulatory',
      sourceTier: 'high',
    });

    const dexter = buildDexterNarrative(conflictingNews);

    expect(dexter.explanation.newsAlignment).toBe('conflicts_with_technical');
    expect(dexter.explanation.conflictCheck.toLowerCase()).toContain('conflicts');
    // Action stance should be downgraded
    expect(['cautious_buy', 'hold', 'avoid', 'reject']).toContain(dexter.actionStance);
  });

  it('marks insufficient quality when manipulation is very high', () => {
    const manipNews = makeBaseEnvelope({
      bias: 'positive',
      strength: 0.8,
      freshnessHours: 1,
      sourceConfidence: 0.15,
      eventTags: ['general'],
      headline: 'BIG PUMP',
      symbolImpactScore: 0.5,
      eventRiskScore: 0.4,
      manipulationSuspicion: 0.75,
      directnessScore: 0.5,
      noveltyScore: 0.2,
      sentimentScore: 0.4,
      eventType: 'general',
      sourceTier: 'low',
    });

    const dexter = buildDexterNarrative(manipNews);
    expect(dexter.explanation.newsAlignment).toBe('insufficient_news_quality');
    expect(dexter.explanation.conflictCheck.toLowerCase()).toContain('insufficient');
  });

  it('derives deterministic action stance based on rules', () => {
    // High confidence + low risk + confirming news = strong_buy
    const strongSetup = makeBaseEnvelope({
      bias: 'positive',
      strength: 0.7,
      freshnessHours: 2,
      sourceConfidence: 0.8,
      symbolImpactScore: 0.7,
      directnessScore: 0.8,
      eventRiskScore: 0.1,
      manipulationSuspicion: 0.05,
    });
    strongSetup.adjustedConfidenceScore = 85;
    strongSetup.riskScore = 25;

    const dexter = buildDexterNarrative(strongSetup);
    expect(dexter.actionStance).toBe('strong_buy');

    // Low confidence + high manipulation = reject
    const weakSetup = makeBaseEnvelope({
      bias: 'positive',
      strength: 0.5,
      sourceConfidence: 0.2,
      manipulationSuspicion: 0.6,
    });
    weakSetup.adjustedConfidenceScore = 45;
    weakSetup.riskScore = 60;

    const weakDexter = buildDexterNarrative(weakSetup);
    expect(weakDexter.actionStance).toBe('reject');
  });

  it('does not overstate weak/low-confidence news', () => {
    const weakNews = makeBaseEnvelope({
      bias: 'positive',
      strength: 0.15,
      freshnessHours: 48,
      sourceConfidence: 0.2,
      eventTags: [],
      headline: 'Minor market note',
    });

    const dexter = buildDexterNarrative(weakNews);

    // Verdict should not claim strong news support
    expect(dexter.verdict.toLowerCase()).not.toContain('supported by');
    expect(dexter.verdict.toLowerCase()).not.toContain('catalyst');
  });
});
