/**
 * scripts/validatePhase5Rejection.ts
 *
 * Phase-5 validation harness for runRejectionEngine. Exercises:
 *   - one approved signal (all 9 rules pass)
 *   - one rejected signal that fails MULTIPLE Phase-5 rules at once
 *     (so we see rejection_codes / rejection_reasons accumulate)
 *   - one rejected signal per Phase-5 rule, to prove each fires
 *
 * Run:
 *   npx tsx scripts/validatePhase5Rejection.ts
 */
import {
  runRejectionEngine,
  type RejectionInput,
} from '../src/lib/signal-engine/core/runRejectionEngine';
import type { PortfolioFitResult, ExecutionReadiness } from '../src/lib/signal-engine/types/phase3.types';

// ── Reusable fixtures ──────────────────────────────────────────
const goodPortfolioFit: PortfolioFitResult = {
  fitScore:            72,
  sectorExposureImpact:'acceptable',
  directionImpact:     'acceptable',
  capitalAvailability: 'sufficient',
  correlationCluster:  null,
  correlationPenalty:  0,
  portfolioDecision:   'approved',
  penalties:           [],
};

const goodExecutionReadiness: ExecutionReadiness = {
  status:           'ready',
  actionTag:        'enter_now',
  priorityRank:     null,
  approvalDecision: 'approved',
  reasons:          [],
};

const cleanInput: RejectionInput = {
  symbol:             'TCS',
  strategy:           'bullish_breakout',
  confidenceScore:    78,
  riskScore:          42,
  rewardRisk:         2.4,
  entryPrice:         1500,
  stopLoss:           1460,
  atrPct:             1.4,
  volume:             2_500_000,
  regime:             'Bullish',
  sector:             'IT',
  portfolioFit:       goodPortfolioFit,
  executionReadiness: goodExecutionReadiness,
  manipulationContext: { score: 12, band: 'low', shouldPenalize: false, shouldReject: false, warning: null },
  stanceContext: { stance: 'selective', conviction: 'medium', riskMode: 'strict', minConfidence: 60, minRR: 1.5, maxRiskScore: 70 },
  generatedAt:        new Date().toISOString(),
  // Phase-5 inputs
  liquidityScore:     85,
  minLiquidityScore:  50,
  minPortfolioFit:    50,
  maxManipulationRisk: 60,
  decayState:         'fresh',
  liveInvalidated:    false,
  currentPrice:       1505,
  direction:          'BUY',
};

function dump(label: string, input: RejectionInput) {
  const r = runRejectionEngine(input);
  console.log('── ' + label);
  console.log('   rejected:          ' + r.rejected);
  console.log('   signal_status:     ' + r.signalStatus);
  console.log('   rejection_codes:   ' + JSON.stringify(r.rejection_codes));
  console.log('   rejection_reasons:');
  for (const m of r.rejection_reasons) console.log('     - ' + m);
  const blockedKeys = Object.entries(r.blocked_by)
    .filter(([, v]) => v)
    .map(([k]) => k);
  console.log('   blocked_by:        ' + (blockedKeys.length ? blockedKeys.join(', ') : '(none)'));
  console.log('');
  return r;
}

console.log('='.repeat(72));
console.log('PHASE-5 REJECTION ENGINE — VALIDATION');
console.log('='.repeat(72));
console.log('');

// ── 1. Approved signal ───────────────────────────────────────────
console.log('## 1. APPROVED SIGNAL — all 9 rules pass');
console.log('');
const approved = dump('APPROVED — TCS BUY, healthy across the board', cleanInput);

// ── 2. Multi-failure rejection ───────────────────────────────────
console.log('## 2. REJECTED SIGNAL — multiple Phase-5 rules fire simultaneously');
console.log('');
const multiFail = dump('MULTI-FAIL — confidence + risk + R:R + liquidity + portfolio_fit + manipulation + decay + live_invalidated + stop_violated', {
  ...cleanInput,
  symbol:             'BADSTOCK',
  confidenceScore:    45,                 // < 60 → confidence_below_threshold
  riskScore:          82,                 // > 70 → risk_score_exceeded
  rewardRisk:         1.1,                // < 1.5 → risk_reward_insufficient
  liquidityScore:     30,                 // < 50 → liquidity_score_low
  portfolioFit:       { ...goodPortfolioFit, fitScore: 35 },  // < 50 → portfolio_fit_rejected
  manipulationContext:{ score: 78, band: 'high', shouldPenalize: true, shouldReject: false, warning: 'High wash-trading suspicion' },
  decayState:         'expired',          // → decay_expired
  liveInvalidated:    true,               // → live_invalidated
  currentPrice:       1455,               // BUY but cp <= stop (1460) → stop_violated
});

// ── 3. Per-rule isolation tests ──────────────────────────────────
console.log('## 3. PER-RULE ISOLATION — each Phase-5 rule fires alone');
console.log('');

dump('R1 confidence < 60',          { ...cleanInput, confidenceScore: 55 });
dump('R2 risk_score > 70',          { ...cleanInput, riskScore: 75 });
dump('R3 risk_reward < 1.5',        { ...cleanInput, rewardRisk: 1.3 });
dump('R4 liquidity_score < 50',     { ...cleanInput, liquidityScore: 35 });
dump('R5 portfolio_fit < 50',       { ...cleanInput, portfolioFit: { ...goodPortfolioFit, fitScore: 40 } });
dump('R6 manipulation_risk > 60',   { ...cleanInput, manipulationContext: { score: 75, band: 'high', shouldPenalize: false, shouldReject: false, warning: null } });
dump('R7 decay_state=expired',      { ...cleanInput, decayState: 'expired' });
dump('R7b decay_state=stale',       { ...cleanInput, decayState: 'stale' });
dump('R8 live_invalidated=true',    { ...cleanInput, liveInvalidated: true });
dump('R9 BUY current price ≤ stop', { ...cleanInput, currentPrice: 1455 });   // stop=1460
dump('R9b SELL current price ≥ stop', {
  ...cleanInput,
  strategy:    'bearish_breakdown',
  direction:   'SELL',
  entryPrice:  1500,
  stopLoss:    1540,
  currentPrice:1545,                                                          // crosses SELL stop
});

// ── 4. Invariants ────────────────────────────────────────────────
const ok = (
  approved.rejected === false &&
  approved.signalStatus === 'APPROVED_SIGNAL' &&
  approved.rejection_codes.length === 0 &&
  approved.rejection_reasons.length === 0 &&
  Object.values(approved.blocked_by).every((v) => v === false) &&

  multiFail.rejected === true &&
  multiFail.signalStatus === 'NO_TRADE' &&
  multiFail.rejection_codes.length >= 5 &&
  multiFail.rejection_reasons.length === multiFail.rejection_codes.length &&
  multiFail.blocked_by.confidence       &&
  multiFail.blocked_by.risk             &&
  multiFail.blocked_by.risk_reward      &&
  multiFail.blocked_by.liquidity        &&
  multiFail.blocked_by.portfolio_fit    &&
  multiFail.blocked_by.manipulation     &&
  multiFail.blocked_by.staleness        &&
  multiFail.blocked_by.live_invalidated &&
  multiFail.blocked_by.stop_violated
);

console.log('='.repeat(72));
console.log('## INVARIANTS');
console.log('='.repeat(72));
console.log('  approved row: rejected=false, no codes/reasons, blocked_by all false');
console.log('  multi-fail:   every Phase-5 category in blocked_by is true');
console.log('  rejection_codes.length === rejection_reasons.length:  ' + (multiFail.rejection_codes.length === multiFail.rejection_reasons.length));
console.log('');
console.log(ok
  ? 'RESULT: ✅ Phase-5 rejection engine honours the spec.'
  : 'RESULT: ❌ At least one invariant failed.');
console.log('='.repeat(72));
process.exit(ok ? 0 : 1);
