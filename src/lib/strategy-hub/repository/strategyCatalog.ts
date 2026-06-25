import { db } from '@/lib/db';
import type { StrategyRegistryEntry } from '@/lib/signal-engine/types/signalEngine.types';
import { ACTIVE_RUNNER_STRATEGIES } from '../registry';

export interface StrategyDbRow {
  id: string;
  display_name: string;
  category: string;
  direction: string;
  risk_profile: string;
  timeframe: string;
  is_featured: boolean;
  is_active: boolean;
  paper_trading_ready: boolean;
  deployment_status: string;
  explanation: string | null;
}

import type { StrategyConditionRow } from '../types';

export async function loadStrategyFromDb(strategyId: string): Promise<StrategyDbRow | null> {
  try {
    const { rows } = await db.query(
      `SELECT id, display_name, category, direction, risk_profile, timeframe,
              is_featured, is_active, paper_trading_ready, deployment_status, explanation
         FROM strategies WHERE id = ? LIMIT 1`,
      [strategyId],
    );
    return rows.length ? (rows[0] as StrategyDbRow) : null;
  } catch {
    return null;
  }
}

export async function loadStrategyConditions(strategyId: string): Promise<StrategyConditionRow[]> {
  try {
    const { rows } = await db.query(
      `SELECT id, strategy_id, condition_key, condition_label, condition_type,
              operator, value_numeric, value_text, is_required, sort_order
         FROM strategy_conditions
        WHERE strategy_id = ?
        ORDER BY sort_order ASC`,
      [strategyId],
    );
    return rows as StrategyConditionRow[];
  } catch {
    return [];
  }
}

function buildConditionsFromEntry(entry: StrategyRegistryEntry): Array<Omit<StrategyConditionRow, 'id'>> {
  const conditions: Array<Omit<StrategyConditionRow, 'id'>> = [];
  let order = 1;

  if (entry.allowedRegimes.length > 0) {
    conditions.push({
      strategy_id: entry.strategyId,
      condition_key: 'regime_allowed',
      condition_label: 'Allowed market regimes',
      condition_type: 'regime',
      operator: 'in',
      value_numeric: null,
      value_text: entry.allowedRegimes.join(','),
      is_required: true,
      sort_order: order++,
    });
  }
  if (entry.minVolumeExpansion != null) {
    conditions.push({
      strategy_id: entry.strategyId,
      condition_key: 'min_volume_expansion',
      condition_label: 'Minimum volume expansion',
      condition_type: 'volume',
      operator: '>=',
      value_numeric: entry.minVolumeExpansion,
      value_text: null,
      is_required: true,
      sort_order: order++,
    });
  }
  if (entry.idealRsiRange) {
    conditions.push({
      strategy_id: entry.strategyId,
      condition_key: 'ideal_rsi_range',
      condition_label: 'Ideal RSI range',
      condition_type: 'indicator',
      operator: 'between',
      value_numeric: entry.idealRsiRange[0],
      value_text: `${entry.idealRsiRange[0]}-${entry.idealRsiRange[1]}`,
      is_required: true,
      sort_order: order++,
    });
  }
  if (entry.minAdx != null) {
    conditions.push({
      strategy_id: entry.strategyId,
      condition_key: 'min_adx',
      condition_label: 'Minimum ADX',
      condition_type: 'indicator',
      operator: '>=',
      value_numeric: entry.minAdx,
      value_text: null,
      is_required: true,
      sort_order: order++,
    });
  }
  return conditions;
}

export async function syncRegistryEntryToDb(
  entry: StrategyRegistryEntry,
  isFeatured: boolean,
): Promise<void> {
  const direction = entry.direction === 'short' ? 'SELL' : 'BUY';
  const isActive = ACTIVE_RUNNER_STRATEGIES.has(entry.strategyId);

  try {
    await db.query(
      `INSERT INTO strategies
         (id, display_name, category, direction, risk_profile, timeframe,
          is_featured, is_active, paper_trading_ready, deployment_status, explanation, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON CONFLICT (id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         category = EXCLUDED.category,
         direction = EXCLUDED.direction,
         risk_profile = EXCLUDED.risk_profile,
         timeframe = EXCLUDED.timeframe,
         is_featured = EXCLUDED.is_featured,
         is_active = EXCLUDED.is_active,
         explanation = EXCLUDED.explanation,
         updated_at = NOW()`,
      [
        entry.strategyId,
        entry.displayName,
        entry.category,
        direction,
        entry.riskProfile,
        entry.timeframe,
        isFeatured,
        isActive,
        isFeatured && isActive,
        isFeatured && isActive ? 'paper_ready' : 'registered',
        entry.explanationTemplate,
      ],
    );

    await db.query(
      `INSERT INTO strategy_registry
         (strategy_id, entry_type, signal_type, confidence_weight,
          allowed_regimes, blocked_regimes, ideal_market_regime,
          ideal_rsi_min, ideal_rsi_max, min_adx, min_volume_expansion,
          invalidation_logic, explanation_template, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON CONFLICT (strategy_id) DO UPDATE SET
         entry_type = EXCLUDED.entry_type,
         signal_type = EXCLUDED.signal_type,
         confidence_weight = EXCLUDED.confidence_weight,
         allowed_regimes = EXCLUDED.allowed_regimes,
         blocked_regimes = EXCLUDED.blocked_regimes,
         ideal_market_regime = EXCLUDED.ideal_market_regime,
         ideal_rsi_min = EXCLUDED.ideal_rsi_min,
         ideal_rsi_max = EXCLUDED.ideal_rsi_max,
         min_adx = EXCLUDED.min_adx,
         min_volume_expansion = EXCLUDED.min_volume_expansion,
         invalidation_logic = EXCLUDED.invalidation_logic,
         explanation_template = EXCLUDED.explanation_template,
         synced_at = NOW()`,
      [
        entry.strategyId,
        entry.entryType,
        entry.signalType,
        entry.defaultConfidenceWeight,
        JSON.stringify(entry.allowedRegimes),
        JSON.stringify(entry.blockedRegimes),
        JSON.stringify(entry.idealMarketRegime),
        entry.idealRsiRange[0],
        entry.idealRsiRange[1],
        entry.minAdx ?? null,
        entry.minVolumeExpansion ?? null,
        entry.invalidationLogic,
        entry.explanationTemplate,
      ],
    );

    const conditions = buildConditionsFromEntry(entry);
    for (const c of conditions) {
      await db.query(
        `INSERT INTO strategy_conditions
           (strategy_id, condition_key, condition_label, condition_type,
            operator, value_numeric, value_text, is_required, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (strategy_id, condition_key) DO UPDATE SET
           condition_label = EXCLUDED.condition_label,
           condition_type = EXCLUDED.condition_type,
           operator = EXCLUDED.operator,
           value_numeric = EXCLUDED.value_numeric,
           value_text = EXCLUDED.value_text,
           sort_order = EXCLUDED.sort_order`,
        [
          c.strategy_id, c.condition_key, c.condition_label, c.condition_type,
          c.operator, c.value_numeric, c.value_text, c.is_required, c.sort_order,
        ],
      );
    }
  } catch {
    // Tables may not exist before migration
  }
}
