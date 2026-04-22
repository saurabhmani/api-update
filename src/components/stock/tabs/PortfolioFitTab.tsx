'use client';

import { Card }           from '@/components/ui';
import RingProgress       from '../shared/RingProgress';
import type { StockData } from '../types';
import s from '../StockDashboard.module.scss';

interface Props { data: StockData; }

export default function PortfolioFitTab({ data }: Props) {
  const conf      = data.confidence ?? 0;
  const score     = data.score ?? 0;
  const riskScore = Math.min(100, Math.max(0, 100 - conf));
  const fitScore  = Math.min(100, Math.max(0, score * 0.8 + conf * 0.2));

  const factors: [string, number, string][] = [
    ['Sector Exposure',        Math.min(100, score * 0.85),       score * 0.85 >= 55 ? '#16A34A' : '#D97706'],
    ['Strategy Concentration', Math.min(100, conf * 0.9),         conf * 0.9 >= 55 ? '#16A34A' : '#D97706'],
    ['Correlation Risk',       Math.min(100, 100 - riskScore * 0.6), riskScore < 45 ? '#16A34A' : '#DC2626'],
    ['Capital Impact',         Math.min(100, fitScore * 0.75),    fitScore >= 50 ? '#16A34A' : '#D97706'],
    ['Drawdown Buffer',        Math.min(100, 100 - riskScore * 0.5), riskScore < 50 ? '#16A34A' : '#DC2626'],
  ];

  return (
    <div className={s.panel}>
      <div className={s.grid2}>
        <Card title="Portfolio Fit Score">
          <div className={s.fitCenter}>
            <div className={s.fitRingWrap}>
              <RingProgress
                value={fitScore}
                size={110}
                color={fitScore >= 65 ? '#16A34A' : fitScore >= 40 ? '#D97706' : '#DC2626'}
              />
              <div className={s.fitRingValue}>
                {fitScore.toFixed(0)}
                <span className={s.fitRingSub}>/ 100</span>
              </div>
            </div>
            <div className={s.fitRingCaption}>
              {fitScore >= 65 ? 'Strong Fit' : fitScore >= 40 ? 'Moderate Fit' : 'Weak Fit'}
            </div>
          </div>
        </Card>

        <Card title="Fit Factors">
          {factors.map(([label, val, color]) => (
            <div key={label} className={s.fitFactor}>
              <span className={s.fitFactorName}>{label}</span>
              <div className={s.fitFactorBar}>
                <div className={s.fitFactorBarFill} style={{ width: `${val}%`, background: color }} />
              </div>
              <span className={s.fitFactorVal}>{val.toFixed(0)}</span>
            </div>
          ))}
        </Card>
      </div>

      <Card title="Capital Allocation" compact>
        {([
          ['Recommended Size',   '2-3% of capital'],
          ['Sector After Add',   'Within limits'],
          ['Active Correlation',  riskScore < 40 ? 'Low' : riskScore < 60 ? 'Moderate' : 'High'],
          ['Portfolio Decision',  fitScore >= 60 ? 'Approved' : fitScore >= 40 ? 'Review Required' : 'Blocked'],
        ] as [string, string][]).map(([l, v]) => (
          <div key={l} className={s.kv}>
            <span className={s.kvLabel}>{l}</span>
            <span className={s.kvValue}>{v}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}
