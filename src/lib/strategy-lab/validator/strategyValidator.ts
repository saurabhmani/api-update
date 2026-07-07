// ════════════════════════════════════════════════════════════════
//  Strategy Validator — gates save, backtest, and deployment
// ════════════════════════════════════════════════════════════════

import { getIndicatorMeta, INDICATOR_IDS, SUPPORTED_TIMEFRAMES } from '../indicators';
import type { LabCondition, StrategyDefinition, ValidationIssue, ValidationResult } from '../types';

const FORBIDDEN_LOOKAHEAD = ['future', 'next_bar', 'tomorrow', 'forward_fill_future'];

const INDICATOR_RANGES: Partial<Record<string, [number, number]>> = {
  rsi: [0, 100],
  adx: [0, 100],
  atr_pct: [0, 50],
  volume_expansion: [0, 10],
};

function validateCondition(c: LabCondition, field: string, issues: ValidationIssue[]): void {
  if (!INDICATOR_IDS.has(c.indicator)) {
    issues.push({ code: 'INDICATOR_UNSUPPORTED', severity: 'error', message: `Unsupported indicator: ${c.indicator}`, field });
    return;
  }
  const meta = getIndicatorMeta(c.indicator);
  if (meta && !meta.lookaheadSafe) {
    issues.push({ code: 'LOOKAHEAD_RISK', severity: 'error', message: `${c.indicator} may introduce look-ahead bias`, field });
  }

  const range = INDICATOR_RANGES[c.indicator];
  if (c.operator === 'between' && Array.isArray(c.value)) {
    const [lo, hi] = c.value;
    if (lo > hi) {
      issues.push({ code: 'IMPOSSIBLE_CONDITION', severity: 'error', message: `${c.indicator} between ${lo} and ${hi} is impossible (min > max)`, field });
    }
    if (range && (lo < range[0] || hi > range[1])) {
      issues.push({ code: 'IMPOSSIBLE_CONDITION', severity: 'error', message: `${c.indicator} range ${lo}-${hi} outside valid bounds ${range[0]}-${range[1]}`, field });
    }
    if (lo === hi) {
      issues.push({ code: 'IMPOSSIBLE_CONDITION', severity: 'warning', message: `${c.indicator} between ${lo} and ${hi} is a single point — use equals instead`, field });
    }
  } else if (typeof c.value === 'number' && range) {
    if (c.value < range[0] || c.value > range[1]) {
      issues.push({ code: 'IMPOSSIBLE_CONDITION', severity: 'error', message: `${c.indicator} value ${c.value} outside valid range ${range[0]}-${range[1]}`, field });
    }
  }

  if ((c.operator === 'crosses_above' || c.operator === 'crosses_below') && typeof c.value === 'number' && c.value !== 0) {
    issues.push({ code: 'IMPOSSIBLE_CONDITION', severity: 'error', message: `${c.operator} on ${c.indicator} does not take a numeric threshold`, field });
  }
}

function detectContradictoryAndGroup(conditions: LabCondition[], field: string, issues: ValidationIssue[]): void {
  const rsiGt = conditions.filter((c) => c.indicator === 'rsi' && c.operator === 'gt' && typeof c.value === 'number');
  const rsiLt = conditions.filter((c) => c.indicator === 'rsi' && c.operator === 'lt' && typeof c.value === 'number');
  for (const gt of rsiGt) {
    for (const lt of rsiLt) {
      if ((gt.value as number) >= (lt.value as number)) {
        issues.push({
          code: 'IMPOSSIBLE_CONDITION',
          severity: 'error',
          message: `RSI cannot be > ${gt.value} AND < ${lt.value} simultaneously`,
          field,
        });
      }
    }
  }
}

export function validateStrategyDefinition(
  def: StrategyDefinition,
  options: { forDeploy?: boolean; backtestPassed?: boolean } = {},
): ValidationResult {
  const issues: ValidationIssue[] = [];

  if (!def.name?.trim()) {
    issues.push({ code: 'NAME_REQUIRED', severity: 'error', message: 'Strategy name is required', field: 'name' });
  }

  if (def.market !== 'equity' && def.market !== 'options') {
    issues.push({ code: 'MARKET_UNSUPPORTED', severity: 'error', message: 'Market must be Equity or Options', field: 'market' });
  }

  if (def.market === 'options') {
    issues.push({
      code: 'OPTIONS_BACKTEST_LIMITED',
      severity: 'warning',
      message: 'Options strategies can be designed here, but current backtest execution uses equity/EOD data.',
      field: 'market',
    });
  }

  if (!def.symbolUniverse?.length) {
    issues.push({ code: 'UNIVERSE_REQUIRED', severity: 'error', message: 'Select at least one symbol or universe', field: 'symbolUniverse' });
  }

  if (!SUPPORTED_TIMEFRAMES.includes(def.timeframe)) {
    issues.push({ code: 'TIMEFRAME_UNSUPPORTED', severity: 'error', message: `Timeframe must be one of ${SUPPORTED_TIMEFRAMES.join(', ')}`, field: 'timeframe' });
  }

  if (def.timeframe === 'intraday') {
    issues.push({
      code: 'INTRADAY_BACKTEST_LIMITED',
      severity: 'warning',
      message: 'Intraday strategies can be authored, but current lab backtests use EOD candles.',
      field: 'timeframe',
    });
  }

  if (def.marketRegimeFilter?.length && def.entry.conditions.some((c) => c.indicator === 'regime_bullish')) {
    issues.push({
      code: 'REGIME_DUPLICATED',
      severity: 'warning',
      message: 'Market regime is set both as a filter and as an entry condition.',
      field: 'marketRegimeFilter',
    });
  }

  // Entry required
  if (!def.entry?.conditions?.length) {
    issues.push({ code: 'ENTRY_MISSING', severity: 'error', message: 'At least one entry condition is required', field: 'entry' });
  } else {
    for (const c of def.entry.conditions) {
      validateCondition(c, 'entry', issues);
    }
    if (def.entry.operator === 'AND') {
      detectContradictoryAndGroup(def.entry.conditions, 'entry', issues);
    }
  }

  // Exit required
  if (!def.exit?.conditions?.length) {
    issues.push({ code: 'EXIT_MISSING', severity: 'error', message: 'At least one exit condition is required', field: 'exit' });
  } else {
    for (const c of def.exit.conditions) {
      validateCondition(c, 'exit', issues);
    }
    if (def.exit.operator === 'AND') {
      detectContradictoryAndGroup(def.exit.conditions, 'exit', issues);
    }
  }

  // Stop loss required
  if (!def.stopLoss || def.stopLoss.value <= 0) {
    issues.push({ code: 'STOP_MISSING', severity: 'error', message: 'Stop loss rule is required', field: 'stopLoss' });
  } else if (def.stopLoss.type === 'percent' && def.stopLoss.value > 15) {
    issues.push({ code: 'STOP_TOO_WIDE', severity: 'warning', message: 'Stop loss exceeds 15% — review risk', field: 'stopLoss' });
  }

  const rrTarget = def.targets?.find((t) => t.type === 'rr_multiple');
  if (def.stopLoss.type === 'percent' && rrTarget && def.risk.minRewardRisk && rrTarget.value < def.risk.minRewardRisk) {
    issues.push({
      code: 'IMPOSSIBLE_CONDITION',
      severity: 'error',
      message: `Target ${rrTarget.value}R is below minimum reward:risk ${def.risk.minRewardRisk}`,
      field: 'targets',
    });
  }

  // Targets
  if (!def.targets?.length) {
    issues.push({ code: 'TARGET_MISSING', severity: 'warning', message: 'No profit target defined', field: 'targets' });
  }

  // Risk
  if (!def.risk?.riskPerTradePct || def.risk.riskPerTradePct <= 0 || def.risk.riskPerTradePct > 5) {
    issues.push({ code: 'RISK_INVALID', severity: 'error', message: 'Risk per trade must be 0.1–5%', field: 'risk' });
  }

  // Look-ahead scan on AI prompt
  const prompt = def.metadata?.aiPrompt?.toLowerCase() ?? '';
  for (const term of FORBIDDEN_LOOKAHEAD) {
    if (prompt.includes(term)) {
      issues.push({ code: 'LOOKAHEAD_FORBIDDEN', severity: 'error', message: `Forbidden look-ahead term: ${term}`, field: 'metadata' });
    }
  }

  // AI cannot deploy directly
  if (options.forDeploy && def.source === 'ai') {
    issues.push({ code: 'AI_REVIEW_REQUIRED', severity: 'warning', message: 'AI-generated strategies require human review before deployment', field: 'source' });
  }

  if (options.forDeploy && !options.backtestPassed) {
    issues.push({ code: 'BACKTEST_REQUIRED', severity: 'error', message: 'Backtest must pass before paper trading deployment', field: 'backtest' });
  }

  const errors = issues.filter((i) => i.severity === 'error');
  const valid = errors.length === 0;

  return {
    valid,
    issues,
    canSave: valid,
    canBacktest: valid,
    canDeploy: valid && options.backtestPassed === true,
  };
}
