/**
 * scripts/testStrategyFactorWeights.ts
 *
 * Phase-3 validation: dump the weight preset for each named strategy,
 * confirm totals ≈ 100, exercise the unknown-strategy fallback, and
 * exercise the friendly-label normalizer.
 *
 * Run:
 *   npx tsx scripts/testStrategyFactorWeights.ts
 */
import {
  getStrategyFactorWeights,
  sumStrategyFactorWeights,
  STRATEGY_FACTOR_WEIGHT_PRESETS,
  DEFAULT_STRATEGY_FACTOR_WEIGHTS,
  type StrategyFactorWeights,
} from '../src/lib/signal-engine/scoring/strategyWeightModel';

const TOLERANCE = 0.5;

function dump(label: string, w: StrategyFactorWeights, total: number) {
  console.log(`── ${label} (total = ${total})`);
  for (const [k, v] of Object.entries(w)) {
    console.log(`     ${k.padEnd(22)} ${String(v).padStart(3)}`);
  }
  const ok = Math.abs(total - 100) <= TOLERANCE;
  console.log(`     ${ok ? '✓' : '✗'} total ≈ 100${ok ? '' : '  ← OUT OF TOLERANCE'}`);
  console.log('');
  return ok;
}

let allOk = true;

console.log('='.repeat(72));
console.log('PHASE-3 STRATEGY FACTOR WEIGHTS — VALIDATION');
console.log('='.repeat(72));
console.log('');

// 1. Each named preset
const named = [
  'bullish_breakout',
  'bullish_pullback',
  'momentum_continuation',
  'mean_reversion_bounce',
  'bearish_breakdown',
];
for (const n of named) {
  const r = getStrategyFactorWeights(n);
  if (r.source !== 'preset') {
    console.log(`✗ '${n}' did not resolve to a preset (got ${r.source})`);
    allOk = false;
    continue;
  }
  if (!dump(`${n}  [source=${r.source}]`, r.weights, r.total)) allOk = false;
}

// 2. Friendly-label normalisation ("Bullish Breakout" → bullish_breakout)
console.log('-- friendly-label normalization --');
for (const friendly of ['Bullish Breakout', 'BULLISH-BREAKOUT', '  bullish_breakout ']) {
  const r = getStrategyFactorWeights(friendly);
  const ok = r.strategy === 'bullish_breakout' && r.source === 'preset';
  console.log(`  ${ok ? '✓' : '✗'} "${friendly}" → strategy=${r.strategy}, source=${r.source}`);
  if (!ok) allOk = false;
}
console.log('');

// 3. Unknown strategy → default fallback
console.log('-- unknown strategy fallback --');
const unknown = getStrategyFactorWeights('opening_range_drive_xyz');
const okUnknown = unknown.source === 'default'
  && Math.abs(unknown.total - 100) <= TOLERANCE
  && unknown.weights === DEFAULT_STRATEGY_FACTOR_WEIGHTS;
console.log(`  ${okUnknown ? '✓' : '✗'} 'opening_range_drive_xyz' → source=${unknown.source}, total=${unknown.total}`);
if (!okUnknown) allOk = false;
console.log('');
dump('default (unknown-strategy fallback)', unknown.weights, unknown.total);

// 4. Cross-check sum helper directly against the preset map
console.log('-- direct sum cross-check on STRATEGY_FACTOR_WEIGHT_PRESETS --');
for (const [name, w] of Object.entries(STRATEGY_FACTOR_WEIGHT_PRESETS)) {
  const total = sumStrategyFactorWeights(w);
  const ok = Math.abs(total - 100) <= TOLERANCE;
  console.log(`  ${ok ? '✓' : '✗'} ${name.padEnd(22)} total=${total}`);
  if (!ok) allOk = false;
}
console.log('');

console.log('='.repeat(72));
console.log(allOk
  ? 'RESULT: ✅ all presets total ≈ 100; lookup + fallback behave to spec.'
  : 'RESULT: ❌ at least one check failed.');
console.log('='.repeat(72));
process.exit(allOk ? 0 : 1);
