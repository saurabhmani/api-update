'use client';

import type { BacktestRunConfig } from '@/lib/backtesting/types';

interface Props {
  config: BacktestRunConfig;
  onChange: (config: BacktestRunConfig) => void;
  onRun: () => void;
  onClose: () => void;
  running: boolean;
}

export function BacktestConfigPanel({ config, onChange, onRun, onClose, running }: Props) {
  const set = <K extends keyof BacktestRunConfig>(key: K, value: BacktestRunConfig[K]) => {
    onChange({ ...config, [key]: value });
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)', zIndex: 100,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24,
    }}>
      <div style={{
        background: '#fff', borderRadius: 12, width: '100%', maxWidth: 560,
        maxHeight: '90vh', overflow: 'auto', padding: 24, boxShadow: '0 20px 40px rgba(0,0,0,0.15)',
      }}>
        <h2 style={{ margin: '0 0 4px', fontSize: '1.1rem' }}>Backtest Configuration</h2>
        <p style={{ margin: '0 0 20px', fontSize: '0.85rem', color: '#64748B' }}>
          Zero look-ahead replay — signals generated bar-by-bar from historical candles only.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label style={{ gridColumn: '1 / -1' }}>
            <span style={{ fontSize: '0.75rem', color: '#64748B' }}>Run Name</span>
            <input className="input" value={config.name} onChange={(e) => set('name', e.target.value)} />
          </label>

          <label>
            <span style={{ fontSize: '0.75rem', color: '#64748B' }}>Start Date</span>
            <input className="input" type="date" value={config.startDate} onChange={(e) => set('startDate', e.target.value)} />
          </label>
          <label>
            <span style={{ fontSize: '0.75rem', color: '#64748B' }}>End Date</span>
            <input className="input" type="date" value={config.endDate} onChange={(e) => set('endDate', e.target.value)} />
          </label>

          <label>
            <span style={{ fontSize: '0.75rem', color: '#64748B' }}>Initial Capital (₹)</span>
            <input className="input" type="number" value={config.initialCapital} onChange={(e) => set('initialCapital', Number(e.target.value))} />
          </label>
          <label>
            <span style={{ fontSize: '0.75rem', color: '#64748B' }}>Risk / Trade (%)</span>
            <input className="input" type="number" step="0.1" value={config.riskPerTradePct} onChange={(e) => set('riskPerTradePct', Number(e.target.value))} />
          </label>

          <label>
            <span style={{ fontSize: '0.75rem', color: '#64748B' }}>Position Sizing</span>
            <select className="input" value={config.positionSizingModel} onChange={(e) => set('positionSizingModel', e.target.value as BacktestRunConfig['positionSizingModel'])}>
              <option value="risk_based">Risk-Based</option>
              <option value="fixed_pct">Fixed % Equity</option>
            </select>
          </label>
          {config.positionSizingModel === 'fixed_pct' && (
            <label>
              <span style={{ fontSize: '0.75rem', color: '#64748B' }}>Fixed Position %</span>
              <input className="input" type="number" step="0.5" value={config.fixedPositionPct ?? 5} onChange={(e) => set('fixedPositionPct', Number(e.target.value))} />
            </label>
          )}

          <label>
            <span style={{ fontSize: '0.75rem', color: '#64748B' }}>Slippage (bps)</span>
            <input className="input" type="number" value={config.slippageBps} onChange={(e) => set('slippageBps', Number(e.target.value))} />
          </label>
          <label>
            <span style={{ fontSize: '0.75rem', color: '#64748B' }}>Brokerage Model</span>
            <select className="input" value={config.feeModel} onChange={(e) => set('feeModel', e.target.value as BacktestRunConfig['feeModel'])}>
              <option value="nse_delivery">NSE Delivery (STT + GST)</option>
              <option value="flat">Flat Commission</option>
            </select>
          </label>

          <label>
            <span style={{ fontSize: '0.75rem', color: '#64748B' }}>Commission / Order (₹)</span>
            <input className="input" type="number" value={config.commissionPerTrade} onChange={(e) => set('commissionPerTrade', Number(e.target.value))} />
          </label>
          <label>
            <span style={{ fontSize: '0.75rem', color: '#64748B' }}>Fill Model</span>
            <select className="input" value={config.fillModel} onChange={(e) => set('fillModel', e.target.value as BacktestRunConfig['fillModel'])}>
              <option value="conservative">Conservative</option>
              <option value="midpoint">Midpoint</option>
              <option value="aggressive">Aggressive</option>
            </select>
          </label>

          <label>
            <span style={{ fontSize: '0.75rem', color: '#64748B' }}>Max Open Positions</span>
            <input className="input" type="number" value={config.maxOpenPositions} onChange={(e) => set('maxOpenPositions', Number(e.target.value))} />
          </label>
          <label>
            <span style={{ fontSize: '0.75rem', color: '#64748B' }}>Min Confidence</span>
            <input className="input" type="number" value={config.minConfidence} onChange={(e) => set('minConfidence', Number(e.target.value))} />
          </label>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 24, justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn--outline" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={onRun} disabled={running}>
            {running ? 'Queuing…' : 'Run Backtest'}
          </button>
        </div>
      </div>
    </div>
  );
}
