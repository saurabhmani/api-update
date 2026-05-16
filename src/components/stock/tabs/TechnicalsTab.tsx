'use client';

import { Card }           from '@/components/ui';
import { fmt, clsx }      from '@/lib/utils';
import { pct52w }         from '../helpers';
import type { StockData } from '../types';
import s from '../StockDashboard.module.scss';

interface Props { data: StockData; }

function Chip({ signal }: { signal: string }) {
  return (
    <span className={clsx(s.techChip, s[`techChip--${signal}`])}>
      {signal}
    </span>
  );
}

export default function TechnicalsTab({ data }: Props) {
  const conf  = data.confidence ?? 0;
  const score = data.score ?? 0;
  const pos52 = pct52w(data.week52_low, data.week52_high, data.ltp);
  const dayRangePct = data.day_low ? ((data.day_high - data.day_low) / data.day_low * 100).toFixed(2) : '-';
  const rangePct52  = data.week52_low ? ((data.week52_high - data.week52_low) / data.week52_low * 100).toFixed(1) : '-';

  return (
    <div className={s.panel}>
      <div className={s.grid2}>
        <Card title="Momentum Indicators">
          {([
            ['Signal Direction', data.signal_type ?? '-',     data.signal_type === 'BUY' ? 'bullish' : data.signal_type === 'SELL' ? 'bearish' : 'neutral'],
            ['Signal Strength',  data.signal_strength ?? '-', data.signal_type === 'BUY' ? 'bullish' : data.signal_type === 'SELL' ? 'bearish' : 'neutral'],
            ['Confidence',       `${conf}%`,                 conf >= 60 ? 'bullish' : conf >= 40 ? 'neutral' : 'bearish'],
            ['Q365 Score',       score > 0 ? score.toFixed(1) : '-', score >= 60 ? 'bullish' : score >= 40 ? 'neutral' : 'bearish'],
          ] as [string, string, string][]).map(([name, val, signal]) => (
            <div key={name} className={s.techRow}>
              <span className={s.techName}>{name}</span>
              <span className={s.techValue}>{val}</span>
              <Chip signal={signal} />
            </div>
          ))}
        </Card>

        <Card title="Price Structure">
          {([
            ['Day High',     fmt.currency(data.day_high)],
            ['Day Low',      fmt.currency(data.day_low)],
            ['Day Range',    `${dayRangePct}%`],
            ['52W Position', `${pos52}%`],
            ['vs Prev Close', `${data.change_percent >= 0 ? '+' : ''}${data.change_percent.toFixed(2)}%`],
            ['Volume',       fmt.volume(data.volume)],
          ] as [string, string][]).map(([name, val]) => (
            <div key={name} className={s.techRow}>
              <span className={s.techName}>{name}</span>
              <span className={s.techValue}>{val}</span>
            </div>
          ))}
        </Card>

        <Card title="Support & Resistance">
          {([
            ['Entry Zone',      data.entry_price ? fmt.currency(data.entry_price) : '-'],
            ['Stop Loss',       data.stop_loss ? fmt.currency(data.stop_loss) : '-'],
            ['Target 1',        data.target1 ? fmt.currency(data.target1) : '-'],
            ['Target 2',        data.target2 ? fmt.currency(data.target2) : '-'],
            ['52W Support',     fmt.currency(data.week52_low)],
            ['52W Resistance',  fmt.currency(data.week52_high)],
          ] as [string, string][]).map(([name, val]) => (
            <div key={name} className={s.techRow}>
              <span className={s.techName}>{name}</span>
              <span className={s.techValue}>{val}</span>
            </div>
          ))}
        </Card>

        <Card title="Volatility">
          {([
            ['Day Range %',     `${dayRangePct}%`],
            ['Absolute Change', fmt.currency(Math.abs(data.change_abs))],
            ['52W Range',       `${rangePct52}%`],
          ] as [string, string][]).map(([name, val]) => (
            <div key={name} className={s.techRow}>
              <span className={s.techName}>{name}</span>
              <span className={s.techValue}>{val}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
