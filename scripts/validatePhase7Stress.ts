/**
 * scripts/validatePhase7Stress.ts
 *
 * Phase-7 validation harness for the stress test engine.
 * Runs one BUY and one SELL signal through runStressTest() and
 * prints the full output (per-scenario losses, expected loss,
 * worst case, survival score, fragile flag, rejection codes).
 *
 * Run:
 *   npx tsx scripts/validatePhase7Stress.ts
 */
import {
  runStressTest,
  STRESS_SURVIVAL_HARD_FLOOR,
  type StressTestInput,
  type StressTestResult,
} from '../src/lib/signal-engine/risk/stressTestEngine';

function dump(label: string, input: StressTestInput): StressTestResult {
  const r = runStressTest(input);
  console.log('── ' + label);
  console.log('   symbol:                 ' + r.symbol + ' (' + r.direction + ')');
  console.log('   scenarios:');
  for (const s of r.scenarios) {
    const stop = s.stop_hit ? ' [STOP HIT]' : '';
    console.log(
      '     - ' + s.scenario.padEnd(32) +
      ' loss=' + String(s.loss).padStart(10) +
      ' (' + String(s.loss_pct).padStart(6) + '%)' + stop,
    );
  }
  console.log('   expected_loss:          ' + r.expected_loss + ' (' + r.expected_loss_pct + '% of capital)');
  console.log('   worst_case_loss:        ' + r.worst_case_loss + ' (' + r.worst_case_loss_pct + '% of capital)');
  console.log('   worst_case_scenario:    ' + r.worst_case_scenario);
  console.log('   stress_survival_score:  ' + r.stress_survival_score);
  console.log('   fragile:                ' + r.fragile);
  console.log('   stress_rejection_codes: ' + JSON.stringify(r.stress_rejection_codes));
  console.log('');
  return r;
}

console.log('='.repeat(72));
console.log('PHASE-7 STRESS TEST ENGINE — VALIDATION');
console.log('  hard-reject floor: stress_survival_score < ' + STRESS_SURVIVAL_HARD_FLOOR);
console.log('='.repeat(72));
console.log('');

// ── BUY signal: long position on a typical IT large-cap ─────────
const buySignal: StressTestInput = {
  symbol:         'TCS',
  direction:      'BUY',
  entryPrice:     1500,
  stopLoss:       1460,         // 2.67 % below entry
  positionSize:   200,           // gross = 300,000
  atrPct:         0.014,         // 1.4 %
  liquidityScore: 85,
  sector:         'IT',
  capital:        5_000_000,     // 50 lakh
  marketBeta:     1.0,
  sectorBeta:     1.0,
};

const buyResult = dump('BUY — TCS long, 200 sh @ 1500, stop 1460', buySignal);

// ── SELL signal: short position with tighter stop ──────────────
const sellSignal: StressTestInput = {
  symbol:         'INFY',
  direction:      'SELL',
  entryPrice:     1600,
  stopLoss:       1640,         // 2.5 % above entry
  positionSize:   150,           // gross = 240,000
  atrPct:         0.018,         // 1.8 %
  liquidityScore: 78,
  sector:         'IT',
  capital:        5_000_000,
  marketBeta:     1.1,
  sectorBeta:     1.0,
};

const sellResult = dump('SELL — INFY short, 150 sh @ 1600, stop 1640', sellSignal);

// ── Invariants ─────────────────────────────────────────────────
const buyInvariants = (
  buyResult.scenarios.length === 7 &&
  // Every directional market-down should produce a positive loss for a long.
  buyResult.scenarios.find((s) => s.scenario === 'market_down_10_percent')!.loss > 0 &&
  // Worst case for a long in this fixture is the 10 % crash.
  buyResult.worst_case_scenario === 'market_down_10_percent' &&
  buyResult.fragile === (buyResult.stress_survival_score < STRESS_SURVIVAL_HARD_FLOOR) &&
  // If fragile, hard-reject code must be present; if not, must be absent.
  (buyResult.fragile === buyResult.stress_rejection_codes.includes('stress_survival_below_60'))
);

const sellInvariants = (
  sellResult.scenarios.length === 7 &&
  // A short profits on a market crash → loss is negative.
  sellResult.scenarios.find((s) => s.scenario === 'market_down_10_percent')!.loss < 0 &&
  // gap-against-position is adverse for shorts too (gap up) → positive loss.
  sellResult.scenarios.find((s) => s.scenario === 'gap_down_against_position')!.loss > 0 &&
  // market_down_* on a short cannot hit a stop placed above entry.
  sellResult.scenarios.find((s) => s.scenario === 'market_down_10_percent')!.stop_hit === false &&
  // Worst case for a short cannot be one of the directional market-down
  // scenarios (those are profitable when short).
  sellResult.worst_case_scenario !== 'market_down_3_percent' &&
  sellResult.worst_case_scenario !== 'market_down_5_percent' &&
  sellResult.worst_case_scenario !== 'market_down_10_percent' &&
  sellResult.worst_case_scenario !== 'sector_down_5_percent' &&
  sellResult.fragile === (sellResult.stress_survival_score < STRESS_SURVIVAL_HARD_FLOOR) &&
  (sellResult.fragile === sellResult.stress_rejection_codes.includes('stress_survival_below_60'))
);

console.log('='.repeat(72));
console.log('## INVARIANTS');
console.log('='.repeat(72));
console.log('  BUY  — long loses on market crash, worst case = market_down_10_percent: ' + buyInvariants);
console.log('  SELL — short profits on market crash, worst case is symmetric/liquidity: ' + sellInvariants);
console.log('  fragile flag agrees with score < ' + STRESS_SURVIVAL_HARD_FLOOR + ' threshold:                 ' +
  (buyResult.fragile === (buyResult.stress_survival_score < STRESS_SURVIVAL_HARD_FLOOR) &&
   sellResult.fragile === (sellResult.stress_survival_score < STRESS_SURVIVAL_HARD_FLOOR)));
console.log('');
const ok = buyInvariants && sellInvariants;
console.log(ok
  ? 'RESULT: Phase-7 stress test engine honours the spec.'
  : 'RESULT: At least one invariant failed.');
console.log('='.repeat(72));
process.exit(ok ? 0 : 1);
