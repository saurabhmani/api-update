'use client';

import { Card }           from '@/components/ui';
import { fmt }            from '@/lib/utils';
import RingProgress       from '../shared/RingProgress';
import { pct52w, calcReturn, returnColor } from '../helpers';
import type { StockData, CandleBar } from '../types';
import s from '../StockDashboard.module.scss';

interface Props {
  data: StockData;
  candles: CandleBar[];
}

export default function OverviewTab({ data, candles }: Props) {
  const pos52 = pct52w(data.week52_low, data.week52_high, data.ltp);
  const score = data.score ?? 0;

  const returns: [string, number | null][] = [
    ['1W',  calcReturn(candles, data.ltp, 5)],
    ['1M',  calcReturn(candles, data.ltp, 22)],
    ['3M',  calcReturn(candles, data.ltp, 66)],
    ['6M',  calcReturn(candles, data.ltp, 130)],
    ['1Y',  data.week52_low ? ((data.ltp - data.week52_low) / data.week52_low) * 100 : null],
  ];

  return (
    <div className={s.panel}>
      {/* Performance */}
      <Card title="Performance">
        <div className={s.perfRow}>
          {returns.map(([period, val]) => (
            <div key={period} className={s.perfItem}>
              <div className={s.perfItemLabel}>{period}</div>
              <div className={s.perfItemValue}
                style={{ color: val != null ? returnColor(val) : '#CBD5E1' }}>
                {val != null ? `${val >= 0 ? '+' : ''}${val.toFixed(2)}%` : '-'}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className={s.grid2}>
        {/* Key stats */}
        <Card title="Key Statistics">
          {([
            ['LTP',          fmt.currency(data.ltp)],
            ['Day Range',    `${fmt.currency(data.day_low)} - ${fmt.currency(data.day_high)}`],
            ['Volume',       fmt.volume(data.volume)],
            ['VWAP',         data.vwap != null ? fmt.currency(data.vwap) : '-'],
            ['Prev Close',   fmt.currency(data.prev_close)],
            ['52W High',     fmt.currency(data.week52_high)],
            ['52W Low',      fmt.currency(data.week52_low)],
            ['Q365 Score',   score > 0 ? score.toFixed(1) : '-'],
            ['Rank',         data.rank_position != null ? `#${data.rank_position}` : '-'],
          ] as [string, string][]).map(([l, v]) => (
            <div key={l} className={s.kv}>
              <span className={s.kvLabel}>{l}</span>
              <span className={s.kvValue}>{v}</span>
            </div>
          ))}
        </Card>

        {/* 52W range + Score */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Card title="52-Week Range">
            <div style={{ padding: '4px 0' }}>
              <div className={s.rangeLabels}>
                <span>{fmt.currency(data.week52_low)}</span>
                <span style={{ fontWeight: 700, color: '#0B1120' }}>{pos52}%</span>
                <span>{fmt.currency(data.week52_high)}</span>
              </div>
              <div className={s.rangeTrack}>
                <div className={s.rangeFill} style={{ width: `${pos52}%` }} />
                <div className={s.rangeDot} style={{ left: `${pos52}%` }} />
              </div>
            </div>
          </Card>

          <Card title="Quantorus365 Score">
            <div className={s.scoreRingWrap}>
              <div className={s.scoreRingInner}>
                <RingProgress
                  value={score}
                  color={score >= 70 ? '#16A34A' : score >= 50 ? '#D97706' : '#DC2626'}
                />
                <div className={s.scoreRingLabel}>
                  {score > 0 ? score.toFixed(0) : '-'}
                  <span className={s.scoreRingSub}>/ 100</span>
                </div>
              </div>
              <div className={s.scoreRingCaption}>
                {data.rank_position ? `Rank #${data.rank_position}` : 'Overall Score'}
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
