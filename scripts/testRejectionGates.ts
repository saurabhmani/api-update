/* eslint-disable no-console */
// ════════════════════════════════════════════════════════════════
//  Rejection-Engine Threshold Smoke Test
//
//  Verifies Phase-5 tightening:
//    - default minConfidence is 60
//    - default maxRiskScore is 70
//    - default minRR is 1.5
//    - stale signals (age > maxSignalAgeHours) are rejected
//
//  Run: npx tsx scripts/testRejectionGates.ts
// ════════════════════════════════════════════════════════════════

import {
  runRejectionEngine,
  type RejectionInput,
} from '../src/lib/signal-engine/core/runRejectionEngine';
import type { PortfolioFitResult, ExecutionReadiness } from '../src/lib/signal-engine/types/phase3.types';

const cleanPortfolio: PortfolioFitResult = {
  fitScore:             85,
  sectorExposureImpact: 'acceptable',
  directionImpact:      'acceptable',
  capitalAvailability:  'sufficient',
  correlationCluster:   null,
  correlationPenalty:   0,
  portfolioDecision:    'approved',
  penalties:            [],
};
const cleanExec: ExecutionReadiness = {
  status:           'ready',
  actionTag:        'enter_now',
  priorityRank:     1,
  approvalDecision: 'approved',
  reasons:          [],
};

function base(): RejectionInput {
  return {
    symbol:             'TEST',
    strategy:           'bullish_breakout',
    confidenceScore:    75,
    riskScore:          30,
    rewardRisk:         2.0,
    entryPrice:         100,
    stopLoss:            98,
    atrPct:              1.5,
    volume:           500_000,
    regime:             'Bullish',
    sector:             'IT',
    portfolioFit:       cleanPortfolio,
    executionReadiness: cleanExec,
  };
}

interface Case {
  name:     string;
  input:    RejectionInput;
  expect:   'approved' | 'rejected';
  expectCode?: string | null;
}

const cases: Case[] = [
  { name: 'baseline clean',          input: base(),
    expect: 'approved', expectCode: null },

  // Confidence: was 55, now 60.
  { name: 'confidence=59 (new floor)', input: { ...base(), confidenceScore: 59 },
    expect: 'rejected', expectCode: 'confidence_below_threshold' },
  { name: 'confidence=60 (at floor)',  input: { ...base(), confidenceScore: 60 },
    expect: 'approved', expectCode: null },

  // Risk: was 80, now 70.
  { name: 'riskScore=71 (above new cap)', input: { ...base(), riskScore: 71 },
    expect: 'rejected', expectCode: 'risk_score_exceeded' },
  { name: 'riskScore=70 (at cap)',        input: { ...base(), riskScore: 70 },
    expect: 'approved', expectCode: null },

  // RR unchanged 1.5.
  { name: 'rr=1.4 (below floor)', input: { ...base(), rewardRisk: 1.4 },
    expect: 'rejected', expectCode: 'risk_reward_insufficient' },

  // Staleness — opt-in via generatedAt.
  { name: 'generatedAt omitted (staleness skipped)',
    input: base(),
    expect: 'approved', expectCode: null },
  { name: 'generatedAt=now (fresh)',
    input: { ...base(), generatedAt: new Date().toISOString() },
    expect: 'approved', expectCode: null },
  { name: 'generatedAt=30h ago (stale)',
    input: { ...base(), generatedAt: new Date(Date.now() - 30 * 3_600_000).toISOString() },
    expect: 'rejected', expectCode: 'signal_stale' },
  { name: 'generatedAt=30h ago with custom cutoff=48h',
    input: { ...base(), generatedAt: new Date(Date.now() - 30 * 3_600_000).toISOString(), maxSignalAgeHours: 48 },
    expect: 'approved', expectCode: null },
];

function pad(s: string, w: number) { return s + ' '.repeat(Math.max(0, w - s.length)); }

let failures = 0;
console.log('\n━━━ REJECTION GATE SMOKE TEST ━━━\n');
console.log(pad('CASE', 50) + pad('EXPECT', 14) + pad('ACTUAL', 14) + 'CODE');
console.log('─'.repeat(100));

for (const c of cases) {
  const out = runRejectionEngine(c.input);
  const gotDecision = out.finalDecision === 'deferred' ? 'approved' : out.finalDecision;
  const gotCode     = out.rejectionCode;
  const decisionOk  = gotDecision === c.expect;
  const codeOk      = c.expectCode === undefined ? true : gotCode === c.expectCode;
  const ok          = decisionOk && codeOk;
  if (!ok) failures++;
  const mark = ok ? '✓' : '✗';
  console.log(
    `${mark} ` + pad(c.name, 48) +
    pad(c.expect, 14) +
    pad(gotDecision, 14) +
    (gotCode ?? '—'),
  );
}

console.log('\n━━━ THRESHOLD SNAPSHOT CHECK ━━━\n');
const snap = runRejectionEngine(base()).thresholdSnapshot;
console.log('minConfidence    =', snap.minConfidence,    snap.minConfidence    === 60 ? '✓' : '✗ expected 60');
console.log('maxRiskScore     =', snap.maxRiskScore,     snap.maxRiskScore     === 70 ? '✓' : '✗ expected 70');
console.log('minRR            =', snap.minRR,            snap.minRR            === 1.5 ? '✓' : '✗ expected 1.5');
console.log('maxSignalAgeHours=', snap.maxSignalAgeHours, snap.maxSignalAgeHours === 20 ? '✓' : '✗ expected 20');

if (snap.minConfidence     !== 60)  failures++;
if (snap.maxRiskScore      !== 70)  failures++;
if (snap.minRR             !== 1.5) failures++;
if (snap.maxSignalAgeHours !== 20)  failures++;

if (failures === 0) {
  console.log('\n✓ All assertions passed. Phase-5 thresholds and stale gate wired correctly.');
  process.exit(0);
} else {
  console.log(`\n✗ ${failures} failure(s).`);
  process.exit(1);
}
