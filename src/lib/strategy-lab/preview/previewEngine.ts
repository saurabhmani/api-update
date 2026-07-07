// ════════════════════════════════════════════════════════════════
//  Strategy Preview Engine — human-readable preview, no execution
// ════════════════════════════════════════════════════════════════

import { getIndicatorMeta } from '../indicators';
import type { ConditionGroup, LabCondition, StrategyDefinition, StrategyPreviewResult } from '../types';

function describeCondition(c: LabCondition): string {
  const meta = getIndicatorMeta(c.indicator);
  const label = c.label ?? meta?.label ?? c.indicator;
  const val = Array.isArray(c.value) ? `${c.value[0]}–${c.value[1]}` : String(c.value);
  return `${label} ${c.operator.replace(/_/g, ' ')} ${val}`;
}

function describeGroup(group: ConditionGroup): string {
  if (!group.conditions.length) return 'No conditions';
  return group.conditions.map(describeCondition).join(` ${group.operator} `);
}

export function previewStrategy(def: StrategyDefinition): StrategyPreviewResult {
  const warnings: string[] = [];

  if (def.source === 'ai') {
    warnings.push('AI-generated rules require validation and backtest before any deployment.');
  }
  if (def.entry.conditions.length > 5) {
    warnings.push('Many entry conditions may reduce signal frequency significantly.');
  }
  if (def.direction === 'short') {
    warnings.push('Short strategies require bearish regime alignment in live engine.');
  }
  if (def.market === 'options') {
    warnings.push('Options strategy authoring is supported; backtest execution currently uses equity/EOD data.');
  }
  if (def.timeframe === 'intraday') {
    warnings.push('Intraday authoring is supported; backtest execution currently uses EOD candles.');
  }

  const entryDescription = describeGroup(def.entry);
  const exitDescription = describeGroup(def.exit);
  const stopLossDescription = def.stopLoss.type === 'percent'
    ? `${def.stopLoss.value}% from entry`
    : def.stopLoss.type === 'atr_multiple'
      ? `${def.stopLoss.value}× ATR from entry`
      : 'Structure-based stop';

  const targetDescriptions = def.targets.map((t) =>
    t.type === 'rr_multiple' ? `${t.value}R target (${t.label ?? ''})`
    : t.type === 'percent' ? `${t.value}% target (${t.label ?? ''})`
    : `Structure target (${t.label ?? ''})`,
  );

  const riskDescription = `${def.risk.riskPerTradePct}% risk/trade, max ${def.risk.maxOpenPositions} positions, ${def.risk.maxGrossExposurePct}% gross exposure`;
  const universe = def.symbolUniverse?.join(', ') || 'NIFTY 500';
  const regimes = def.marketRegimeFilter?.length ? def.marketRegimeFilter.join(', ') : 'No regime filter';

  const freq = def.entry.conditions.length <= 2 ? 'Moderate (3–8/month est.)'
    : def.entry.conditions.length <= 4 ? 'Low (1–4/month est.)'
    : 'Very low (<2/month est.)';

  return {
    summary: `${def.direction.toUpperCase()} ${def.market.toUpperCase()} ${def.timeframe} strategy "${def.name}" for ${universe}. Regime gate: ${regimes}.`,
    entryDescription,
    exitDescription,
    stopLossDescription,
    targetDescriptions,
    riskDescription,
    estimatedSignalsPerMonth: freq,
    lookaheadSafe: true,
    warnings,
  };
}
