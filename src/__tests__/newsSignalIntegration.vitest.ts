// ══════════════════════════════════════════════════════════════���═
//  F1: Signal Integration Tests — enriched context preservation
//
//  Verifies that enriched news fields survive end-to-end from
//  the news engine to the signal engine:
//    - All enriched fields present after buildSignalNewsContext()
//    - No enriched fields stripped by conversion/helpers
//    - Output values follow 0-1 contract
// ════════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { buildModifierFromImpact, buildSignalNewsContext, buildLegacyNewsContext } from '@/lib/news-engine/impact/signalIntegration';
import type { SymbolImpact } from '@/lib/news-engine/types/impact.types';

function makeMockImpact(overrides: Partial<SymbolImpact> & { realDimensions?: any } = {}): SymbolImpact & { realDimensions?: any } {
  return {
    symbol: 'RELIANCE',
    confidenceModifier: 5,
    riskPenalty: 2,
    netSentiment: 'bullish',
    aggregateImpact: 65,
    eventRiskScore: 35,
    manipulationRiskBoost: 10,
    eventCount: 3,
    warnings: ['Test warning'],
    activeTags: ['earnings'],
    suppressSignal: false,
    suppressionReason: null,
    // Real scorecard dimensions — always provided by getSymbolImpact
    realDimensions: {
      avgTrustScore: 65,
      avgNoveltyScore: 70,
      avgDirectnessScore: 75,
      avgFreshnessScore: 80,
      avgSentimentMagnitude: 45,
      avgSentimentScore: 50,
      avgManipulationScore: 15,
      avgImportanceScore: 80,
      avgEntityConfidence: 3,
      derivedSourceClass: 'media' as const,
    },
    ...overrides,
  };
}

describe('buildSignalNewsContext', () => {
  it('preserves all enriched fields in 0-1 range', () => {
    const impact = makeMockImpact();
    const ctx = buildSignalNewsContext(impact);

    // Core fields
    expect(ctx.bias).toBe('positive');
    expect(ctx.strength).toBeGreaterThanOrEqual(0);
    expect(ctx.strength).toBeLessThanOrEqual(1);
    expect(ctx.sourceConfidence).toBeGreaterThanOrEqual(0);
    expect(ctx.sourceConfidence).toBeLessThanOrEqual(1);
    expect(ctx.eventTags).toEqual(['earnings']);
    expect(ctx.headline).toBe('Test warning');

    // Enriched fields must be present
    expect(ctx.symbolImpactScore).toBeDefined();
    expect(ctx.eventRiskScore).toBeDefined();
    expect(ctx.manipulationSuspicion).toBeDefined();
    expect(ctx.noveltyScore).toBeDefined();
    expect(ctx.directnessScore).toBeDefined();
    expect(ctx.sentimentScore).toBeDefined();
    expect(ctx.eventType).toBeDefined();
    expect(ctx.sourceTier).toBeDefined();
  });

  it('normalizes all enriched values to 0-1', () => {
    const impact = makeMockImpact({
      aggregateImpact: 80,
      eventRiskScore: 60,
      realDimensions: {
        avgTrustScore: 72, avgNoveltyScore: 85, avgDirectnessScore: 78,
        avgFreshnessScore: 90, avgSentimentMagnitude: 45, avgSentimentScore: 55,
        avgManipulationScore: 30, avgImportanceScore: 88, avgEntityConfidence: 3,
        derivedSourceClass: 'media' as const,
      },
    });
    const ctx = buildSignalNewsContext(impact);

    expect(ctx.symbolImpactScore).toBe(0.8);
    expect(ctx.eventRiskScore).toBe(0.6);
    expect(ctx.manipulationSuspicion).toBeCloseTo(0.3, 1);
    expect(ctx.manipulationSuspicion).toBeLessThanOrEqual(1);
    expect(ctx.strength).toBe(0.8);
  });

  it('handles zero-event empty impact gracefully', () => {
    const impact = makeMockImpact({
      eventCount: 0,
      aggregateImpact: 0,
      netSentiment: 'neutral',
      realDimensions: {
        avgTrustScore: 0, avgNoveltyScore: 0, avgDirectnessScore: 0,
        avgFreshnessScore: 0, avgSentimentMagnitude: 0, avgSentimentScore: 0,
        avgManipulationScore: 0, avgImportanceScore: 0, avgEntityConfidence: 0,
        derivedSourceClass: 'unknown' as const,
      },
    });
    const ctx = buildSignalNewsContext(impact);

    expect(ctx.bias).toBe('neutral');
    expect(ctx.strength).toBe(0);
    expect(ctx.symbolImpactScore).toBe(0);
    expect(ctx.freshnessHours).toBe(999);
    expect(ctx.noveltyScore).toBe(0);
    expect(ctx.directnessScore).toBe(0);
  });

  it('sentimentScore is in -1 to +1 range', () => {
    const bullish = buildSignalNewsContext(makeMockImpact({
      netSentiment: 'bullish',
      realDimensions: { ...makeMockImpact().realDimensions!, avgSentimentScore: 60 },
    }));
    expect(bullish.sentimentScore).toBeCloseTo(0.6, 1);
    expect(bullish.sentimentScore).toBeLessThanOrEqual(1);

    const bearish = buildSignalNewsContext(makeMockImpact({
      netSentiment: 'bearish',
      realDimensions: { ...makeMockImpact().realDimensions!, avgSentimentScore: -45 },
    }));
    expect(bearish.sentimentScore).toBeCloseTo(-0.45, 1);
    expect(bearish.sentimentScore).toBeGreaterThanOrEqual(-1);

    const neutral = buildSignalNewsContext(makeMockImpact({
      netSentiment: 'neutral',
      realDimensions: { ...makeMockImpact().realDimensions!, avgSentimentScore: 0 },
    }));
    expect(neutral.sentimentScore).toBe(0);
  });

  it('uses real scorecard dimensions when provided', () => {
    const impact = {
      ...makeMockImpact(),
      realDimensions: {
        avgTrustScore: 72,
        avgNoveltyScore: 85,
        avgDirectnessScore: 78,
        avgFreshnessScore: 90,
        avgSentimentMagnitude: 45,
        avgSentimentScore: 55,
        avgManipulationScore: 12,
        avgImportanceScore: 88,
        avgEntityConfidence: 3,
        derivedSourceClass: 'media' as const,
      },
    };
    const ctx = buildSignalNewsContext(impact);

    // Real values from scorecard, not heuristic proxies
    expect(ctx.noveltyScore).toBeCloseTo(0.85, 1);
    expect(ctx.directnessScore).toBeCloseTo(0.78, 1);
    expect(ctx.sourceConfidence).toBeCloseTo(0.72, 1);
    expect(ctx.scoreCard!.recency).toBeCloseTo(0.90, 1);
    expect(ctx.sourceClass).toBe('media');
  });
});

describe('buildModifierFromImpact', () => {
  it('returns enrichedNewsContext with all enriched fields', () => {
    const impact = makeMockImpact();
    const mod = buildModifierFromImpact(impact);

    // The enrichedNewsContext should have all enriched fields
    expect(mod.enrichedNewsContext.symbolImpactScore).toBeDefined();
    expect(mod.enrichedNewsContext.eventRiskScore).toBeDefined();
    expect(mod.enrichedNewsContext.manipulationSuspicion).toBeDefined();
  });

  it('passes through confidence modifier and risk penalty', () => {
    const impact = makeMockImpact({ confidenceModifier: 6, riskPenalty: 3 });
    const mod = buildModifierFromImpact(impact);

    expect(mod.confidenceModifier).toBe(6);
    expect(mod.riskPenalty).toBe(3);
  });
});

describe('buildSignalNewsContext — scoreCard and impactBreakdown', () => {
  it('attaches scoreCard with all dimensions in 0-1 range', () => {
    const impact = makeMockImpact({ aggregateImpact: 70, eventRiskScore: 40, manipulationRiskBoost: 15 });
    const ctx = buildSignalNewsContext(impact);

    expect(ctx.scoreCard).toBeDefined();
    const sc = ctx.scoreCard!;
    expect(sc.sourceReliability).toBeGreaterThanOrEqual(0);
    expect(sc.sourceReliability).toBeLessThanOrEqual(1);
    expect(sc.finalSymbolImpact).toBe(0.7);
    expect(sc.finalEventRisk).toBe(0.4);
    expect(sc.manipulationRisk).toBeGreaterThanOrEqual(0);
    expect(sc.manipulationRisk).toBeLessThanOrEqual(1);
    expect(sc.novelty).toBeGreaterThanOrEqual(0);
    expect(sc.directness).toBeGreaterThanOrEqual(0);
    expect(sc.entityConfidence).toBeGreaterThanOrEqual(0);
  });

  it('attaches impactBreakdown with narrative summary', () => {
    const impact = makeMockImpact({ aggregateImpact: 65, riskPenalty: 3, confidenceModifier: -2 });
    const ctx = buildSignalNewsContext(impact);

    expect(ctx.impactBreakdown).toBeDefined();
    const ib = ctx.impactBreakdown!;
    expect(ib.symbolImpact).toBe(0.65);
    expect(ib.riskPenalty).toBe(3);
    expect(ib.confidencePenalty).toBe(2);  // abs of -2
    expect(ib.narrativeSummary).toBeTruthy();
    expect(ib.narrativeSummary.length).toBeGreaterThan(10);
  });

  it('attaches sourceClass from real event distribution', () => {
    const impact = makeMockImpact({ eventCount: 5 });
    const ctx = buildSignalNewsContext(impact);
    expect(ctx.sourceClass).toBe('media'); // from derivedSourceClass in realDimensions

    const officialImpact = makeMockImpact({
      realDimensions: { ...makeMockImpact().realDimensions!, derivedSourceClass: 'official' as const },
    });
    expect(buildSignalNewsContext(officialImpact).sourceClass).toBe('official');
  });

  it('scoreCard has no values exceeding valid ranges', () => {
    // Extreme high values
    const impact = makeMockImpact({
      aggregateImpact: 100,
      eventRiskScore: 100,
      manipulationRiskBoost: 50,
      eventCount: 20,
      realDimensions: {
        avgTrustScore: 95, avgNoveltyScore: 100, avgDirectnessScore: 100,
        avgFreshnessScore: 100, avgSentimentMagnitude: 100, avgSentimentScore: 90,
        avgManipulationScore: 95, avgImportanceScore: 100, avgEntityConfidence: 10,
        derivedSourceClass: 'official' as const,
      },
    });
    const ctx = buildSignalNewsContext(impact);
    const sc = ctx.scoreCard!;

    for (const key of ['sourceReliability', 'recency', 'novelty', 'directness', 'entityConfidence', 'manipulationRisk', 'finalSymbolImpact', 'finalEventRisk'] as const) {
      expect(sc[key]).toBeGreaterThanOrEqual(0);
      expect(sc[key]).toBeLessThanOrEqual(1);
    }
    expect(sc.sentiment).toBeGreaterThanOrEqual(-1);
    expect(sc.sentiment).toBeLessThanOrEqual(1);
  });
});

describe('buildModifierFromImpact — sector/market impact passthrough', () => {
  it('patches sectorImpactScore and marketImpactScore when provided', () => {
    const impact = { ...makeMockImpact(), sectorImpactScore: 45, marketImpactScore: 30 };
    const mod = buildModifierFromImpact(impact);

    expect(mod.enrichedNewsContext.sectorImpactScore).toBeCloseTo(0.45, 2);
    expect(mod.enrichedNewsContext.marketImpactScore).toBeCloseTo(0.30, 2);
    expect(mod.enrichedNewsContext.impactBreakdown?.sectorImpact).toBeCloseTo(0.45, 2);
    expect(mod.enrichedNewsContext.impactBreakdown?.marketImpact).toBeCloseTo(0.30, 2);
  });
});

describe('buildLegacyNewsContext', () => {
  it('does NOT include enriched fields', () => {
    const impact = makeMockImpact();
    const ctx = buildLegacyNewsContext(impact);

    expect(ctx.symbolImpactScore).toBeUndefined();
    expect(ctx.eventRiskScore).toBeUndefined();
    expect(ctx.manipulationSuspicion).toBeUndefined();
  });

  it('still follows 0-1 contract for core fields', () => {
    const ctx = buildLegacyNewsContext(makeMockImpact({ aggregateImpact: 75 }));
    expect(ctx.strength).toBe(0.75);
    expect(ctx.sourceConfidence).toBeGreaterThanOrEqual(0);
    expect(ctx.sourceConfidence).toBeLessThanOrEqual(1);
  });
});
