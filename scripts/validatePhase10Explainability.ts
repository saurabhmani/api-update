/**
 * scripts/validatePhase10Explainability.ts
 *
 * Phase-10 validation harness for the signal explainability engine.
 * Renders one APPROVED signal (every gate passes) and one REJECTED
 * signal (multiple gates fail) and prints the full block.
 *
 * Run:
 *   npx tsx scripts/validatePhase10Explainability.ts
 */
import {
  explainSignal,
  type SignalExplainabilityInput,
  type SignalExplainabilityReport,
} from '../src/lib/signal-engine/explainability/signalExplainabilityEngine';

function dump(label: string, input: SignalExplainabilityInput): SignalExplainabilityReport {
  const r = explainSignal(input);
  console.log('── ' + label);
  console.log('   symbol / direction:         ' + r.symbol + ' ' + r.direction +
              ' (approved=' + r.approved + ')');
  console.log('   summary_reason:');
  console.log('     ' + r.summary_reason);
  console.log('   factor_score_explanation:');
  console.log('     ' + r.factor_score_explanation);
  console.log('   risk_explanation:');
  console.log('     ' + r.risk_explanation);
  console.log('   portfolio_explanation:');
  console.log('     ' + r.portfolio_explanation);
  console.log('   stress_explanation:');
  console.log('     ' + r.stress_explanation);
  console.log('   rejection_explanation:');
  console.log('     ' + r.rejection_explanation);
  console.log('   final_decision_explanation:');
  console.log('     ' + r.final_decision_explanation);
  console.log('');
  return r;
}

console.log('='.repeat(72));
console.log('PHASE-10 SIGNAL EXPLAINABILITY ENGINE — VALIDATION');
console.log('='.repeat(72));
console.log('');

// ── 1. APPROVED signal — clean across every gate ───────────────
const approved = dump('APPROVED — TCS BUY, every gate clears', {
  symbol:         'TCS',
  direction:      'BUY',
  strategy:       'bullish_breakout',
  finalScore:     78,
  classification: 'HIGH_CONVICTION',
  factorScores: {
    strategy_quality:    82,
    trend_alignment:     85,
    momentum:            76,
    volume_confirmation: 71,
    risk_reward:         80,
    liquidity:           88,
    market_regime:       70,
    portfolio_fit:       72,
  },
  rejection: {
    rejected:          false,
    rejection_codes:   [],
    rejection_reasons: [],
  },
  portfolio: {
    approved:                   true,
    portfolio_fit_score:        76,
    breach_codes:               [],
    sector_exposure_after:      0.18,   // 18 %
    stock_exposure_after:       0.04,   //  4 %
    total_portfolio_risk_after: 0.045,  // 4.5 %
    capital_at_risk:            22_500,
    available_risk_budget:      157_500,
  },
  stress: {
    expected_loss:          12_710,
    worst_case_loss:        30_000,
    worst_case_scenario:    'market_down_10_percent',
    stress_survival_score:  75,
    fragile:                false,
    stress_rejection_codes: [],
  },
  liveValidation: {
    live_valid:            true,
    live_validation_codes: [],
    drift_pct:             0.13,
    distance_to_stop:      42,
    stop_buffer_pct:       1.05,
  },
  risk: {
    risk_score:   38,
    risk_band:    'Low Risk',
    risk_factors: ['ATR within band', 'liquidity ample'],
  },
  approved: true,
});

// ── 2. REJECTED signal — multiple gates fail ───────────────────
const rejected = dump('REJECTED — BADSTOCK BUY, multi-gate failure', {
  symbol:         'BADSTOCK',
  direction:      'BUY',
  strategy:       'bullish_breakout',
  finalScore:     34,
  classification: 'NO_TRADE',
  factorScores: {
    strategy_quality:    45,
    trend_alignment:     30,
    momentum:            28,
    volume_confirmation: 25,
    risk_reward:         40,
    liquidity:           38,
    market_regime:       42,
    portfolio_fit:       35,
  },
  rejection: {
    rejected:        true,
    rejection_codes: ['confidence_below_threshold', 'liquidity_score_low', 'risk_reward_insufficient'],
    rejection_reasons: [
      'Confidence 45 below threshold 60',
      'Liquidity score 38 below floor 50',
      'Risk:Reward 1.1 below floor 1.5',
    ],
  },
  portfolio: {
    approved:                   false,
    portfolio_fit_score:        32,
    breach_codes:               ['SECTOR_OVEREXPOSURE', 'POSITION_CONCENTRATION'],
    sector_exposure_after:      0.31,
    stock_exposure_after:       0.12,
    total_portfolio_risk_after: 0.07,
    capital_at_risk:            35_000,
    available_risk_budget:      5_000,
  },
  stress: {
    expected_loss:          48_000,
    worst_case_loss:        125_000,
    worst_case_scenario:    'market_down_10_percent',
    stress_survival_score:  42,                          // < 60 → fragile
    fragile:                true,
    stress_rejection_codes: ['stress_survival_below_60', 'market_crash_breaches_stop'],
  },
  liveValidation: {
    live_valid:            false,
    live_validation_codes: ['stop_violated'],
    drift_pct:            -3.2,
    distance_to_stop:      -2,
    stop_buffer_pct:       -0.05,
  },
  risk: {
    risk_score:   78,
    risk_band:    'High Risk',
    risk_factors: ['ATR elevated', 'thin liquidity', 'wide stop'],
  },
  approved: false,
});

// ── Invariants ─────────────────────────────────────────────────
const ok = (
  // Approved: every section reflects a clean state.
  approved.approved === true &&
  approved.summary_reason.includes('APPROVED') &&
  approved.factor_score_explanation.includes('HIGH_CONVICTION') &&
  approved.portfolio_explanation.includes('APPROVED') &&
  approved.stress_explanation.includes('resilient') &&
  approved.rejection_explanation.startsWith('No blocking codes') &&
  approved.final_decision_explanation.includes('APPROVED') &&
  approved.final_decision_explanation.includes('Sized for entry') &&

  // Rejected: every section names the failing gate.
  rejected.approved === false &&
  rejected.summary_reason.includes('REJECTED') &&
  rejected.summary_reason.includes('confidence_below_threshold') &&
  rejected.factor_score_explanation.includes('NO_TRADE') &&
  rejected.portfolio_explanation.includes('REJECTED') &&
  rejected.stress_explanation.includes('FRAGILE') &&
  rejected.rejection_explanation.includes('confidence_below_threshold') &&
  rejected.rejection_explanation.includes('SECTOR_OVEREXPOSURE') &&
  rejected.rejection_explanation.includes('stress_survival_below_60') &&
  rejected.rejection_explanation.includes('stop_violated') &&
  rejected.final_decision_explanation.includes('REJECTED') &&
  rejected.final_decision_explanation.includes('rejection engine') &&
  rejected.final_decision_explanation.includes('portfolio risk') &&
  rejected.final_decision_explanation.includes('stress test') &&
  rejected.final_decision_explanation.includes('live validation') &&
  rejected.final_decision_explanation.includes('Not sized')
);

console.log('='.repeat(72));
console.log('## INVARIANTS');
console.log('='.repeat(72));
console.log('  APPROVED → every section confirms clean state, sized for entry');
console.log('  REJECTED → rejection_explanation is the union of every gate\'s codes');
console.log('  REJECTED → final_decision_explanation names every failing gate');
console.log('');
console.log(ok
  ? 'RESULT: Phase-10 explainability engine honours the spec.'
  : 'RESULT: At least one invariant failed.');
console.log('='.repeat(72));
process.exit(ok ? 0 : 1);
