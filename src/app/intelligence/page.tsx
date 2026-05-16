'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useEventStream } from '@/hooks/useEventStream';
import AppShell from '@/components/layout/AppShell';
import { Card, Loading } from '@/components/ui';
import { fmt } from '@/lib/utils';
import {
  Brain, RefreshCw, ArrowUpRight, ArrowDownRight, Minus,
  Shield, Zap, Target, TrendingUp, TrendingDown,
  ChevronDown, ChevronRight, AlertTriangle, Info,
} from 'lucide-react';
import ConvictionGrid from '@/components/intelligence/ConvictionGrid';

// ── Types ─────────────────────────────────────────────────────────
interface SignalReason {
  type:          string;
  message:       string;
  factor_key?:   string;
  contribution?: number;
}

interface SignalRow {
  id:                number;
  tradingsymbol:     string;
  exchange:          string;
  direction:         string;
  timeframe:         string;
  signal_type:       string;
  signal_subtype:    string;
  strategy_group:    string;
  strategy_display:  string;
  confidence_score:  number;
  conviction_band:   string;
  strength_tag:      string;
  market_context_tag:string;
  risk_score:        number;
  risk:              string;
  opportunity_score: number;
  entry_price:       number;
  stop_loss:         number;
  target1:           number;
  target2:           number | null;
  risk_reward:       number;
  regime:            string;
  market_stance:     string;
  scenario_tag:      string;
  factor_scores:     Record<string, number> | null;
  ltp:               number | null;
  pct_change:        number | null;
  status:            string;
  approved:          boolean;
  reasons:           SignalReason[];
  warnings:          string[];
  generated_at:      string;
}

interface IntelligenceData {
  buySignals:    Record<string, SignalRow[]>;
  sellSignals:   Record<string, SignalRow[]>;
  by_direction:  Record<string, SignalRow[]>;
  by_strategy:   Record<string, SignalRow[]>;
  by_conviction: Record<string, SignalRow[]>;
  summary:       {
    total: number; buy: number; sell: number; hold: number;
    avg_confidence: number; avg_rr: number;
    buy_avg_confidence: number; sell_avg_confidence: number;
    conviction_distribution: Record<string, number>;
  };
  regime:        string;
  scenario:      { tag: string; confidence: number; stance_hint: string; direction_bias: string; volatility_mode: string; breadth_state: string } | null;
  market_stance: { stance: string; confidence: number; guidance: string; rationale: string; config: any } | null;
  stats:         { overview: any; by_conviction: any[]; by_scenario: any[] } | null;
}

// ── Strategy display names ────────────────────────────────────────
const STRATEGY_LABELS: Record<string, string> = {
  bullish_trend:         'Bullish Trend',
  bearish_trend:         'Bearish Trend',
  bullish_breakout:      'Bullish Breakout',
  bearish_breakdown:     'Bearish Breakdown',
  bullish_pullback:      'Bullish Pullback',
  bearish_pullback:      'Bearish Pullback',
  mean_reversion_bounce: 'Mean Reversion Bounce',
  mean_reversion_fade:   'Mean Reversion Fade',
  bullish_momentum:      'Bullish Momentum',
  bearish_momentum:      'Bearish Momentum',
  relative_strength:     'Relative Strength',
  relative_weakness:     'Relative Weakness',
  volatility_breakout:   'Volatility Breakout',
  volatility_breakdown:  'Volatility Breakdown',
  event_driven_long:     'Event Driven Long',
  event_driven_short:    'Event Driven Short',
  sector_rotation:       'Sector Rotation',
  watchlist_long:        'Watchlist Long',
  watchlist_short:       'Watchlist Short',
  unclassified:          'Unclassified',
};

// ── UI helpers ────────────────────────────────────────────────────
function DirectionBadge({ dir }: { dir: string }) {
  const isBuy = dir === 'BUY';
  const isSell = dir === 'SELL';
  const bg    = isBuy ? '#DCFCE7' : isSell ? '#FEE2E2' : '#F1F5F9';
  const color = isBuy ? '#15803D' : isSell ? '#DC2626' : '#64748B';
  const Icon  = isBuy ? ArrowUpRight : isSell ? ArrowDownRight : Minus;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
      background: bg, color, fontWeight: 800, fontSize: 11,
      padding: '2px 8px', borderRadius: 99 }}>
      <Icon size={11} /> {dir}
    </span>
  );
}

function ConvictionPips({ band }: { band: string | null | undefined }) {
  const map: Record<string, { pips: number; color: string; bg: string; label: string }> = {
    high_conviction: { pips: 4, color: '#065F46', bg: '#D1FAE5', label: 'High Conviction' },
    actionable:      { pips: 3, color: '#1D4ED8', bg: '#DBEAFE', label: 'Actionable' },
    watchlist:       { pips: 2, color: '#92400E', bg: '#FEF3C7', label: 'Watchlist' },
    reject:          { pips: 1, color: '#DC2626', bg: '#FEE2E2', label: 'Ignore' },
  };
  const cfg = band ? map[band] : null;
  if (!cfg) return <span style={{ color: '#CBD5E1', fontSize: 10 }}>--</span>;
  return (
    <span style={{ background: cfg.bg, color: cfg.color, fontSize: 9, fontWeight: 700,
      padding: '2px 7px', borderRadius: 99, display: 'inline-flex', alignItems: 'center', gap: 3, whiteSpace: 'nowrap' }}>
      {'●'.repeat(cfg.pips)}{'○'.repeat(4 - cfg.pips)} {cfg.label}
    </span>
  );
}

function StrengthBadge({ tag }: { tag: string }) {
  const map: Record<string, { color: string; bg: string }> = {
    'High Conviction': { color: '#065F46', bg: '#D1FAE5' },
    'Actionable':      { color: '#1D4ED8', bg: '#DBEAFE' },
    'Watchlist':       { color: '#92400E', bg: '#FEF3C7' },
    'Ignore':          { color: '#DC2626', bg: '#FEE2E2' },
  };
  const s = map[tag] ?? { color: '#64748B', bg: '#F1F5F9' };
  return (
    <span style={{ background: s.bg, color: s.color, fontSize: 9, fontWeight: 700,
      padding: '2px 7px', borderRadius: 99 }}>
      {tag}
    </span>
  );
}

function ConfBar({ val }: { val: number | null | undefined }) {
  if (val == null) return <span style={{ color: '#CBD5E1', fontSize: 10 }}>--</span>;
  const c = val >= 85 ? '#065F46' : val >= 70 ? '#1D4ED8' : val >= 55 ? '#D97706' : '#DC2626';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div style={{ width: 44, height: 4, background: '#E2E8F0', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${val}%`, background: c, borderRadius: 99 }} />
      </div>
      <span style={{ fontSize: 10, fontWeight: 700, color: c }}>{val}%</span>
    </div>
  );
}

function ContextBadge({ tag }: { tag: string }) {
  const map: Record<string, { color: string; bg: string }> = {
    Bullish: { color: '#15803D', bg: '#F0FDF4' },
    Neutral: { color: '#1D4ED8', bg: '#EFF6FF' },
    Weak:    { color: '#DC2626', bg: '#FEF2F2' },
  };
  const s = map[tag] ?? map.Neutral;
  return (
    <span style={{ background: s.bg, color: s.color, fontSize: 9, fontWeight: 700,
      padding: '1px 6px', borderRadius: 99 }}>
      {tag}
    </span>
  );
}

// ── Expandable signal row ─────────────────────────────────────────
function SignalRowExpand({ s, isBuy }: { s: SignalRow; isBuy: boolean }) {
  const [open, setOpen] = useState(false);
  const reasons   = s.reasons?.filter(r => r.type === 'reason') ?? [];
  const rejections = s.reasons?.filter(r => r.type === 'rejection') ?? [];
  const warnings  = s.warnings ?? [];
  const hasDetails = reasons.length > 0 || warnings.length > 0 || rejections.length > 0;

  return (
    <>
      <tr
        style={{ borderTop: '1px solid #F1F5F9', cursor: hasDetails ? 'pointer' : 'default',
          background: isBuy ? '#FAFFFE' : '#FFFAFA' }}
        onClick={() => hasDetails && setOpen(!open)}
      >
        <td style={{ padding: '7px 10px', width: 20 }}>
          {hasDetails && (open
            ? <ChevronDown size={12} color="#94A3B8" />
            : <ChevronRight size={12} color="#94A3B8" />
          )}
        </td>
        <td style={{ padding: '7px 10px' }}>
          <div style={{ fontWeight: 700, fontSize: 12, color: '#0F172A' }}>{s.tradingsymbol}</div>
          <div style={{ fontSize: 9, color: '#94A3B8' }}>{s.exchange} · {s.timeframe}</div>
        </td>
        <td style={{ padding: '7px 10px' }}>
          <StrengthBadge tag={s.strength_tag} />
        </td>
        <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 600, fontSize: 12 }}>
          {s.entry_price ? fmt.currency(s.entry_price) : '--'}
        </td>
        <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 600, fontSize: 12,
          color: isBuy ? '#15803D' : '#DC2626' }}>
          {isBuy ? (s.target1 ? fmt.currency(s.target1) : '--') : (s.stop_loss ? fmt.currency(s.stop_loss) : '--')}
        </td>
        <td style={{ padding: '7px 10px', textAlign: 'right', fontWeight: 600, fontSize: 12 }}>
          {s.risk_reward ? `1:${s.risk_reward}` : '--'}
        </td>
        <td style={{ padding: '7px 10px', textAlign: 'right' }}>
          <ConfBar val={s.confidence_score} />
        </td>
        <td style={{ padding: '7px 10px', textAlign: 'right' }}>
          <ConvictionPips band={s.conviction_band} />
        </td>
      </tr>
      {open && hasDetails && (
        <tr style={{ background: isBuy ? '#F0FDF4' : '#FEF2F2' }}>
          <td colSpan={8} style={{ padding: '8px 16px 10px 36px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 11 }}>
              {/* Reasons */}
              {reasons.length > 0 && (
                <div>
                  <div style={{ fontWeight: 700, color: '#0F172A', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <Info size={11} color="#1D4ED8" /> Why this signal
                  </div>
                  {reasons.map((r, i) => (
                    <div key={i} style={{ display: 'flex', gap: 5, color: '#334155', marginBottom: 2 }}>
                      <span style={{ color: '#1D4ED8', fontWeight: 700, flexShrink: 0 }}>+</span>
                      <span>{r.message}</span>
                      {r.contribution != null && (
                        <span style={{ color: r.contribution > 0 ? '#15803D' : '#DC2626', fontWeight: 600, flexShrink: 0 }}>
                          {r.contribution > 0 ? '+' : ''}{(r.contribution * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Warnings + Rejections */}
              {(warnings.length > 0 || rejections.length > 0) && (
                <div>
                  {warnings.length > 0 && (
                    <>
                      <div style={{ fontWeight: 700, color: '#D97706', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <AlertTriangle size={11} color="#D97706" /> Warnings
                      </div>
                      {warnings.map((w, i) => (
                        <div key={i} style={{ display: 'flex', gap: 5, color: '#92400E', marginBottom: 2 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0 }}>!</span> {w}
                        </div>
                      ))}
                    </>
                  )}
                  {rejections.length > 0 && (
                    <>
                      <div style={{ fontWeight: 700, color: '#DC2626', marginBottom: 4, marginTop: warnings.length > 0 ? 8 : 0,
                        display: 'flex', alignItems: 'center', gap: 4 }}>
                        <AlertTriangle size={11} color="#DC2626" /> Rejection Flags
                      </div>
                      {rejections.map((r, i) => (
                        <div key={i} style={{ display: 'flex', gap: 5, color: '#991B1B', marginBottom: 2 }}>
                          <span style={{ fontWeight: 700, flexShrink: 0 }}>x</span> {r.message}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Tags row */}
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <ContextBadge tag={s.market_context_tag} />
              <span style={{ fontSize: 9, background: '#EFF6FF', color: '#1D4ED8',
                padding: '1px 6px', borderRadius: 99, fontWeight: 600 }}>
                {s.strategy_display}
              </span>
              <span style={{ fontSize: 9, background: '#F5F3FF', color: '#7C3AED',
                padding: '1px 6px', borderRadius: 99, fontWeight: 600 }}>
                {s.signal_type}
              </span>
              {s.scenario_tag && (
                <span style={{ fontSize: 9, background: '#F1F5F9', color: '#475569',
                  padding: '1px 6px', borderRadius: 99, fontWeight: 600 }}>
                  {s.scenario_tag.replace(/_/g, ' ')}
                </span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Strategy group section ────────────────────────────────────────
function StrategySection({ groupKey, signals, isBuy }: {
  groupKey: string; signals: SignalRow[]; isBuy: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const label   = STRATEGY_LABELS[groupKey] || groupKey.replace(/_/g, ' ');
  const avgConf = signals.length > 0
    ? Math.round(signals.reduce((sum, s) => sum + (s.confidence_score || 0), 0) / signals.length)
    : 0;
  const hcCount = signals.filter(s => s.conviction_band === 'high_conviction').length;

  return (
    <div style={{ marginBottom: 12 }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
          background: isBuy ? '#F0FDF4' : '#FEF2F2', borderRadius: 8, cursor: 'pointer',
          border: `1px solid ${isBuy ? '#BBF7D0' : '#FECACA'}` }}
      >
        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span style={{ fontWeight: 700, fontSize: 13, color: isBuy ? '#15803D' : '#DC2626' }}>
          {label}
        </span>
        <span style={{ fontSize: 11, color: '#64748B', fontWeight: 600 }}>
          {signals.length} signal{signals.length !== 1 ? 's' : ''}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, fontSize: 10, color: '#64748B' }}>
          {hcCount > 0 && (
            <span style={{ color: '#065F46', fontWeight: 700 }}>
              {hcCount} high conviction
            </span>
          )}
          <span>Avg {avgConf}%</span>
        </div>
      </div>

      {expanded && (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 2 }}>
          <thead>
            <tr style={{ background: '#FAFAFA' }}>
              <th style={{ padding: '5px 10px', width: 20 }}></th>
              <th style={{ ...TH, textAlign: 'left' }}>SYMBOL</th>
              <th style={{ ...TH, textAlign: 'left' }}>STRENGTH</th>
              <th style={{ ...TH, textAlign: 'right' }}>ENTRY</th>
              <th style={{ ...TH, textAlign: 'right' }}>{isBuy ? 'TARGET' : 'STOP LOSS'}</th>
              <th style={{ ...TH, textAlign: 'right' }}>R:R</th>
              <th style={{ ...TH, textAlign: 'right' }}>CONF</th>
              <th style={{ ...TH, textAlign: 'right' }}>CONVICTION</th>
            </tr>
          </thead>
          <tbody>
            {signals.map(s => (
              <SignalRowExpand key={s.id ?? s.tradingsymbol} s={s} isBuy={isBuy} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const TH: React.CSSProperties = {
  padding: '5px 10px', fontSize: 9, color: '#94A3B8', fontWeight: 700, whiteSpace: 'nowrap',
};

// ════════════════════════════════════════════════════════════════
export default function IntelligencePage() {
  const [data,    setData]    = useState<IntelligenceData | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastAt,  setLastAt]  = useState<string | null>(null);
  const [pipelineRunning, setPipelineRunning] = useState(false);

  const loadingRef = useRef(false);
  // Fingerprint of the last applied payload — id + direction + final_score
  // per row across both BUY and SELL groups. At 1s poll cadence, ~99% of
  // responses carry identical data; the fingerprint short-circuits setData
  // on those frames so React doesn't reconcile the strategy groups for no
  // reason. Kept in a ref so updating it never triggers a render.
  const lastFingerprintRef = useRef<string>('');

  const load = useCallback(async (spinner = true) => {
    if (loadingRef.current && !spinner) return; // skip silent poll if one is already in flight
    if (spinner) setLoading(true);
    loadingRef.current = true;
    try {
      const res = await fetch('/api/intelligence', { cache: 'no-store' });
      const json = await res.json();

      // No-op frame fast-path. Build a compact fingerprint from the
      // visible signal pool — by_direction is the densest representation
      // and covers everything the page actually renders.
      let fp = '';
      const byDir = json?.by_direction ?? {};
      for (const dir of Object.keys(byDir)) {
        const arr = byDir[dir];
        if (!Array.isArray(arr)) continue;
        for (const r of arr) {
          fp += `${r.id}:${r.direction ?? ''}:${r.final_score ?? ''}|`;
        }
      }
      // Include summary counts so a same-rows-but-changed-stance frame
      // still goes through (rare, but possible if the rescore cron flips
      // a band without changing direction or score).
      const sm = json?.summary ?? {};
      fp += `#${sm.total ?? 0}/${sm.buy ?? 0}/${sm.sell ?? 0}`;

      if (fp !== lastFingerprintRef.current || spinner) {
        lastFingerprintRef.current = fp;
        setData(json);
        setLastAt(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }));
      }
    } finally {
      loadingRef.current = false;
      if (spinner) setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => { load(); }, [load]);

  // 1-second auto-refresh (silent, no spinner). Matches the /signals
  // dashboard cadence so both pages feel equally live. The /api/intelligence
  // route has its own SWR cache (1s fresh) so this does NOT translate
  // into 1 DB query/sec — most polls hit the in-memory cache and return
  // in microseconds. Skipped when the tab is in the background.
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) load(false);
    }, 1_000);
    return () => clearInterval(id);
  }, [load]);

  // Refresh immediately when the signal pipeline completes
  const { lastEvent } = useEventStream();
  useEffect(() => {
    if (
      lastEvent?.type === 'signal:new' ||
      lastEvent?.type === 'pipeline:status'
    ) {
      load(false);
    }
  }, [lastEvent, load]);

  const runPipeline = async () => {
    setPipelineRunning(true);
    try {
      await fetch('/api/run-signal-engine', { method: 'POST' });
      await load(false);
    } finally { setPipelineRunning(false); }
  };

  // Derived
  const stanceKey   = data?.market_stance?.stance ?? 'selective';
  const stanceMap: Record<string, { color: string; bg: string; label: string }> = {
    aggressive:           { color: '#15803D', bg: '#DCFCE7', label: 'Aggressive' },
    selective:            { color: '#1D4ED8', bg: '#DBEAFE', label: 'Selective' },
    defensive:            { color: '#D97706', bg: '#FEF3C7', label: 'Defensive' },
    capital_preservation: { color: '#DC2626', bg: '#FEE2E2', label: 'Capital Preservation' },
  };
  const stanceStyle = stanceMap[stanceKey] ?? stanceMap.selective;

  const summary    = data?.summary ?? {
    total: 0, buy: 0, sell: 0, hold: 0, avg_confidence: 0, avg_rr: 0,
    buy_avg_confidence: 0, sell_avg_confidence: 0,
    conviction_distribution: { high_conviction: 0, actionable: 0, watchlist: 0, reject: 0 },
  };

  const buyGroups  = data?.buySignals  ?? {};
  const sellGroups = data?.sellSignals ?? {};
  const convDist   = summary.conviction_distribution ?? {};
  const totalForDist = Math.max(summary.total, 1);

  return (
    <AppShell title="Intelligence Hub">
      <div className="page">
        {/* ── Header ── */}
        <div className="page__header" style={{ marginBottom: 20 }}>
          <div>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Brain size={22} style={{ color: '#2E75B6' }} /> Intelligence Hub
            </h1>
            <p style={{ color: '#64748B', fontSize: 13, marginTop: 4 }}>
              Strategy-grouped signals with conviction bands, reasons, and warnings
              {lastAt && <span style={{ marginLeft: 8, color: '#94A3B8' }}>Updated {lastAt}</span>}
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn--secondary btn--sm" onClick={() => load(true)} disabled={loading}>
              <RefreshCw size={13} /> Refresh
            </button>
            <button className="btn btn--primary btn--sm" onClick={runPipeline} disabled={pipelineRunning}>
              <Zap size={13} /> {pipelineRunning ? 'Running...' : 'Run Pipeline'}
            </button>
          </div>
        </div>

        {loading ? <Loading text="Loading intelligence..." /> : (
          <div style={{ display: 'grid', gap: 16 }}>

            {/* ── Row 1: Market Stance + Counts ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12 }}>
              {/* Market Stance */}
              <div style={{ background: stanceStyle.bg,
                border: `1.5px solid ${stanceStyle.color}30`, borderRadius: 10, padding: '14px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <Shield size={16} color={stanceStyle.color} />
                  <span style={{ fontWeight: 700, fontSize: 14, color: stanceStyle.color }}>
                    Market Stance: {stanceStyle.label}
                  </span>
                  {data?.market_stance && (
                    <span style={{ fontSize: 11, color: stanceStyle.color, background: 'white',
                      padding: '1px 8px', borderRadius: 99, fontWeight: 600, marginLeft: 'auto' }}>
                      {data.market_stance.confidence}% confidence
                    </span>
                  )}
                </div>
                {data?.market_stance?.guidance && (
                  <p style={{ fontSize: 12, color: '#475569', margin: 0, lineHeight: 1.5 }}>
                    {data.market_stance.guidance}
                  </p>
                )}
                <div style={{ display: 'flex', gap: 12, marginTop: 8, flexWrap: 'wrap' }}>
                  {data?.scenario && (
                    <span style={{ fontSize: 10, background: 'white', color: '#1D4ED8',
                      padding: '2px 8px', borderRadius: 99, fontWeight: 600 }}>
                      {data.scenario.tag.replace(/_/g, ' ')}
                    </span>
                  )}
                  <span style={{ fontSize: 10, color: '#64748B' }}>
                    Regime: <strong>{data?.regime ?? 'NEUTRAL'}</strong>
                  </span>
                  {data?.scenario?.direction_bias && (
                    <span style={{ fontSize: 10, color: '#64748B' }}>
                      Bias: <strong style={{ color: data.scenario.direction_bias === 'bullish' ? '#15803D' : data.scenario.direction_bias === 'bearish' ? '#DC2626' : '#64748B' }}>
                        {data.scenario.direction_bias}
                      </strong>
                    </span>
                  )}
                </div>
              </div>

              {/* BUY count */}
              <div style={{ background: '#F0FDF4', border: '1.5px solid #BBF7D0',
                borderRadius: 10, padding: '14px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <ArrowUpRight size={16} color="#15803D" />
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#15803D', textTransform: 'uppercase' }}>BUY Signals</span>
                </div>
                <div style={{ fontSize: 28, fontWeight: 800, color: '#15803D', lineHeight: 1 }}>{summary.buy}</div>
                <div style={{ fontSize: 10, color: '#16A34A', marginTop: 4 }}>
                  {summary.buy > 0 ? `Avg conf: ${summary.buy_avg_confidence}%` : 'No active buy signals'}
                </div>
                <div style={{ fontSize: 10, color: '#94A3B8', marginTop: 2 }}>
                  {Object.keys(buyGroups).length} strategies
                </div>
              </div>

              {/* SELL count */}
              <div style={{ background: '#FEF2F2', border: '1.5px solid #FECACA',
                borderRadius: 10, padding: '14px 18px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <ArrowDownRight size={16} color="#DC2626" />
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#DC2626', textTransform: 'uppercase' }}>SELL Signals</span>
                </div>
                <div style={{ fontSize: 28, fontWeight: 800, color: '#DC2626', lineHeight: 1 }}>{summary.sell}</div>
                <div style={{ fontSize: 10, color: '#DC2626', marginTop: 4 }}>
                  {summary.sell > 0 ? `Avg conf: ${summary.sell_avg_confidence}%` : 'No active sell signals'}
                </div>
                <div style={{ fontSize: 10, color: '#94A3B8', marginTop: 2 }}>
                  {Object.keys(sellGroups).length} strategies
                </div>
              </div>
            </div>

            {/* ── Row 2: Conviction Distribution + Stats ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 10 }}>
              {[
                { label: 'Total', val: summary.total, color: '#1D4ED8', bg: '#EFF6FF' },
                { label: 'Avg Confidence', val: `${summary.avg_confidence}%`, color: '#065F46', bg: '#F0FDF4' },
                { label: 'Avg R:R', val: `1:${summary.avg_rr}`, color: '#D97706', bg: '#FFFBEB' },
                { label: 'Regime', val: data?.regime ?? 'NEUTRAL', color: '#7C3AED', bg: '#F5F3FF' },
                { label: 'Direction Bias', val: data?.scenario?.direction_bias ?? 'neutral', color: '#0369A1', bg: '#F0F9FF' },
              ].map(({ label, val, color, bg }) => (
                <div key={label} style={{ background: bg, border: `1px solid ${color}15`,
                  borderRadius: 8, padding: '10px 14px', textAlign: 'center' }}>
                  <div style={{ fontSize: 9, color: '#64748B', fontWeight: 700, marginBottom: 4, textTransform: 'uppercase' }}>{label}</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color, textTransform: 'capitalize' }}>{val}</div>
                </div>
              ))}
            </div>

            {/* ── Row 3: Conviction Distribution Grid (Slider) ── */}
            <div>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                marginBottom: 12, paddingBottom: 10,
                borderBottom: '2px solid #CFFAFE',
              }}>
                <Target size={14} style={{ color: '#06B6D4', flexShrink: 0 }} />
                <span style={{
                  fontSize: 15, fontWeight: 700,
                  background: 'linear-gradient(135deg, #2563EB, #06B6D4)',
                  WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
                }}>
                  Conviction Distribution
                </span>
              </div>
              <ConvictionGrid
                convictionDistribution={convDist}
                signals={[
                  ...Object.values(buyGroups).flat(),
                  ...Object.values(sellGroups).flat(),
                ]}
                total={summary.total}
                loading={loading}
              />
            </div>

            {/* ── Row 4: BUY & SELL Strategy-Grouped Signals (2 columns) ── */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, alignItems: 'start' }}>
              {/* LEFT — BUY Signals */}
              <Card flush>
                <div style={{ padding: '12px 16px', borderBottom: '1.5px solid #BBF7D0',
                  background: '#F0FDF4', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <TrendingUp size={16} color="#15803D" />
                  <span style={{ fontWeight: 800, fontSize: 15, color: '#15803D' }}>BUY Signals</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#15803D', fontWeight: 600 }}>
                    {summary.buy} active
                  </span>
                </div>
                <div style={{ padding: 12 }}>
                  {Object.keys(buyGroups).length === 0 ? (
                    <div style={{ padding: '24px 0', color: '#94A3B8', fontSize: 13, textAlign: 'center' }}>
                      No BUY signals -- run pipeline to generate
                    </div>
                  ) : (
                    Object.entries(buyGroups).map(([group, signals]) => (
                      <StrategySection key={group} groupKey={group} signals={signals} isBuy />
                    ))
                  )}
                </div>
              </Card>

              {/* RIGHT — SELL Signals */}
              <Card flush>
                <div style={{ padding: '12px 16px', borderBottom: '1.5px solid #FECACA',
                  background: '#FEF2F2', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <TrendingDown size={16} color="#DC2626" />
                  <span style={{ fontWeight: 800, fontSize: 15, color: '#DC2626' }}>SELL Signals</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#DC2626', fontWeight: 600 }}>
                    {summary.sell} active
                  </span>
                </div>
                <div style={{ padding: 12 }}>
                  {Object.keys(sellGroups).length === 0 ? (
                    <div style={{ padding: '24px 0', color: '#94A3B8', fontSize: 13, textAlign: 'center' }}>
                      No SELL signals -- run pipeline to generate
                    </div>
                  ) : (
                    Object.entries(sellGroups).map(([group, signals]) => (
                      <StrategySection key={group} groupKey={group} signals={signals} isBuy={false} />
                    ))
                  )}
                </div>
              </Card>
            </div>

            {/* ── Row 5: Strategy Overview Grid ── */}
            {data?.by_strategy && Object.keys(data.by_strategy).length > 0 && (
              <Card flush>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #E2E8F0',
                  display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Target size={15} color="#2E75B6" />
                  <span style={{ fontWeight: 700, fontSize: 14 }}>Strategy Overview</span>
                  <span style={{ marginLeft: 'auto', fontSize: 11, color: '#94A3B8' }}>
                    {Object.keys(data.by_strategy).length} strategy groups
                  </span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10, padding: 14 }}>
                  {Object.entries(data.by_strategy).map(([stratKey, signals]) => {
                    const label = STRATEGY_LABELS[stratKey] || stratKey.replace(/_/g, ' ');
                    const avgConf = signals.length > 0
                      ? Math.round(signals.reduce((s, x) => s + (x.confidence_score || 0), 0) / signals.length)
                      : 0;
                    const buys = signals.filter(s => s.direction === 'BUY').length;
                    const sells = signals.filter(s => s.direction === 'SELL').length;
                    const hc   = signals.filter(s => s.conviction_band === 'high_conviction').length;
                    const isBullish = buys > sells;
                    return (
                      <div key={stratKey} style={{
                        background: isBullish ? '#FAFFFE' : '#FFFAFA',
                        borderRadius: 8, padding: '10px 14px',
                        border: `1px solid ${isBullish ? '#D1FAE5' : '#FECACA'}`,
                      }}>
                        <div style={{ fontWeight: 700, fontSize: 12, color: '#0F172A', marginBottom: 6 }}>
                          {label}
                        </div>
                        <div style={{ display: 'flex', gap: 8, fontSize: 10, color: '#64748B', flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 700 }}>{signals.length} signals</span>
                          {buys > 0 && <span style={{ color: '#15803D', fontWeight: 700 }}>{buys} BUY</span>}
                          {sells > 0 && <span style={{ color: '#DC2626', fontWeight: 700 }}>{sells} SELL</span>}
                        </div>
                        <div style={{ display: 'flex', gap: 10, marginTop: 4, fontSize: 10, color: '#94A3B8' }}>
                          <span>Avg {avgConf}%</span>
                          {hc > 0 && <span style={{ color: '#065F46', fontWeight: 600 }}>{hc} HC</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {/* ── Empty state ── */}
            {summary.total === 0 && (
              <div style={{ textAlign: 'center', padding: '40px 0', color: '#94A3B8' }}>
                <Brain size={36} style={{ marginBottom: 14, opacity: 0.4 }} />
                <div style={{ fontSize: 15, fontWeight: 700, color: '#475569' }}>No signals in database</div>
                <div style={{ fontSize: 12, marginTop: 4, marginBottom: 14 }}>
                  Click "Run Pipeline" to generate BUY and SELL signals through the centralized engine
                </div>
                <button className="btn btn--primary btn--sm" onClick={runPipeline} disabled={pipelineRunning}>
                  <Zap size={13} /> Generate Signals
                </button>
              </div>
            )}

          </div>
        )}
      </div>
    </AppShell>
  );
}
