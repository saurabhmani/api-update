'use client';

import { History } from 'lucide-react';
import { Card }    from '@/components/ui';
import { fmt, clsx } from '@/lib/utils';
import type { StockData } from '../types';
import s from '../StockDashboard.module.scss';

interface Props { data: StockData; }

export default function HistoryTab({ data }: Props) {
  return (
    <div className={s.panel}>
      <Card title="Signal Lifecycle">
        {data.signal_type ? (
          <div className={s.timeline}>
            <div className={s.tlItem}>
              <div className={clsx(s.tlDot, s['tlDot--signal'])} />
              <div className={s.tlDate}>
                {data.signal_age_min != null ? `${data.signal_age_min}m ago` : fmt.datetime(data.as_of)}
              </div>
              <div className={s.tlTitle}>Signal Generated: {data.signal_type}</div>
              <div className={s.tlDesc}>
                Confidence {data.confidence ?? 0}% &middot; {data.signal_strength} conviction
              </div>
            </div>

            {data.entry_price && (
              <div className={s.tlItem}>
                <div className={clsx(s.tlDot, s['tlDot--entry'])} />
                <div className={s.tlDate}>Entry Zone</div>
                <div className={s.tlTitle}>Entry at {fmt.currency(data.entry_price)}</div>
                <div className={s.tlDesc}>
                  Stop: {data.stop_loss ? fmt.currency(data.stop_loss) : '-'} &middot; Target: {data.target1 ? fmt.currency(data.target1) : '-'}
                </div>
              </div>
            )}

            <div className={s.tlItem}>
              <div className={clsx(s.tlDot, s['tlDot--default'])} />
              <div className={s.tlDate}>Current</div>
              <div className={s.tlTitle}>LTP: {fmt.currency(data.ltp)}</div>
              <div className={s.tlDesc}>
                {data.change_percent >= 0 ? '+' : ''}{data.change_percent.toFixed(2)}% from prev close
              </div>
            </div>
          </div>
        ) : (
          <div className={s.empty}>
            <div className={s.emptyIcon}><History size={22} /></div>
            <div className={s.emptyTitle}>No signal history</div>
            <div className={s.emptyDesc}>
              Signal lifecycle events appear here once a signal is generated for this symbol.
            </div>
          </div>
        )}
      </Card>

      <Card title="Data Audit" compact>
        {([
          ['Data Source',  data.data_source],
          ['Last Updated', fmt.datetime(data.as_of)],
          ['Symbol',       data.symbol],
          ['Instrument',   data.instrument_key],
          ['Interval',     data.candle_interval],
        ] as [string, string][]).map(([l, v]) => (
          <div key={l} className={s.kv}>
            <span className={s.kvLabel}>{l}</span>
            <span className={s.kvValue} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }}>{v}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}
