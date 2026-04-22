'use client';

import { Loading, Empty } from '@/components/ui';
import { fmt, clsx }      from '@/lib/utils';
import { TrendingUp }     from 'lucide-react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid, ReferenceLine,
} from 'recharts';
import type { StockData, CandleBar, Interval } from './types';
import { INTERVALS, INTERVAL_LABEL } from './types';
import s from './StockDashboard.module.scss';

interface Props {
  data: StockData;
  candles: CandleBar[];
  interval: Interval;
  chartLoading: boolean;
  onIntervalChange: (iv: Interval) => void;
}

export default function StockChart({ data, candles, interval, chartLoading, onIntervalChange }: Props) {
  const positive = data.change_percent >= 0;
  const strokeColor = positive ? '#16A34A' : '#DC2626';

  return (
    <div className={s.chartSection}>
      <div className={s.chartToolbar}>
        <span className={s.chartTitle}>{data.symbol} Price</span>
        <div className={s.intervalGroup}>
          {INTERVALS.map(iv => (
            <button
              key={iv}
              className={clsx(s.intervalBtn, interval === iv && s['intervalBtn--active'])}
              onClick={() => onIntervalChange(iv)}
            >
              {INTERVAL_LABEL[iv]}
            </button>
          ))}
        </div>
      </div>

      {chartLoading ? (
        <div style={{ padding: 40, textAlign: 'center' }}>
          <Loading text="Loading chart..." />
        </div>
      ) : candles.length === 0 ? (
        <Empty icon={TrendingUp} title="No chart data"
          description="Chart data populates after the scheduler runs." />
      ) : (
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={candles} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <defs>
              <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={strokeColor} stopOpacity={0.1} />
                <stop offset="100%" stopColor={strokeColor} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" />
            <XAxis
              dataKey="ts"
              tickFormatter={v =>
                interval === '1day'
                  ? new Date(v).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
                  : new Date(v).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
              }
              tick={{ fontSize: 10, fill: '#94A3B8' }}
            />
            <YAxis
              domain={['auto', 'auto']}
              tickFormatter={v => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              tick={{ fontSize: 10, fill: '#94A3B8' }}
              width={60}
            />
            <Tooltip
              formatter={(v: any) => [fmt.currency(v), 'Close']}
              labelFormatter={v => new Date(v).toLocaleString('en-IN')}
              contentStyle={{ borderRadius: 8, border: '1px solid #E2E8F0', fontSize: 12 }}
            />
            {data.prev_close > 0 && (
              <ReferenceLine y={data.prev_close} stroke="#94A3B8" strokeDasharray="4 4"
                label={{ value: 'Prev', fill: '#94A3B8', fontSize: 9 }} />
            )}
            {data.entry_price && (
              <ReferenceLine y={data.entry_price} stroke="#0B1F3A" strokeDasharray="4 4"
                label={{ value: 'Entry', fill: '#0B1F3A', fontSize: 9 }} />
            )}
            {data.stop_loss && (
              <ReferenceLine y={data.stop_loss} stroke="#DC2626" strokeDasharray="4 4"
                label={{ value: 'SL', fill: '#DC2626', fontSize: 9 }} />
            )}
            {data.target1 && (
              <ReferenceLine y={data.target1} stroke="#16A34A" strokeDasharray="4 4"
                label={{ value: 'T1', fill: '#16A34A', fontSize: 9 }} />
            )}
            <Area
              type="monotone"
              dataKey="close"
              stroke={strokeColor}
              strokeWidth={1.5}
              fill="url(#areaFill)"
              dot={false}
              activeDot={{ r: 3, strokeWidth: 1.5 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
