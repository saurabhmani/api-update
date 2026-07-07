// ════════════════════════════════════════════════════════════════
//  Strategy Rule Parser — structured JSON + natural language
// ════════════════════════════════════════════════════════════════

import { v4 as uuidv4 } from 'uuid';
import type { ConditionGroup, LabCondition, StrategyDefinition } from '../types';
import { isSupportedIndicator } from '../indicators';

function cid(): string {
  return uuidv4().slice(0, 8);
}

function defaultRisk() {
  return { riskPerTradePct: 0.5, maxOpenPositions: 5, maxGrossExposurePct: 40, minRewardRisk: 1.5 };
}

function normalizeUniverse(value: unknown): string[] {
  if (Array.isArray(value)) {
    const symbols = value.map((s) => String(s).trim().toUpperCase()).filter(Boolean);
    return symbols.length ? [...new Set(symbols)] : ['NIFTY 500'];
  }
  if (typeof value === 'string') {
    const symbols = value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    return symbols.length ? [...new Set(symbols)] : ['NIFTY 500'];
  }
  return ['NIFTY 500'];
}

function normalizeRegimes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((s) => String(s).trim()).filter(Boolean);
  }
  return [];
}

function normalizeTimeframe(value: unknown): StrategyDefinition['timeframe'] {
  return value === 'intraday' || value === 'positional' || value === 'daily' ? value : 'swing';
}

export function parseStructuredDefinition(raw: unknown): StrategyDefinition {
  const o = raw as Partial<StrategyDefinition>;
  if (!o.name?.trim()) throw new Error('Strategy name is required');
  return {
    id: o.id,
    name: o.name.trim(),
    description: o.description,
    market: o.market === 'options' ? 'options' : 'equity',
    symbolUniverse: normalizeUniverse(o.symbolUniverse),
    timeframe: normalizeTimeframe(o.timeframe),
    direction: o.direction === 'short' ? 'short' : 'long',
    marketRegimeFilter: normalizeRegimes(o.marketRegimeFilter),
    source: o.source ?? 'no_code',
    entry: normalizeGroup(o.entry, 'entry'),
    exit: normalizeGroup(o.exit, 'exit'),
    stopLoss: o.stopLoss ?? { type: 'percent', value: 2, description: '2% stop loss' },
    targets: Array.isArray(o.targets) && o.targets.length > 0
      ? o.targets
      : [{ type: 'rr_multiple', value: 2, label: 'T1' }],
    risk: { ...defaultRisk(), ...o.risk },
    metadata: o.metadata,
  };
}

function normalizeGroup(group: ConditionGroup | undefined, kind: string): ConditionGroup {
  if (!group?.conditions?.length) {
    throw new Error(`${kind} conditions are required`);
  }
  return {
    operator: group.operator === 'OR' ? 'OR' : 'AND',
    conditions: group.conditions.map((c) => ({
      ...c,
      id: c.id || cid(),
      indicator: isSupportedIndicator(c.indicator) ? c.indicator : 'rsi',
    })),
  };
}

/** Pattern-based NL → structured rules (deterministic; no direct deploy) */
export function parseNaturalLanguageStrategy(text: string, name = 'AI Strategy'): StrategyDefinition {
  const lower = text.toLowerCase();
  const isFibonacciPullback = /fib|fibonacci/.test(lower) && /pullback|retracement|retrace/.test(lower);
  const entryConditions: LabCondition[] = [];
  const exitConditions: LabCondition[] = [];

  if (isFibonacciPullback) {
    entryConditions.push(
      {
        id: cid(),
        indicator: 'fib_pullback_zone',
        operator: 'eq',
        value: 1,
        label: 'Price pulls back into the 38.2%-61.8% Fibonacci zone',
      },
      {
        id: cid(),
        indicator: 'price_above_ema20',
        operator: 'eq',
        value: 1,
        label: 'Price remains above EMA20 trend support',
      },
      {
        id: cid(),
        indicator: 'rsi',
        operator: 'between',
        value: [45, 65],
        label: 'RSI confirms controlled pullback',
      },
      {
        id: cid(),
        indicator: 'volume_expansion',
        operator: 'gte',
        value: 1.1,
        label: 'Volume confirms renewed demand',
      },
    );
  }

  // RSI patterns
  const rsiBetween = lower.match(/rsi\s*(?:between|from)\s*(\d+)\s*(?:and|to|-)\s*(\d+)/);
  if (rsiBetween) {
    entryConditions.push({
      id: cid(), indicator: 'rsi', operator: 'between',
      value: [Number(rsiBetween[1]), Number(rsiBetween[2])],
      label: `RSI ${rsiBetween[1]}-${rsiBetween[2]}`,
    });
  } else if (/rsi\s*(?:above|over|>)\s*(\d+)/.test(lower)) {
    const m = lower.match(/rsi\s*(?:above|over|>)\s*(\d+)/)!;
    entryConditions.push({ id: cid(), indicator: 'rsi', operator: 'gt', value: Number(m[1]) });
  } else if (/rsi\s*(?:below|under|<)\s*(\d+)/.test(lower)) {
    const m = lower.match(/rsi\s*(?:below|under|<)\s*(\d+)/)!;
    entryConditions.push({ id: cid(), indicator: 'rsi', operator: 'lt', value: Number(m[1]) });
  }

  // EMA crossover
  if (/ema\s*(?:20|cross).*cross.*(?:above|over).*ema\s*50/i.test(text) || /ema crossover/i.test(lower)) {
    entryConditions.push({ id: cid(), indicator: 'ema_20', operator: 'crosses_above', value: 0, label: 'EMA20 crosses above EMA50' });
  }
  if (/price\s*above\s*ema\s*20/i.test(lower) || /above\s*20\s*ema/i.test(lower)) {
    entryConditions.push({ id: cid(), indicator: 'price_above_ema20', operator: 'eq', value: 1 });
  }

  // ADX
  const adxMatch = lower.match(/adx\s*(?:above|>|over)\s*(\d+)/);
  if (adxMatch) {
    entryConditions.push({ id: cid(), indicator: 'adx', operator: 'gte', value: Number(adxMatch[1]) });
  }

  // Volume
  if (/volume\s*(?:expansion|spike|above)/i.test(lower)) {
    const volMatch = lower.match(/volume.*?(\d+\.?\d*)x/);
    entryConditions.push({
      id: cid(), indicator: 'volume_expansion', operator: 'gte',
      value: volMatch ? Number(volMatch[1]) : 1.5,
    });
  }

  // Regime
  if (/bullish\s*regime|bull\s*market/i.test(lower)) {
    entryConditions.push({ id: cid(), indicator: 'regime_bullish', operator: 'eq', value: 1 });
  }

  // Default entry if nothing parsed
  if (entryConditions.length === 0) {
    entryConditions.push({ id: cid(), indicator: 'rsi', operator: 'between', value: [45, 65], label: 'Default RSI range' });
  }

  // Exit patterns
  if (/rsi\s*(?:above|over)\s*(\d+)/.test(lower) && entryConditions.every((c) => c.indicator !== 'rsi' || c.operator !== 'gt')) {
    const m = lower.match(/exit.*rsi\s*(?:above|over)\s*(\d+)/) ?? lower.match(/rsi\s*(?:above|over)\s*(\d+).*exit/);
    if (m) exitConditions.push({ id: cid(), indicator: 'rsi', operator: 'gt', value: Number(m[1]) });
  }
  if (/ema.*cross.*below/i.test(lower)) {
    exitConditions.push({ id: cid(), indicator: 'ema_20', operator: 'crosses_below', value: 0, label: 'EMA20 crosses below EMA50' });
  }
  if (exitConditions.length === 0) {
    exitConditions.push({
      id: cid(),
      indicator: 'rsi',
      operator: 'gt',
      value: isFibonacciPullback ? 70 : 75,
      label: isFibonacciPullback ? 'Exit when pullback becomes extended' : 'RSI overbought exit',
    });
  }

  // Stop loss
  let stopValue = 2;
  const stopMatch = lower.match(/stop\s*loss\s*(?:at|of)?\s*(\d+\.?\d*)\s*%/);
  if (stopMatch) stopValue = Number(stopMatch[1]);
  const atrStop = lower.match(/stop.*?(\d+\.?\d*)\s*atr/);
  const stopLoss = atrStop
    ? { type: 'atr_multiple' as const, value: Number(atrStop[1]), description: `${atrStop[1]} ATR stop` }
    : { type: 'percent' as const, value: stopValue, description: `${stopValue}% stop loss` };

  // Targets
  const targets = [];
  const rrMatch = lower.match(/(?:target|r:r|risk.?reward)\s*(?:of|at)?\s*(\d+\.?\d*)/);
  if (rrMatch) {
    targets.push({ type: 'rr_multiple' as const, value: Number(rrMatch[1]), label: 'T1' });
  }
  const pctTarget = lower.match(/target\s*(?:of|at)?\s*(\d+\.?\d*)\s*%/);
  if (pctTarget) {
    targets.push({ type: 'percent' as const, value: Number(pctTarget[1]), label: 'T1' });
  }
  if (targets.length === 0) {
    targets.push({ type: 'rr_multiple' as const, value: 2, label: 'T1' });
  }

  // Risk
  const riskPct = lower.match(/risk\s*(?:per\s*trade)?\s*(\d+\.?\d*)\s*%/);
  const risk = {
    ...defaultRisk(),
    riskPerTradePct: riskPct ? Number(riskPct[1]) : 0.5,
  };

  const market = /option|options|nifty option|banknifty option/i.test(lower) ? 'options' : 'equity';
  const timeframe: StrategyDefinition['timeframe'] =
    /intraday|1m|3m|5m|15m|30m/i.test(lower) ? 'intraday'
    : /positional|position/i.test(lower) ? 'positional'
    : /daily|eod|end of day/i.test(lower) ? 'daily'
    : 'swing';
  const universeMatch = text.match(/(?:universe|symbols?)\s*(?:is|are|:)?\s*([A-Z0-9,&\s-]{2,80})/i);
  const symbolUniverse = universeMatch
    ? normalizeUniverse(universeMatch[1].replace(/\band\b/gi, ','))
    : ['NIFTY 500'];
  const marketRegimeFilter = [
    /bullish|uptrend|bull market/i.test(lower) ? 'Bullish' : null,
    /sideways|range bound|range-bound/i.test(lower) ? 'Sideways' : null,
    /bearish|downtrend|bear market/i.test(lower) ? 'Bearish' : null,
    /high volatility/i.test(lower) ? 'High Volatility Risk' : null,
  ].filter((v): v is string => Boolean(v));
  if (isFibonacciPullback && !marketRegimeFilter.includes('Bullish')) {
    marketRegimeFilter.push('Bullish');
  }

  return {
    name: isFibonacciPullback && name === 'AI Strategy' ? 'Bullish Fibonacci Pullback' : name,
    description: isFibonacciPullback
      ? 'Bullish pullback strategy that looks for price reacting from a Fibonacci retracement zone inside an intact uptrend.'
      : text.slice(0, 500),
    market,
    symbolUniverse,
    timeframe,
    direction: /short|sell|bearish/i.test(lower) && !/long|buy|bullish/i.test(lower) ? 'short' : 'long',
    marketRegimeFilter,
    source: 'ai',
    entry: { operator: 'AND', conditions: entryConditions },
    exit: { operator: 'OR', conditions: exitConditions },
    stopLoss,
    targets,
    risk,
    metadata: {
      aiPrompt: text,
      parentStrategyId: isFibonacciPullback ? 'fibonacci_pullback' : undefined,
    },
  };
}
