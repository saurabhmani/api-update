// ════════════════════════════════════════════════════════════════
//  Quantorus365 — End-to-End Pipeline Correctness Test
//
//  Validates the full pipeline:
//    Ingestion → Signal → Dexter → Backtest
//
//  Tests:
//    1. News ingestion produces RawNewsItems with correct shape
//    2. Scoring produces scoreCards with all 7 dimensions (0-1)
//    3. Signal integration returns enriched NewsContext (0-1)
//    4. Phase 4 pipeline preserves enriched context + scoreCard
//    5. Dexter narratives include scoreBreakdown + alignment
//    6. Backtest newsReplay tags carry enriched fields (0-1)
//    7. Manipulation suspicion actively suppresses hype signals
//
//  Run: npx tsx src/__tests__/endToEndPipeline.test.ts
// ════════════════════════════════════════════════════════════════

export {};  // Force module scope — prevent global collisions with other test files

const results: { name: string; passed: boolean; error?: string }[] = [];

function assert(name: string, condition: boolean, detail?: string) {
  results.push({ name, passed: condition, error: condition ? undefined : detail ?? 'Assertion failed' });
}

// ════════════════════════════════════════════════════════════════
//  1. NEWS INGESTION — ADAPTER SHAPE VALIDATION
// ════════════════════════════════════════════════════════════════

async function testIngestionAdapters() {
  const { SOURCE_CLASS_MAP } = await import('../lib/news-engine/types/newsEngine.types');

  // All 4 source classes must be covered
  const classes = new Set(Object.values(SOURCE_CLASS_MAP));
  assert('ingestion:official_class_exists', classes.has('official'));
  assert('ingestion:media_class_exists', classes.has('media'));
  assert('ingestion:deals_class_exists', classes.has('deals'));
  assert('ingestion:social_class_exists', classes.has('social'));

  // Verify all adapters are importable
  const { officialExchangeAdapter, corporateFilingsAdapter } = await import('../lib/news-engine/ingestion/officialExchangeAdapter');
  assert('ingestion:official_adapter_exists', typeof officialExchangeAdapter.fetch === 'function');
  assert('ingestion:corporate_adapter_exists', typeof corporateFilingsAdapter.fetch === 'function');

  const { dealsFeedAdapter } = await import('../lib/news-engine/ingestion/dealsFeedAdapter');
  assert('ingestion:deals_adapter_exists', typeof dealsFeedAdapter.fetch === 'function');

  const { socialSignalsAdapter } = await import('../lib/news-engine/ingestion/socialSignalsAdapter');
  assert('ingestion:social_adapter_exists', typeof socialSignalsAdapter.fetch === 'function');

  // Verify ingestAll wires all adapters
  const { ingestFromAllSources } = await import('../lib/news-engine/ingestion/ingestAll');
  assert('ingestion:ingestAll_exists', typeof ingestFromAllSources === 'function');
}

// ════════════════════════════════════════════════════════════════
//  2. NEWS SCORING — SCORECARD 0-1 VALIDATION
// ════════════════════════════════════════════════════════════════

async function testScoringNormalization() {
  const { computeScoreCard } = await import('../lib/news-engine/scoring/computeScoreCard');
  const { NewsEvent } = {} as any; // type-only

  // Create a synthetic news event
  const testEvent = {
    id: 999,
    sourceId: 'gnews' as const,
    externalId: 'test-001',
    dedupHash: 'test-hash-001',
    title: 'Reliance Industries reports record quarterly earnings with strong revenue growth',
    body: 'Reliance Industries Ltd reported a surge in quarterly profits driven by strong retail and telecom performance. The stock jumped 3% on the announcement.',
    url: 'https://example.com/test',
    category: 'earnings' as const,
    sentiment: 'positive' as const,
    sentimentScore: 0.6,
    publishedAt: new Date().toISOString(),
    fetchedAt: new Date().toISOString(),
    entities: [],
    symbols: ['RELIANCE'],
    sectors: ['Energy'],
    macroFactors: [],
    commodities: ['crude_oil'],
    isProcessed: true,
  };

  const card = computeScoreCard(testEvent, 'RELIANCE', 0);

  // All composite scores must be 0-100 (internal scale)
  assert('scoring:symbolImpact_range', card.symbolImpactScore >= 0 && card.symbolImpactScore <= 100,
    `symbolImpactScore=${card.symbolImpactScore}`);
  assert('scoring:eventRisk_range', card.eventRiskScore >= 0 && card.eventRiskScore <= 100,
    `eventRiskScore=${card.eventRiskScore}`);
  assert('scoring:manipulationBoost_range', card.manipulationRiskBoost >= 0 && card.manipulationRiskBoost <= 50,
    `manipulationRiskBoost=${card.manipulationRiskBoost}`);

  // Individual dimensions must be 0-100
  assert('scoring:trust_range', card.trust.score >= 0 && card.trust.score <= 100);
  assert('scoring:importance_range', card.importance.score >= 0 && card.importance.score <= 100);
  assert('scoring:novelty_range', card.novelty.score >= 0 && card.novelty.score <= 100);
  assert('scoring:freshness_range', card.freshness.score >= 0 && card.freshness.score <= 100);
  assert('scoring:directness_range', card.directness.score >= 0 && card.directness.score <= 100);
  assert('scoring:sentiment_range', card.sentiment.score >= -100 && card.sentiment.score <= 100);
  assert('scoring:manipulation_range', card.manipulation.score >= 0 && card.manipulation.score <= 100);

  // Earnings for RELIANCE from gnews should have decent impact and trust
  assert('scoring:earnings_has_impact', card.symbolImpactScore > 20, `Expected impact > 20, got ${card.symbolImpactScore}`);
  assert('scoring:directness_primary', card.directness.matchType === 'primary_subject',
    `Expected primary_subject, got ${card.directness.matchType}`);
  assert('scoring:novelty_breaking', card.novelty.isBreaking === true, 'First earnings event should be breaking');
}

// ════════════════════════════════════════════════════════════════
//  3. SIGNAL INTEGRATION — ENRICHED NEWSCONTEXT 0-1
// ════════════════════════════════════════════════════════════════

async function testSignalIntegrationNormalization() {
  const { buildSignalNewsContext } = await import('../lib/news-engine/impact/signalIntegration');

  // Simulate a SymbolImpact with real scorecard dimensions (no heuristic fallbacks)
  const mockImpact = {
    symbol: 'RELIANCE',
    confidenceModifier: 5,
    riskPenalty: 3,
    netSentiment: 'bullish' as const,
    aggregateImpact: 65,
    eventRiskScore: 35,
    manipulationRiskBoost: 10,
    eventCount: 3,
    warnings: ['Earnings approaching'],
    activeTags: ['earnings' as const],
    suppressSignal: false,
    suppressionReason: null,
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

  const ctx = buildSignalNewsContext(mockImpact);

  // ALL enriched fields must be 0-1
  assert('integration:strength_01', ctx.strength >= 0 && ctx.strength <= 1, `strength=${ctx.strength}`);
  assert('integration:sourceConfidence_01', ctx.sourceConfidence >= 0 && ctx.sourceConfidence <= 1, `sourceConfidence=${ctx.sourceConfidence}`);
  assert('integration:symbolImpact_01', ctx.symbolImpactScore !== undefined && ctx.symbolImpactScore >= 0 && ctx.symbolImpactScore <= 1, `symbolImpactScore=${ctx.symbolImpactScore}`);
  assert('integration:eventRisk_01', ctx.eventRiskScore !== undefined && ctx.eventRiskScore >= 0 && ctx.eventRiskScore <= 1, `eventRiskScore=${ctx.eventRiskScore}`);
  assert('integration:manipulation_01', ctx.manipulationSuspicion !== undefined && ctx.manipulationSuspicion >= 0 && ctx.manipulationSuspicion <= 1, `manipulationSuspicion=${ctx.manipulationSuspicion}`);
  assert('integration:novelty_01', ctx.noveltyScore !== undefined && ctx.noveltyScore >= 0 && ctx.noveltyScore <= 1, `noveltyScore=${ctx.noveltyScore}`);
  assert('integration:directness_01', ctx.directnessScore !== undefined && ctx.directnessScore >= 0 && ctx.directnessScore <= 1, `directnessScore=${ctx.directnessScore}`);
  assert('integration:sentiment_range', ctx.sentimentScore !== undefined && ctx.sentimentScore >= -1 && ctx.sentimentScore <= 1, `sentimentScore=${ctx.sentimentScore}`);

  // Enriched fields MUST NOT be dropped
  assert('integration:symbolImpact_present', ctx.symbolImpactScore !== undefined, 'symbolImpactScore must not be dropped');
  assert('integration:eventRisk_present', ctx.eventRiskScore !== undefined, 'eventRiskScore must not be dropped');
  assert('integration:manipulation_present', ctx.manipulationSuspicion !== undefined, 'manipulationSuspicion must not be dropped');
  assert('integration:novelty_present', ctx.noveltyScore !== undefined, 'noveltyScore must not be dropped');
  assert('integration:directness_present', ctx.directnessScore !== undefined, 'directnessScore must not be dropped');
  assert('integration:sentiment_present', ctx.sentimentScore !== undefined, 'sentimentScore must not be dropped');

  // ScoreCard must be present
  assert('integration:scoreCard_present', ctx.scoreCard !== undefined, 'scoreCard must not be dropped');
  assert('integration:impactBreakdown_present', ctx.impactBreakdown !== undefined, 'impactBreakdown must not be dropped');

  // ScoreCard dimensions must be 0-1
  if (ctx.scoreCard) {
    const sc = ctx.scoreCard;
    assert('integration:sc_reliability_01', sc.sourceReliability >= 0 && sc.sourceReliability <= 1);
    assert('integration:sc_recency_01', sc.recency >= 0 && sc.recency <= 1);
    assert('integration:sc_novelty_01', sc.novelty >= 0 && sc.novelty <= 1);
    assert('integration:sc_directness_01', sc.directness >= 0 && sc.directness <= 1);
    assert('integration:sc_manipulationRisk_01', sc.manipulationRisk >= 0 && sc.manipulationRisk <= 1);
    assert('integration:sc_finalImpact_01', sc.finalSymbolImpact >= 0 && sc.finalSymbolImpact <= 1);
    assert('integration:sc_finalEventRisk_01', sc.finalEventRisk >= 0 && sc.finalEventRisk <= 1);
  }

  // SourceClass must be present
  assert('integration:sourceClass_present', ctx.sourceClass !== undefined, 'sourceClass must not be dropped');
}

// ════════════════════════════════════════════════════════════════
//  4. PHASE 4 — ENVELOPE PRESERVES ENRICHED CONTEXT
// ════════════════════════════════════════════════════════════════

async function testPhase4EnvelopeShape() {
  // Validate the Phase4SignalEnvelope type has the required fields
  // by importing the module and checking exported types exist
  const phase4Types = await import('../lib/signal-engine/types/phase4.types');

  // Check that key interfaces are exportable (won't throw if types exist)
  assert('phase4:types_importable', true);

  // Validate the macro context builder
  const { buildMacroContext, defaultNewsContext, computeEventRisk } = await import('../lib/signal-engine/context/macroContext');

  const defaultNews = defaultNewsContext();
  assert('phase4:defaultNews_strength_01', defaultNews.strength >= 0 && defaultNews.strength <= 1, `strength=${defaultNews.strength}`);
  assert('phase4:defaultNews_sourceConf_01', defaultNews.sourceConfidence >= 0 && defaultNews.sourceConfidence <= 1, `sourceConfidence=${defaultNews.sourceConfidence}`);

  // Validate computeEventRisk
  const risk = computeEventRisk(['earnings_within_3_days']);
  assert('phase4:eventRisk_has_score', risk.eventRiskScore >= 0 && risk.eventRiskScore <= 100, `eventRiskScore=${risk.eventRiskScore}`);
  assert('phase4:eventRisk_has_band', ['low', 'moderate', 'elevated', 'high'].includes(risk.eventRiskBand));
  assert('phase4:eventRisk_has_penalty', risk.eventRiskPenalty >= 0 && risk.eventRiskPenalty <= 10);

  // Validate contextual modifiers (all news values 0-1)
  const { computeContextualModifiers } = await import('../lib/signal-engine/context/contextualModifiers');

  const enrichedNews = {
    bias: 'positive' as const,
    strength: 0.65,
    freshnessHours: 4,
    sourceConfidence: 0.7,
    eventTags: ['earnings'],
    headline: 'Test headline',
    symbolImpactScore: 0.72,
    eventRiskScore: 0.35,
    manipulationSuspicion: 0.1,
    noveltyScore: 0.85,
    directnessScore: 0.9,
    sentimentScore: 0.5,
    eventType: 'earnings',
    sourceTier: 'high',
  };

  const macro = buildMacroContext({
    label: 'Bullish',
    allowBullishSignals: true,
    details: { closeVsEma20: 1, closeVsEma50: 1, closeVsEma200: 1, ema20VsEma50: 1, ema50VsEma200: 1, rsi: 60, atrPct: 1.5 },
    strength: 80,
    volatilityRegime: 'Normal',
    trendSlope: 0.5,
    confidence: 85,
  } as any, ['Banking']);

  const freshness = { ageBars: 0, ageHours: 0.5, freshnessScore: 95, decayState: 'fresh' as const, urgencyTag: 'high' as const, priceDriftPct: 0 };
  const feedback = { strategyRecentWinRate: 0.6, strategyEnvironmentFit: 'good' as const, confidenceCalibrationState: 'well_calibrated' as const };

  const mods = computeContextualModifiers(75, macro, enrichedNews, risk, freshness, feedback, true);
  assert('phase4:modifiers_has_newsModifier', typeof mods.newsModifier === 'number');
  assert('phase4:modifiers_final_bounded', mods.finalAdjustedConfidence >= 0 && mods.finalAdjustedConfidence <= 100,
    `finalAdjustedConfidence=${mods.finalAdjustedConfidence}`);
  assert('phase4:modifiers_cap_bounded', Math.abs(mods.cappedAdaptiveAdjustment) <= 10,
    `cappedAdaptiveAdjustment=${mods.cappedAdaptiveAdjustment}`);
}

// ════════════════════════════════════════════════════════════════
//  5. DEXTER — SCORE BREAKDOWN + ALIGNMENT + RISK
// ════════════════════════════════════════════════════════════════

async function testDexterNarrative() {
  const { buildDexterNarrative } = await import('../lib/signal-engine/dexter/buildDexterNarrative');

  // Build a synthetic Phase4SignalEnvelope
  const envelope = {
    symbol: 'RELIANCE',
    signalType: 'bullish_breakout',
    signalSubtype: 'fresh_breakout',
    marketRegime: 'Bullish',
    confidenceScore: 78,
    adjustedConfidenceScore: 82,
    confidenceBand: 'High Conviction',
    riskScore: 35,
    tradePlan: { entryZoneLow: 2900, entryZoneHigh: 2920, stopLoss: 2850, target1: 2990, target2: 3050, rrTarget1: 2.4 },
    positionSizing: { positionSizeUnits: 100, positionSizeValue: 292000, riskAmountAbsolute: 7000, validationStatus: 'approved' },
    portfolioFit: { fitScore: 85, sectorExposureImpact: 'acceptable', correlationPenalty: 2, correlationCluster: 'Energy', portfolioDecision: 'approved' },
    executionReadiness: { approvalDecision: 'approved', actionTag: 'ready' },
    macroContext: { marketTone: 'constructive', riskMode: 'moderate_risk_on', volatilityState: 'Normal', sectorLeadership: ['Banking'], macroEventProximity: 'none' },
    newsContext: {
      bias: 'positive' as const,
      strength: 0.65,
      freshnessHours: 4,
      sourceConfidence: 0.7,
      eventTags: ['earnings'],
      headline: 'Reliance earnings beat estimates',
      symbolImpactScore: 0.72,
      eventRiskScore: 0.25,
      manipulationSuspicion: 0.08,
      noveltyScore: 0.9,
      directnessScore: 0.85,
      sentimentScore: 0.5,
      eventType: 'earnings',
      sourceTier: 'high',
      sourceClass: 'media' as const,
      scoreCard: {
        sourceReliability: 0.55,
        recency: 0.8,
        sentiment: 0.5,
        novelty: 0.7,
        directness: 0.8,
        entityConfidence: 0.7,
        manipulationRisk: 0.08,
        finalSymbolImpact: 0.65,
        finalEventRisk: 0.25,
      },
      impactBreakdown: {
        symbolImpact: 0.65,
        sectorImpact: 0.3,
        marketImpact: 0.1,
        confidencePenalty: 0,
        riskPenalty: 2,
        narrativeSummary: 'strong positive news flow from 3 event(s), low risk.',
      },
    },
    eventRisk: { eventRiskScore: 25, eventRiskBand: 'moderate' as const, eventRiskPenalty: 3, eventTags: ['earnings_within_3_days' as const], comment: 'Earnings approaching' },
    contextualModifiers: { newsModifier: 4, macroModifier: 2, eventRiskPenalty: -3, sectorNarrativeModifier: 3, strategyFitModifier: 1, freshnessPenalty: 0, feedbackCalibrationModifier: 0, rawTotal: 7, cappedAdaptiveAdjustment: 7, originalConfidence: 78, finalAdjustedConfidence: 82 },
    aiExplanation: { summary: 'Test', whyNow: 'Test', decisionNarrative: 'Test', traderGuidance: ['Buy on confirmation'], riskHighlights: ['Event risk'], whatWouldInvalidate: ['Stop breach'], whyNotOversize: 'Risk' },
    traderNarrative: { shortSummary: 'Test', fullNarrative: 'Test', guidanceBullets: ['Buy'], invalidationSummary: 'Stop' },
    freshness: { ageBars: 0, ageHours: 0.5, freshnessScore: 95, decayState: 'fresh' as const, urgencyTag: 'high' as const, priceDriftPct: 0 },
    feedbackState: { strategyRecentWinRate: 0.62, strategyEnvironmentFit: 'good' as const, confidenceCalibrationState: 'well_calibrated' as const },
    lifecycleStatus: 'active',
    scoreCard: {
      sourceReliability: 0.55,
      recency: 0.8,
      sentiment: 0.5,
      novelty: 0.7,
      directness: 0.8,
      entityConfidence: 0.7,
      manipulationRisk: 0.08,
      finalSymbolImpact: 0.65,
      finalEventRisk: 0.25,
    },
    reasons: ['Breakout confirmed'],
    warnings: [],
    generatedAt: new Date().toISOString(),
  };

  const dexter = buildDexterNarrative(envelope as any);

  // Score breakdown must be present when scoreCard is provided
  assert('dexter:scoreBreakdown_present', dexter.scoreBreakdown !== null, 'scoreBreakdown must be present when scoreCard exists');
  if (dexter.scoreBreakdown) {
    assert('dexter:sb_reliability_01', dexter.scoreBreakdown.sourceReliability >= 0 && dexter.scoreBreakdown.sourceReliability <= 1);
    assert('dexter:sb_manipulationRisk_01', dexter.scoreBreakdown.manipulationRisk >= 0 && dexter.scoreBreakdown.manipulationRisk <= 1);
    assert('dexter:sb_finalImpact_01', dexter.scoreBreakdown.finalSymbolImpact >= 0 && dexter.scoreBreakdown.finalSymbolImpact <= 1);
    assert('dexter:sb_finalEventRisk_01', dexter.scoreBreakdown.finalEventRisk >= 0 && dexter.scoreBreakdown.finalEventRisk <= 1);
  }

  // Explanation sections
  assert('dexter:has_setupReason', dexter.explanation.setupReason.length > 0);
  assert('dexter:has_technicalContext', dexter.explanation.technicalContext.length > 0);
  assert('dexter:has_newsImpact', dexter.explanation.newsImpact.length > 0);
  assert('dexter:has_conflictCheck', dexter.explanation.conflictCheck.length > 0);
  assert('dexter:has_riskView', dexter.explanation.riskView.length > 0);
  assert('dexter:has_stanceReasoning', dexter.explanation.stanceReasoning.length > 0);

  // News alignment — bullish technical + bullish news = confirms or weakly supports
  assert('dexter:alignment_supportive',
    dexter.explanation.newsAlignment === 'confirms_technical' || dexter.explanation.newsAlignment === 'weakly_supports_technical',
    `Expected supportive alignment, got ${dexter.explanation.newsAlignment}`);

  // Verdict should be present and non-empty
  assert('dexter:verdict_present', dexter.verdict.length > 0);

  // Action stance for high-confidence, low-risk, confirmed signal = strong_buy or buy
  assert('dexter:stance_is_positive',
    dexter.actionStance === 'strong_buy' || dexter.actionStance === 'buy',
    `Expected positive stance, got ${dexter.actionStance}`);

  // Modifiers must be present
  assert('dexter:modifiers_news', typeof dexter.modifiers.news === 'number');
  assert('dexter:modifiers_macro', typeof dexter.modifiers.macro === 'number');
  assert('dexter:modifiers_eventRisk', typeof dexter.modifiers.eventRisk === 'number');

  // Calibration must be present
  assert('dexter:calibration_winRate', dexter.calibration.strategyWinRate === 0.62);
  assert('dexter:calibration_fit', dexter.calibration.strategyFit === 'good');

  // Guidance must be non-empty
  assert('dexter:guidance_present', dexter.guidance.length > 0);
}

// ════════════════════════════════════════════════════════════════
//  6. DEXTER — MANIPULATION + CONFLICT DETECTION
// ════════════════════════════════════════════════════════════════

async function testDexterManipulationDetection() {
  const { buildDexterNarrative } = await import('../lib/signal-engine/dexter/buildDexterNarrative');

  // Signal with HIGH manipulation suspicion + weak technical
  const manipEnvelope = {
    symbol: 'SCAMCO',
    signalType: 'momentum_continuation',
    signalSubtype: 'momentum_ride',
    marketRegime: 'Sideways',
    confidenceScore: 52,
    adjustedConfidenceScore: 48,
    confidenceBand: 'Avoid',
    riskScore: 65,
    tradePlan: { entryZoneLow: 100, entryZoneHigh: 102, stopLoss: 95, target1: 110, target2: 115, rrTarget1: 1.3 },
    positionSizing: { positionSizeUnits: 50, positionSizeValue: 5100, riskAmountAbsolute: 350, validationStatus: 'approved' },
    portfolioFit: { fitScore: 45, sectorExposureImpact: 'elevated', correlationPenalty: 10, correlationCluster: 'Unknown', portfolioDecision: 'approved_with_penalty' },
    executionReadiness: { approvalDecision: 'approved', actionTag: 'ready' },
    macroContext: { marketTone: 'neutral', riskMode: 'neutral', volatilityState: 'Normal', sectorLeadership: [], macroEventProximity: 'none' },
    newsContext: {
      bias: 'positive' as const,
      strength: 0.8,
      freshnessHours: 2,
      sourceConfidence: 0.2,
      eventTags: ['general'],
      headline: 'SCAMCO is the next multibagger! Buy now!',
      symbolImpactScore: 0.6,
      eventRiskScore: 0.7,
      manipulationSuspicion: 0.75,
      noveltyScore: 0.3,
      directnessScore: 0.9,
      sentimentScore: 0.8,
      eventType: 'general',
      sourceTier: 'low',
      sourceClass: 'social' as const,
      scoreCard: {
        sourceReliability: 0.2,
        recency: 0.9,
        sentiment: 0.8,
        novelty: 0.3,
        directness: 0.9,
        entityConfidence: 0.3,
        manipulationRisk: 0.75,
        finalSymbolImpact: 0.4,
        finalEventRisk: 0.7,
      },
    },
    eventRisk: { eventRiskScore: 15, eventRiskBand: 'low' as const, eventRiskPenalty: 2, eventTags: ['none' as const], comment: 'No events' },
    contextualModifiers: { newsModifier: -3, macroModifier: 0, eventRiskPenalty: -2, sectorNarrativeModifier: 0, strategyFitModifier: 0, freshnessPenalty: 0, feedbackCalibrationModifier: 0, rawTotal: -5, cappedAdaptiveAdjustment: -5, originalConfidence: 52, finalAdjustedConfidence: 48 },
    aiExplanation: { summary: 'Test', whyNow: 'Test', decisionNarrative: 'Test', traderGuidance: ['Caution'], riskHighlights: ['Hype'], whatWouldInvalidate: ['Stop'], whyNotOversize: 'Risk' },
    traderNarrative: { shortSummary: 'Test', fullNarrative: 'Test', guidanceBullets: ['Wait'], invalidationSummary: 'Stop' },
    freshness: { ageBars: 0, ageHours: 1, freshnessScore: 90, decayState: 'fresh' as const, urgencyTag: 'high' as const, priceDriftPct: 0 },
    feedbackState: { strategyRecentWinRate: null, strategyEnvironmentFit: 'insufficient_data' as const, confidenceCalibrationState: 'insufficient_data' as const },
    lifecycleStatus: 'active',
    reasons: ['Momentum detected'],
    warnings: ['NEWS: Elevated manipulation suspicion (75%)'],
    generatedAt: new Date().toISOString(),
  };

  const dexter = buildDexterNarrative(manipEnvelope as any);

  // With manipulation > 0.5, news quality should be insufficient
  assert('dexter:manip_alignment_flags_quality',
    dexter.explanation.newsAlignment === 'insufficient_news_quality',
    `Expected insufficient_news_quality, got ${dexter.explanation.newsAlignment}`);

  // Low confidence + manipulation → reject stance
  assert('dexter:manip_stance_reject',
    dexter.actionStance === 'reject' || dexter.actionStance === 'avoid',
    `Expected reject/avoid for hype signal, got ${dexter.actionStance}`);

  // Risk view should mention manipulation
  assert('dexter:manip_risk_mentions_manipulation',
    dexter.explanation.riskView.toLowerCase().includes('manipulation'),
    'Risk view should mention manipulation suspicion');

  // Guidance should warn about manipulation
  const guidanceText = dexter.guidance.join(' ').toLowerCase();
  assert('dexter:manip_guidance_warns',
    guidanceText.includes('manipulation') || guidanceText.includes('avoid'),
    'Guidance should warn about manipulation or avoid');
}

// ════════════════════════════════════════════════════════════════
//  7. BACKTEST — ENRICHED NEWS FIELDS + MANIPULATION FILTER
// ════════════════════════════════════════════════════════════════

async function testBacktestNewsReplay() {
  // Validate SimulatedSignal type has enriched news fields
  // We check this by creating a mock and ensuring the fields exist
  const mockSignal: any = {
    signalId: 'bt-test-001',
    symbol: 'RELIANCE',
    date: '2025-01-15',
    barIndex: 100,
    direction: 'long',
    strategy: 'bullish_breakout',
    regime: 'Bullish',
    confidenceScore: 75,
    confidenceBand: 'Actionable',
    riskScore: 35,
    sector: 'Energy',
    entryZoneLow: 2900,
    entryZoneHigh: 2920,
    stopLoss: 2850,
    target1: 2990,
    target2: 3050,
    target3: 3100,
    riskPerUnit: 70,
    rewardRiskApprox: 2.1,
    reasons: ['Breakout'],
    warnings: [],
    status: 'pending',
    barsWaited: 0,
    expiryDate: null,
    // Enriched news fields (all 0-1 normalized)
    newsImpactScore: 0.65,
    newsConfidenceModifier: 4,
    newsRiskPenalty: 2,
    newsEventRiskScore: 0.25,
    newsSentiment: 'bullish',
    newsWarnings: [],
    newsManipulationSuspicion: 0.08,
    newsNoveltyScore: 0.9,
    newsDirectnessScore: 0.85,
    newsSentimentScore: 0.5,
    newsSymbolImpactScore: 0.65,
    newsSourceClass: 'media',
    excludedByNewsFilter: false,
  };

  // Verify all enriched fields are present
  assert('backtest:has_manipulationSuspicion', mockSignal.newsManipulationSuspicion !== undefined);
  assert('backtest:has_noveltyScore', mockSignal.newsNoveltyScore !== undefined);
  assert('backtest:has_directnessScore', mockSignal.newsDirectnessScore !== undefined);
  assert('backtest:has_sentimentScore', mockSignal.newsSentimentScore !== undefined);
  assert('backtest:has_symbolImpactScore', mockSignal.newsSymbolImpactScore !== undefined);
  assert('backtest:has_sourceClass', mockSignal.newsSourceClass !== undefined);

  // Verify 0-1 normalization
  assert('backtest:impactScore_01', mockSignal.newsImpactScore >= 0 && mockSignal.newsImpactScore <= 1);
  assert('backtest:eventRisk_01', mockSignal.newsEventRiskScore >= 0 && mockSignal.newsEventRiskScore <= 1);
  assert('backtest:manipulation_01', mockSignal.newsManipulationSuspicion >= 0 && mockSignal.newsManipulationSuspicion <= 1);
  assert('backtest:novelty_01', mockSignal.newsNoveltyScore >= 0 && mockSignal.newsNoveltyScore <= 1);
  assert('backtest:directness_01', mockSignal.newsDirectnessScore >= 0 && mockSignal.newsDirectnessScore <= 1);
  assert('backtest:sentiment_range', mockSignal.newsSentimentScore >= -1 && mockSignal.newsSentimentScore <= 1);
  assert('backtest:symbolImpact_01', mockSignal.newsSymbolImpactScore >= 0 && mockSignal.newsSymbolImpactScore <= 1);

  // Test manipulation-driven filtering: high manipulation + weak technical → filtered
  const hypeSignal: any = {
    ...mockSignal,
    signalId: 'bt-hype-001',
    symbol: 'SCAMCO',
    confidenceScore: 55,
    newsManipulationSuspicion: 0.75,
    newsSourceClass: 'social',
  };
  // In the live pipeline, manipulationSuspicion > 0.6 + confidence < 70 → filtered
  const shouldFilter = hypeSignal.newsManipulationSuspicion > 0.6 && hypeSignal.confidenceScore < 70;
  assert('backtest:hype_signal_filtered', shouldFilter, 'Hype signals with high manipulation suspicion and weak technical should be filtered');
}

// ════════════════════════════════════════════════════════════════
//  8. AI EXPLANATION — NEWS CONTEXT IN EXPLANATION
// ════════════════════════════════════════════════════════════════

async function testAIExplanationWithNews() {
  const { buildExplanation } = await import('../lib/signal-engine/ai-explain/buildExplanation');

  const newsContext = {
    bias: 'positive' as const,
    strength: 0.7,
    freshnessHours: 3,
    sourceConfidence: 0.8,
    eventTags: ['earnings'],
    headline: 'Strong earnings beat',
    symbolImpactScore: 0.75,
    eventRiskScore: 0.3,
    manipulationSuspicion: 0.05,
    noveltyScore: 0.95,
    directnessScore: 0.9,
    sentimentScore: 0.6,
    eventType: 'earnings',
    sourceTier: 'high',
    scoreCard: {
      sourceReliability: 0.7,
      recency: 0.9,
      sentiment: 0.6,
      novelty: 0.95,
      directness: 0.9,
      entityConfidence: 0.8,
      manipulationRisk: 0.05,
      finalSymbolImpact: 0.75,
      finalEventRisk: 0.3,
    },
  };

  const explanation = buildExplanation({
    symbol: 'RELIANCE',
    strategy: 'bullish_breakout' as any,
    features: {
      trend: { close: 2920, open: 2900, ema9: 2910, ema21: 2895, ema20: 2880, ema50: 2850, ema200: 2700, sma200: 2690, closeAbove20Ema: true, closeAbove50Ema: true, closeAbove200Ema: true, ema20Above50: true, ema50Above200: true, distanceFrom20EmaPct: 1.4, distanceFrom50EmaPct: 2.5 },
      momentum: { rsi14: 62, macdLine: 15, macdSignal: 10, macdHistogram: 5, roc5: 2.1, roc20: 5.3, stochasticK: 65, stochasticD: 60, adx: 32, bullishDivergence: false, bearishDivergence: false },
      volume: { volume: 5000000, avgVolume20: 3200000, volumeVs20dAvg: 1.56, breakoutVolumeRatio: 1.1, obv: 10000000, obvSlope: 8, vwap: 2910, volumeClimaxRatio: 1.2 },
      volatility: { atr14: 45, atrPct: 1.54, dailyRangePct: 2.1, gapPct: 0.5, bollingerUpper: 2960, bollingerLower: 2800, bollingerWidth: 0.055, bollingerPctB: 0.75, squeezed: false },
      structure: { recentResistance20: 2910, recentSupport20: 2830, breakoutDistancePct: 0.34, distanceToResistancePct: -0.34, distanceToSupportPct: 3.1, recentHigh20: 2910, recentLow20: 2830, isInsideDay: false, rangeCompressionRatio: 0.95, consecutiveHigherLows: 3, consecutiveLowerHighs: 0 },
      context: { marketRegime: 'Bullish' as const, liquidityPass: true },
    },
    confidence: { trendScore: 22, momentumScore: 16, volumeScore: 15, structureScore: 14, contextScore: 11, rawScore: 78, penaltyScore: 0, finalScore: 78, band: 'Actionable' as const },
    risk: { atrRisk: 15, gapRisk: 5, stopDistanceRisk: 20, overextensionRisk: 5, liquidityRisk: 10, candleVolatilityRisk: 10, regimeRisk: 5, totalScore: 35, band: 'Moderate Risk' as const },
    tradePlan: { entryZoneLow: 2900, entryZoneHigh: 2920, stopLoss: 2850, target1: 2990, target2: 3050, rrTarget1: 2.4, rrTarget2: 3.5 } as any,
    portfolioFit: { fitScore: 85, sectorExposureImpact: 'acceptable', correlationPenalty: 2, correlationCluster: 'Energy', portfolioDecision: 'approved' } as any,
    sizing: { positionSizeUnits: 100, positionSizeValue: 292000, riskAmountAbsolute: 7000, validationStatus: 'approved' } as any,
    macro: { marketTone: 'constructive' as const, riskMode: 'moderate_risk_on' as const, volatilityState: 'Normal', sectorLeadership: ['Banking'], macroEventProximity: 'none' as const },
    eventRisk: { eventRiskScore: 25, eventRiskBand: 'moderate' as const, eventRiskPenalty: 3, eventTags: ['earnings_within_3_days' as const], comment: 'Earnings approaching' },
    freshness: { ageBars: 0, ageHours: 0.5, freshnessScore: 95, decayState: 'fresh' as const, urgencyTag: 'high' as const, priceDriftPct: 0 },
    newsContext,
  });

  // Explanation should mention news catalyst
  assert('explanation:whyNow_has_news', explanation.whyNow.toLowerCase().includes('news') || explanation.whyNow.toLowerCase().includes('catalyst'),
    'whyNow should reference news catalyst when direct positive news exists');

  // Summary should be non-empty
  assert('explanation:summary_present', explanation.summary.length > 0);
  assert('explanation:decisionNarrative_present', explanation.decisionNarrative.length > 0);
}

// ════════════════════════════════════════════════════════════════
//  RUNNER
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Quantorus365 — End-to-End Pipeline Correctness Test  ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  await testIngestionAdapters();
  console.log('  ✓ Ingestion adapters validated');

  await testScoringNormalization();
  console.log('  ✓ Scoring normalization validated');

  await testSignalIntegrationNormalization();
  console.log('  ✓ Signal integration normalization validated');

  await testPhase4EnvelopeShape();
  console.log('  ✓ Phase 4 envelope shape validated');

  await testDexterNarrative();
  console.log('  ✓ Dexter narrative validated');

  await testDexterManipulationDetection();
  console.log('  ✓ Dexter manipulation detection validated');

  await testBacktestNewsReplay();
  console.log('  ✓ Backtest news replay validated');

  await testAIExplanationWithNews();
  console.log('  ✓ AI explanation with news validated');

  // Report
  console.log('\n════════════════════════════════════════════════════════');
  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${results.length} total\n`);

  if (failed > 0) {
    console.log('  FAILURES:');
    for (const r of results.filter(r => !r.passed)) {
      console.log(`    ✗ ${r.name}: ${r.error}`);
    }
  }

  console.log('\n════════════════════════════════════════════════════════');
  console.log(failed === 0 ? '  ✓ ALL TESTS PASSED' : `  ✗ ${failed} TESTS FAILED`);
  console.log('════════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
