'use client';

import { Brain, Target, AlertTriangle, Layers } from 'lucide-react';
import { fmt, clsx }          from '@/lib/utils';
import { reasonSentiment }     from '../helpers';
import type { StockData }     from '../types';
import s from '../StockDashboard.module.scss';

interface Props { data: StockData; }

export default function AIExplanationTab({ data }: Props) {
  const conf = data.confidence ?? 0;

  return (
    <div className={s.panel}>
      {/* Decision Summary */}
      <div className={s.aiBlock}>
        <div className={s.aiBlockTitle}>
          <Brain size={15} /> Decision Summary
        </div>
        <p className={s.aiText}>
          {data.signal_type
            ? `${data.symbol} currently shows a ${data.signal_type} signal with ${conf}% confidence. The ${data.signal_strength ?? 'moderate'} conviction level is derived from the alignment of technical, momentum, and context factors evaluated by the Quantorus365 engine.`
            : `${data.symbol} does not have an active signal. The system has not identified a high-conviction setup at the current price level. Continue monitoring for emerging patterns.`
          }
        </p>
      </div>

      {data.signal_type && (
        <>
          {/* Trade Narrative */}
          <div className={s.aiBlock}>
            <div className={s.aiBlockTitle}>
              <Target size={15} /> Trade Narrative
            </div>
            <div className={s.aiCallout}>
              {data.signal_type === 'BUY'
                ? `Price action suggests upside potential with entry near ${data.entry_price ? fmt.currency(data.entry_price) : 'current levels'}. Protective stop at ${data.stop_loss ? fmt.currency(data.stop_loss) : 'defined level'} limits downside. Risk-reward ratio of 1:${data.risk_reward ?? '-'} meets the system threshold for actionable setups.`
                : data.signal_type === 'SELL'
                ? `Bearish pressure detected. Consider reducing exposure or implementing protective measures. Key resistance acts as invalidation above ${data.stop_loss ? fmt.currency(data.stop_loss) : 'defined level'}.`
                : `Neutral stance recommended. No clear directional edge identified. Wait for improved factor alignment before committing capital.`
              }
            </div>
          </div>

          {/* Invalidation */}
          <div className={s.aiBlock}>
            <div className={s.aiBlockTitle}>
              <AlertTriangle size={15} /> Invalidation Logic
            </div>
            <p className={s.aiText}>
              This setup is invalidated if price moves beyond the stop loss at {data.stop_loss ? fmt.currency(data.stop_loss) : 'the defined level'}.
              Additional invalidation triggers: volume spike against direction, regime change to opposing scenario, confidence drop below 50%, or deterioration in sector breadth.
            </p>
          </div>

          {/* Factor Breakdown */}
          {data.reasons.length > 0 && (
            <div className={s.aiBlock}>
              <div className={s.aiBlockTitle}>
                <Layers size={15} /> Factor Breakdown
              </div>
              <div className={s.reasons}>
                {data.reasons.map((r, i) => {
                  const sent = reasonSentiment(r.text);
                  return (
                    <div key={i} className={s.reasonRow}>
                      <div className={clsx(s.reasonDot, s[`reasonDot--${sent}`])} />
                      <span className={s.reasonText}>{r.text}</span>
                      {r.factor_key && <span className={s.reasonKey}>{r.factor_key}</span>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
