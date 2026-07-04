'use client';

import { v4 as uuidv4 } from 'uuid';
import { Plus, Trash2, GripVertical } from 'lucide-react';
import { SUPPORTED_INDICATORS } from '@/lib/strategy-lab/indicators';
import type {
  ConditionGroup,
  LabCondition,
  LabDirection,
  LabMarket,
  LabTimeframe,
  RiskSettings,
  StopLossRule,
  StrategyDefinition,
  TargetRule,
} from '@/lib/strategy-lab/types';
import styles from '@/app/strategies/lab/lab.module.scss';

const OPERATORS = [
  { value: 'gt', label: '>' },
  { value: 'lt', label: '<' },
  { value: 'gte', label: '>=' },
  { value: 'lte', label: '<=' },
  { value: 'eq', label: '=' },
  { value: 'between', label: 'between' },
  { value: 'crosses_above', label: 'crosses above' },
  { value: 'crosses_below', label: 'crosses below' },
] as const;

const MARKET_REGIMES = ['Bullish', 'Sideways', 'Bearish', 'High Volatility Risk'];
const DEFAULT_UNIVERSES = ['NIFTY 500', 'NIFTY 50', 'BANKNIFTY', 'RELIANCE,TCS,HDFCBANK,INFY,ICICIBANK'];

function defaultValueFor(indicator: LabCondition['indicator'], operator: LabCondition['operator']): number | [number, number] {
  if (operator === 'between') return indicator === 'rsi' ? [45, 65] : [0, 1];
  if (operator === 'crosses_above' || operator === 'crosses_below') return 0;
  if (indicator === 'volume_expansion') return 1.5;
  if (indicator === 'adx') return 20;
  if (indicator === 'atr_pct') return 5;
  if (indicator === 'regime_bullish' || indicator === 'price_above_ema20' || indicator === 'fib_pullback_zone') return 1;
  return 50;
}

function newCondition(): LabCondition {
  return {
    id: uuidv4().slice(0, 8),
    indicator: 'rsi',
    operator: 'between',
    value: [45, 65],
  };
}

interface Props {
  definition: StrategyDefinition;
  onChange: (def: StrategyDefinition) => void;
}

function ConditionEditor({
  group,
  label,
  onUpdate,
}: {
  group: ConditionGroup;
  label: string;
  onUpdate: (g: ConditionGroup) => void;
}) {
  const updateCondition = (idx: number, patch: Partial<LabCondition>) => {
    const conditions = group.conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    onUpdate({ ...group, conditions });
  };

  const removeCondition = (idx: number) => {
    onUpdate({ ...group, conditions: group.conditions.filter((_, i) => i !== idx) });
  };

  const addCondition = () => {
    onUpdate({ ...group, conditions: [...group.conditions, newCondition()] });
  };

  return (
    <div>
      <div className={styles.groupHeader}>
        <span>{label}</span>
        <select
          value={group.operator}
          onChange={(e) => onUpdate({ ...group, operator: e.target.value as 'AND' | 'OR' })}
          style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #E2E8F0' }}
        >
          <option value="AND">AND</option>
          <option value="OR">OR</option>
        </select>
      </div>
      {group.conditions.map((c, idx) => (
        <div key={c.id} className={styles.conditionRow}>
          <GripVertical size={14} color="#CBD5E1" />
          <select
            value={c.indicator}
            onChange={(e) => {
              const indicator = e.target.value as LabCondition['indicator'];
              const meta = SUPPORTED_INDICATORS.find((ind) => ind.id === indicator);
              const operator = (meta?.defaultOperator ?? c.operator) as LabCondition['operator'];
              updateCondition(idx, { indicator, operator, value: defaultValueFor(indicator, operator) });
            }}
          >
            {SUPPORTED_INDICATORS.map((ind) => (
              <option key={ind.id} value={ind.id}>{ind.label}</option>
            ))}
          </select>
          <select
            value={c.operator}
            onChange={(e) => updateCondition(idx, { operator: e.target.value as LabCondition['operator'] })}
          >
            {OPERATORS.map((op) => (
              <option key={op.value} value={op.value}>{op.label}</option>
            ))}
          </select>
          {c.operator === 'between' ? (
            <input
              type="text"
              value={Array.isArray(c.value) ? `${c.value[0]}-${c.value[1]}` : ''}
              onChange={(e) => {
                const [a, b] = e.target.value.split('-').map(Number);
                if (!Number.isNaN(a) && !Number.isNaN(b)) updateCondition(idx, { value: [a, b] });
              }}
              placeholder="45-65"
            />
          ) : c.operator === 'crosses_above' || c.operator === 'crosses_below' ? (
            <input
              type="text"
              value={c.indicator === 'ema_20' ? 'EMA50' : 'prior value'}
              disabled
              title="Cross-over rules compare against the paired indicator baseline."
            />
          ) : (
            <input
              type="number"
              value={typeof c.value === 'number' ? c.value : 0}
              onChange={(e) => updateCondition(idx, { value: Number(e.target.value) })}
            />
          )}
          <button type="button" onClick={() => removeCondition(idx)} aria-label="Remove">
            <Trash2 size={14} color="#94A3B8" />
          </button>
        </div>
      ))}
      <button type="button" onClick={addCondition} style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: 4 }}>
        <Plus size={14} /> Add condition
      </button>
    </div>
  );
}

export function NoCodeBuilder({ definition, onChange }: Props) {
  const patch = (partial: Partial<StrategyDefinition>) => onChange({ ...definition, ...partial });
  const updateRegime = (regime: string) => {
    const current = definition.marketRegimeFilter ?? [];
    patch({
      marketRegimeFilter: current.includes(regime)
        ? current.filter((r) => r !== regime)
        : [...current, regime],
    });
  };

  return (
    <div className={styles.panel}>
      <h3 className={styles.panelTitle}>Rule Builder</h3>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12, marginBottom: 16 }}>
        <label style={{ fontSize: '0.8rem' }}>
          Strategy Name
          <input
            value={definition.name}
            onChange={(e) => patch({ name: e.target.value })}
            style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #E2E8F0' }}
          />
        </label>
        <label style={{ fontSize: '0.8rem' }}>
          Market
          <select
            value={definition.market ?? 'equity'}
            onChange={(e) => patch({ market: e.target.value as LabMarket })}
            style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #E2E8F0' }}
          >
            <option value="equity">Equity</option>
            <option value="options">Options</option>
          </select>
        </label>
        <label style={{ fontSize: '0.8rem' }}>
          Timeframe
          <select
            value={definition.timeframe}
            onChange={(e) => patch({ timeframe: e.target.value as LabTimeframe })}
            style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #E2E8F0' }}
          >
            <option value="intraday">Intraday</option>
            <option value="swing">Swing</option>
            <option value="positional">Positional</option>
            <option value="daily">Daily</option>
          </select>
        </label>
        <label style={{ fontSize: '0.8rem' }}>
          Direction
          <select
            value={definition.direction}
            onChange={(e) => patch({ direction: e.target.value as LabDirection })}
            style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #E2E8F0' }}
          >
            <option value="long">Long</option>
            <option value="short">Short</option>
          </select>
        </label>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 16 }}>
        <label style={{ fontSize: '0.8rem' }}>
          Symbol Universe
          <input
            list="strategy-lab-universes"
            value={(definition.symbolUniverse ?? ['NIFTY 500']).join(',')}
            onChange={(e) => patch({
              symbolUniverse: e.target.value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
            })}
            placeholder="NIFTY 500 or RELIANCE,TCS,HDFCBANK"
            style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #E2E8F0' }}
          />
          <datalist id="strategy-lab-universes">
            {DEFAULT_UNIVERSES.map((u) => <option key={u} value={u} />)}
          </datalist>
        </label>
        <label style={{ fontSize: '0.8rem' }}>
          Description
          <input
            value={definition.description ?? ''}
            onChange={(e) => patch({ description: e.target.value })}
            placeholder="Optional strategy notes"
            style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #E2E8F0' }}
          />
        </label>
      </div>

      <div style={{ marginBottom: 16 }}>
        <div className={styles.groupHeader} style={{ marginTop: 0 }}>Market Regime Filter</div>
        <div className={styles.chipGroup}>
          {MARKET_REGIMES.map((regime) => (
            <button
              key={regime}
              type="button"
              className={(definition.marketRegimeFilter ?? []).includes(regime) ? styles.chipActive : styles.chip}
              onClick={() => updateRegime(regime)}
            >
              {regime}
            </button>
          ))}
        </div>
      </div>

      <ConditionEditor
        label="Entry Conditions"
        group={definition.entry}
        onUpdate={(entry) => patch({ entry })}
      />
      <ConditionEditor
        label="Exit Conditions"
        group={definition.exit}
        onUpdate={(exit) => patch({ exit })}
      />

      <div style={{ marginTop: 16, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <label style={{ fontSize: '0.8rem' }}>
          Stop Loss (%)
          <input
            type="number"
            value={definition.stopLoss.value}
            onChange={(e) => patch({
              stopLoss: { ...definition.stopLoss, type: 'percent', value: Number(e.target.value) } as StopLossRule,
            })}
            style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #E2E8F0' }}
          />
        </label>
        <label style={{ fontSize: '0.8rem' }}>
          Target (R multiple)
          <input
            type="number"
            value={definition.targets[0]?.value ?? 2}
            onChange={(e) => {
              const targets: TargetRule[] = [{ type: 'rr_multiple', value: Number(e.target.value), label: 'T1' }];
              patch({ targets });
            }}
            style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #E2E8F0' }}
          />
        </label>
        <label style={{ fontSize: '0.8rem' }}>
          Risk / Trade (%)
          <input
            type="number"
            step="0.1"
            value={definition.risk.riskPerTradePct}
            onChange={(e) => patch({
              risk: { ...definition.risk, riskPerTradePct: Number(e.target.value) } as RiskSettings,
            })}
            style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #E2E8F0' }}
          />
        </label>
        <label style={{ fontSize: '0.8rem' }}>
          Max Positions
          <input
            type="number"
            value={definition.risk.maxOpenPositions}
            onChange={(e) => patch({
              risk: { ...definition.risk, maxOpenPositions: Number(e.target.value) } as RiskSettings,
            })}
            style={{ width: '100%', padding: 6, marginTop: 4, borderRadius: 6, border: '1px solid #E2E8F0' }}
          />
        </label>
      </div>
    </div>
  );
}
