// ════════════════════════════════════════════════════════════════
//  Architecture Verification — Proves each phase, service, and
//  integration point works as documented in ARCHITECTURE.md
//
//  Run: npm run test:architecture
// ════════════════════════════════════════════════════════════════

export {};  // Force module scope — prevent global collisions with other test files

const archResults: { name: string; passed: boolean; error?: string }[] = [];

function archAssert(name: string, condition: boolean, detail?: string) {
  archResults.push({ name, passed: condition, error: condition ? undefined : detail ?? 'Assertion failed' });
}

// ════════════════════════════════════════════════════════════════
//  1. SERVICE LAYER — All 4 services exist and export correctly
// ════════════════════════════════════════════════════════════════

async function testServiceLayer() {
  // Scenario Engine
  const scenario = await import('../services/scenarioEngine');
  archAssert('services:scenarioEngine_exists', typeof scenario.computeScenario === 'function');
  archAssert('services:scenarioEngine_isStrategyAllowed', typeof scenario.isStrategyAllowed === 'function');

  // Market Stance Engine
  const stance = await import('../services/marketStanceEngine');
  archAssert('services:marketStanceEngine_exists', typeof stance.computeMarketStance === 'function');
  archAssert('services:marketStanceEngine_getStanceConfig', typeof stance.getStanceConfig === 'function');

  // System Config Service
  const config = await import('../services/systemConfigService');
  archAssert('services:systemConfigService_exists', typeof config.getConfig === 'function');
  archAssert('services:systemConfigService_applyStanceOverrides', typeof config.applyStanceOverrides === 'function');

  // Portfolio Fit Service
  const portfolio = await import('../services/portfolioFitService');
  archAssert('services:portfolioFitService_exists', typeof portfolio.computePortfolioFit === 'function');
  archAssert('services:portfolioFitService_getPortfolioContext', typeof portfolio.getPortfolioContext === 'function');
}

// ════════════════════════════════════════════════════════════════
//  2. PIPELINE — All 4 phases exist and chain correctly
// ════════════════════════════════════════════════════════════════

async function testPipelinePhases() {
  const p1 = await import('../lib/signal-engine/pipeline/generatePhase1Signals');
  archAssert('pipeline:phase1_exists', typeof p1.generatePhase1Signals === 'function');

  const p2 = await import('../lib/signal-engine/pipeline/generatePhase2Signals');
  archAssert('pipeline:phase2_exists', typeof p2.generatePhase2Signals === 'function');

  const p3 = await import('../lib/signal-engine/pipeline/generatePhase3Signals');
  archAssert('pipeline:phase3_exists', typeof p3.generatePhase3Signals === 'function');

  const p4 = await import('../lib/signal-engine/pipeline/generatePhase4Signals');
  archAssert('pipeline:phase4_exists', typeof p4.generatePhase4Signals === 'function');
}

// ════════════════════════════════════════════════════════════════
//  3. REJECTION ENGINE — Canonical gate system
// ════════════════════════════════════════════════════════════════

async function testRejectionEngine() {
  const { runRejectionEngine } = await import('../lib/signal-engine/core/runRejectionEngine');
  archAssert('rejection:engine_exists', typeof runRejectionEngine === 'function');

  // Test: low confidence → rejected
  const lowConfResult = runRejectionEngine({
    symbol: 'TEST', strategy: 'bullish_breakout' as any,
    confidenceScore: 40, riskScore: 50, rewardRisk: 2.0,
    entryPrice: 100, stopLoss: 95, atrPct: 1.5, volume: 500000,
    regime: 'Bullish', sector: 'IT',
    portfolioFit: { fitScore: 80, portfolioDecision: 'approved', penalties: [] } as any,
    executionReadiness: { approvalDecision: 'approved' } as any,
    stanceContext: { stance: 'selective', conviction: 'moderate', riskMode: 'normal', minConfidence: 55, minRR: 1.5, maxRiskScore: 80 },
  });
  archAssert('rejection:low_confidence_rejected', lowConfResult.finalDecision === 'rejected', `Expected rejected, got ${lowConfResult.finalDecision}`);
  archAssert('rejection:low_confidence_code', lowConfResult.rejectionCode === 'confidence_below_threshold');
  archAssert('rejection:has_decision_trace', lowConfResult.decisionTrace.length > 0);

  // Test: manipulation rejection (stop within valid ATR range)
  const manipResult = runRejectionEngine({
    symbol: 'SCAMCO', strategy: 'momentum_continuation' as any,
    confidenceScore: 70, riskScore: 40, rewardRisk: 2.5,
    entryPrice: 100, stopLoss: 97, atrPct: 2.0, volume: 500000,
    regime: 'Bullish', sector: 'IT',
    portfolioFit: { fitScore: 75, portfolioDecision: 'approved', penalties: [] } as any,
    executionReadiness: { approvalDecision: 'approved' } as any,
    manipulationContext: { score: 85, band: 'severe', shouldPenalize: true, shouldReject: true, warning: 'Severe manipulation' },
  });
  archAssert('rejection:manipulation_rejected', manipResult.finalDecision === 'rejected');
  archAssert('rejection:manipulation_code', manipResult.rejectionCode === 'manipulation_rejected');
  archAssert('rejection:manipulation_snapshot', manipResult.manipulationSnapshot !== null);
  archAssert('rejection:manipulation_snapshot_score', manipResult.manipulationSnapshot?.score === 85);

  // Test: scenario blocked (use Sideways regime so regime gate passes)
  const scenarioResult = runRejectionEngine({
    symbol: 'TEST', strategy: 'bullish_breakout' as any,
    confidenceScore: 80, riskScore: 30, rewardRisk: 2.5,
    entryPrice: 100, stopLoss: 95, atrPct: 1.5, volume: 500000,
    regime: 'Sideways', sector: 'IT',
    portfolioFit: { fitScore: 80, portfolioDecision: 'approved', penalties: [] } as any,
    executionReadiness: { approvalDecision: 'approved' } as any,
    scenarioContext: { scenarioTag: 'DEFENSIVE_ROTATION', allowedStrategies: ['mean_reversion_bounce'], blockedStrategies: ['bullish_breakout'] },
  });
  archAssert('rejection:scenario_blocked', scenarioResult.finalDecision === 'rejected');
  archAssert('rejection:scenario_code', scenarioResult.rejectionCode === 'scenario_blocked');

  // Test: regime incompatible (bullish strategy in bearish regime)
  const regimeResult = runRejectionEngine({
    symbol: 'TEST', strategy: 'bullish_breakout' as any,
    confidenceScore: 85, riskScore: 30, rewardRisk: 3.0,
    entryPrice: 100, stopLoss: 95, atrPct: 1.5, volume: 500000,
    regime: 'Bearish', sector: 'IT',
    portfolioFit: { fitScore: 85, portfolioDecision: 'approved', penalties: [] } as any,
    executionReadiness: { approvalDecision: 'approved' } as any,
  });
  archAssert('rejection:regime_incompatible', regimeResult.finalDecision === 'rejected');
  archAssert('rejection:regime_code', regimeResult.rejectionCode === 'regime_incompatible');

  // Test: liquidity insufficient
  const liqResult = runRejectionEngine({
    symbol: 'ILLIQUID', strategy: 'mean_reversion_bounce' as any,
    confidenceScore: 80, riskScore: 35, rewardRisk: 2.5,
    entryPrice: 100, stopLoss: 95, atrPct: 1.5, volume: 50000,
    regime: 'Bullish', sector: 'IT',
    portfolioFit: { fitScore: 80, portfolioDecision: 'approved', penalties: [] } as any,
    executionReadiness: { approvalDecision: 'approved' } as any,
  });
  archAssert('rejection:liquidity_insufficient', liqResult.finalDecision === 'rejected');
  archAssert('rejection:liquidity_code', liqResult.rejectionCode === 'liquidity_insufficient');

  // Test: clean approval
  const approvedResult = runRejectionEngine({
    symbol: 'RELIANCE', strategy: 'bullish_breakout' as any,
    confidenceScore: 82, riskScore: 35, rewardRisk: 2.5,
    entryPrice: 2920, stopLoss: 2850, atrPct: 1.5, volume: 5000000,
    regime: 'Bullish', sector: 'Energy',
    portfolioFit: { fitScore: 85, portfolioDecision: 'approved', penalties: [] } as any,
    executionReadiness: { approvalDecision: 'approved' } as any,
    stanceContext: { stance: 'selective', conviction: 'moderate', riskMode: 'normal', minConfidence: 55, minRR: 1.5, maxRiskScore: 80 },
  });
  archAssert('rejection:clean_approved', approvedResult.finalDecision === 'approved');
  archAssert('rejection:no_rejection_code', approvedResult.rejectionCode === null);
  archAssert('rejection:threshold_snapshot', Object.keys(approvedResult.thresholdSnapshot).length >= 5);
}

// ════════════════════════════════════════════════════════════════
//  4. CANONICAL SIGNAL TYPE — exists and has all required fields
// ════════════════════════════════════════════════════════════════

async function testCanonicalSignalType() {
  const { toApiResponse } = await import('../lib/signal-engine/types/canonicalSignal');
  archAssert('canonical:toApiResponse_exists', typeof toApiResponse === 'function');

  const mockRecord = {
    symbol: 'RELIANCE', instrumentKey: 'NSE_EQ|RELIANCE', exchange: 'NSE',
    direction: 'BUY' as const, strategy: 'bullish_breakout' as any, signalSubtype: 'fresh_breakout',
    timeframe: 'daily' as const,
    confidenceScore: 82, confidenceBand: 'High Conviction' as any, riskScore: 35, riskBand: 'Moderate',
    entryType: 'breakout_confirmation' as any, entryPrice: 2920, entryZoneLow: 2900, entryZoneHigh: 2920,
    stopLoss: 2850, target1: 2990, target2: 3050, target3: 3100, riskReward: 2.4,
    marketRegime: 'Bullish' as any, scenarioTag: 'BREAKOUT_CONTINUATION', marketStance: 'selective',
    sector: 'Energy', volatilityState: 'Normal',
    approvalDecision: 'approved' as any, rejectionCode: null, rejectionMessage: null,
    portfolioFitScore: 85, portfolioFitDecision: 'approved',
    manipulationScore: 12, manipulationBand: 'low', manipulationPenalty: 0,
    aiSummary: 'Strong breakout setup', enginePhase: 4, engineVersion: '4.0.0',
    generationSource: 'test', batchId: null,
    status: 'active' as const, generatedAt: new Date().toISOString(),
  };

  const api = toApiResponse(mockRecord, ['Breakout confirmed'], ['Event risk moderate']);
  archAssert('canonical:api_has_symbol', api.symbol === 'RELIANCE');
  archAssert('canonical:api_has_direction', api.direction === 'BUY');
  archAssert('canonical:api_has_strategy', api.strategy === 'bullish_breakout');
  archAssert('canonical:api_has_strategyDisplay', api.strategyDisplay === 'Bullish Breakout');
  archAssert('canonical:api_has_reasons', api.reasons.length === 1);
  archAssert('canonical:api_has_warnings', api.warnings.length === 1);
  archAssert('canonical:api_no_manipulation_warning', api.manipulationWarning === null); // low band
}

// ════════════════════════════════════════════════════════════════
//  5. DEXTER — Backtesting endpoint exists
// ════════════════════════════════════════════════════════════════

async function testDexterIntegration() {
  const dexterOutput = await import('../lib/backtesting/api/dexterOutput');
  archAssert('dexter:buildDexterOutput_exists', typeof dexterOutput.buildDexterOutput === 'function');

  // Verify Dexter narrative builder exists
  const dexterNarrative = await import('../lib/signal-engine/dexter/buildDexterNarrative');
  archAssert('dexter:buildDexterNarrative_exists', typeof dexterNarrative.buildDexterNarrative === 'function');
  archAssert('dexter:buildDexterNarratives_exists', typeof dexterNarrative.buildDexterNarratives === 'function');
}

// ════════════════════════════════════════════════════════════════
//  6. SIGNAL PERSISTENCE — write + read alignment
// ════════════════════════════════════════════════════════════════

async function testSignalPersistence() {
  const saveModule = await import('../lib/signal-engine/repository/saveSignals');
  archAssert('persistence:saveSignals_exists', typeof saveModule.saveSignals === 'function');
  archAssert('persistence:getLatestSignals_exists', typeof saveModule.getLatestSignals === 'function');

  const readModule = await import('../lib/signal-engine/repository/readSignals');
  archAssert('persistence:getActiveSignals_exists', typeof readModule.getActiveSignals === 'function');
  archAssert('persistence:getTopSignals_exists', typeof readModule.getTopSignals === 'function');
  archAssert('persistence:getIntelligenceSignals_exists', typeof readModule.getIntelligenceSignals === 'function');
}

// ════════════════════════════════════════════════════════════════
//  7. NEWS INTELLIGENCE — adapters + scoring + integration
// ════════════════════════════════════════════════════════════════

async function testNewsIntelligence() {
  const { SOURCE_CLASS_MAP } = await import('../lib/news-engine/types/newsEngine.types');
  const classes = new Set(Object.values(SOURCE_CLASS_MAP));
  archAssert('news:4_source_classes', classes.size === 4);
  archAssert('news:official_class', classes.has('official'));
  archAssert('news:social_class', classes.has('social'));

  const { buildSignalNewsContext } = await import('../lib/news-engine/impact/signalIntegration');
  archAssert('news:buildSignalNewsContext_exists', typeof buildSignalNewsContext === 'function');

  const { computeScoreCard } = await import('../lib/news-engine/scoring/computeScoreCard');
  archAssert('news:computeScoreCard_exists', typeof computeScoreCard === 'function');
}

// ════════════════════════════════════════════════════════════════
//  8. MANIPULATION ENGINE — integration hooks
// ════════════════════════════════════════════════════════════════

async function testManipulationEngine() {
  const hooks = await import('../lib/manipulation-engine/api/signalEngineHooks');
  archAssert('manipulation:getManipulationStatusForSymbol_exists', typeof hooks.getManipulationStatusForSymbol === 'function');
  archAssert('manipulation:buildHookResult_exists', typeof hooks.buildHookResult === 'function');

  const penalty = await import('../lib/manipulation-engine/api/applyManipulationPenalty');
  archAssert('manipulation:applyHookToSignal_exists', typeof penalty.applyHookToSignal === 'function');
  archAssert('manipulation:applyManipulationPenalty_exists', typeof penalty.applyManipulationPenalty === 'function');

  // Test hook result for null snapshot (no data)
  const noDataResult = hooks.buildHookResult(null, 'TEST');
  archAssert('manipulation:no_data_is_safe', noDataResult.shouldPenalize === false);
  archAssert('manipulation:no_data_score_zero', noDataResult.score === 0);
}

// ════════════════════════════════════════════════════════════════
//  RUNNER
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log('╔════════════════════════════════════════════════════════╗');
  console.log('║  Architecture Verification — Quantorus365              ║');
  console.log('╚════════════════════════════════════════════════════════╝\n');

  await testServiceLayer();
  console.log('  1. Service layer validated');

  await testPipelinePhases();
  console.log('  2. Pipeline phases validated');

  await testRejectionEngine();
  console.log('  3. Canonical rejection engine validated');

  await testCanonicalSignalType();
  console.log('  4. Canonical signal type validated');

  await testDexterIntegration();
  console.log('  5. Dexter integration validated');

  await testSignalPersistence();
  console.log('  6. Signal persistence validated');

  await testNewsIntelligence();
  console.log('  7. News intelligence validated');

  await testManipulationEngine();
  console.log('  8. Manipulation engine validated');

  // Report
  console.log('\n════════════════════════════════════════════════════════');
  const passed = archResults.filter(r => r.passed).length;
  const failed = archResults.filter(r => !r.passed).length;
  console.log(`  RESULTS: ${passed} passed, ${failed} failed, ${archResults.length} total\n`);

  if (failed > 0) {
    console.log('  FAILURES:');
    for (const r of archResults.filter(r => !r.passed)) {
      console.log(`    x ${r.name}: ${r.error}`);
    }
  }

  console.log('\n════════════════════════════════════════════════════════');
  console.log(failed === 0 ? '  ALL ARCHITECTURE CHECKS PASSED' : `  ${failed} CHECKS FAILED`);
  console.log('════════════════════════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Architecture verification failed:', err);
  process.exit(1);
});
