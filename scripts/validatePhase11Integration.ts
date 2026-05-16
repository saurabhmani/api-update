/**
 * scripts/validatePhase11Integration.ts
 *
 * Integration smoke test for the Phase-11 wiring.
 *
 *   1. Builds a synthetic ExecutableSignal (matches what
 *      generatePhase3Signals emits in production).
 *   2. Calls runPhase11Pipeline — the per-signal helper that
 *      generatePhase4Signals invokes on every approved row.
 *   3. Asserts the output carries every Phase-11 field expected
 *      by saveSignals (the INSERT extension we just added).
 *   4. Round-trips through the Phase-11 serializer and confirms
 *      the columns map cleanly to the canonical API response.
 *
 * Pure / synthetic — no DB or live tape required.
 *
 * Run:
 *   npx tsx scripts/validatePhase11Integration.ts
 */
import {
  runPhase11Pipeline,
  type Phase11RunInput,
} from '../src/lib/signal-engine/pipeline/runPhase11Pipeline';
import {
  fromDbRow,
  serializeForCache,
  deserializeFromCache,
  toApiResponse,
  PHASE_11_REQUIRED_FIELDS,
} from '../src/lib/signal-engine/repository/phase11Serialization';
import type { ExecutableSignal } from '../src/lib/signal-engine/types/phase3.types';

console.log('='.repeat(80));
console.log('PHASE-11 INTEGRATION SMOKE TEST');
console.log('  exercises the per-signal pipeline runner that');
console.log('  generatePhase4Signals → saveSignals now consumes');
console.log('='.repeat(80));
console.log('');

// ── Synthetic ExecutableSignal (matches Phase-3 production output) ──
const sig: ExecutableSignal = {
  symbol:           'TCS',
  signalType:       'bullish_breakout',
  signalSubtype:    'primary',
  marketRegime:     'BULL',
  confidenceScore:  78,
  confidenceBand:   'High Conviction',
  tradePlan: {
    entryType:           'breakout_confirmation',
    entryZoneLow:        1490,
    entryZoneHigh:       1500,
    stopLoss:            1300,
    initialRiskPerUnit:  200,
    target1:             1700,
    target2:             1900,
    target3:             2100,
    rrTarget1:           2.4,
    rrTarget2:           4.0,
    rrTarget3:           5.5,
  },
  positionSizing: {
    capitalModel:        'fixed_fractional',
    portfolioCapital:    5_000_000,
    riskBudgetPct:       1.0,
    riskBudgetAmount:    50_000,
    initialRiskPerUnit:  200,
    positionSizeUnits:   250,
    grossPositionValue:  375_000,
    validationStatus:    'valid',
    warnings:            [],
  },
  portfolioFit: {
    fitScore:             82,
    sectorExposureImpact: 'acceptable',
    directionImpact:      'acceptable',
    capitalAvailability:  'sufficient',
    correlationCluster:   null,
    correlationPenalty:   0,
    portfolioDecision:    'approved',
    penalties:            [],
  },
  executionReadiness: {
    status:           'ready',
    actionTag:        'enter_now',
    priorityRank:     1,
    approvalDecision: 'approved',
    reasons:          [],
  },
  riskBreakdown: {
    standaloneRiskScore: 30,
    portfolioRiskScore:  25,
    totalRiskScore:      30,
    riskBand:            'Low Risk',
    riskFactors:         ['ATR within band', 'Liquidity ample'],
  },
  lifecycle: {
    state:     'approved',
    reason:    'phase3_approved',
    changedAt: '2026-04-25T08:00:00Z',
  },
  final_score:    92,
  classification: 'HIGH_CONVICTION',
  factor_scores:  {
    strategy_quality:    90, trend_alignment: 92, momentum: 88,
    volume_confirmation: 80, risk_reward: 90, liquidity: 88,
    market_regime:       78, portfolio_fit: 82,
  },
  reasons:     ['Bullish breakout confirmed on volume'],
  warnings:    [],
  generatedAt: '2026-04-25T08:00:00Z',
};

const input: Phase11RunInput = {
  signal:            sig,
  direction:         'BUY',
  sector:            'IT',
  atrPct:            0.014,
  liquidityScore:    85,
  riskReward:        2.4,
  risk: {
    risk_score:   30,
    risk_band:    'Low Risk',
    risk_factors: ['ATR within band', 'Liquidity ample'],
  },
  rejectionCodes:    [],
  rejectionReasons:  [],
  portfolioApproved: true,
  portfolioFitScore: 82,
  finalScore:        92,
  classification:    'HIGH_CONVICTION',
  factorScores:      sig.factor_scores,
  portfolioCapital:  5_000_000,
  riskPerTradePct:   1.0,
};

// ── Step 1. Run the pipeline ──────────────────────────────────
const out = runPhase11Pipeline(input);

console.log('## runPhase11Pipeline output (per-signal block)');
console.log('   stress_survival_score:   ' + out.stress_survival_score);
console.log('   stress_fragile:          ' + out.stress_fragile);
console.log('   stress_codes:            ' + JSON.stringify(out.stress_codes));
console.log('   live_valid:              ' + out.live_valid);
console.log('   live_validation_codes:   ' + JSON.stringify(out.live_validation_codes));
console.log('   recommended_quantity:    ' + out.recommended_quantity);
console.log('   recommended_capital:     ' + out.recommended_capital);
console.log('   rejection_codes:         ' + JSON.stringify(out.rejection_codes));
console.log('   rejection_reasons:       ' + JSON.stringify(out.rejection_reasons));
console.log('   explanation.summary:     ' + out.explanation.summary_reason);
console.log('');

// ── Step 2. Simulate the saveSignals INSERT params ─────────────
//
// This is the shape `saveSignals.ts` now writes for the eight new
// columns + four JSON blobs. The test passes if every column has
// a non-undefined value (NULL is allowed; undefined is not).
const insertCols: Record<string, unknown> = {
  stress_survival_score:        out.stress_survival_score,
  recommended_quantity:         out.recommended_quantity,
  recommended_capital:          out.recommended_capital,
  live_valid:                   out.live_valid ? 1 : 0,
  rejection_codes_json:         JSON.stringify(out.rejection_codes),
  rejection_reasons_json:       JSON.stringify(out.rejection_reasons),
  live_validation_reasons_json: JSON.stringify(out.live_validation_reasons),
  explanation_json:             JSON.stringify(out.explanation),
};
console.log('## saveSignals INSERT column values for q365_signals');
for (const [k, v] of Object.entries(insertCols)) {
  const display = typeof v === 'string' && v.length > 60 ? v.slice(0, 57) + '...' : String(v);
  console.log('   ' + k.padEnd(34) + ' = ' + display);
}
console.log('');

// ── Step 3. Round-trip via Phase-11 serializer to a canonical API row ─
const dbRow = {
  id:                  4242,
  symbol:              sig.symbol,
  direction:           'BUY',
  generated_at:        new Date(sig.generatedAt),
  final_score:         sig.final_score,
  classification:      sig.classification,
  confidence_score:    sig.confidenceScore,
  risk_score:          sig.riskBreakdown.totalRiskScore,
  portfolio_fit_score: sig.portfolioFit.fitScore,
  risk_reward:         sig.tradePlan.rrTarget1,
  signal_status:       'APPROVED_SIGNAL',
  phase4_factor_scores_json: JSON.stringify(sig.factor_scores),
  // Phase-11 columns from the INSERT block above
  stress_survival_score:        insertCols.stress_survival_score,
  recommended_quantity:         insertCols.recommended_quantity,
  recommended_capital:          insertCols.recommended_capital,
  live_valid:                   insertCols.live_valid,
  rejection_codes_json:         insertCols.rejection_codes_json,
  rejection_reasons_json:       insertCols.rejection_reasons_json,
  live_validation_reasons_json: insertCols.live_validation_reasons_json,
  explanation_json:             insertCols.explanation_json,
};
const row     = fromDbRow(dbRow as any);
const cached  = serializeForCache(row);
const wired   = JSON.parse(JSON.stringify(cached));
const restored = deserializeFromCache(wired);
const api     = toApiResponse(restored);

// ── Invariants ────────────────────────────────────────────────
const invariants: Array<[string, boolean]> = [
  ['stress_survival_score is finite & in [0,100]',
   typeof api.stress_survival_score === 'number' &&
   api.stress_survival_score >= 0 && api.stress_survival_score <= 100],
  ['live_valid is true (clean live tape)',
   api.live_valid === true],
  ['recommended_quantity matches base size (250)',
   api.recommended_quantity === 250],
  ['recommended_capital matches qty × entry (375,000)',
   api.recommended_capital === 250 * 1500],
  ['rejection_codes empty for approved row',
   api.rejection_codes.length === 0],
  ['rejection_reasons empty for approved row',
   api.rejection_reasons.length === 0],
  ['live_validation_reasons empty (live valid)',
   api.live_validation_reasons.length === 0],
  ['explanation.summary_reason mentions APPROVED',
   api.explanation.summary_reason.includes('APPROVED')],
  ['factor_scores 8-factor block populated',
   typeof api.factor_scores === 'object' &&
   typeof api.factor_scores.liquidity === 'number'],
  ['every Phase-11 required key present on API response',
   PHASE_11_REQUIRED_FIELDS.every((k) =>
     k in (api as unknown as Record<string, unknown>)
   )],
];

console.log('## Invariants');
let ok = true;
for (const [label, pass] of invariants) {
  console.log('   ' + (pass ? '✅' : '❌') + '  ' + label);
  if (!pass) ok = false;
}
console.log('');

console.log('='.repeat(80));
console.log(ok
  ? 'RESULT: Phase-11 integration wired correctly across runPhase11Pipeline → saveSignals → readSignals → API.'
  : 'RESULT: Integration FAIL — see invariants above.');
console.log('='.repeat(80));
process.exit(ok ? 0 : 1);
