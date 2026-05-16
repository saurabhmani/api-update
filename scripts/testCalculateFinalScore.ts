/**
 * scripts/testCalculateFinalScore.ts
 *
 * Smoke test for the Phase-2 calculateFinalScore() function.
 * Exercises every classification band + the three penalties and
 * prints the full breakdown for visual inspection.
 *
 * Run:
 *   npx tsx scripts/testCalculateFinalScore.ts
 */
import { calculateFinalScore, type FinalScoreInput } from '../src/lib/signal-engine/scoring/scoringEngine';

type Case = {
  name:     string;
  input:    FinalScoreInput;
  expected: string;   // expected classification
};

const cases: Case[] = [
  {
    name: 'INSTITUTIONAL_HIGH_CONVICTION — every factor 90, no penalties',
    expected: 'INSTITUTIONAL_HIGH_CONVICTION',
    input: {
      strategyQuality: 90, trendAlignment: 90, momentum: 90,
      volumeConfirmation: 90, riskReward: 90, liquidity: 90,
      marketRegime: 90, portfolioFit: 90,
      manipulationRiskPenalty: 0, stalenessPenalty: 0, volatilityShockPenalty: 0,
    },
  },
  {
    name: 'HIGH_CONVICTION — every factor 80',
    expected: 'HIGH_CONVICTION',
    input: {
      strategyQuality: 80, trendAlignment: 80, momentum: 80,
      volumeConfirmation: 80, riskReward: 80, liquidity: 80,
      marketRegime: 80, portfolioFit: 80,
      manipulationRiskPenalty: 0, stalenessPenalty: 0, volatilityShockPenalty: 0,
    },
  },
  {
    name: 'VALID_SIGNAL — every factor 70',
    expected: 'VALID_SIGNAL',
    input: {
      strategyQuality: 70, trendAlignment: 70, momentum: 70,
      volumeConfirmation: 70, riskReward: 70, liquidity: 70,
      marketRegime: 70, portfolioFit: 70,
      manipulationRiskPenalty: 0, stalenessPenalty: 0, volatilityShockPenalty: 0,
    },
  },
  {
    name: 'DEVELOPING_SETUP — every factor 55',
    expected: 'DEVELOPING_SETUP',
    input: {
      strategyQuality: 55, trendAlignment: 55, momentum: 55,
      volumeConfirmation: 55, riskReward: 55, liquidity: 55,
      marketRegime: 55, portfolioFit: 55,
      manipulationRiskPenalty: 0, stalenessPenalty: 0, volatilityShockPenalty: 0,
    },
  },
  {
    name: 'WATCHLIST_ONLY — every factor 40',
    expected: 'WATCHLIST_ONLY',
    input: {
      strategyQuality: 40, trendAlignment: 40, momentum: 40,
      volumeConfirmation: 40, riskReward: 40, liquidity: 40,
      marketRegime: 40, portfolioFit: 40,
      manipulationRiskPenalty: 0, stalenessPenalty: 0, volatilityShockPenalty: 0,
    },
  },
  {
    name: 'NO_TRADE — every factor 25',
    expected: 'NO_TRADE',
    input: {
      strategyQuality: 25, trendAlignment: 25, momentum: 25,
      volumeConfirmation: 25, riskReward: 25, liquidity: 25,
      marketRegime: 25, portfolioFit: 25,
      manipulationRiskPenalty: 0, stalenessPenalty: 0, volatilityShockPenalty: 0,
    },
  },
  {
    name: 'Penalties bite: factors=80 (would be HIGH_CONVICTION) but heavy penalties drop it',
    expected: 'VALID_SIGNAL',
    input: {
      strategyQuality: 80, trendAlignment: 80, momentum: 80,
      volumeConfirmation: 80, riskReward: 80, liquidity: 80,
      marketRegime: 80, portfolioFit: 80,
      manipulationRiskPenalty: 5, stalenessPenalty: 5, volatilityShockPenalty: 5,
    },
  },
  {
    name: 'Penalty cap: per-dimension penalty=999 must clamp to 30 each',
    expected: 'NO_TRADE',
    input: {
      strategyQuality: 80, trendAlignment: 80, momentum: 80,
      volumeConfirmation: 80, riskReward: 80, liquidity: 80,
      marketRegime: 80, portfolioFit: 80,
      manipulationRiskPenalty: 999, stalenessPenalty: 999, volatilityShockPenalty: 999,
    },
  },
  {
    name: 'Null factors get neutral 50 substitute, mid-band',
    expected: 'DEVELOPING_SETUP',
    input: {
      strategyQuality: null, trendAlignment: null, momentum: null,
      volumeConfirmation: null, riskReward: null, liquidity: null,
      marketRegime: null, portfolioFit: null,
      manipulationRiskPenalty: null, stalenessPenalty: null, volatilityShockPenalty: null,
    },
  },
  {
    name: 'Clamp floor: extreme negative inputs cannot push below 0',
    expected: 'NO_TRADE',
    input: {
      strategyQuality: -50, trendAlignment: -50, momentum: -50,
      volumeConfirmation: -50, riskReward: -50, liquidity: -50,
      marketRegime: -50, portfolioFit: -50,
      manipulationRiskPenalty: -10, stalenessPenalty: -10, volatilityShockPenalty: -10,
    },
  },
  {
    name: 'Clamp ceiling: extreme positive inputs cannot exceed 100',
    expected: 'INSTITUTIONAL_HIGH_CONVICTION',
    input: {
      strategyQuality: 9999, trendAlignment: 9999, momentum: 9999,
      volumeConfirmation: 9999, riskReward: 9999, liquidity: 9999,
      marketRegime: 9999, portfolioFit: 9999,
      manipulationRiskPenalty: 0, stalenessPenalty: 0, volatilityShockPenalty: 0,
    },
  },
];

let pass = 0, fail = 0;

for (const c of cases) {
  const r = calculateFinalScore(c.input);
  const ok = r.classification === c.expected
          && r.finalScore >= 0 && r.finalScore <= 100;
  if (ok) pass++; else fail++;
  console.log(`${ok ? '✓' : '✗'} ${c.name}`);
  console.log(`   → finalScore=${r.finalScore.toFixed(1).padStart(5)}  classification=${r.classification}` +
              (r.classification !== c.expected ? `  (expected ${c.expected})` : ''));
}

// Detail dump for the headline case so the operator can see the
// full breakdown shape exposed by the function.
console.log('');
console.log('='.repeat(72));
console.log('FULL BREAKDOWN — INSTITUTIONAL_HIGH_CONVICTION case');
console.log('='.repeat(72));
const detail = calculateFinalScore(cases[0].input);
for (const line of detail.breakdown.lines) console.log('  ' + line);
console.log('  rationale:', detail.breakdown.rationale);
console.log('');
console.log('factor_scores:        ', detail.factor_scores);
console.log('penalty_contributions:', detail.penalty_contributions);
console.log('');

console.log('='.repeat(72));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail === 0 ? 0 : 1);
