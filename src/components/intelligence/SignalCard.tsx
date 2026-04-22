'use client';
import { useState } from 'react';
import { ChevronDown, ChevronUp, ShieldAlert, CheckCircle, AlertTriangle, Clock } from 'lucide-react';
import { fmt } from '@/lib/utils';
import DisclaimerBanner from './DisclaimerBanner';
import type { Signal } from '@/lib/signal-engine/live/analyzeInstrument';

interface Props {
  signal:      Signal;
  compact?:    boolean;
  showLevels?: boolean;
}

const DIR_STYLE: Record<string, { bg: string; color: string }> = {
  BUY:  { bg: '#DCFCE7', color: '#15803D' },
  SELL: { bg: '#FEE2E2', color: '#DC2626' },
  HOLD: { bg: '#F1F5F9', color: '#64748B' },
  WAIT: { bg: '#FEF3C7', color: '#D97706' },
};

const CONVICTION_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string }> = {
  high_conviction: { label: 'High Conviction', color: '#065F46', bg: '#D1FAE5', icon: '●●●●' },
  actionable:      { label: 'Actionable',      color: '#1D4ED8', bg: '#DBEAFE', icon: '●●●○' },
  watchlist:       { label: 'Watchlist',        color: '#92400E', bg: '#FEF3C7', icon: '●●○○' },
  reject:          { label: 'Below Threshold',  color: '#991B1B', bg: '#FEE2E2', icon: '●○○○' },
};

const SCENARIO_LABEL: Record<string, string> = {
  trend_continuation:    'Trend',
  breakout_expansion:    'Breakout',
  choppy_mean_reverting: 'Mean Rev',
  defensive_risk_off:    'Defensive',
  short_covering_rally:  'Short Cover',
  event_driven_volatility:'Event',
  no_trade_uncertain:    'No Trade',
  TREND_CONTINUATION:    'Trend',
  BREAKOUT_CONTINUATION: 'Breakout',
  PULLBACK_IN_TREND:     'Pullback',
  MEAN_REVERSION:        'Mean Rev',
  MOMENTUM_EXPANSION:    'Momentum',
};

function ConfBar({ value }: { value: number }) {
  const color = value >= 75 ? '#065F46' : value >= 65 ? '#1D4ED8' : value >= 55 ? '#D97706' : '#DC2626';
  const label = value >= 85 ? 'High' : value >= 70 ? 'Good' : value >= 55 ? 'Moderate' : 'Low';
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: '#64748B', marginBottom: 3 }}>
        <span>Confidence</span>
        <span style={{ color, fontWeight: 700 }}>{value}% · {label}</span>
      </div>
      <div style={{ height: 5, background: '#E2E8F0', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${value}%`, background: color, borderRadius: 99, transition: 'width 0.5s' }} />
      </div>
    </div>
  );
}

function ConvictionBadge({ band }: { band?: string }) {
  if (!band) return null;
  const cfg = CONVICTION_CONFIG[band] ?? CONVICTION_CONFIG.watchlist;
  return (
    <span style={{
      background: cfg.bg, color: cfg.color,
      fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
      letterSpacing: 0.4, display: 'inline-flex', alignItems: 'center', gap: 4,
    }}>
      <span style={{ letterSpacing: 1 }}>{cfg.icon}</span> {cfg.label}
    </span>
  );
}

function ScenarioTag({ tag }: { tag?: string | null }) {
  if (!tag || tag === 'NO_STRATEGY' || tag === 'no_trade_uncertain') return null;
  const label = SCENARIO_LABEL[tag] ?? tag.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return (
    <span style={{
      background: '#EFF6FF', color: '#1E40AF',
      fontSize: 10, fontWeight: 600, padding: '2px 7px', borderRadius: 99,
    }}>
      {label}
    </span>
  );
}

function RejectionBlock({ reasons }: { reasons: string[] }) {
  if (!reasons?.length) return null;
  return (
    <div style={{
      background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: 8,
      padding: '10px 12px', marginTop: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <ShieldAlert size={14} color="#C2410C" />
        <span style={{ fontSize: 11, fontWeight: 700, color: '#C2410C' }}>
          {reasons.length === 1 ? 'Signal blocked' : `${reasons.length} quality gates failed`}
        </span>
      </div>
      {reasons.slice(0, 3).map((r, i) => (
        <div key={i} style={{ fontSize: 11, color: '#7C3AED', marginBottom: 3, paddingLeft: 4 }}>
          · {r}
        </div>
      ))}
    </div>
  );
}

function ManipulationBadge({
  score, band, warning, penalized,
}: { score?: number | null; band?: string | null; warning?: string | null; penalized?: boolean }) {
  if (score == null && !band && !warning) return null;
  const s = score ?? 0;
  const tone =
    band === 'severe' ? { bg: '#FEE2E2', color: '#7F1D1D', label: 'Severe' } :
    band === 'high'   ? { bg: '#FEE2E2', color: '#991B1B', label: 'High' } :
    band === 'elevated' ? { bg: '#FEF3C7', color: '#92400E', label: 'Elevated' } :
    band === 'watch'  ? { bg: '#FEF9C3', color: '#854D0E', label: 'Watch' } :
                        { bg: '#F0FDF4', color: '#15803D', label: 'Low' };
  return (
    <span
      title={warning ?? `Manipulation suspicion: ${tone.label}`}
      style={{
        background: tone.bg, color: tone.color,
        fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
        display: 'inline-flex', alignItems: 'center', gap: 4,
      }}
    >
      <ShieldAlert size={11} />
      Manipulation: {tone.label} ({s}){penalized ? ' · penalized' : ''}
    </span>
  );
}

function PortfolioFitBadge({ score }: { score?: number | null }) {
  if (score == null) return null;
  const color = score >= 70 ? '#065F46' : score >= 50 ? '#D97706' : '#DC2626';
  const bg    = score >= 70 ? '#D1FAE5' : score >= 50 ? '#FEF3C7' : '#FEE2E2';
  const label = score >= 80 ? 'Great fit' : score >= 60 ? 'Good fit' : score >= 40 ? 'Marginal' : 'Poor fit';
  return (
    <span style={{ background: bg, color, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 99 }}>
      Portfolio: {label} ({score})
    </span>
  );
}

export default function SignalCard({ signal, compact, showLevels = true }: Props) {
  const [expanded, setExpanded] = useState(false);
  const ds      = DIR_STYLE[signal.direction] || DIR_STYLE.HOLD;
  const approved = !signal.rejection_reasons?.length;

  if (compact) {
    return (
      <div style={{ padding: '12px 16px', borderBottom: '1px solid #F1F5F9', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#1E3A5F' }}>{signal.tradingsymbol}</div>
          <div style={{ fontSize: 11, color: '#94A3B8' }}>
            {signal.exchange} · {signal.timeframe}
            {signal.scenario_tag && <span style={{ marginLeft: 6 }}>· <ScenarioTag tag={signal.scenario_tag} /></span>}
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {!approved && <ShieldAlert size={13} color="#C2410C" />}
          <span style={{ background: ds.bg, color: ds.color, fontWeight: 700, fontSize: 11, padding: '2px 8px', borderRadius: 99, letterSpacing: 0.5 }}>
            {signal.direction}
          </span>
          <span style={{ fontSize: 12, color: signal.confidence >= 70 ? '#065F46' : '#D97706', fontWeight: 600 }}>
            {signal.confidence}%
          </span>
        </div>
      </div>
    );
  }

  const borderColor = !approved ? '#FED7AA' : ds.color;

  return (
    <div style={{
      background: '#fff',
      border: `1px solid ${!approved ? '#FEE2E2' : '#E2E8F0'}`,
      borderRadius: 12,
      padding: 20,
      borderLeft: `3px solid ${borderColor}`,
      boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
      opacity: !approved ? 0.92 : 1,
    }}>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 10 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <span style={{ fontWeight: 800, fontSize: 18, color: '#1E3A5F' }}>{signal.tradingsymbol}</span>
            <span style={{ background: ds.bg, color: ds.color, fontWeight: 800, fontSize: 12, padding: '3px 10px', borderRadius: 99 }}>
              {signal.direction}
            </span>
            {!approved && <ShieldAlert size={15} color="#C2410C" />}
            {approved && signal.conviction_band === 'high_conviction' && <CheckCircle size={15} color="#065F46" />}
          </div>
          <div style={{ fontSize: 12, color: '#94A3B8' }}>
            {signal.exchange} · {signal.timeframe} · {signal.risk} Risk
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
          {signal.conviction_band && <ConvictionBadge band={signal.conviction_band} />}
          {signal.scenario_tag && <ScenarioTag tag={signal.scenario_tag} />}
        </div>
      </div>

      {/* If rejected — show rejection block before everything else */}
      {!approved && (
        <RejectionBlock reasons={signal.rejection_reasons ?? []} />
      )}

      {/* Confidence bar — always show */}
      {typeof signal.confidence === 'number' && (
        <div style={{ marginBottom: 12, marginTop: approved ? 12 : 8 }}>
          <ConfBar value={signal.confidence} />
        </div>
      )}

      {/* Entry / SL / Target — only if approved */}
      {approved && showLevels && signal.entry_price && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8, marginBottom: 12 }}>
          {[
            { label: 'Entry', value: signal.entry_price, color: '#1E3A5F' },
            { label: 'Stop Loss', value: signal.stop_loss, color: '#DC2626' },
            { label: 'Target 1', value: signal.target1, color: '#15803D' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: '#F8FAFC', borderRadius: 8, padding: '8px 10px', textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: '#94A3B8', fontWeight: 600, marginBottom: 2 }}>{label}</div>
              <div style={{ fontSize: 13, fontWeight: 700, color }}>{value ? fmt.currency(value) : '—'}</div>
            </div>
          ))}
        </div>
      )}

      {/* Scores row */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
        {signal.risk_reward && approved && (
          <span style={{ background: '#F0F9FF', color: '#0369A1', fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99 }}>
            R:R {signal.risk_reward}
          </span>
        )}
        {signal.risk_score != null && (
          <span style={{
            background: signal.risk_score >= 70 ? '#FEE2E2' : signal.risk_score >= 45 ? '#FEF3C7' : '#F0FDF4',
            color: signal.risk_score >= 70 ? '#DC2626' : signal.risk_score >= 45 ? '#D97706' : '#15803D',
            fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 99,
          }}>
            Risk {signal.risk_score}
          </span>
        )}
        {signal.portfolio_fit != null && (
          <PortfolioFitBadge score={signal.portfolio_fit} />
        )}
        <ManipulationBadge
          score={(signal as any).manipulation_score}
          band={(signal as any).manipulation_band}
          warning={(signal as any).manipulation_warning}
          penalized={(signal as any).manipulation_penalized}
        />

        {signal.market_stance && (
          <span style={{ background: '#F5F3FF', color: '#5B21B6', fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 99 }}>
            {signal.market_stance.replace('_', ' ')}
          </span>
        )}
      </div>

      {/* Expandable reasons */}
      {approved && signal.reasons?.length > 0 && (
        <button
          onClick={() => setExpanded(e => !e)}
          style={{ width: '100%', border: 'none', background: 'none', cursor: 'pointer', color: '#64748B', fontSize: 12, padding: '6px 0', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? 'Hide' : 'Show'} reasoning ({signal.reasons.length} factors)
        </button>
      )}

      {expanded && approved && (
        <div style={{ borderTop: '1px solid #F1F5F9', paddingTop: 10, marginTop: 4 }}>
          {signal.reasons.slice(0, 5).map((r: any, i: number) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
              <div style={{
                width: 7, height: 7, borderRadius: '50%',
                background: r.contribution > 0 ? '#16A34A' : r.contribution < 0 ? '#DC2626' : '#94A3B8',
                flexShrink: 0, marginTop: 5,
              }} />
              <span style={{ fontSize: 12, color: '#475569', flex: 1 }}>{r.text ?? r.description}</span>
            </div>
          ))}
        </div>
      )}

      <DisclaimerBanner variant="signal" />
    </div>
  );
}
