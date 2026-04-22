'use client';

import {
  TrendingUp, TrendingDown, Minus, Check,
  AlertTriangle, Shield, Copy,
} from 'lucide-react';
import { fmt, clsx }       from '@/lib/utils';
import { confLevel }        from '../helpers';
import ScoreBar             from '../shared/ScoreBar';
import type { StockData }   from '../types';
import s from '../StockDashboard.module.scss';

interface Props {
  data: StockData;
  onCopyPlan: () => void;
  copied: boolean;
}

export default function DecisionPanel({ data, onCopyPlan, copied }: Props) {
  const dir       = data.signal_type ?? 'HOLD';
  const conf      = data.confidence ?? 0;
  const score     = data.score ?? 0;
  const riskScore = Math.min(100, Math.max(0, 100 - conf));
  const fitScore  = Math.min(100, Math.max(0, score * 0.8 + conf * 0.2));

  return (
    <aside className={s.decisionPanel}>

      {/* Signal Intelligence */}
      <div className={s.dpCardAccent}>
        <div className={s.dpLabel}>Signal Intelligence</div>

        {data.signal_type ? (
          <>
            <div className={clsx(s.dpVerdict, s[`dpVerdict--${dir}`])}>
              {dir === 'BUY' ? <TrendingUp size={16} /> : dir === 'SELL' ? <TrendingDown size={16} /> : <Minus size={16} />}
              {dir}
            </div>

            <div className={s.dpRow}>
              <span className={s.dpRowLabel}>Confidence</span>
              <span className={s.dpRowValue}>
                <ScoreBar value={conf} />
                {conf}%
              </span>
            </div>
            <div className={s.dpRow}>
              <span className={s.dpRowLabel}>Risk Score</span>
              <span className={s.dpRowValue}>
                <ScoreBar value={riskScore} variant={riskScore <= 40 ? 'success' : riskScore <= 60 ? 'warning' : 'danger'} />
                {riskScore}
              </span>
            </div>
            <div className={s.dpRow}>
              <span className={s.dpRowLabel}>Q365 Score</span>
              <span className={s.dpRowValue}>
                <ScoreBar value={score} />
                {score > 0 ? score.toFixed(0) : '-'}
              </span>
            </div>
          </>
        ) : (
          <div style={{ textAlign: 'center', padding: '16px 0', color: '#94A3B8', fontSize: 13 }}>
            No active signal
          </div>
        )}
      </div>

      {/* Execution readiness */}
      {data.signal_type && (
        <div className={s.dpCard}>
          <div className={s.dpLabel}>Execution Readiness</div>
          <div className={clsx(
            s.dpReadiness,
            conf >= 65 ? s['dpReadiness--go']
              : conf >= 45 ? s['dpReadiness--watch']
              : s['dpReadiness--block']
          )}>
            {conf >= 65 ? <Check size={14} /> : conf >= 45 ? <AlertTriangle size={14} /> : <Shield size={14} />}
            {conf >= 65 ? 'Ready to Execute' : conf >= 45 ? 'Proceed with Caution' : 'Not Recommended'}
          </div>
        </div>
      )}

      {/* Trade Plan */}
      {data.signal_type && (
        <div className={s.dpCard}>
          <div className={s.dpLabel}>Trade Plan</div>
          <div className={s.dpLevels}>
            <div className={s.dpLevel}>
              <div className={s.dpLevelLabel}>Entry</div>
              <div className={clsx(s.dpLevelValue, s['dpLevelValue--entry'])}>
                {data.entry_price ? fmt.currency(data.entry_price) : '-'}
              </div>
            </div>
            <div className={s.dpLevel}>
              <div className={s.dpLevelLabel}>Stop Loss</div>
              <div className={clsx(s.dpLevelValue, s['dpLevelValue--stop'])}>
                {data.stop_loss ? fmt.currency(data.stop_loss) : '-'}
              </div>
            </div>
            <div className={s.dpLevel}>
              <div className={s.dpLevelLabel}>Target 1</div>
              <div className={clsx(s.dpLevelValue, s['dpLevelValue--target'])}>
                {data.target1 ? fmt.currency(data.target1) : '-'}
              </div>
            </div>
            <div className={s.dpLevel}>
              <div className={s.dpLevelLabel}>Target 2</div>
              <div className={clsx(s.dpLevelValue, s['dpLevelValue--target'])}>
                {data.target2 ? fmt.currency(data.target2) : '-'}
              </div>
            </div>
          </div>

          {data.risk_reward != null && (
            <div className={s.dpRR}>
              <span className={s.dpRRLabel}>R : R</span>
              <span className={s.dpRRValue}>1:{data.risk_reward}</span>
            </div>
          )}
        </div>
      )}

      {/* Portfolio Fit */}
      <div className={s.dpCard}>
        <div className={s.dpLabel}>Portfolio Fit</div>
        <div className={s.dpRow}>
          <span className={s.dpRowLabel}>Fit Score</span>
          <span className={s.dpRowValue}>{fitScore.toFixed(0)}/100</span>
        </div>
        <div className={s.dpRow}>
          <span className={s.dpRowLabel}>Size</span>
          <span className={s.dpRowValue}>2-3%</span>
        </div>
        <div className={s.dpRow}>
          <span className={s.dpRowLabel}>Correlation</span>
          <span className={s.dpRowValue}>{riskScore < 40 ? 'Low' : riskScore < 60 ? 'Moderate' : 'High'}</span>
        </div>
      </div>

      {/* Event Risk */}
      <div className={s.dpCard}>
        <div className={s.dpLabel}>Event Risk</div>
        <div className={s.dpEvent}>
          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>No major events detected. Verify corporate announcements before execution.</span>
        </div>
      </div>

      {/* Copy */}
      <button className={clsx(s.dpCopy, copied && s['dpCopy--done'])} onClick={onCopyPlan}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
        {copied ? 'Copied' : 'Copy Trade Plan'}
      </button>
    </aside>
  );
}
