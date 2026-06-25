// Strategy DSL serializer — human-readable rule representation

import type { ConditionGroup, LabCondition, StrategyDefinition } from './types';
import { getIndicatorMeta } from './indicators';

function formatCondition(c: LabCondition): string {
  const meta = getIndicatorMeta(c.indicator);
  const label = meta?.label ?? c.indicator;
  const val = Array.isArray(c.value) ? `${c.value[0]}-${c.value[1]}` : String(c.value);
  return `${label} ${c.operator} ${val}`;
}

function formatGroup(name: string, group: ConditionGroup): string {
  const lines = group.conditions.map((c) => `  - ${formatCondition(c)}`);
  return `${name} (${group.operator}):\n${lines.join('\n')}`;
}

export function serializeToDsl(def: StrategyDefinition): string {
  const lines = [
    `STRATEGY "${def.name}"`,
    `TIMEFRAME ${def.timeframe}`,
    `DIRECTION ${def.direction}`,
    `SOURCE ${def.source}`,
    '',
    formatGroup('ENTRY', def.entry),
    '',
    formatGroup('EXIT', def.exit),
    '',
    `STOP_LOSS ${def.stopLoss.type} ${def.stopLoss.value}`,
    ...def.targets.map((t, i) => `TARGET_${i + 1} ${t.type} ${t.value}`),
    '',
    `RISK risk_per_trade=${def.risk.riskPerTradePct}% max_positions=${def.risk.maxOpenPositions} max_exposure=${def.risk.maxGrossExposurePct}%`,
  ];
  if (def.description) lines.splice(1, 0, `# ${def.description}`);
  return lines.join('\n');
}

export function definitionToJson(def: StrategyDefinition): string {
  return JSON.stringify(def, null, 2);
}
