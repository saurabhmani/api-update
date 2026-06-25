/**
 * scripts/validateLearningEngineHealth.ts
 *
 * Validates Learning Engine health transitions against live DB state
 * and synthetic scenario fixtures.
 *
 * Run: npx tsx scripts/validateLearningEngineHealth.ts
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import {
  evaluateLearningPersistenceHealth,
  probeLearningPersistence,
  LEARNING_MATURE_OBSERVATION_THRESHOLD,
} from '../src/lib/learning/learningPersistenceProbe';
import { buildLearningHealthNode } from '../src/lib/signals/engineHealthMap';

const SCENARIOS = {
  A: { tableExists: false, observationCount: 0, distinctStrategies: 0, lastReviewedAt: null },
  B: { tableExists: true, observationCount: 0, distinctStrategies: 0, lastReviewedAt: null },
  C: { tableExists: true, observationCount: 10, distinctStrategies: 3, lastReviewedAt: '2026-06-24T10:00:00Z' },
  D: { tableExists: true, observationCount: 45, distinctStrategies: 8, lastReviewedAt: '2026-06-24T10:00:00Z' },
} as const;

const EXPECTED: Record<keyof typeof SCENARIOS, string> = {
  A: 'NOT_CONFIGURED',
  B: 'INSUFFICIENT_DATA',
  C: 'INSUFFICIENT_DATA',
  D: 'HEALTHY',
};

async function main(): Promise<void> {
  console.log('═══ LEARNING ENGINE HEALTH VALIDATION ═══\n');

  let ok = true;
  for (const [label, probe] of Object.entries(SCENARIOS) as Array<[keyof typeof SCENARIOS, typeof SCENARIOS[keyof typeof SCENARIOS]]>) {
    const evald = evaluateLearningPersistenceHealth(probe);
    const pass = evald.status === EXPECTED[label];
    if (!pass) ok = false;
    console.log(`  ${pass ? '✓' : '✗'}  Scenario ${label}: ${evald.status} (expected ${EXPECTED[label]}) — ${evald.primaryIssue ?? 'ok'}`);
  }

  console.log('\n── Live warehouse probe ─────────────────');
  const live = await probeLearningPersistence();
  const liveEval = evaluateLearningPersistenceHealth(live);
  const node = buildLearningHealthNode({
    generatedAt: new Date().toISOString(),
    marketStatus: { isOpen: true, label: 'Market Open' },
    feed: {
      provider: null, lastSuccessAt: null, lastApiRequestAt: null,
      isBootstrap: false, isFallback: false, staleMinutes: null, freshnessLabel: null,
      coveragePercent: null, symbolsRequested: null, symbolsReturned: null, candleAgeHours: null,
    },
    pipeline: {
      lastPipelineRunAt: null, lastConfirmedSignalAt: null, latestBatchId: null,
      latestBatchEngineKind: null, scanCoveragePercent: null, totalScanned: null,
      totalPersisted: null, universeSize: null, inProgressCount: null, validationStatus: null,
    },
    signals: {
      approved: [], highPotential: [], watchlist: [], developing: [],
      scannerCandidates: [], riskRestricted: [], rejected: [],
    },
    counters: {
      approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
      highPotentialTotal: 0, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 0,
    },
    dueDiligenceSummary: null,
    learningPersistence: live,
  });

  console.log(`  tableExists:        ${live.tableExists}`);
  console.log(`  observationCount:   ${live.observationCount}`);
  console.log(`  distinctStrategies: ${live.distinctStrategies}`);
  console.log(`  mature threshold:   ${LEARNING_MATURE_OBSERVATION_THRESHOLD}`);
  console.log(`  health status:      ${liveEval.status} (${liveEval.readiness})`);
  console.log(`  node status:        ${node.status}`);
  if (liveEval.primaryIssue) console.log(`  primary issue:      ${liveEval.primaryIssue}`);

  console.log('\n── Summary ─────────────────────────────');
  console.log(ok
    ? '  Synthetic scenarios A–D: PASS'
  : '  Synthetic scenarios A–D: FAIL');
  console.log(`  Live readiness: ${liveEval.readiness} — honest, not suppressed`);

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
