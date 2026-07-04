import './loadEnv';
// Strategy Lab — parser, validator, preview, DSL, deployment gates

import { v4 as uuidv4 } from 'uuid';
import { parseNaturalLanguageStrategy, parseStructuredDefinition } from '../lib/strategy-lab/parser/ruleParser';
import { validateStrategyDefinition } from '../lib/strategy-lab/validator/strategyValidator';
import { previewStrategy } from '../lib/strategy-lab/preview/previewEngine';
import { serializeToDsl, definitionToJson } from '../lib/strategy-lab/dsl';
import type { StrategyDefinition } from '../lib/strategy-lab/types';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail = '') {
  checks.push({ name, passed, detail });
}

function baseDef(overrides: Partial<StrategyDefinition> = {}): StrategyDefinition {
  return {
    name: 'Test Strategy',
    market: 'equity',
    symbolUniverse: ['NIFTY 500'],
    timeframe: 'swing',
    direction: 'long',
    marketRegimeFilter: ['Bullish'],
    source: 'no_code',
    entry: {
      operator: 'AND',
      conditions: [{ id: uuidv4().slice(0, 8), indicator: 'rsi', operator: 'between', value: [45, 65] }],
    },
    exit: {
      operator: 'OR',
      conditions: [{ id: uuidv4().slice(0, 8), indicator: 'rsi', operator: 'gt', value: 75 }],
    },
    stopLoss: { type: 'percent', value: 2 },
    targets: [{ type: 'rr_multiple', value: 2, label: 'T1' }],
    risk: { riskPerTradePct: 0.5, maxOpenPositions: 5, maxGrossExposurePct: 40 },
    ...overrides,
  };
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Strategy Lab — Unit Tests');
  console.log('══════════════════════════════════════════════════\n');

  // Parser — NL
  const ai = parseNaturalLanguageStrategy(
    'Long swing when RSI between 45 and 65, ADX above 20, stop loss 2%, target 2R, risk 0.5%',
    'RSI Momentum',
  );
  check('AI parser sets source=ai', ai.source === 'ai', `source=${ai.source}`);
  check('AI parser finds RSI entry', ai.entry.conditions.some((c) => c.indicator === 'rsi'), '');
  check('AI parser finds ADX entry', ai.entry.conditions.some((c) => c.indicator === 'adx'), '');
  check('AI parser sets stop loss', ai.stopLoss.value === 2, `stop=${ai.stopLoss.value}`);
  check('AI parser sets target R', ai.targets[0]?.value === 2, '');

  const fibAi = parseNaturalLanguageStrategy('Create a bullish Fibonacci pullback strategy.', 'AI Strategy');
  check('AI parser recognizes Fibonacci pullback', fibAi.entry.conditions.some((c) => c.indicator === 'fib_pullback_zone'), '');
  check('AI parser maps Fibonacci parent strategy', fibAi.metadata?.parentStrategyId === 'fibonacci_pullback', '');
  check('AI parser adds bullish regime gate', fibAi.marketRegimeFilter.includes('Bullish'), '');

  // Parser — structured
  const structured = parseStructuredDefinition(baseDef({ name: 'Structured' }));
  check('Structured parser preserves name', structured.name === 'Structured', '');

  // Validator — valid strategy
  const valid = validateStrategyDefinition(baseDef());
  check('Valid strategy passes', valid.valid, `issues=${valid.issues.length}`);
  check('Valid strategy can save', valid.canSave, '');
  check('Valid strategy can backtest', valid.canBacktest, '');
  check('Valid strategy cannot deploy without backtest', !valid.canDeploy, '');

  // Validator — missing entry
  const noEntry = validateStrategyDefinition(baseDef({ entry: { operator: 'AND', conditions: [] } }));
  check('Missing entry fails', !noEntry.valid && noEntry.issues.some((i) => i.code === 'ENTRY_MISSING'), '');

  // Validator — missing exit
  const noExit = validateStrategyDefinition(baseDef({ exit: { operator: 'OR', conditions: [] } }));
  check('Missing exit fails', !noExit.valid && noExit.issues.some((i) => i.code === 'EXIT_MISSING'), '');

  // Validator — missing stop
  const noStop = validateStrategyDefinition(baseDef({ stopLoss: { type: 'percent', value: 0 } }));
  check('Missing stop fails', !noStop.valid && noStop.issues.some((i) => i.code === 'STOP_MISSING'), '');

  // Validator — deploy gate
  const deployNoBt = validateStrategyDefinition(baseDef(), { forDeploy: true, backtestPassed: false });
  check('Deploy blocked without backtest', !deployNoBt.canDeploy && deployNoBt.issues.some((i) => i.code === 'BACKTEST_REQUIRED'), '');

  const deployWithBt = validateStrategyDefinition(baseDef(), { forDeploy: true, backtestPassed: true });
  check('Deploy allowed after backtest', deployWithBt.canDeploy, '');

  // AI cannot deploy without review warning
  const aiDeploy = validateStrategyDefinition(ai, { forDeploy: true, backtestPassed: true });
  check('AI deploy has review warning', aiDeploy.issues.some((i) => i.code === 'AI_REVIEW_REQUIRED'), '');

  // Preview
  const prev = previewStrategy(baseDef());
  check('Preview has summary', prev.summary.includes('Test Strategy'), '');
  check('Preview has entry description', prev.entryDescription.includes('RSI'), '');
  check('Preview lookahead safe', prev.lookaheadSafe, '');

  // Impossible conditions
  const impossible = validateStrategyDefinition(baseDef({
    entry: {
      operator: 'AND',
      conditions: [{ id: 'x', indicator: 'rsi', operator: 'between', value: [80, 20] }],
    },
  }));
  check('Rejects impossible between range', !impossible.valid && impossible.issues.some((i) => i.code === 'IMPOSSIBLE_CONDITION'), '');

  const unsupported = validateStrategyDefinition(baseDef({
    entry: {
      operator: 'AND',
      conditions: [{ id: 'x', indicator: 'macd' as 'rsi', operator: 'gt', value: 0 }],
    },
  }));
  check('Rejects unsupported indicator', !unsupported.valid && unsupported.issues.some((i) => i.code === 'INDICATOR_UNSUPPORTED'), '');

  const contradictory = validateStrategyDefinition(baseDef({
    entry: {
      operator: 'AND',
      conditions: [
        { id: 'a', indicator: 'rsi', operator: 'gt', value: 70 },
        { id: 'b', indicator: 'rsi', operator: 'lt', value: 30 },
      ],
    },
  }));
  check('Rejects contradictory AND conditions', !contradictory.valid, '');
  const dsl = serializeToDsl(baseDef());
  check('DSL contains STRATEGY', dsl.includes('STRATEGY'), '');
  check('DSL contains ENTRY', dsl.includes('ENTRY'), '');
  const json = definitionToJson(baseDef());
  check('JSON parses back', JSON.parse(json).name === 'Test Strategy', '');

  // Summary
  const passed = checks.filter((c) => c.passed).length;
  const failed = checks.filter((c) => !c.passed);
  console.log(`\nResults: ${passed}/${checks.length} passed\n`);
  for (const c of checks) {
    console.log(`  ${c.passed ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  if (failed.length) {
    console.error('\nFailed checks:', failed.map((f) => f.name).join(', '));
    process.exit(1);
  }
  console.log('\nAll Strategy Lab tests passed.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
