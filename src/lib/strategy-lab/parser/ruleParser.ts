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

export function parseStructuredDefinition(raw: unknown): StrategyDefinition {
  const o = raw as Partial<StrategyDefinition>;
  if (!o.name?.trim()) throw new Error('Strategy name is required');
  return {
    name: o.name.trim(),
    description: o.description,
    timeframe: o.timeframe === 'daily' ? 'daily' : 'swing',
    direction: o.direction === 'short' ? 'short' : 'long',
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
  const entryConditions: LabCondition[] = [];
  const exitConditions: LabCondition[] = [];

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
    exitConditions.push({ id: cid(), indicator: 'rsi', operator: 'gt', value: 75, label: 'RSI overbought exit' });
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

  return {
    name,
    description: text.slice(0, 500),
    timeframe: /intraday|1m|5m|15m/i.test(text) ? 'daily' : 'swing', // intraday not supported — downgrade
    direction: /short|sell|bearish/i.test(lower) && !/long|buy|bullish/i.test(lower) ? 'short' : 'long',
    source: 'ai',
    entry: { operator: 'AND', conditions: entryConditions },
    exit: { operator: 'OR', conditions: exitConditions },
    stopLoss,
    targets,
    risk,
    metadata: { aiPrompt: text },
  };
}
