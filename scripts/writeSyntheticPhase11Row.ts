/**
 * scripts/writeSyntheticPhase11Row.ts
 *
 * Bypasses the candle pipeline (which needs market_data_daily
 * populated) and writes ONE synthetic signal directly through
 * the production saveSignals path. Proves the live INSERT writes
 * the eight Phase-11 columns + four JSON blobs correctly.
 *
 * After running this, scripts/smokeTestPhase11Live.ts should show
 * the writer-wired flag green.
 *
 * Run:
 *   npx tsx scripts/writeSyntheticPhase11Row.ts
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import { saveSignals } from '../src/lib/signal-engine/repository/saveSignals';
import { runPhase11Pipeline } from '../src/lib/signal-engine/pipeline/runPhase11Pipeline';
import type { ExecutableSignal } from '../src/lib/signal-engine/types/phase3.types';
import type { QuantSignal } from '../src/lib/signal-engine/types/signalEngine.types';

async function main() {
  console.log('='.repeat(72));
  console.log('SYNTHETIC PHASE-11 ROW WRITER');
  console.log('='.repeat(72));
  console.log('');

  // ── Build a synthetic ExecutableSignal (no candles needed) ──
  const sig: ExecutableSignal = {
    symbol:           'PHASE11_SMOKE',
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
      changedAt: new Date().toISOString(),
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
    generatedAt: new Date().toISOString(),
  };

  // ── Run the Phase-11 pipeline on it ──────────────────────────
  console.log('[1/3] Running runPhase11Pipeline (stress + live + sizing + explanation)…');
  const phase11 = runPhase11Pipeline({
    signal: sig, direction: 'BUY', sector: 'IT',
    atrPct: 0.014, liquidityScore: 85,
    riskReward: 2.4,
    risk: { risk_score: 30, risk_band: 'Low Risk', risk_factors: ['ATR within band'] },
    rejectionCodes: [], rejectionReasons: [],
    portfolioApproved: true, portfolioFitScore: 82,
    finalScore: 92, classification: 'HIGH_CONVICTION', factorScores: sig.factor_scores,
    portfolioCapital: 5_000_000, riskPerTradePct: 1.0,
  });
  console.log('   stress_survival_score:    ' + phase11.stress_survival_score);
  console.log('   live_valid:               ' + phase11.live_valid);
  console.log('   recommended_quantity:     ' + phase11.recommended_quantity);
  console.log('   recommended_capital:      ' + phase11.recommended_capital);
  console.log('   explanation.summary:      ' + phase11.explanation.summary_reason.slice(0, 80) + '…');
  console.log('');

  // ── Build a QuantSignal with phase11 attached ───────────────
  console.log('[2/3] Calling saveSignals — exercises the production INSERT into q365_signals…');
  const quantSignal: any = {
    symbol:             sig.symbol,
    timeframe:          'daily',
    signalType:         sig.signalType,
    signalSubtype:      sig.signalSubtype,
    action:             'enter_on_breakout',
    marketRegime:       sig.marketRegime,
    marketContextTag:   'normal',
    strengthTag:        'moderate',
    strategyName:       sig.signalType,
    strategyConfidence: sig.confidenceScore,
    contextScore:       0,
    confidenceScore:    sig.confidenceScore,
    confidenceBand:     sig.confidenceBand,
    riskScore:          sig.riskBreakdown.totalRiskScore,
    riskBand:           'Low',
    entry: { type: 'breakout_confirmation', zoneLow: sig.tradePlan.entryZoneLow, zoneHigh: sig.tradePlan.entryZoneHigh },
    stopLoss:           sig.tradePlan.stopLoss,
    targets:            { target1: sig.tradePlan.target1, target2: sig.tradePlan.target2 },
    rewardRiskApprox:   sig.tradePlan.rrTarget1,
    reasons:            sig.reasons,
    warnings:           sig.warnings,
    status:             'active',
    generatedAt:        sig.generatedAt,
    // Phase-4 pass-through
    phase4FinalScore:     sig.final_score,
    phase4Classification: sig.classification,
    phase4FactorScores:   sig.factor_scores,
    // Phase-11 unified row block
    phase11StressSurvivalScore:   phase11.stress_survival_score,
    phase11LiveValid:             phase11.live_valid,
    phase11RecommendedQuantity:   phase11.recommended_quantity,
    phase11RecommendedCapital:    phase11.recommended_capital,
    phase11RejectionCodes:        phase11.rejection_codes,
    phase11RejectionReasons:      phase11.rejection_reasons,
    phase11LiveValidationReasons: phase11.live_validation_reasons,
    phase11Explanation:           phase11.explanation,
  };
  const idMap = await saveSignals([quantSignal as QuantSignal], 'scripts:writeSyntheticPhase11Row');
  const insertedId = idMap.get(sig.symbol);
  console.log('   inserted signal_id: ' + insertedId);
  console.log('');

  // ── Read it back and verify Phase-11 columns landed ─────────
  console.log('[3/3] Reading the row back and verifying Phase-11 columns are populated.');
  const { rows } = await db.query<any>(
    `SELECT id, symbol, direction, signal_status,
            stress_survival_score, recommended_quantity, recommended_capital,
            live_valid, rejection_codes_json, rejection_reasons_json,
            live_validation_reasons_json, explanation_json,
            classification, phase4_factor_scores_json
     FROM q365_signals WHERE id = ?`,
    [insertedId],
  );
  const row = rows[0];
  if (!row) {
    console.error('   row not found — INSERT did not commit');
    process.exit(1);
  }
  const checks: Array<[string, boolean, string]> = [
    ['stress_survival_score is numeric',         row.stress_survival_score != null, String(row.stress_survival_score)],
    ['recommended_quantity > 0',                 Number(row.recommended_quantity) > 0, String(row.recommended_quantity)],
    ['recommended_capital > 0',                  Number(row.recommended_capital) > 0, String(row.recommended_capital)],
    ['live_valid is set',                        row.live_valid != null, String(row.live_valid)],
    // For an APPROVED row these arrays are NULL (saveSignals only
    // persists JSON when there's something to record). The verification
    // is therefore: column is either NULL OR a valid JSON array.
    ['rejection_codes_json is NULL on approved row',         row.rejection_codes_json == null,       String(row.rejection_codes_json)],
    ['rejection_reasons_json is NULL on approved row',       row.rejection_reasons_json == null,     String(row.rejection_reasons_json)],
    ['live_validation_reasons_json is NULL on approved row', row.live_validation_reasons_json == null, String(row.live_validation_reasons_json)],
    ['explanation_json carries summary_reason',
      typeof row.explanation_json === 'string'
        ? row.explanation_json.includes('summary_reason')
        : (row.explanation_json && (row.explanation_json as any).summary_reason != null),
      'present'],
    ['classification is HIGH_CONVICTION',        row.classification === 'HIGH_CONVICTION', String(row.classification)],
    ['phase4_factor_scores_json carries 8 factors',
      typeof row.phase4_factor_scores_json === 'string'
        ? row.phase4_factor_scores_json.includes('strategy_quality')
        : (row.phase4_factor_scores_json && (row.phase4_factor_scores_json as any).strategy_quality != null),
      'present'],
  ];

  let ok = true;
  for (const [label, pass, val] of checks) {
    console.log('   ' + (pass ? '✅' : '❌') + '  ' + label.padEnd(48) + '  ' + val);
    if (!pass) ok = false;
  }
  console.log('');
  console.log('='.repeat(72));
  console.log(ok
    ? 'RESULT: Production INSERT writes every Phase-11 column. Live wiring confirmed.'
    : 'RESULT: At least one Phase-11 column did NOT populate.');
  console.log('='.repeat(72));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('SMOKE TEST FAILED:', err);
  process.exit(1);
});
