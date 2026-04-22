'use client';

import { Card }           from '@/components/ui';
import { fmt }            from '@/lib/utils';
import type { StockData } from '../types';
import s from '../StockDashboard.module.scss';

interface Props { data: StockData; }

export default function FinancialsTab({ data }: Props) {
  return (
    <div className={s.panel}>
      <Card title="Market Metrics">
        <div style={{ overflowX: 'auto' }}>
          <table className={s.finTable}>
            <thead>
              <tr>
                <th>Metric</th>
                <th>Current</th>
                <th>52W High</th>
                <th>52W Low</th>
              </tr>
            </thead>
            <tbody>
              {([
                ['LTP',        fmt.currency(data.ltp),          fmt.currency(data.week52_high), fmt.currency(data.week52_low)],
                ['Day Range',  `${fmt.currency(data.day_low)} - ${fmt.currency(data.day_high)}`, '-', '-'],
                ['Volume',     fmt.volume(data.volume),         '-', '-'],
                ['VWAP',       data.vwap ? fmt.currency(data.vwap) : '-', '-', '-'],
                ['Score',      data.score?.toFixed(1) ?? '-',   '-', '-'],
                ['Signal',     data.signal_type ?? '-',         '-', '-'],
                ['Confidence', data.confidence ? `${data.confidence}%` : '-', '-', '-'],
              ] as [string, string, string, string][]).map(([label, ...vals]) => (
                <tr key={label}>
                  <td>{label}</td>
                  {vals.map((v, i) => <td key={i}>{v}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className={s.disclaimer}>
        Detailed financials (P/E, revenue, EPS, margins) require a premium data provider integration. Connect BSE/NSE corporate data in Admin settings.
      </div>
    </div>
  );
}
