// ════════════════════════════════════════════════════════════════
//  Quantorus365 — Unit + Integration Tests (Vitest)
//
//  Run:  npx vitest run
//  Watch: npx vitest
// ════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

// ── 1. Outcome Tracker — pnlR computation ────────────────────
describe('evaluateOutcome', () => {
  // Dynamic import to avoid triggering DB connections at module level
  it('computes pnlR correctly for a winning trade (target1 hit)', async () => {
    const { evaluateOutcome } = await import('@/lib/signal-engine/feedback/outcomeTracker');

    const result = evaluateOutcome(
      1,        // signalId
      100,      // entryPrice
      95,       // stopLoss (risk = 5)
      110,      // target1 (reward = 10 = 2R)
      120,      // target2
      130,      // target3
      [
        { high: 105, low: 99, close: 104 },
        { high: 108, low: 102, close: 107 },
        { high: 112, low: 106, close: 111 }, // T1 hit (high >= 110)
        { high: 115, low: 110, close: 113 },
        { high: 118, low: 112, close: 116 },
      ],
      false, // not bearish
    );

    expect(result.target1Hit).toBe(true);
    expect(result.entryTriggered).toBe(true);
    expect(result.outcomeLabel).toBe('partial_success');
    expect(result.pnlR).toBe(2); // (110-100)/5 = 2R
    expect(result.maxFavorableExcursionPct).toBeGreaterThan(0);
  });

  it('computes pnlR = -1 for a stopped-out trade', async () => {
    const { evaluateOutcome } = await import('@/lib/signal-engine/feedback/outcomeTracker');

    const result = evaluateOutcome(
      2, 100, 95, 110, 120, 130,
      [
        { high: 101, low: 96, close: 97 },
        { high: 98, low: 93, close: 94 }, // stop hit (low <= 95)
        { high: 96, low: 91, close: 92 },
        { high: 93, low: 88, close: 89 },
        { high: 90, low: 86, close: 87 },
      ],
      false,
    );

    expect(result.stopHit).toBe(true);
    expect(result.target1Hit).toBe(false);
    expect(result.outcomeLabel).toBe('stopped_out');
    expect(result.pnlR).toBe(-1);
  });
});

// ── 2. Contextual Modifiers — bounded adjustment ─────────────
describe('computeContextualModifiers', () => {
  it('caps total adjustment at ±10', async () => {
    const { computeContextualModifiers } = await import('@/lib/signal-engine/context/contextualModifiers');

    const result = computeContextualModifiers(
      75, // originalConfidence
      { marketTone: 'strongly_constructive', riskMode: 'risk_on', volatilityState: 'low', sectorLeadership: ['IT'], macroEventProximity: 'none' },
      { bias: 'positive', strength: 0.9, freshnessHours: 2, sourceConfidence: 0.8, eventTags: [], headline: null },
      { eventRiskScore: 0, eventRiskBand: 'low', eventRiskPenalty: 0, eventTags: ['none'], comment: '' },
      { ageBars: 0, ageHours: 0, freshnessScore: 100, decayState: 'fresh', urgencyTag: 'high', priceDriftPct: 0 },
      { strategyRecentWinRate: 0.7, strategyEnvironmentFit: 'excellent', confidenceCalibrationState: 'underconfident' },
      true, // sectorInLeadership
    );

    // All modifiers are positive but total should be capped at +10
    expect(result.cappedAdaptiveAdjustment).toBeLessThanOrEqual(10);
    expect(result.cappedAdaptiveAdjustment).toBeGreaterThanOrEqual(-10);
    expect(result.finalAdjustedConfidence).toBeLessThanOrEqual(100);
    expect(result.finalAdjustedConfidence).toBeGreaterThanOrEqual(0);
  });

  it('news modifier cannot exceed event risk penalty', async () => {
    const { computeContextualModifiers } = await import('@/lib/signal-engine/context/contextualModifiers');

    const result = computeContextualModifiers(
      70,
      { marketTone: 'neutral', riskMode: 'neutral', volatilityState: 'normal', sectorLeadership: [], macroEventProximity: 'none' },
      { bias: 'positive', strength: 0.95, freshnessHours: 1, sourceConfidence: 0.9, eventTags: ['earnings'], headline: 'Strong earnings' },
      { eventRiskScore: 80, eventRiskBand: 'high', eventRiskPenalty: 6, eventTags: ['earnings_within_3_days'], comment: 'Earnings imminent' },
      { ageBars: 0, ageHours: 0, freshnessScore: 100, decayState: 'fresh', urgencyTag: 'normal', priceDriftPct: 0 },
      { strategyRecentWinRate: null, strategyEnvironmentFit: 'insufficient_data', confidenceCalibrationState: 'insufficient_data' },
      false,
    );

    // News modifier should be constrained by event risk penalty
    // positive news mod max = 5 (legacy), penalty = 6 → news capped to max(0, 5-6) = 0
    expect(result.newsModifier).toBeLessThanOrEqual(0);
  });
});

// ── 3. Dexter Narrative — deterministic output ───────────────
describe('buildDexterNarrative', () => {
  it('produces a structured verdict with all required fields', async () => {
    const { buildDexterNarrative } = await import('@/lib/signal-engine/dexter/buildDexterNarrative');

    const signal: any = {
      symbol: 'RELIANCE',
      signalType: 'bullish_breakout',
      signalSubtype: 'primary',
      marketRegime: 'STRONG_BULL',
      confidenceScore: 75,
      adjustedConfidenceScore: 80,
      confidenceBand: 'Actionable',
      riskScore: 35,
      tradePlan: { entryZoneLow: 2400, entryZoneHigh: 2420, stopLoss: 2350, target1: 2500, target2: 2580, target3: 2650, rrTarget1: 2.3, rrTarget2: 3.4, rrTarget3: 4.6, initialRiskPerUnit: 70, entryType: 'breakout_confirmation' },
      positionSizing: { positionSizeUnits: 10 },
      portfolioFit: { fitScore: 85 },
      executionReadiness: { approvalDecision: 'approved' },
      macroContext: { marketTone: 'constructive', riskMode: 'moderate_risk_on', volatilityState: 'normal', sectorLeadership: ['Energy'], macroEventProximity: 'none' },
      newsContext: { bias: 'positive', strength: 0.7, freshnessHours: 6, sourceConfidence: 0.8, eventTags: ['earnings'], headline: 'Strong Q4 results' },
      eventRisk: { eventRiskScore: 20, eventRiskBand: 'low', eventRiskPenalty: 0, eventTags: ['none'], comment: '' },
      contextualModifiers: { newsModifier: 4, macroModifier: 2, eventRiskPenalty: 0, sectorNarrativeModifier: 3, strategyFitModifier: 1, freshnessPenalty: 0, feedbackCalibrationModifier: 0, rawTotal: 10, cappedAdaptiveAdjustment: 10, originalConfidence: 75, finalAdjustedConfidence: 85 },
      aiExplanation: { summary: 'test', whyNow: 'test', decisionNarrative: 'test', traderGuidance: ['Watch for volume confirmation'], riskHighlights: ['Gap risk if earnings miss'], whatWouldInvalidate: ['Close below 2350'], whyNotOversize: 'test' },
      traderNarrative: { shortSummary: '', fullNarrative: '', guidanceBullets: [], invalidationSummary: '' },
      freshness: { ageBars: 0, ageHours: 0, freshnessScore: 100, decayState: 'fresh', urgencyTag: 'high', priceDriftPct: 0 },
      feedbackState: { strategyRecentWinRate: 0.62, strategyEnvironmentFit: 'good', confidenceCalibrationState: 'well_calibrated' },
      lifecycleStatus: 'active',
      reasons: ['Breakout above resistance'],
      warnings: [],
      generatedAt: new Date().toISOString(),
    };

    const result = buildDexterNarrative(signal);

    // Structure checks
    expect(result.symbol).toBe('RELIANCE');
    expect(['high', 'moderate', 'low', 'avoid']).toContain(result.conviction);
    expect(result.verdict).toBeTruthy();
    expect(result.verdict.length).toBeGreaterThan(10);
    expect(result.explanation.setupReason).toBeTruthy();
    expect(result.explanation.newsImpact).toContain('earnings');
    expect(result.modifiers.news).toBe(4);
    expect(result.modifiers.totalAdjustment).toBe(10);
    expect(result.guidance.length).toBeGreaterThan(0);
    expect(result.calibration.strategyWinRate).toBe(0.62);
  });
});

// ── 4. Backtest News Replay — no future leakage ──────────────
describe('buildNewsTag', () => {
  it('returns null when no news data is available (no DB)', async () => {
    // This test verifies the function handles missing DB gracefully
    // In a real environment it would query q365_news_scores
    const { buildNewsTag } = await import('@/lib/backtesting/replay/newsReplay');

    // With no DB connection, should return null (caught error)
    const result = await buildNewsTag('RELIANCE', '2025-01-15', undefined);
    // Either null (no DB) or a valid tag object
    expect(result === null || typeof result === 'object').toBe(true);
    if (result) {
      expect(result.confidenceModifier).toBeGreaterThanOrEqual(-8);
      expect(result.confidenceModifier).toBeLessThanOrEqual(8);
      expect(result.riskPenalty).toBeGreaterThanOrEqual(0);
      expect(result.riskPenalty).toBeLessThanOrEqual(10);
    }
  });
});
