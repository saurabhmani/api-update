'use client';
import { useEffect, useState, useRef, Fragment } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading } from '@/components/ui';
import { fmt, changeClass } from '@/lib/utils';
import {
  Zap, Search, TrendingUp, TrendingDown, Activity, Target,
  ChevronRight, RefreshCw, ArrowUpRight, ArrowDownRight, Minus,
  Shield, AlertTriangle, FileText, FlaskConical,
} from 'lucide-react';
import Link from 'next/link';
// useLivePrices + useSignalStream are now consumed inside
// useSignalsPolling. The page no longer imports them directly.
import {
  useSignalsPolling,
  type SignalRow,
  type DashboardTab,
  type MarketStatus,
  type DataFreshness,
  type SignalCounters,
  type RejectedDisplayRow,
  type SignalFunnelSummary,
  // PHASE_2_DUE_DILIGENCE_2026-05
  type DueDiligenceReview,
  type PerformanceReview,
  type DueDiligenceSummary,
  // PHASE_3_DAILY_INTELLIGENCE_2026-05
  type DailyReportPreview,
  // PHASE_5_HEALTH_OBSERVABILITY_2026-05
  type EngineHealthPreview,
} from './useSignalsPolling';
import {
  ClassificationBadge,
  FinalScorePill,
  RiskScorePill,
  PortfolioFitPill,
  StressSurvivalPill,
  RiskRewardCell,
  ExplanationSummary,
} from '@/components/signals/Phase12SignalRow';
// EmergingOpportunitiesSection import removed (UI-SIMPLIFY §1 — single-table dashboard).
// SignalExplanation only referenced by the moved SignalRow interface;
// no longer imported here.

// SignalRow type now lives in ./useSignalsPolling and is re-imported
// at the top of this file. The duplicate interface that lived here
// has been retired.

// ── UI helpers ────────────────────────────────────────────────────
const DIR_STYLE: Record<string, { bg: string; color: string }> = {
  BUY:  { bg: '#F0FDF4', color: '#16A34A' },
  SELL: { bg: '#FEF2F2', color: '#DC2626' },
  HOLD: { bg: '#FFFBEB', color: '#D97706' },
};

// ── Live-cell animation ───────────────────────────────────────────
// Kite-style tick flash: on every price CHANGE we paint a translucent // @deprecated marker
// green (up) or red (down) background for ~400ms, then fade back to
// default. Pure presentation — no effect on the underlying price
// stream. Fresh/stale dot is computed from the WS frame age: green
// for ≤3s (actively ticking), amber 3–30s (quiet/illiquid), red
// >30s (likely stale or fallback). Source badge (K/Y) is unchanged.
function LiveCell({
  price, pChange, source, tickTs, ltp, direction,
}: {
  price:     number | null;
  pChange:   number | null;
  source:    string | null;
  tickTs:    number | null;
  ltp:       number | null;
  direction: string | null;
}) {
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const prevPriceRef = useRef<number | null>(null);
  useEffect(() => {
    if (price == null) return;
    const prev = prevPriceRef.current;
    if (prev != null && prev !== price) {
      setFlash(price > prev ? 'up' : 'down');
      // 850ms duration was 400ms — too short to register at a glance.
      // Yahoo's 15-min-delayed tape means real ticks are infrequent, // @deprecated marker
      // so each one needs to be unmissable.
      const id = setTimeout(() => setFlash(null), 850);
      prevPriceRef.current = price;
      return () => clearTimeout(id);
    }
    prevPriceRef.current = price;
  }, [price]);

  if (price == null || price <= 0) {
    return <div style={{ color: '#CBD5E1', fontSize: 11 }}>—</div>;
  }

  // Higher opacity (0.32 / was 0.18) so the up/down flash reads at
  // a glance against the white table row. Easing curve also widened
  // (transition: 850ms — matches the timeout) so the fade-out is
  // visible, not abrupt.
  const bg =
    flash === 'up'   ? 'rgba(22,163,74,0.32)' :
    flash === 'down' ? 'rgba(220,38,38,0.32)' :
    'transparent';

  const ageMs = tickTs ? Date.now() - tickTs : null;
  const dotColor =
    ageMs == null                ? '#CBD5E1' :
    ageMs <=  3_000              ? '#16A34A' :
    ageMs <= 30_000              ? '#D97706' :
                                   '#DC2626';
  const dotTitle =
    ageMs == null
      ? 'no tick yet'
      : `last tick ${(ageMs / 1000).toFixed(1)}s ago`;

  // K = green = Kite WebSocket (sub-second). // @deprecated marker
  // R = blue  = Kite REST quote (one-shot, ~1s). // @deprecated marker
  const sourceMap: Record<string, [string, string, string, string]> = {
    kite:      ['#10B981', '#fff', 'K', 'Kite • Live'], // @deprecated marker
    kite_ws:   ['#10B981', '#fff', 'K', 'Kite WebSocket • Live'], // @deprecated marker
    kite_rest: ['#3B82F6', '#fff', 'R', 'Kite REST • Quote'], // @deprecated marker
  };
  const srcCfg = source ? sourceMap[source] : null;

  // Side-aware unrealised P/L vs the frozen entry (`ltp`).
  let pnlPct: number | null = null;
  if (ltp != null && ltp > 0) {
    const diff = direction === 'SELL' ? ltp - price : price - ltp;
    pnlPct = (diff / ltp) * 100;
  }

  return (
    <div style={{
      background: bg,
      // Match the 850ms flash window so the colour fully fades before
      // it disappears, instead of snapping to transparent halfway.
      transition: 'background-color 850ms ease-out',
      borderRadius: 4,
      padding: '2px 4px',
      margin: '-2px -4px',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4, color: '#0F172A' }}>
        <span title={dotTitle} style={{
          display: 'inline-block', width: 6, height: 6, borderRadius: 99,
          background: dotColor,
        }} />
        {fmt.currency(price)}
      </div>
      {pChange != null && (
        <div style={{
          fontSize: 10, fontWeight: 600,
          color: pChange >= 0 ? '#16A34A' : '#DC2626',
        }}>
          {pChange >= 0 ? '+' : ''}{pChange.toFixed(2)}%
        </div>
      )}
      {srcCfg && (
        <span title={srcCfg[3]} style={{
          display: 'inline-block', marginTop: 2,
          fontSize: 8, fontWeight: 800,
          background: srcCfg[0], color: srcCfg[1],
          padding: '1px 4px', borderRadius: 3,
        }}>{srcCfg[2]}</span>
      )}
      {pnlPct != null && (
        <div style={{
          fontSize: 9, fontWeight: 600,
          color: pnlPct >= 0 ? '#16A34A' : '#DC2626',
        }}>
          {pnlPct >= 0 ? '+' : ''}{pnlPct.toFixed(2)}%
        </div>
      )}
    </div>
  );
}

function SignalChip({ dir, isExtra }: { dir: string | null; isExtra?: boolean }) {
  // Pure UI translation — the data layer is responsible for sending
  // direction=null + isExtra=true; this component decides what that
  // means visually. Never read placeholder strings like '—' here.
  if (isExtra || (dir !== 'BUY' && dir !== 'SELL' && dir !== 'HOLD')) {
    return (
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 10, fontWeight: 700,
        background: '#F1F5F9', color: '#94A3B8',
        padding: '3px 9px', borderRadius: 20,
        letterSpacing: 0.3,
      }}>
        <Minus size={11} /> NO SIGNAL
      </span>
    );
  }
  const s = DIR_STYLE[dir] ?? DIR_STYLE.HOLD;
  const Icon = dir === 'BUY' ? ArrowUpRight : dir === 'SELL' ? ArrowDownRight : Minus;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, fontWeight: 800, background: s.bg, color: s.color,
      padding: '3px 10px', borderRadius: 20 }}>
      <Icon size={12} /> {dir}
    </span>
  );
}

function ConfBar({ value }: { value: number }) {
  if (!value || value <= 0) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  const col = value >= 75 ? '#065F46' : value >= 65 ? '#1D4ED8' : value >= 55 ? '#D97706' : '#DC2626';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
      <div style={{ width: 50, height: 5, background: '#E2E8F0', borderRadius: 99, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${value}%`, background: col, borderRadius: 99 }} />
      </div>
      <span style={{ fontSize: 11, fontWeight: 600, color: col }}>{value}%</span>
    </div>
  );
}

function ConvictionBadge({ band }: { band: string | null }) {
  // Spec INSTITUTIONAL §UX-SIMPLIFY — only institutional-grade
  // conviction tiers surface in the APPROVED tab. The legacy
  // 'watchlist' band is retired (it was never tradable, and any row
  // that lands here at all is now institutional by construction).
  if (!band || band === 'reject' || band === 'watchlist') return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  const map: Record<string, [string, string, string]> = {
    high_conviction: ['#D1FAE5', '#065F46', '●●●●'],
    actionable:      ['#DBEAFE', '#1D4ED8', '●●●○'],
  };
  const cfg = map[band];
  if (!cfg) return null;
  return <span style={{ background: cfg[0], color: cfg[1], fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 99 }}>{cfg[2]} {band.replace(/_/g, ' ')}</span>;
}

function ScenarioTag({ tag }: { tag: string | null }) {
  if (!tag) return null;
  return (
    <span style={{ fontSize: 10, background: '#EFF6FF', color: '#1D4ED8',
      padding: '1px 7px', borderRadius: 99, fontWeight: 600 }}>
      {tag.replace(/_/g, ' ')}
    </span>
  );
}

// ── Deep search result ────────────────────────────────────────────
function SearchResult({ data, symbol }: { data: any; symbol: string }) {
  if (!data) return null;
  const approved = data.approved ?? false;
  const sig = data.signal;

  return (
    <div style={{ marginTop: 16, padding: 16, background: '#F8FAFC', borderRadius: 10, border: '1px solid #E2E8F0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: '#1E3A5F' }}>{symbol}</span>
        {sig && <SignalChip dir={sig.direction} />}
        {sig?.risk && (
          <Badge variant={sig.risk === 'High' || sig.risk === 'Very High' ? 'red' : sig.risk === 'Low' ? 'green' : 'orange'}>
            {sig.risk} Risk
          </Badge>
        )}
        {approved
          ? <span style={{ marginLeft: 'auto', fontSize: 12, color: '#16A34A', fontWeight: 700 }}>✓ Signal Approved</span>
          : <span style={{ marginLeft: 'auto', fontSize: 12, color: '#DC2626', fontWeight: 700 }}>✗ Rejected</span>
        }
      </div>

      {approved && sig && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 12 }}>
            {[['Entry', sig.entry_price], ['Stop Loss', sig.stop_loss], ['Target', sig.target1], ['R:R', `1:${sig.risk_reward}`]].map(([l, v]) => (
              <div key={String(l)} style={{ background: '#fff', borderRadius: 8, padding: '10px 14px', border: '1px solid #E2E8F0', textAlign: 'center' }}>
                <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600, marginBottom: 2 }}>{l}</div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>{typeof v === 'number' ? fmt.currency(v) : v}</div>
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 16, marginBottom: 10, fontSize: 12, color: '#64748B', flexWrap: 'wrap' }}>
            {sig.confidence != null && <span>Confidence: <strong style={{ color: '#0F172A' }}>{sig.confidence}%</strong></span>}
            {sig.scenario_tag && <span>Strategy: <strong>{sig.scenario_tag.replace(/_/g, ' ')}</strong></span>}
            {sig.regime && <span>Regime: <strong>{sig.regime}</strong></span>}
          </div>
        </>
      )}

      {!approved && data.rejection_reasons?.length > 0 && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: '#DC2626', marginBottom: 6 }}>REJECTION REASONS</div>
          {data.rejection_reasons.map((r: string, i: number) => (
            <div key={i} style={{ display: 'flex', gap: 6, fontSize: 12, color: '#334155', marginBottom: 4 }}>
              <span style={{ color: '#DC2626', fontWeight: 700, flexShrink: 0 }}>✗</span> {r}
            </div>
          ))}
        </div>
      )}

      {(sig?.factor_scores || data.factor_scores) && (() => {
        const fs = sig?.factor_scores ?? data.factor_scores;
        return (
          <div style={{ marginTop: 10, borderTop: '1px solid #E2E8F0', paddingTop: 10 }}>
            <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600, marginBottom: 6 }}>FACTOR SCORES</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
              {Object.entries(fs).map(([k, v]) => (
                <div key={k} style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 9, color: '#94A3B8', fontWeight: 600, marginBottom: 2, textTransform: 'uppercase' }}>
                    {k.replace(/_/g, ' ').slice(0, 12)}
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700,
                    color: Number(v) >= 65 ? '#16A34A' : Number(v) >= 45 ? '#D97706' : '#DC2626' }}>
                    {Number(v).toFixed(0)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {data.soft_warnings?.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#D97706' }}>
          ⚠ {data.soft_warnings.join(' · ')}
        </div>
      )}
    </div>
  );
}

// ── FIX FINAL SIGNAL VISIBILITY 2026-05 ──
function DiagnosticHeader({
  marketStatus, dataFreshness, counters, pipelineRunning, lastApiRequestAt,
  isBootstrap, isFallback, reasonSummary
}: {
  marketStatus: MarketStatus | null;
  dataFreshness: DataFreshness | null;
  counters: SignalCounters | null;
  pipelineRunning: boolean;
  lastApiRequestAt: string | null;
  isBootstrap: boolean;
  isFallback: boolean;
  reasonSummary: string | null;
}) {
  const mOpen = marketStatus?.isOpen ?? false;
  const mState = marketStatus?.state ?? 'unknown';
  const fStale = dataFreshness?.isStale ?? false;
  const fAge = dataFreshness?.ageMinutes ?? 0;

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
      gap: 12, marginBottom: 16, background: '#F8FAFC', borderRadius: 12,
      padding: 16, border: '1px solid #E2E8F0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)'
    }}>
      {/* 1. Market & Feed Status */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', letterSpacing: 0.5 }}>ENGINE STATUS</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            width: 8, height: 8, borderRadius: 99,
            background: mOpen ? '#16A34A' : '#DC2626',
            boxShadow: mOpen ? '0 0 8px rgba(22,163,74,0.4)' : 'none'
          }} />
          <span style={{ fontSize: 14, fontWeight: 700, color: '#1E3A5F' }}>
            {marketStatus?.label ?? 'Determining Market Status...'}
          </span>
          {isBootstrap && <Badge variant="orange">BOOTSTRAP</Badge>}
          {isFallback && <Badge variant="red">FALLBACK</Badge>}
        </div>
        <div style={{ fontSize: 11, color: '#64748B', fontWeight: 500 }}>
          {isFallback ? '⚠️ Engine in stale/fallback mode' : '✅ Normal institutional operation'}
        </div>
      </div>

      {/* 2. Data Freshness */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', letterSpacing: 0.5 }}>DATA FRESHNESS</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Activity size={14} color={fStale ? '#DC2626' : '#16A34A'} />
          <span style={{ fontSize: 14, fontWeight: 700, color: fStale ? '#DC2626' : '#1E3A5F' }}>
            {dataFreshness?.label ?? '—'}
          </span>
          {fStale && <Badge variant="red">STALE</Badge>}
        </div>
        <div style={{ fontSize: 11, color: '#64748B', fontWeight: 500 }}>
          Last tick: {fAge}m ago · {mOpen ? 'Intraday Feed' : 'Close Snapshot'}
        </div>
      </div>

      {/* 3. Pipeline Lifecycle */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', letterSpacing: 0.5 }}>PIPELINE HEALTH</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <RefreshCw size={14} className={pipelineRunning ? 'spin' : ''} color={pipelineRunning ? '#3B82F6' : '#64748B'} />
          <span style={{ fontSize: 14, fontWeight: 700, color: '#1E3A5F' }}>
            {pipelineRunning ? 'Scan In-Flight' : 'Idle / Ready'}
          </span>
        </div>
        <div style={{ fontSize: 11, color: '#64748B', fontWeight: 500 }}>
          Last Request: {lastApiRequestAt ? new Date(lastApiRequestAt).toLocaleTimeString() : '—'}
        </div>
      </div>

      {/* 4. Filter Rejection Diagnostic */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: '#94A3B8', letterSpacing: 0.5 }}>REJECTION DIAGNOSTIC</div>
        {reasonSummary ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <AlertTriangle size={14} color="#D97706" />
              <span style={{ fontSize: 13, fontWeight: 700, color: '#92400E' }}>
                {reasonSummary.length > 25 ? reasonSummary.slice(0, 25) + '...' : reasonSummary}
              </span>
            </div>
            <div style={{ fontSize: 10, color: '#94A3B8', fontWeight: 500, lineHeight: 1.2 }}>
              Dominant gate blocking signal graduation
            </div>
          </>
        ) : (
          <div style={{ fontSize: 13, color: '#16A34A', fontWeight: 700 }}>
            No active rejections
          </div>
        )}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// PHASE_2_DUE_DILIGENCE_2026-05 — UI components.
//
// `DueDiligenceSummaryStrip` renders the top-of-page aggregate stats.
// `DueDiligencePanel` renders the per-row expandable analysis card.
// Both are presentation-only — they never alter signal state.

function ddBadgeStyle(status: DueDiligenceReview['status']): React.CSSProperties {
  const palette: Record<DueDiligenceReview['status'], { bg: string; color: string; border: string }> = {
    PASSED:        { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0' },
    FAILED:        { bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
    PENDING:       { bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
    NOT_AVAILABLE: { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1' },
  };
  const p = palette[status] ?? palette.NOT_AVAILABLE;
  return {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '2px 8px', borderRadius: 999,
    background: p.bg, color: p.color, border: `1px solid ${p.border}`,
    fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
  };
}

function severityChipStyle(sev: DueDiligenceReview['severity']): React.CSSProperties {
  const palette: Record<DueDiligenceReview['severity'], string> = {
    LOW:      '#15803D',
    MEDIUM:   '#B45309',
    HIGH:     '#B91C1C',
    CRITICAL: '#7F1D1D',
  };
  return {
    display: 'inline-flex', alignItems: 'center',
    padding: '1px 6px', borderRadius: 4,
    background: '#FFFFFF',
    color: palette[sev] ?? '#475569',
    border: `1px solid ${palette[sev] ?? '#CBD5E1'}33`,
    fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
  };
}

function DueDiligenceSummaryStrip({ summary }: { summary: DueDiligenceSummary | null }) {
  if (!summary) return null;
  const top = summary.topBlockReasons[0] ?? null;
  return (
    <div style={{
      margin: '0 0 12px 0',
      padding: '10px 14px',
      background: '#F8FAFC',
      border: '1px solid #E2E8F0',
      borderRadius: 8,
      display: 'flex', flexWrap: 'wrap', gap: 14, rowGap: 6,
      alignItems: 'center',
      fontSize: 11.5, color: '#1E293B',
    }}>
      <span style={{ fontWeight: 800, color: '#0F172A', letterSpacing: 0.4 }}>
        Due Diligence Summary
      </span>
      <span style={{ color: '#475569', fontWeight: 600 }}>
        Reviewed: <span style={{ color: '#0F172A', fontWeight: 800 }}>{summary.totalReviewed}</span>
      </span>
      {top && (
        <span style={{ color: '#475569', fontWeight: 600 }}>
          Top block:{' '}
          <span style={{ color: '#B91C1C', fontWeight: 800 }} title={top.reason}>
            {top.reason.length > 32 ? `${top.reason.slice(0, 32)}…` : top.reason}
          </span>{' '}
          ({top.count})
        </span>
      )}
      <span style={{ color: '#475569', fontWeight: 600 }}>
        High-score not approved: <span style={{ color: '#B45309', fontWeight: 800 }}>{summary.highScoreNotApproved}</span>
      </span>
      <span style={{ color: '#475569', fontWeight: 600 }}>
        Low RR blocked: <span style={{ color: '#B45309', fontWeight: 800 }}>{summary.lowRiskRewardBlocked}</span>
      </span>
      <span style={{ color: '#475569', fontWeight: 600 }}>
        Volume pending: <span style={{ color: '#B45309', fontWeight: 800 }}>{summary.volumePending}</span>
      </span>
      <span style={{ color: '#475569', fontWeight: 600 }}>
        Stale/feed blocked: <span style={{ color: '#B91C1C', fontWeight: 800 }}>{summary.staleBlocked}</span>
      </span>
      <span style={{ color: '#475569', fontWeight: 600 }}>
        Market confirmation pending: <span style={{ color: '#B45309', fontWeight: 800 }}>{summary.marketConfirmationPending}</span>
      </span>
      <span style={{ color: '#475569', fontWeight: 600 }}>
        Data-quality warnings: <span style={{ color: '#7F1D1D', fontWeight: 800 }}>{summary.dataQualityWarnings}</span>
      </span>
    </div>
  );
}

function ListBlock({ title, items, accent }: { title: string; items: string[]; accent: string }) {
  if (!items || items.length === 0) return null;
  return (
    <div style={{ minWidth: 220, flex: 1 }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: accent, marginBottom: 4 }}>
        {title.toUpperCase()}
      </div>
      <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: '#334155', lineHeight: 1.55 }}>
        {items.map((line, i) => <li key={i}>{line}</li>)}
      </ul>
    </div>
  );
}

function PerformanceBlock({ review }: { review: PerformanceReview | undefined }) {
  if (!review) return null;
  const statusBadge: Record<PerformanceReview['reviewStatus'], React.CSSProperties> = {
    PENDING:          { ...ddBadgeStyle('PENDING'),       background: '#FFFBEB' },
    COMPLETED:        { ...ddBadgeStyle('PASSED') },
    INSUFFICIENT_DATA:{ ...ddBadgeStyle('NOT_AVAILABLE'),  background: '#F1F5F9' },
  };
  const outcomeBadge: Record<PerformanceReview['outcome'], React.CSSProperties> = {
    SUCCESS: ddBadgeStyle('PASSED'),
    FAILED:  ddBadgeStyle('FAILED'),
    NEUTRAL: ddBadgeStyle('NOT_AVAILABLE'),
    PENDING: ddBadgeStyle('PENDING'),
    UNKNOWN: ddBadgeStyle('NOT_AVAILABLE'),
  };
  return (
    <div style={{ minWidth: 240, flex: 1 }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.5, color: '#1D4ED8', marginBottom: 4 }}>
        PERFORMANCE REVIEW
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={statusBadge[review.reviewStatus]}>{review.reviewStatus.replace('_', ' ')}</span>
        <span style={outcomeBadge[review.outcome]}>{review.outcome}</span>
      </div>
      {review.reviewStatus === 'INSUFFICIENT_DATA' ? (
        <div style={{ fontSize: 11, color: '#475569', lineHeight: 1.5 }}>
          Insufficient data for performance review.
          {review.insufficientDataReasons.length > 0 && (
            <div style={{ marginTop: 4, color: '#94A3B8' }}>
              Reasons: {review.insufficientDataReasons.join('; ')}
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: '#334155', lineHeight: 1.5 }}>
          {review.entryPrice != null && (
            <div>Entry: <strong>{review.entryPrice}</strong></div>
          )}
          {review.currentPrice != null && (
            <div>Current: <strong>{review.currentPrice}</strong></div>
          )}
          {review.movePercent != null && (
            <div>Move since signal:{' '}
              <strong style={{ color: review.movePercent >= 0 ? '#15803D' : '#B91C1C' }}>
                {review.movePercent.toFixed(2)}%
              </strong>
            </div>
          )}
          {review.targetHit === true && <div style={{ color: '#15803D' }}>Target reached</div>}
          {review.stopLossHit === true && <div style={{ color: '#B91C1C' }}>Stop loss breached</div>}
        </div>
      )}
    </div>
  );
}

// ── PHASE_B_MANIPULATION_BADGE ─────────────────────────────────────
// Compact label + palette derivation. Safe wording — never asserts the
// stock is manipulated, only "risk detected / suspicious pattern".
type WireManipulationRisk = {
  score:             number | null;
  band:              'LOW' | 'WATCH' | 'ELEVATED' | 'HIGH' | 'SEVERE' | 'UNKNOWN';
  freshnessStatus:   'FRESH' | 'STALE' | 'NO_DATA' | 'PARTIAL' | 'UNKNOWN';
  latestEventDate:   string | null;
  latestScanAt:      string | null;
  dominantPatterns:  string[];
  alertCount:        number;
  criticalCount:     number;
  recommendedAction: 'NO_IMPACT' | 'WARNING_ONLY' | 'PENALIZE' | 'RISK_RESTRICT' | 'BLOCK_APPROVAL';
  canAffectApproval: boolean;
  explanation:       string;
  evidence:          string[];
};

function manipulationBadgeLabel(r: WireManipulationRisk): string {
  if (r.freshnessStatus !== 'FRESH' && r.freshnessStatus !== 'UNKNOWN' && r.band !== 'LOW' && r.band !== 'UNKNOWN') {
    return 'Manipulation: Stale Warning';
  }
  switch (r.band) {
    case 'SEVERE':   return 'Manipulation: Severe';
    case 'HIGH':     return 'Manipulation: High Risk';
    case 'ELEVATED': return 'Manipulation: Elevated';
    case 'WATCH':    return 'Manipulation: Watch';
    case 'LOW':      return 'Manipulation: Low';
    case 'UNKNOWN':
    default:         return 'Manipulation: No Data';
  }
}

function manipulationBadgePalette(r: WireManipulationRisk): { bg: string; color: string; border: string } {
  // Stale severe/high/elevated → grey-yellow warning, never red.
  if (r.freshnessStatus !== 'FRESH' && r.band !== 'LOW' && r.band !== 'UNKNOWN') {
    return { bg: '#FEF3C7', color: '#92400E', border: '#FDE68A' };
  }
  switch (r.band) {
    case 'SEVERE':   return { bg: '#FEE2E2', color: '#7F1D1D', border: '#FCA5A5' };
    case 'HIGH':     return { bg: '#FEE2E2', color: '#B91C1C', border: '#FCA5A5' };
    case 'ELEVATED': return { bg: '#FFFBEB', color: '#B45309', border: '#FDE68A' };
    case 'WATCH':    return { bg: '#FEF3C7', color: '#92400E', border: '#FDE68A' };
    case 'LOW':      return { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0' };
    case 'UNKNOWN':
    default:         return { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1' };
  }
}

function ManipulationDetailBlock({ risk }: { risk: WireManipulationRisk }) {
  const pal = manipulationBadgePalette(risk);
  return (
    <div style={{
      marginTop: 12, padding: '10px 12px',
      background: pal.bg, border: `1px solid ${pal.border}`,
      borderRadius: 6, fontSize: 12, color: pal.color, lineHeight: 1.5,
    }}>
      <div style={{ fontWeight: 800, marginBottom: 4 }}>
        {manipulationBadgeLabel(risk)}
        {risk.score != null && <> · score {risk.score.toFixed(1)}</>}
      </div>
      <div style={{ color: '#334155', fontWeight: 500 }}>{risk.explanation}</div>
      <div style={{ marginTop: 4, color: '#475569', fontSize: 11 }}>
        Freshness: <strong>{risk.freshnessStatus}</strong>
        {' '}· Action: <strong>{risk.recommendedAction.replace(/_/g, ' ')}</strong>
        {' '}· Affects approval: <strong>{risk.canAffectApproval ? 'YES' : 'no'}</strong>
        {risk.latestEventDate && <> · Latest event: <strong>{risk.latestEventDate}</strong></>}
      </div>
      {risk.dominantPatterns.length > 0 && (
        <div style={{ marginTop: 4, color: '#475569', fontSize: 11 }}>
          Patterns: {risk.dominantPatterns.map((p) => p.replace(/_/g, ' ')).join(', ')}
        </div>
      )}
    </div>
  );
}

function DueDiligencePanel({
  dueDiligence,
  performanceReview,
  manipulationRisk,
}: {
  dueDiligence:      DueDiligenceReview | undefined;
  performanceReview: PerformanceReview | undefined;
  manipulationRisk?: WireManipulationRisk | null;
}) {
  if (!dueDiligence) {
    return (
      <div style={{
        padding: '12px 16px',
        background: '#F8FAFC',
        border: '1px dashed #CBD5E1',
        borderRadius: 8,
        color: '#475569',
        fontSize: 12,
      }}>
        Due diligence not available for this row.
      </div>
    );
  }
  return (
    <div style={{
      padding: '14px 16px',
      background: '#FFFFFF',
      border: '1px solid #E2E8F0',
      borderRadius: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <span style={ddBadgeStyle(dueDiligence.status)}>
          {dueDiligence.status.replace('_', ' ')}
        </span>
        <span style={severityChipStyle(dueDiligence.severity)}>
          {dueDiligence.severity}
        </span>
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
          padding: '1px 6px', borderRadius: 4,
          background: '#F1F5F9', color: '#475569', border: '1px solid #CBD5E1',
        }} title="Engine's confidence that this analysis is well-populated">
          EXPLAINABILITY {dueDiligence.explainabilityScore}/100
        </span>
        {manipulationRisk && (
          <span style={{
            fontSize: 10, fontWeight: 800, letterSpacing: 0.3,
            padding: '2px 8px', borderRadius: 99,
            background: manipulationBadgePalette(manipulationRisk).bg,
            color:      manipulationBadgePalette(manipulationRisk).color,
            border: `1px solid ${manipulationBadgePalette(manipulationRisk).border}`,
          }}>
            {manipulationBadgeLabel(manipulationRisk).toUpperCase()}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 200, fontSize: 13, color: '#0F172A', fontWeight: 600, lineHeight: 1.4 }}>
          {dueDiligence.summary}
        </div>
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: '#475569' }}>
        <strong style={{ color: '#0F172A' }}>Primary reason:</strong> {dueDiligence.primaryReason}
      </div>
      {dueDiligence.secondaryReasons.length > 0 && (
        <div style={{ marginTop: 4, fontSize: 11.5, color: '#64748B' }}>
          Secondary: {dueDiligence.secondaryReasons.slice(0, 4).join(' • ')}
        </div>
      )}
      <div style={{
        marginTop: 12,
        display: 'flex', flexWrap: 'wrap', gap: 18,
      }}>
        <ListBlock title="Passed Checks" items={dueDiligence.confirmationPassed} accent="#15803D" />
        <ListBlock title="Failed / Pending Checks" items={dueDiligence.confirmationFailed} accent="#B45309" />
      </div>
      <div style={{
        marginTop: 12,
        display: 'flex', flexWrap: 'wrap', gap: 18,
      }}>
        <ListBlock title="Risk Findings" items={dueDiligence.riskFindings} accent="#B91C1C" />
        <ListBlock title="Data Findings" items={dueDiligence.dataFindings} accent="#1D4ED8" />
        <ListBlock title="Market Findings" items={dueDiligence.marketFindings} accent="#0F766E" />
        <ListBlock title="Indicator Findings" items={dueDiligence.indicatorFindings} accent="#7C3AED" />
      </div>
      <div style={{
        marginTop: 12,
        display: 'flex', flexWrap: 'wrap', gap: 18,
      }}>
        <PerformanceBlock review={performanceReview} />
        <ListBlock title="Learning Notes" items={dueDiligence.learningNotes} accent="#475569" />
      </div>
      <div style={{
        marginTop: 12,
        padding: '8px 12px',
        background: '#F8FAFC', borderRadius: 6,
        fontSize: 12, color: '#334155',
      }}>
        <strong style={{ color: '#0F172A' }}>Next action:</strong> {dueDiligence.nextAction}
      </div>
      {manipulationRisk && manipulationRisk.band !== 'UNKNOWN' && (
        <ManipulationDetailBlock risk={manipulationRisk} />
      )}
      <div style={{ marginTop: 8, fontSize: 10, color: '#94A3B8', fontStyle: 'italic' }}>
        Due diligence is for explainability only. Not a recommendation to trade.
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
export default function SignalsPage() {
  // ── Page-only UI state ──────────────────────────────────────
  // Tab, search box, manual pipeline-run guards. Everything
  // related to data + polling lives in useSignalsPolling.
  // INSTITUTIONAL_TIER_2026-05 + CONDITIONAL_FALLBACK_2026-05 — six-tab
  // dashboard. Each tab is backed by a dedicated array on the API
  // response so weaker rows are visually distinct from strict APPROVED
  // ones. Tabs:
  //   APPROVED              — signals[] (strict execution-ready only)
  //   HIGH_POTENTIAL        — high_potential[] (Tier 1.5 conditional fallback)
  //   AWAITING_CONFIRMATION — developing[]
  //   EMERGING_OPPORTUNITY  — scanner_candidates[]
  //   MONITOR               — watchlist[]
  //   RISK_RESTRICTED       — risk_restricted[]
  // Default tab follows the server's `default_tab` hint on the first
  // poll, then becomes user-controlled.
  // ── activeTab persistence ───────────────────────────────────────
  // Spec UI-BOUNCE-FIX-2026-05 — activeTab is the single stable source
  // of truth for the selected tab.
  // activeTab persistence — initialized from sessionStorage to ensure the
  // user's view remains locked through refreshes and data stream updates.
  const [activeTab, setActiveTab] = useState<DashboardTab>(() => {
    if (typeof window === 'undefined') return 'APPROVED';
    const saved = sessionStorage.getItem('q365_signals_active_tab');
    return (saved as DashboardTab) || 'APPROVED';
  });

  // PHASE_2_DUE_DILIGENCE_2026-05 — per-row expansion state for
  // the "Why?" / "View Analysis" toggle. Tracks the row's stable key
  // (signal id when available, otherwise tradingsymbol).
  const [expandedDDRows, setExpandedDDRows] = useState<Set<string>>(new Set());
  const toggleDDRow = (key: string) => {
    setExpandedDDRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Spec UI-BOUNCE-FIX-2026-05 — userSelectedTabRef locks the tab
  // ownership to the user state. Once true, all automatic tab
  // mutations are blocked.
  // userSelectedTabRef: set to true once the user clicks a tab or if we
  // restored a tab from sessionStorage. Prevents the auto-selection
  // logic (which lands the user on the "best" data-filled tab) from
  // overriding a manual choice.
  const userSelectedTabRef = useRef<boolean>(
    typeof window !== 'undefined' && sessionStorage.getItem('q365_signals_active_tab') !== null
  );
  // TAB-BOUNCE-FIX (2026-05) — auto-select must run AT MOST ONCE per
  // mount on the first non-empty data load. Without this, transient
  // empty frames (poll N sees watchlist non-empty, poll N+1 sees it
  // empty, poll N+2 sees it non-empty again) caused the active tab to
  // bounce WATCHLIST ↔ REJECTED on every refresh. didAutoSelectRef
  // flips to true the moment we make any auto-decision, after which
  // the effect is a no-op for the rest of the mount.
  const didAutoSelectRef = useRef(false);

  // Persist activeTab to localStorage whenever it changes.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('q365_signals_active_tab', activeTab);
    }
  }, [activeTab]);
  // Direction filter inside the APPROVED tab. Kept separate from the
  // main tab so BUY/SELL slicing still works on the institutional set.
  const [tab,       setTab]      = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [query,     setQuery]    = useState('');
  const [srResult,  setSrResult] = useState<any>(null);
  const [srLoading, setSrLoad]   = useState(false);
  const [pipelineRunning, setPipelineRunning] = useState(false);
  // Manual-run lock state (one run per IST calendar day from the
  // frontend). Populated on mount via GET /api/run-signal-engine?status=true
  // and on every 429 response.
  const [manualRunStatus, setManualRunStatus] = useState<{
    used:          boolean;
    inProgress:    boolean;
    lastRunAt:     string | null;
    nextAllowedAt: string | null;
  }>({ used: false, inProgress: false, lastRunAt: null, nextAllowedAt: null });

  // Live data-feed health summary (refreshed every 5s while the page
  // is visible). Drives the Signal Engine status header — Data Source,
  // Last API Request / Success, Last Pipeline Run, Last Confirmed
  // Signal Update, Freshness, Fallback Used.
  const [feedHealth, setFeedHealth] = useState<{
    dataSource:                  string | null;
    lastApiRequestAt:            string | null;
    lastSuccessAt:               string | null;
    lastPipelineRunAt:           string | null;
    lastConfirmedSignalUpdateAt: string | null;
    freshness:                   string | null;
    fallbackUsed:                string | null;
  }>({
    dataSource: null, lastApiRequestAt: null, lastSuccessAt: null,
    lastPipelineRunAt: null, lastConfirmedSignalUpdateAt: null,
    freshness: null, fallbackUsed: null,
  });

  useEffect(() => {
    let cancelled = false;
    const fetchHealth = async () => {
      try {
        const res = await fetch('/api/data-feed/health');
        if (!res.ok || cancelled) return;
        const j = await res.json().catch(() => null);
        if (j && !cancelled) {
          setFeedHealth({
            dataSource:                  j.dataSource ?? null,
            lastApiRequestAt:            j.lastApiRequestAt ?? null,
            lastSuccessAt:               j.lastSuccessAt ?? null,
            lastPipelineRunAt:           j.lastPipelineRunAt ?? null,
            lastConfirmedSignalUpdateAt: j.lastConfirmedSignalUpdateAt ?? null,
            freshness:                   j.freshness ?? null,
            fallbackUsed:                j.fallbackUsed ?? null,
          });
        }
      } catch { /* ignore */ }
    };
    fetchHealth();
    const id = setInterval(fetchHealth, 5_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/run-signal-engine?status=true', { method: 'GET' });
        if (!res.ok || cancelled) return;
        const j = await res.json().catch(() => null);
        if (j && typeof j === 'object' && !cancelled) {
          setManualRunStatus({
            used:          !!j.used,
            inProgress:    !!j.inProgress,
            lastRunAt:     j.lastRunAt ?? null,
            nextAllowedAt: j.nextAllowedAt ?? null,
          });
        }
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);
  // Cancel signal for the pipeline polling loop. The actual scan runs
  // server-side in the background and can't be aborted from the client
  // (the signal engine does not expose a cancel hook), but we CAN stop
  // waiting for it. Set to true → the next poll tick exits cleanly,
  // pipelineRunning flips to false, and the button unlocks. The
  // server-side scan keeps running and its results will appear in the
  // signals table when the next normal /api/signals poll completes.
  const pipelineCancelRef = useRef(false);
  // Tracks the batch_id of the most recent pipeline run that is still
  // executing server-side. Set on a successful POST (202/409); cleared
  // the moment pollForBatch detects completion. While this is non-null
  // we MUST NOT POST /api/run-signal-engine again — the server would
  // return 409 (which fetch dutifully logs as a console error). The
  // 5 s UI auto-stop unlocks the button quickly, but the underlying
  // scan can still be running for minutes; without this guard a
  // second click during that window spams 409s.
  const inFlightBatchRef = useRef<string | null>(null);
  // Search debounce timer.
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  // ── Data + polling subsystem ────────────────────────────────
  // useSignalsPolling owns: signals/emerging/loading/freshness state,
  // LKG refs, the load() function, the SSE handler, the 5s + 10s
  // polling loops, the 5-min auto-scan, the direction-flip detector,
  // triggerAutoRebuild, autoRefreshIfStale. The page passes
  // pipelineRunning in so the auto layer knows when a manual run is
  // in progress and reads everything else out of the returned bundle.
  const {
    signals, rejected, funnel, emerging, loading, freshness, lkgWarning, scanProgress,
    directionFlips, termLogs, signalQuality, marketClosed,
    // INSTITUTIONAL_TIER_2026-05 + CONDITIONAL_FALLBACK_2026-05 fields.
    highPotential, developing, scannerCandidates, watchlist, riskRestricted,
    conditionalModeActive, tierCounts, emptyStateMessage,
    defaultTab, conditionalFloors,
    // ── FIX FINAL SIGNAL VISIBILITY 2026-05 ──
    marketStatus, dataFreshness, reasonSummary, lastApiRequestAt, lastSuccessAt,
    isBootstrap, isFallback, approvedSignals, highPotentialSignals, watchlistSignals,
    rejectedSignals, counters,
    // PHASE_1_RANKING_AND_NEAREST_SIGNAL_2026-05
    closestToApproval, nearestSignals,
    // PHASE_2_DUE_DILIGENCE_2026-05
    dueDiligenceSummary,
    // PHASE_3_DAILY_INTELLIGENCE_2026-05
    dailyReportPreview,
    // PHASE_5_HEALTH_OBSERVABILITY_2026-05
    healthPreview,
    wsPrices, wsConnected, wsLastAt, wsMarketOpen, kiteStatus, stream, // @deprecated marker
    pushLog, load,
    lkgBatchIdRef,
  } = useSignalsPolling({ pipelineRunning });
  void emerging; // Spec §UX-SIMPLIFY — Emerging Opportunities retired; field kept on the result type for back-compat only.

  // ── Tab auto-selection ──────────────────────────────────────────
  // Merged WATCHLIST / REJECTED counts — recomputed from the granular
  // backend arrays. Used both by the tab strip and the auto-select.
  const watchlistTotal =
    developing.length + scannerCandidates.length + watchlist.length;
  const rejectedTotal = rejected.length + riskRestricted.length;

  // SIGNAL-ENGINE-COPY-2026-05 — Single source of truth for the
  // provider-fallback state. /api/data-feed/health and /api/signals
  // each carry an independent fallback flag, and historically the
  // header showed "Fallback: No" beside "Live Engine (Fallback Mode)"
  // because the two signals were evaluated separately. Treat either as
  // authoritative: if the pipeline reports fallback OR the health
  // endpoint reports a non-NO fallback string, the entire page renders
  // a coherent "provider in fallback" state.
  const healthFallbackActive = feedHealth.fallbackUsed != null
    && feedHealth.fallbackUsed !== ''
    && feedHealth.fallbackUsed.toUpperCase() !== 'NO'
    && feedHealth.fallbackUsed.toUpperCase() !== 'NONE';
  const providerInFallback = isFallback || healthFallbackActive;
  useEffect(() => {
    // TAB-BOUNCE-FIX (2026-05) — Once we have already auto-decided once,
    // the effect is a no-op for the rest of this mount.
    if (didAutoSelectRef.current)   return;
    // EMPTY-TAB-RESCUE (2026-05) — userSelectedTabRef is set both by an
    // in-session click AND by a sessionStorage restoration. The original
    // gate was unconditional — any saved tab was a hard lock, so a user
    // who had previously been on APPROVED would stay stuck there on the
    // next refresh even when the server now has zero APPROVED rows but
    // populated WATCHLIST / REJECTED arrays. The page appeared empty.
    // New behaviour: respect a saved tab ONLY when it actually has rows
    // this cycle. If the saved tab is empty AND data exists elsewhere,
    // fall through to the auto-switch so the operator lands on the
    // populated tab instead of staring at "no data". An in-session
    // click that picks an empty tab is still respected — the click
    // handler now also raises didAutoSelectRef so this branch never
    // bounces the user away from their explicit choice.
    if (userSelectedTabRef.current) {
      const currentTabRows = (
        activeTab === 'APPROVED'       ? signals.length
      : activeTab === 'HIGH_POTENTIAL' ? highPotential.length
      : activeTab === 'WATCHLIST'      ? watchlistTotal
      : activeTab === 'REJECTED'       ? rejectedTotal
      :                                  0
      );
      if (currentTabRows > 0) {
        didAutoSelectRef.current = true;
        return;
      }
      const haveRowsElsewhere =
        signals.length > 0 || highPotential.length > 0
        || watchlistTotal > 0 || rejectedTotal > 0;
      if (!haveRowsElsewhere) return;
      // eslint-disable-next-line no-console
      console.log('[TAB_AUTO_SWITCH]', { from: activeTab, reason: 'saved-tab empty, rescuing to populated tab' });
      // Fall through to the priority-ordered switch below.
    }
    // The first useful auto-decision only fires when we have ANY rows
    // to point at; transient empty frames (everything is []) wait for
    // the next poll instead of jumping straight to REJECTED.
    const haveAnyRows =
      signals.length > 0
      || highPotential.length > 0
      || watchlistTotal > 0
      || rejectedTotal > 0;
    if (!haveAnyRows && !defaultTab) return;
    if (signals.length > 0) {
      didAutoSelectRef.current = true;
      if (activeTab !== 'APPROVED') {
        // eslint-disable-next-line no-console
        console.log('[TAB_AUTO_SWITCH]', { from: activeTab, to: 'APPROVED', reason: 'signals present (one-shot)' });
        setActiveTab('APPROVED');
      }
      return;
    }
    if (highPotential.length > 0) {
      didAutoSelectRef.current = true;
      if (activeTab !== 'HIGH_POTENTIAL') {
        // eslint-disable-next-line no-console
        console.log('[TAB_AUTO_SWITCH]', { from: activeTab, to: 'HIGH_POTENTIAL', reason: 'highPotential present (one-shot)' });
        setActiveTab('HIGH_POTENTIAL');
      }
      return;
    }
    // Map server's granular default_tab onto the 4-tab UI.
    const serverHint = (() => {
      if (!defaultTab) return null;
      if (defaultTab === 'APPROVED' || defaultTab === 'HIGH_POTENTIAL') return defaultTab;
      if (defaultTab === 'WATCHLIST'             ) return 'WATCHLIST'  as const;
      if (defaultTab === 'REJECTED'              ) return 'REJECTED'   as const;
      const granular = String(defaultTab);
      if (granular === 'AWAITING_CONFIRMATION') return 'WATCHLIST' as const;
      if (granular === 'EMERGING_OPPORTUNITY')  return 'WATCHLIST' as const;
      if (granular === 'MONITOR')                return 'WATCHLIST' as const;
      if (granular === 'RISK_RESTRICTED')        return 'REJECTED'  as const;
      return null;
    })();
    if (serverHint && serverHint !== activeTab) {
      didAutoSelectRef.current = true;
      // eslint-disable-next-line no-console
      console.log('[TAB_AUTO_SWITCH]', { from: activeTab, to: serverHint, reason: 'server hint (one-shot)' });
      setActiveTab(serverHint);
      return;
    }
    if      (watchlistTotal > 0 && activeTab !== 'WATCHLIST') {
      didAutoSelectRef.current = true;
      // eslint-disable-next-line no-console
      console.log('[TAB_AUTO_SWITCH]', { from: activeTab, to: 'WATCHLIST', reason: 'watchlist non-empty (one-shot)' });
      setActiveTab('WATCHLIST');
    }
    else if (rejectedTotal  > 0 && activeTab !== 'REJECTED') {
      didAutoSelectRef.current = true;
      // eslint-disable-next-line no-console
      console.log('[TAB_AUTO_SWITCH]', { from: activeTab, to: 'REJECTED', reason: 'rejected non-empty (one-shot)' });
      setActiveTab('REJECTED');
    }
  }, [
    signals.length, highPotential.length,
    watchlistTotal, rejectedTotal, defaultTab, activeTab,
  ]);

  const runPipeline = async () => {
    setPipelineRunning(true);

    // Fresh cancel signal — clear any leftover flag from a prior run
    // that was stopped, so this new attempt isn't auto-aborted.
    pipelineCancelRef.current = false;
    const t0 = Date.now();

    // Hard 5-second UI auto-stop. The "Auto-updating…" button must
    // never stay locked longer than this — even if the server-side
    // pipeline takes minutes to finish, the user gets their button
    // back within 5 s. If the new batch_id lands sooner, we unlock
    // sooner (typical: ~300 ms – 1.3 s). pollForBatch keeps running
    // in the background after the UI cap so the table still refreshes
    // the moment data finally arrives.
    const UI_AUTOSTOP_MS = 5_000;

    // Polling loop. Sleeps 1 s, hits the cheap /api/signals/freshness
    // probe (~200-300 ms), exits the moment the new batch_id is
    // visible. A periodic awaited reload (every 4 ticks → 4 s) keeps
    // the table populated while waiting so the operator can watch
    // rows fade in. The 6-minute hard cap is the absolute upper bound
    // — the UI cap above is what the user actually sees.
    //
    // On success, clears inFlightBatchRef so the next click is allowed
    // to POST again. On the 6-min hard cap we also clear it so the
    // user is never permanently locked out by a stuck server-side run.
    const pollForBatch = async (batchId: string, label: string): Promise<boolean> => {
      const pollDeadline        = Date.now() + 6 * 60_000;
      const POLL_INTERVAL_MS    = 1_000;
      const TABLE_REFRESH_EVERY = 4;
      let tick = 0;
      while (Date.now() < pollDeadline) {
        if (pipelineCancelRef.current) return false;
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (pipelineCancelRef.current) return false;

        try {
          const probe = await fetch('/api/signals/freshness').then((r) => r.json());
          const f          = probe?.freshness;
          const idMatch    = f?.latest_batch_id === batchId;
          const tsAdvanced = typeof f?.last_pipeline_run_ms === 'number' && f.last_pipeline_run_ms > t0;

          if (idMatch || tsAdvanced) {
            const reason = idMatch ? `batch=${batchId} visible` : `pipeline timestamp advanced`;
            void load({ spinner: false, heavy: false });
            pushLog(`[PIPELINE] ${label} done  ${Math.round((Date.now() - t0) / 1000)}s  ${reason} — auto-stopped`);
            if (inFlightBatchRef.current === batchId) inFlightBatchRef.current = null;
            return true;
          }
        } catch { /* swallow — try again next tick */ }

        if (++tick % TABLE_REFRESH_EVERY === 0) {
          if (pipelineCancelRef.current) return false;
          await load({ spinner: false, heavy: false });
        }
      }
      pushLog(`[PIPELINE] ${label} still running after 6 min — batch ${batchId} should populate soon. Refresh manually if needed.`);
      if (inFlightBatchRef.current === batchId) inFlightBatchRef.current = null;
      return false;
    };

    // Race pollForBatch against the 5-second UI cap. Whichever wins,
    // we stop awaiting and let the finally block flip pipelineRunning
    // back to false. If the timeout wins, pollForBatch keeps running
    // detached — its final load() call will refresh the table the
    // moment the server-side scan writes rows.
    const raceWithUiCap = async (batchId: string, label: string): Promise<void> => {
      const pollPromise = pollForBatch(batchId, label).catch(() => false);
      const uiTimeout   = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), UI_AUTOSTOP_MS),
      );
      const winner = await Promise.race([pollPromise, uiTimeout]);
      if (winner === 'timeout') {
        pushLog(
          `[PIPELINE] UI auto-stopped after ${UI_AUTOSTOP_MS / 1000}s — ` +
          `${label} still running in background, table will refresh when data lands`,
        );
        void pollPromise;
      }
    };

    // If a previous run is still going server-side (the UI auto-stops
    // after 5 s but the scan itself takes 1–5 min), skip the POST and
    // just re-attach to the existing batch. Without this shortcut the
    // server would return 409 and the browser would log it as a
    // console error.
    if (inFlightBatchRef.current) {
      const existing = inFlightBatchRef.current;
      pushLog(`[PIPELINE] previous run still in progress — re-attaching to batch=${existing}`);
      try {
        await raceWithUiCap(existing, 'previous run');
      } finally {
        setPipelineRunning(false);
      }
      return;
    }

    pushLog('[PIPELINE] POST /api/run-signal-engine — starting (async mode)…');
    try {
      // Async mode: server returns 202 immediately with a batch_id, then
      // runs the multi-minute Phase-4 scan in the background. Sync mode
      // would 504 behind nginx (universe is 2,767 symbols, refresh +
      // analysis takes 1–5 min).
      const res = await fetch('/api/run-signal-engine', { method: 'POST' });
      const data = await res.json().catch(() => ({}));

      if (res.status === 202) {
        // Background scan kicked off. Tell the operator and poll until
        // the new batch_id shows up in /api/signals's freshness probe.
        const batchId = data.batch_id ?? '(unknown)';
        inFlightBatchRef.current = batchId;
        pushLog(`[PIPELINE] started in background  batch=${batchId}  — polling (UI auto-stops in ${UI_AUTOSTOP_MS / 1000}s)…`);
        await raceWithUiCap(batchId, 'pipeline');
        return;
      }

      if (res.status === 409 && data?.code === 'MARKET_CLOSED') {
        // Spec rule 4: surface the friendly fallback message and
        // bail out — no upstream call is allowed off-hours, and the
        // /api/signals path already serves last_close_signals +
        // market_close_snapshot for the trading view.
        pushLog('[PIPELINE] Market closed — using last available data');
        return;
      }

      if ((res.status === 409 || res.status === 429) && data?.code === 'MANUAL_RUN_USED') {
        setManualRunStatus({
          used:          true,
          inProgress:    false,
          lastRunAt:     data.last_run_at ?? null,
          nextAllowedAt: data.next_allowed_at ?? null,
        });
        pushLog(`[PIPELINE] manual run already used today  last=${data.last_run_at ?? '?'}  next=${data.next_allowed_at ?? '?'}`);
        return;
      }

      if (res.status === 409) {
        // Another tab/operator beat us to it — attach to their batch.
        // Normally the inFlightBatchRef short-circuit above prevents
        // us from POSTing in this state at all, but the server is the
        // ultimate source of truth for cross-tab races.
        const batchId = data.batch_id ?? '(unknown)';
        inFlightBatchRef.current = batchId;
        pushLog(`[PIPELINE] another run already in progress  batch=${batchId}  — waiting (UI auto-stops in ${UI_AUTOSTOP_MS / 1000}s)…`);
        await raceWithUiCap(batchId, 'earlier run');
        return;
      }

      if (res.ok) {
        // Sync-mode response (someone passed ?sync=true, or we're running
        // against an older server). Preserved for back-compat.
        pushLog(
          `[PIPELINE] done  ${Date.now() - t0}ms  ` +
          `scanned=${data.total_scanned ?? '?'} approved=${data.total_approved ?? '?'} rejected=${data.total_rejected ?? '?'}  ` +
          `engine=${data.engine?.path ?? '?'}`
        );
        await load({ spinner: false, heavy: false });
        return;
      }

      pushLog(`[PIPELINE] FAILED ${res.status} ${data?.error ?? ''} ${data?.details ?? ''}`);
    } catch (e: any) {
      pushLog(`[PIPELINE] FAILED ${e?.message ?? e}`);
    }
    finally { setPipelineRunning(false); }
  };

  const handleSearch = (q: string) => {
    setQuery(q);
    clearTimeout(timerRef.current);
    if (q.length < 2) { setSrResult(null); return; }
    timerRef.current = setTimeout(async () => {
      setSrLoad(true);
      try {
        const clean = q.trim().replace(/\s+/g, '').toUpperCase();
        const res = await fetch(`/api/signals?action=instrument&symbol=${encodeURIComponent(clean)}`);
        setSrResult(res.ok ? await res.json() : null);
      } catch { setSrResult(null); }
      finally { setSrLoad(false); }
    }, 600);
  };

  // ── ROWS = REAL PIPELINE SIGNALS ONLY (NO PADDING) ─────────────
  // Whatever the pipeline returns is what the table shows. 50
  // signals in → 50 rows out. Every drop is accounted for in the
  // counters so "API returned 50 but UI shows 49" becomes visible
  // in the console instead of silent.
  //
  // Direction normalisation + client-side dedupe defence. The server
  // already dedupes by (symbol, direction) keeping the latest row,
  // but a transient race between HTTP/SSE updates can briefly merge
  // overlapping batches into one render. Filtering once by
  // `${symbol}_${direction}` keeps the table from flashing duplicate
  // rows during that window. We keep the FIRST occurrence — the API
  // ships rows sorted DESC by final_score, so first==best.
  const seenKeys = new Set<string>();
  const normalizedSignals: SignalRow[] = [];
  for (const s of signals) {
    const dir = String(s.direction ?? '').toUpperCase().trim();
    const sym = String(s.tradingsymbol ?? s.symbol ?? '').toUpperCase().trim();
    const key = `${sym}_${dir}`;
    if (sym && seenKeys.has(key)) continue;
    if (sym) seenKeys.add(key);
    normalizedSignals.push({ ...s, direction: dir });
  }

  // Spec §8 debug log — fires once per unique (api_count, rendered_count)
  // signature so the console isn't spammed by every poll.
  if (typeof window !== 'undefined') {
    const sigKey = `${signals.length}->${normalizedSignals.length}|${signalQuality ?? '?'}`;
    if ((window as any).__Q365_DROP_SIG__ !== sigKey) {
      (window as any).__Q365_DROP_SIG__ = sigKey;
      // eslint-disable-next-line no-console
      console.log('API SIGNALS:', signals);
      // eslint-disable-next-line no-console
      console.log('Rendered signals:', normalizedSignals.length, '  signal_quality:', signalQuality ?? 'unknown');
    }
  }

  // Live-price binding — WebSocket is the ONLY source.
  //
  //   1. Lookup `wsPrices.get(normalizedSymbol)`. The streamServer
  //      publishes Kite-sourced frames (and never lets Yahoo clobber // @deprecated marker
  //      a Kite entry — see streamServer.ts), so a hit here is the // @deprecated marker
  //      authoritative LTP.
  //
  //   2. Freshness gate:
  //        market OPEN  → require tick age ≤ 30s. Otherwise the feed
  //                       has stalled for this symbol; render '—'
  //                       rather than a value old enough to mislead.
  //        market CLOSED → no age check. The WS snapshot IS the last
  //                       traded price; that's exactly what we want
  //                       to display off-hours (matches Google).
  //
  //   3. Miss → livePrice = null. The UI renders '—'. We DELIBERATELY
  //      do NOT fall back to `sig.livePrice` (server Yahoo enrichment) // @deprecated marker
  //      or `sig.ltp` / `sig.entry_price` (frozen entry snapshot) —
  //      both would make the Live column collapse onto the Entry
  //      column whenever Yahoo's value happens to equal the frozen // @deprecated marker
  //      entry price, which is the symptom operators have been hitting.
  //
  // Symbol normalisation: the WS payload uses bare tradingsymbols
  // ("LUPIN"). Some server paths pass through "NSE:LUPIN". We strip
  // any "NSE:" / "BSE:" / exchange prefix before the Map lookup so
  // a mismatch never produces a silent null.
  const WS_FRESH_MS = 30_000;
  const nowMs = Date.now();
  const normaliseSym = (raw: string): string =>
    raw.trim().toUpperCase().replace(/^(NSE|BSE|NFO|MCX):/, '');

  // Once-per-render sanity log for the first row — proves the Map
  // lookup is finding an entry. If this logs `live=undefined` but
  // `wsPrices.size > 0`, the symbol keys don't match.
  if (typeof window !== 'undefined' && normalizedSignals.length > 0) {
    const firstSig = normalizedSignals[0];
    if (firstSig) {
      const sym = normaliseSym(firstSig.tradingsymbol);
      const live = wsPrices.get(sym) ?? null;
      const sigKey = `${sym}|${wsPrices.size}|${live?.ts ?? 0}`;
      if ((window as any).__Q365_LIVE_PROBE__ !== sigKey) {
        (window as any).__Q365_LIVE_PROBE__ = sigKey;
        // eslint-disable-next-line no-console
        console.log(
          '[LIVE PRICE]',
          sym,
          live ?? 'no-tick',
          'mapSize=', wsPrices.size,
          'marketOpen=', wsMarketOpen,
        );
      }
    }
  }

  const signalRows: SignalRow[] = normalizedSignals.map((sig) => {
    const sym  = normaliseSym(sig.tradingsymbol);
    const live = wsPrices.get(sym) ?? null;

    // Accept the WS frame if market is closed (last traded price is
    // exactly what we want off-hours) OR if it's within WS_FRESH_MS.
    const wsAge  = live?.ts ? nowMs - live.ts : null;
    const accept =
      live != null &&
      live.price != null &&
      live.price > 0 &&
      (!wsMarketOpen || (wsAge != null && wsAge <= WS_FRESH_MS));

    if (accept && live) {
      // Day-change percent is derived in priority order:
      //
      //   1. (price - previous_close) / previous_close × 100
      //      The authoritative formula. Uses Kite's ohlc.close which // @deprecated marker
      //      is the previous trading day's close — same reference
      //      Google / Zerodha Kite / Groww all display against. Guard // @deprecated marker
      //      against close==price (can happen on the very last tick
      //      of a session where Kite echoes today's close into the // @deprecated marker
      //      close field) so we don't publish a bogus 0.00%.
      //
      //   2. Fall back to the frame's own pChange when the formula
      //      is unusable (no close, or close==price edge case) AND
      //      the frame's pChange is a real non-zero number.
      //
      //   3. When market is closed and we still have nothing, fall
      //      back to sig.pct_change — the day-change snapshot at
      //      signal generation. For a Friday-afternoon signal this
      //      is within minutes of Google's "previous close" reference
      //      and keeps the column from displaying a misleading 0.00%
      //      over the weekend.
      //
      //   4. Otherwise null → LiveCell renders no percent row at all.
      const prevClose = live.close ?? null;
      const priceOk   = live.price != null && live.price > 0;
      let livePChange: number | null = null;
      if (priceOk && prevClose != null && prevClose > 0 && prevClose !== live.price) {
        livePChange = ((live.price! - prevClose) / prevClose) * 100;
      } else if (live.pChange != null && live.pChange !== 0) {
        livePChange = live.pChange;
      } else if (!wsMarketOpen && typeof sig.pct_change === 'number') {
        livePChange = sig.pct_change;
      }
      return {
        ...sig,
        livePrice:   live.price,
        livePChange,
        // Honour the per-frame source from the stream server. Default
        // to 'kite_rest' when absent — the WS frame would have set // @deprecated marker
        // 'kite_ws' explicitly, so an unset source means the row was // @deprecated marker
        // enriched via the REST quote path.
        liveSource:  live.source ?? 'kite_rest', // @deprecated marker
        liveTickTs:  live.ts ?? null,
      };
    }

    // No WS entry for this symbol — but the server may have enriched
    // sig.livePrice via Yahoo (see enrichWithLiveLtp in the signals // @deprecated marker
    // API). Fall back to it ONLY when the server has marked the source
    // explicitly as 'yahoo' (or 'kite' for the EOD-bar path). This is // @deprecated marker
    // the safe version of the fallback that used to be blanket-banned:
    //
    //   Historical bug: blindly rendering sig.livePrice would make the
    //   Live column collapse onto Entry when Yahoo's delayed value // @deprecated marker
    //   coincidentally matched entry_price. Operators reported this
    //   as "Live always equals Entry — column is broken".
    //
    //   Guardrails here:
    //     1. Require liveSource ∈ {'yahoo', 'kite'}. A null/undefined // @deprecated marker
    //        source means the server didn't confidently resolve a
    //        price — don't render stale junk.
    //     2. Require livePrice > 0.
    //     3. Require livePrice !== entry_price. If the server's best
    //        guess coincides with the frozen entry, we'd still show
    //        the "broken column" symptom — rendering '—' is more
    //        honest in that specific case.
    //
    // The result: when WS is dead (Kite loginRequired), operators see // @deprecated marker
    // a delayed Yahoo price with a visible 'yahoo' source badge // @deprecated marker
    // instead of staring at a column of '—'.
    const serverLive   = typeof sig.livePrice === 'number' ? sig.livePrice : null;
    const serverSource = (sig as any).liveSource ?? null;
    const entry        = typeof sig.entry_price === 'number' ? sig.entry_price : null;
    const serverPriceAcceptable =
      serverLive != null &&
      serverLive > 0 &&
      (serverSource === 'kite_ws' || serverSource === 'kite_rest' || serverSource === 'kite') && // @deprecated marker
      (entry == null || serverLive !== entry);

    if (serverPriceAcceptable) {
      return {
        ...sig,
        livePrice:   serverLive,
        livePChange: typeof (sig as any).livePChange === 'number' ? (sig as any).livePChange : null,
        liveSource:  serverSource, // 'kite_ws' | 'kite_rest' | 'kite' // @deprecated marker
        liveTickTs:  (sig as any).liveTickTs ?? null,
      };
    }

    // Still nothing usable → render '—'. Never leak sig.ltp or
    // sig.entry_price into the Live column — that's the original
    // "Live == Entry" bug this branch exists to prevent.
    return {
      ...sig,
      livePrice:   null,
      livePChange: null,
      liveSource:  null,
      liveTickTs:  null,
    };
  });

  const universeExtras: SignalRow[] = []; // never populated — kept for shape compat

  // Spec ELITE-2026-05 §UI — defence-in-depth elite gate. Mirrors the
  // backend `applyEliteGate` predicate so a server leak (cached
  // response, RELAXED fallback, scanner_candidates injection, missing
  // env, …) cannot put a non-elite row on screen. The page renders
  // ONLY rows that pass every elite floor + every categorical
  // predicate. When 0 rows pass we render the empty-state copy
  // ("No institutional-grade setups available.") rather than padding
  // with weak setups.
  //
  //   confidence_score      ≥ 75
  //   final/institutional   ≥ 80
  //   risk_reward           ≥ 2.0
  //   stress_survival_score ≥ 75   (skipped when null — backend gate
  //                                  already enforced; rows from
  //                                  pre-elite cache can be missing it)
  //   classification ∈ { INSTITUTIONAL_HIGH_CONVICTION, HIGH_CONVICTION }
  //   execution_allowed = true, no invalidation_reason
  //   freshness_state ≠ stale, decay_state ∉ { stale, expired }
  //
  // The full 8-floor predicate runs server-side; the UI-side floors
  // are the four the user sees on the row (confidence, final, RR,
  // classification + freshness/exec). Per-factor floors (liquidity,
  // market_regime, portfolio_fit, data_quality) are tested when the
  // row carries them — when absent we trust the server gate.
  const ELITE_CLS = new Set(['INSTITUTIONAL_HIGH_CONVICTION', 'HIGH_CONVICTION']);
  type EliteCheck = { passed: boolean; reasons: string[] };
  const eliteRowApproved = (r: SignalRow): EliteCheck => {
    // Spec NEVER-EMPTY-WHEN-DB-HAS-ROWS — when the server tagged a row
    // as relaxed or scanner-candidate, its lenient server gate
    // (SIGNAL_ELITE_LENIENT_FACTORS=true + SIGNAL_ELITE_NEVER_EMPTY=true,
    // both default-on) already made a deliberate ship decision. Re-
    // applying the strict UI floors here was double-gating the response
    // — the server returned signals=[16] tagged is_relaxed=true and
    // signal_quality='RELAXED', then the UI's hard 75/80/2.0 floors
    // and freshness_state!=stale check rejected all of them, leaving
    // the APPROVED tab empty. Respect the server's contract: when the
    // row carries is_relaxed / is_scanner_candidate, OR signal_quality
    // is RELAXED / SCANNER_CANDIDATES, pass it through. The reason
    // 'relaxed_bypass' keeps the audit log grep-able so an operator
    // can still see "16 rows passed via relaxed_bypass" in the
    // [ELITE_UI_FILTERED] line.
    const isRelaxed     = (r as any).is_relaxed === true;
    const isScannerCand = (r as any).is_scanner_candidate === true;
    // signalQuality's declared type is stale ('STRICT' | 'NONE') but the
    // runtime payload carries 'RELAXED' and 'SCANNER_CANDIDATES'
    // (server-side definition in confirmedSignalPolicy / signals route).
    // Compare via String() to bypass the narrow declared type without
    // expanding it here — the type definition fix is out of scope for
    // this UI patch.
    const sq = String(signalQuality ?? '').toUpperCase();
    const qualityRelaxed = sq === 'RELAXED' || sq === 'SCANNER_CANDIDATES';
    if (isRelaxed || isScannerCand || qualityRelaxed) {
      return { passed: true, reasons: ['relaxed_bypass'] };
    }
    const reasons: string[] = [];
    const cls = String((r as any).classification ?? '').toUpperCase().trim();
    const rawCls = String((r as any).raw_classification ?? '').toUpperCase().trim();
    if (!ELITE_CLS.has(cls) && !(rawCls && ELITE_CLS.has(rawCls))) {
      reasons.push(`classification=${cls || rawCls || 'unknown'}`);
    }
    if ((r as any).execution_allowed === false) reasons.push('execution_allowed=false');
    if ((r as any).invalidation_reason)         reasons.push(`invalidated:${(r as any).invalidation_reason}`);
    const ss = String((r as any).signal_status ?? '').toUpperCase();
    if (ss && ss !== 'APPROVED_SIGNAL') reasons.push(`signal_status=${ss}`);
    const conf = Number((r as any).confidence_score ?? (r as any).confidence ?? NaN);
    if (!Number.isFinite(conf) || conf < 75) reasons.push(`confidence=${conf}`);
    const fs = Number((r as any).final_score ?? (r as any).institutional_score ?? NaN);
    if (!Number.isFinite(fs) || fs < 80) reasons.push(`institutional_score=${fs}`);
    const rr = Number((r as any).risk_reward ?? (r as any).rr_ratio ?? NaN);
    if (!Number.isFinite(rr) || rr < 2.0) reasons.push(`risk_reward=${rr}`);
    const stress = (r as any).stress_survival_score;
    if (stress != null) {
      const stN = Number(stress);
      if (!Number.isFinite(stN) || stN < 75) reasons.push(`stress=${stN}`);
    }
    const fresh = String((r as any).freshness_state ?? '').toLowerCase();
    if (fresh === 'stale') reasons.push('freshness_state=stale');
    const decay = String((r as any).decay_state ?? '').toLowerCase();
    if (decay === 'stale' || decay === 'expired') reasons.push(`decay_state=${decay}`);
    const liveVal = String((r as any).live_validation_state ?? '').toUpperCase();
    if (liveVal && liveVal !== 'VALID') reasons.push(`live_validation_state=${liveVal}`);
    // Per-factor floors — only checked when the field is present on the
    // row. Server gate is authoritative; a row missing these came from
    // a path that didn't run the elite gate (cache, pre-migration row).
    const checkFactor = (key: string, floor: number) => {
      const v = (r as any)[key];
      if (v == null) return;
      const n = Number(v);
      if (!Number.isFinite(n) || n < floor) reasons.push(`${key}=${n}`);
    };
    checkFactor('portfolio_fit_score', 70);
    checkFactor('liquidity_score',     60);
    checkFactor('market_regime_score', 65);
    checkFactor('data_quality_score',  80);
    const conv = String((r as any).conviction_band ?? '').toLowerCase();
    if (conv === 'avoid') reasons.push('conviction_band=avoid');
    return { passed: reasons.length === 0, reasons };
  };

  // Audit + filter pass. Logs every input row, every rejection, and
  // every render decision so the operator can confirm what the table
  // is actually showing. Keep the [ELITE_UI_*] tag set tight so a
  // grep tells the full story without log scraping.
  const eliteAudit = signalRows.map((r) => ({
    row:    r,
    detail: eliteRowApproved(r),
  }));
  const validRows: SignalRow[] = eliteAudit
    .filter((e) => e.detail.passed)
    .map((e) => e.row);
  if (typeof window !== 'undefined') {
    const inputSig = `${signalRows.length}|${validRows.length}|${signalQuality ?? '?'}`;
    if ((window as any).__Q365_ELITE_UI_SIG__ !== inputSig) {
      (window as any).__Q365_ELITE_UI_SIG__ = inputSig;
      // Per-row input audit (capped to first 50 rows so a 100-row
      // poll doesn't blow the console buffer).
      console.log('[ELITE_UI_INPUT]', {
        total:           signalRows.length,
        signal_quality:  signalQuality ?? 'unknown',
        rows: signalRows.slice(0, 50).map((r) => ({
          symbol:         (r as any).tradingsymbol ?? (r as any).symbol ?? '?',
          classification: (r as any).classification ?? null,
          confidence:     (r as any).confidence_score ?? (r as any).confidence ?? null,
          rr:             (r as any).risk_reward ?? (r as any).rr_ratio ?? null,
        })),
      });
      // Filtered-out rows + reasons.
      const dropped = eliteAudit.filter((e) => !e.detail.passed);
      console.log('[ELITE_UI_FILTERED]', {
        input:    signalRows.length,
        approved: validRows.length,
        dropped:  dropped.length,
        rows: dropped.slice(0, 50).map((d) => ({
          symbol:         (d.row as any).tradingsymbol ?? (d.row as any).symbol ?? '?',
          classification: (d.row as any).classification ?? null,
          confidence:     (d.row as any).confidence_score ?? (d.row as any).confidence ?? null,
          rr:             (d.row as any).risk_reward ?? (d.row as any).rr_ratio ?? null,
          elite_pass:     false,
          rejection_reason: d.detail.reasons.join(','),
        })),
      });
    }
  }
  const buySignals  = validRows.filter(r => r.direction === 'BUY');
  const sellSignals = validRows.filter(r => r.direction === 'SELL');
  // Hard UI cap at 100 rows. The API already targets 50-100, but a
  // misconfigured limit query param or an emerging-merged batch can
  // push it higher — capping in the render path keeps row count
  // predictable and the table render time bounded (<1.5s budget).
  const UI_DISPLAY_CAP = 100;
  // INSTITUTIONAL_TIER_2026-05 — swap the rendered row source per
  // active tab. APPROVED keeps the elite-gated `validRows` pipeline
  // (with BUY/SELL split). The lower tiers ship server-classified
  // rows — we trust the server's bucketing and don't re-gate them
  // on the client; double-gating was the bug that produced empty
  // dashboards even when the API had viable rows.
  const approvedShown = (tab === 'BUY'  ? buySignals
                      :  tab === 'SELL' ? sellSignals
                      :  validRows).slice(0, UI_DISPLAY_CAP);
  // PRODUCTION_TABS_2026-05 — WATCHLIST is the union of Awaiting
  // Confirmation (developing) + Emerging Opportunity (scanner_candidates)
  // + Monitor (watchlist). Each row's `tier` field is preserved so the
  // per-row sub-badge below can render the correct label/color.
  const watchlistMerged: SignalRow[] = ([
    ...developing       .map(r => ({ ...r, tier: (r as any).tier ?? 'AWAITING_CONFIRMATION' })),
    ...scannerCandidates.map(r => ({ ...r, tier: (r as any).tier ?? 'EMERGING_OPPORTUNITY'  })),
    ...watchlist        .map(r => ({ ...r, tier: (r as any).tier ?? 'MONITOR'               })),
  ] as SignalRow[]).slice(0, UI_DISPLAY_CAP);
  // REJECTED tab: riskRestricted rows ship in the row table; the
  // funnel-shaped `rejected[]` (display-shape, not SignalRow) renders
  // beneath via RejectedSignalsPanel. Both visible together so the
  // operator can see WHY signals were blocked or downgraded.
  const rejectedShown: SignalRow[] = (riskRestricted as SignalRow[])
    .map(r => ({ ...r, tier: (r as any).tier ?? 'RISK_RESTRICTED' }))
    .slice(0, UI_DISPLAY_CAP);
  const tierShown: Record<DashboardTab, SignalRow[]> = {
    APPROVED:       approvedShown,
    HIGH_POTENTIAL: highPotential.slice(0, UI_DISPLAY_CAP),
    WATCHLIST:      watchlistMerged,
    REJECTED:       rejectedShown,
  };
  const shown: SignalRow[] = tierShown[activeTab] ?? approvedShown;

  // Pipeline visibility log — fires every render but cheap.
  if (typeof window !== 'undefined') {
    (window as any).__Q365_COUNTS__ = {
      ws_connected: wsConnected,
      ws_universe:  wsPrices.size,
      signals:      signalRows.length,
      extras:       universeExtras.length,
      valid_rows:   validRows.length,
      buy:          buySignals.length,
      sell:         sellSignals.length,
      tab,
      shown:        shown.length,
    };
    // Render-counter log — gated on a count signature so it fires
    // only when something actually changed. Includes the new tier
    // contract so an operator can verify the dashboard is reading
    // signals[] / high_potential[] / developing[] etc.
    const sig = `${validRows.length}|${shown.length}|${tab}|${activeTab}|${highPotential.length}|${conditionalModeActive ? 1 : 0}`;
    if ((window as any).__Q365_LAST_SIG__ !== sig) {
      (window as any).__Q365_LAST_SIG__ = sig;
      console.log('[UI COUNTS]', {
        // Strict APPROVED.
        signals_length:           signals.length,
        valid_rows:               validRows.length,
        // CONDITIONAL_FALLBACK_2026-05 contract.
        high_potential_length:    highPotential.length,
        developing_length:        developing.length,
        scanner_candidates_length: scannerCandidates.length,
        watchlist_length:         watchlist.length,
        risk_restricted_length:   riskRestricted.length,
        conditional_mode_active:  conditionalModeActive,
        empty_state_message:      emptyStateMessage,
        // Tab + render state.
        selected_tab:             activeTab,
        rendered_rows:            shown.length,
      });
      // Spec ELITE-2026-05 §UI — the actual rows the operator sees.
      // Per-row, post-filter, post-tab-split. If this log shows a row
      // the table also renders, the elite gate accepted it; if it
      // doesn't appear here, the table cannot render it.
      console.log('[ELITE_UI_RENDER]', {
        tab,
        count:           shown.length,
        signal_quality:  signalQuality ?? 'unknown',
        rows: shown.slice(0, 50).map((r) => ({
          symbol:         (r as any).tradingsymbol ?? (r as any).symbol ?? '?',
          classification: (r as any).classification ?? null,
          confidence:     (r as any).confidence_score ?? (r as any).confidence ?? null,
          rr:             (r as any).risk_reward ?? (r as any).rr_ratio ?? null,
          elite_pass:     true,
        })),
      });
    }
  }

  return (
    <AppShell title="Signal Engine">
      {/* Market-closed banner + last-close price table. When the API
          returns `mode: 'market_closed'` the signals card is empty by
          design (gate hasn't approved anything off-hours), so we
          render the static last-close data from
          q365_market_close_snapshot above the (empty) signals view.
          Hides itself instantly when the next poll returns mode='live'. */}
      {marketClosed && (
        <div style={{
          margin: '0 0 16px 0', padding: '12px 16px',
          background: 'rgba(245, 158, 11, 0.12)',
          border: '1px solid rgba(245, 158, 11, 0.5)',
          borderRadius: 8, color: '#92400e',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <strong>{marketClosed.market_label}</strong>
            <span style={{ fontSize: 12, opacity: 0.85 }}>
              {marketClosed.message} — {marketClosed.market_data.length} symbols
            </span>
          </div>
          {marketClosed.market_data.length > 0 && (
            <div style={{ marginTop: 10, maxHeight: 280, overflow: 'auto' }}>
              <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
                <thead style={{ position: 'sticky', top: 0, background: '#fef3c7' }}>
                  <tr>
                    <th style={{ textAlign: 'left',  padding: '4px 8px' }}>Symbol</th>
                    <th style={{ textAlign: 'right', padding: '4px 8px' }}>Price</th>
                    <th style={{ textAlign: 'right', padding: '4px 8px' }}>Change</th>
                    <th style={{ textAlign: 'right', padding: '4px 8px' }}>Change %</th>
                    <th style={{ textAlign: 'right', padding: '4px 8px' }}>Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {marketClosed.market_data.map((r) => {
                    const up = (r.change ?? 0) > 0;
                    const dn = (r.change ?? 0) < 0;
                    const color = up ? '#16a34a' : dn ? '#dc2626' : '#475569';
                    return (
                      <tr key={r.symbol}>
                        <td style={{ padding: '3px 8px', fontFamily: 'monospace' }}>{r.symbol}</td>
                        <td style={{ padding: '3px 8px', textAlign: 'right' }}>{r.price?.toFixed(2)}</td>
                        <td style={{ padding: '3px 8px', textAlign: 'right', color }}>
                          {r.change != null ? (r.change >= 0 ? '+' : '') + r.change.toFixed(2) : '—'}
                        </td>
                        <td style={{ padding: '3px 8px', textAlign: 'right', color }}>
                          {r.change_percent != null ? (r.change_percent >= 0 ? '+' : '') + r.change_percent.toFixed(2) + '%' : '—'}
                        </td>
                        <td style={{ padding: '3px 8px', textAlign: 'right' }}>
                          {r.volume != null ? r.volume.toLocaleString() : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {/* SSE-driven row animations. `sig-row-new` fires when a
          signal enters the top-50 for the first time. `sig-row-updated`
          fires when an existing row's final_score changed in the last
          push. Both are scoped to the <tr>, so the whole row briefly
          tints — easier to spot on a busy dashboard than cell-level
          pulses. */}
      <style jsx global>{`
        @keyframes sigRowFlashNew {
          0%   { background-color: rgba(34, 197, 94, 0.28); }
          100% { background-color: transparent; }
        }
        @keyframes sigRowFlashUpdate {
          0%   { background-color: rgba(253, 224, 71, 0.35); }
          100% { background-color: transparent; }
        }
        /* Direction-flip flashes — much stronger and longer than the
           score-change tint so the operator can't miss a side change.
           Green: SELL → BUY (sig-row-direction-up).
           Red:   BUY  → SELL (sig-row-direction-down). */
        @keyframes sigRowDirectionUp {
          0%   { background-color: rgba(34, 197, 94, 0.55); box-shadow: inset 4px 0 0 0 #16a34a; }
          70%  { background-color: rgba(34, 197, 94, 0.25); box-shadow: inset 4px 0 0 0 #16a34a; }
          100% { background-color: transparent; box-shadow: inset 0 0 0 0 transparent; }
        }
        @keyframes sigRowDirectionDown {
          0%   { background-color: rgba(220, 38, 38, 0.55); box-shadow: inset 4px 0 0 0 #dc2626; }
          70%  { background-color: rgba(220, 38, 38, 0.25); box-shadow: inset 4px 0 0 0 #dc2626; }
          100% { background-color: transparent; box-shadow: inset 0 0 0 0 transparent; }
        }
        tr.sig-row-new    { animation: sigRowFlashNew 1.2s ease; }
        tr.sig-row-updated { animation: sigRowFlashUpdate 0.8s ease; }
        tr.sig-row-direction-up   { animation: sigRowDirectionUp   2.5s ease; }
        tr.sig-row-direction-down { animation: sigRowDirectionDown 2.5s ease; }

        @keyframes sigLivePulse {
          0%   { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.55); }
          70%  { box-shadow: 0 0 0 8px rgba(34, 197, 94, 0);   }
          100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0);     }
        }
        .sig-live-dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #16a34a;
          animation: sigLivePulse 2s infinite;
        }
        .sig-live-dot--off {
          background: #94a3b8;
          animation: none;
        }
      `}</style>
      <div className="page">
        <div className="page__header" style={{ marginBottom: 20 }}>
          <div>
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Zap size={22} color="#2E75B6" /> Signal Engine
            </h1>
            <p style={{ color: '#64748B', fontSize: 14, marginTop: 4 }}>
              All signals from centralized pipeline — BUY/SELL with full analysis
            </p>
            {/* TEMP DEPLOY MARKER — remove after live build is confirmed. */}
            <div
              data-build-marker="signal-engine-final-v33"
              style={{
                marginTop: 6,
                fontSize: 11,
                fontWeight: 700,
                color: '#0F172A',
                background: '#FEF3C7',
                border: '1px solid #FCD34D',
                borderRadius: 6,
                padding: '4px 8px',
                display: 'inline-block',
              }}
            >
              Build Version: signal-engine-final-v33
            </div>
            {/* Freshness metadata strip — surfaces last_pipeline_run,
                last_validation_time, latest_batch_id, and universe
                coverage so the operator can verify data is current
                without opening dev tools. Falls back to '—' on first
                paint before the freshness probe lands. */}
            {freshness && (
              <div
                style={{
                  marginTop: 8,
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 14,
                  fontSize: 11,
                  color: '#475569',
                }}
              >
                <span>
                  <strong>Last pipeline run:</strong>{' '}
                  {freshness.last_pipeline_run
                    ? new Date(freshness.last_pipeline_run).toLocaleString()
                    : (freshness.signal_latest_generated
                       ? new Date(freshness.signal_latest_generated).toLocaleString()
                       : '—')}
                </span>
                <span>
                  <strong>Last live validation:</strong>{' '}
                  {freshness.last_validation_time
                    ? new Date(freshness.last_validation_time).toLocaleTimeString()
                    : '—'}
                </span>
                {/* Persistence vs scan coverage label is engine-aware:
                    Phase-4 strict engine reports approval rate (low is
                    normal in sideways markets); the Yahoo scanner // @deprecated marker
                    reports actual scan coverage. The label flips
                    based on `latest_batch_engine_kind` so the operator
                    doesn't misread a 9.6% Phase-4 approval rate as a
                    partial scan. */}
                {/* Distinct fields for SCAN COVERAGE (universe reach)
                    and PERSISTENCE (rows worth saving). Without the
                    split, operators see "10%" and assume the scanner
                    only touched 10% of the universe — the actual scan
                    reaches every symbol; only ~10% produce signals. */}
                {freshness.latest_batch_engine_kind === 'scanner' && freshness.total_scanned != null && (
                  <span>
                    <strong>Scan coverage:</strong>{' '}
                    {freshness.total_scanned} / {freshness.universe_size ?? '—'}
                    {freshness.scan_coverage_percent != null
                      ? ` (${freshness.scan_coverage_percent}%)`
                      : ''}
                  </span>
                )}
                <span>
                  <strong>
                    {freshness.latest_batch_engine_kind === 'phase4'
                      ? 'Phase-4 approval:'
                      : freshness.latest_batch_engine_kind === 'scanner'
                        ? 'Persistence:'
                        : 'Coverage:'}
                  </strong>{' '}
                  {freshness.latest_batch_symbols ?? freshness.total_persisted ?? '—'} / {freshness.universe_size ?? '—'}
                  {(freshness.persistence_percent ?? freshness.latest_batch_persistence_percent ?? freshness.scan_coverage_percent) != null
                    ? ` (${freshness.persistence_percent ?? freshness.latest_batch_persistence_percent ?? freshness.scan_coverage_percent}%)`
                    : ''}
                </span>
                <span>
                  <strong>Batch:</strong> {freshness.latest_batch_id ?? '—'}
                  {freshness.latest_batch_engine_kind && freshness.latest_batch_engine_kind !== 'unknown'
                    ? ` (${freshness.latest_batch_engine_kind})`
                    : ''}
                </span>
              </div>
            )}
            {/* Phase-4 batches in sideways/strict regimes can produce
                a populated emerging list but a thin main table. Surface
                a clear hint so the operator knows to run the scanner
                if they want a fuller table — instead of staring at
                "Coverage: 9.6%" thinking the universe is partial. */}
            {freshness?.latest_batch_engine_kind === 'phase4'
              && (freshness.latest_batch_persistence_percent ?? 100) < 25 && (
              <div
                style={{
                  marginTop: 6,
                  padding: '6px 10px',
                  borderRadius: 6,
                  background: '#FEF9C3',
                  color: '#92400E',
                  fontSize: 11,
                  border: '1px solid #FDE68A',
                }}
              >
                Latest batch is the <strong>Phase-4 strict engine</strong>. The {freshness.latest_batch_persistence_percent}% value is the approval rate, not the scan rate — every symbol was reviewed. For a more populated table, run the Yahoo scanner: <code style={{ background: '#fff', padding: '1px 5px', borderRadius: 3 }}>npx tsx scripts/generateOneBatch.ts --scanner --full</code> // @deprecated marker
              </div>
            )}
          </div>
          {/* ── Data Feed Status Bar ─────────────────────────────
               Renders the spec-required Signal Engine header fields:
                 Data Source · Last API Request · Last Success ·
                 Last Pipeline Run · Last Confirmed Signal Update ·
                 Freshness · Fallback Used
               Polls /api/data-feed/health every 5 s. Empty fields
               render as '—' so the layout never collapses. */}
          {(() => {
            const fmtIst = (iso: string | null) => {
              if (!iso) return '—';
              const d = new Date(iso);
              if (Number.isNaN(d.getTime())) return '—';
              return d.toLocaleString('en-IN', {
                timeZone: 'Asia/Kolkata',
                day: '2-digit', month: 'short', year: 'numeric',
                hour: '2-digit', minute: '2-digit', second: '2-digit',
                hour12: true,
              }).replace(',', '') + ' IST';
            };
            const freshnessPalette: Record<string, { bg: string; color: string; border: string }> = {
              Fresh:    { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0' },
              Stale:    { bg: '#FFFBEB', color: '#B45309', border: '#FDE68A' },
              Degraded: { bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
              Offline:  { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1' },
            };
            const f = freshnessPalette[feedHealth.freshness ?? 'Offline']
                   ?? freshnessPalette.Offline;
            return (
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 14,
                  rowGap: 4,
                  alignItems: 'center',
                  marginTop: 8,
                  marginBottom: 8,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: '#F8FAFC',
                  border: '1px solid #E2E8F0',
                  fontSize: 11,
                  color: '#334155',
                }}
              >
                <span><strong>Data Source:</strong> {feedHealth.dataSource ?? '—'}</span>
                <span><strong>Last API Request:</strong> {fmtIst(feedHealth.lastApiRequestAt)}</span>
                <span><strong>Last Success:</strong> {fmtIst(feedHealth.lastSuccessAt)}</span>
                <span><strong>Last Pipeline Run:</strong> {fmtIst(feedHealth.lastPipelineRunAt)}</span>
                <span><strong>Last Confirmed Signal:</strong> {fmtIst(feedHealth.lastConfirmedSignalUpdateAt)}</span>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 6,
                    background: f.bg,
                    color: f.color,
                    border: `1px solid ${f.border}`,
                    fontWeight: 700,
                    letterSpacing: 0.3,
                  }}
                >
                  {feedHealth.freshness ?? 'Offline'}
                </span>
                {(() => {
                  // SIGNAL-ENGINE-COPY-2026-05 — read the unified
                  // providerInFallback derived above so this badge,
                  // the Live Engine banner, the DiagnosticHeader and
                  // the Engine Health Warning can never disagree.
                  const badge = providerInFallback ? 'Yes' : 'No';
                  const tip = providerInFallback
                    ? `Provider operating in fallback mode${feedHealth.fallbackUsed && feedHealth.fallbackUsed.toUpperCase() !== 'NO' ? ` (${feedHealth.fallbackUsed})` : ''}`
                    : 'Primary provider is serving data';
                  return (
                    <span title={tip}>
                      <strong>Fallback:</strong> {badge}
                    </span>
                  );
                })()}
              </div>
            );
          })()}
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {/*
              Three-state badge to avoid the scary "OFFLINE" flash on
              first paint while the SSE connection is being negotiated:
                  CONNECTING…  →  LIVE  (or)  OFFLINE (only if connect fails)
              The hook flips `connecting` to false after either the
              EventSource opens (fast path) or 12s elapse (slow-DB path),
              so this only ever shows briefly on real load.
            */}
            {(() => {
              const status = stream.connected
                ? 'live'
                : stream.connecting
                  ? 'connecting'
                  : 'offline';
              // Label is "STREAM ON" not "LIVE" so it can't be confused
              // with the market-hours LIVE badge — the SSE pipe being
              // connected on a Saturday doesn't mean the NSE market is
              // open. The market-state badge lives in freshness and
              // marketClosed; this badge is purely about transport.
              const palette = {
                live:       { bg: '#F0FDF4', border: '#BBF7D0', dot: 'sig-live-dot',                  color: '#15803D', label: 'STREAM ON' },
                connecting: { bg: '#FFFBEB', border: '#FDE68A', dot: 'sig-live-dot sig-live-dot--off', color: '#B45309', label: 'CONNECTING…' },
                offline:    { bg: '#FEF2F2', border: '#FECACA', dot: 'sig-live-dot sig-live-dot--off', color: '#991B1B', label: 'STREAM OFFLINE' },
              }[status];
              const title = status === 'live'
                ? `Live stream active · last push ${stream.lastPushAt ? new Date(stream.lastPushAt).toLocaleTimeString() : '—'}`
                : status === 'connecting'
                  ? 'Establishing live stream…'
                  : 'Stream offline — browser will retry';
              return (
                <div
                  title={title}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '8px 14px', background: palette.bg, borderRadius: 8,
                    border: `1px solid ${palette.border}`,
                  }}
                >
                  <span className={palette.dot} />
                  <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.4, color: palette.color }}>
                    {palette.label}
                  </span>
                </div>
              );
            })()}
            <div style={{ textAlign: 'center', background: '#EFF6FF', borderRadius: 8, padding: '8px 16px' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#1D4ED8' }}>{counters?.approvedTotal ?? validRows.length}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>APPROVED TOTAL</div>
            </div>
            <div style={{ textAlign: 'center', background: '#F0FDF4', borderRadius: 8, padding: '8px 16px' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#16A34A' }}>{counters?.approvedBuy ?? buySignals.length}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>APPROVED BUY</div>
            </div>
            <div style={{ textAlign: 'center', background: '#FEF2F2', borderRadius: 8, padding: '8px 16px' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: '#DC2626' }}>{counters?.approvedSell ?? sellSignals.length}</div>
              <div style={{ fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>APPROVED SELL</div>
            </div>
            {/*
              Single button. While a pipeline run is in flight it shows
              "Auto-updating…" (disabled). The polling loop checks every
              8s and AUTOMATICALLY exits the moment the new batch_id
              appears in /api/signals — no manual stop needed. The table
              also live-refreshes during the wait via the SSE stream, so
              the operator sees rows the instant they're written.
            */}
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
              <button
                className="btn btn--primary btn--sm"
                onClick={runPipeline}
                disabled={pipelineRunning || (manualRunStatus.used && !manualRunStatus.inProgress)}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                title={
                  manualRunStatus.used && !manualRunStatus.inProgress
                    ? `Manual run used today. Next available ${manualRunStatus.nextAllowedAt ?? 'tomorrow'}.`
                    : undefined
                }
              >
                <RefreshCw size={13} className={pipelineRunning ? 'spin' : ''} />
                {pipelineRunning
                  ? 'Auto-updating…'
                  : (manualRunStatus.used && !manualRunStatus.inProgress
                      ? 'Manual Run Used Today'
                      : 'Run Pipeline')}
              </button>
              {manualRunStatus.used && !pipelineRunning && (
                <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 500 }}>
                  Last run {manualRunStatus.lastRunAt ?? '?'} · Next available {manualRunStatus.nextAllowedAt ?? '?'}
                </span>
              )}
              {pipelineRunning && (
                <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 500 }}>
                  Checking every 1s · auto-stops within 5s (sooner if data lands)
                </span>
              )}
            </div>
          </div>
          <div style={{ marginTop: 12, padding: '4px 0', borderTop: '1px solid #F1F5F9', color: '#64748B', fontSize: 12, fontWeight: 500 }}>
            {(() => {
              // SIGNAL-ENGINE-COPY-2026-05 — "0 candidates found" was
              // contradicting the WATCHLIST/REJECTED tabs (which clearly
              // had rows). The server-side `candidateTotal` counter has
              // been stale on this surface; derive from the same tab
              // counts the strip uses so the summary line and the tab
              // headers can never disagree.
              const approvedNow      = counters?.approvedTotal ?? signals.length;
              const highPotentialNow = Math.max(counters?.highPotentialTotal ?? 0, highPotential.length);
              const watchlistNow     = Math.max(counters?.watchlistTotal     ?? 0, watchlistTotal);
              const rejectedNow      = Math.max(counters?.rejectedTotal      ?? 0, rejectedTotal);
              const totalEvaluated   = approvedNow + highPotentialNow + watchlistNow + rejectedNow;
              if (totalEvaluated === 0) {
                return (
                  <span>No candidates evaluated yet.</span>
                );
              }
              return (
                <>
                  <span style={{ color: '#1E3A5F', fontWeight: 700 }}>{totalEvaluated}</span> candidates evaluated ·{' '}
                  <span style={{ color: '#16A34A', fontWeight: 700 }}>{approvedNow}</span> cleared institutional approval gate
                  {(watchlistNow > 0 || rejectedNow > 0) && (
                    <span style={{ color: '#94A3B8', marginLeft: 8 }}>
                      ({watchlistNow} watchlist · {rejectedNow} rejected
                      {highPotentialNow > 0 ? ` · ${highPotentialNow} high potential` : ''})
                    </span>
                  )}
                </>
              );
            })()}
          </div>
          {/* Approved zero-state explanation — only shows when
              approval gate cleared nothing but evidence of watchlist /
              rejected candidates exists. Keeps the operator informed
              without changing any approval rule. */}
          {(() => {
            const approvedNow = counters?.approvedTotal ?? signals.length;
            const hasOtherCandidates = (watchlistTotal + rejectedTotal + highPotential.length) > 0;
            if (approvedNow !== 0 || !hasOtherCandidates) return null;
            return (
              <div
                style={{
                  marginTop: 8,
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: '#FFFBEB',
                  border: '1px solid #FDE68A',
                  color: '#92400E',
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                No signal has cleared the institutional approval gate yet.
                Candidates remain under watchlist / rejection review due to
                confirmation, freshness, risk, or provider-health constraints.
              </div>
            );
          })()}
        </div>

        {/* ── Live / delayed-mode banner ─────────────────────────
            Honest about the data state:
              • market CLOSED                → amber "Last close (Yahoo)" banner // @deprecated marker
              • market OPEN + kite connected → green "Live (Kite)" strip // @deprecated marker
              • market OPEN + kite offline   → red "Delayed — Yahoo fallback" strip // @deprecated marker
            Also shows the last-tick wall clock in IST and a tri-state
            dot based on tick age:
              🟢 <3s (fresh)   🟠 3–30s (aging)   🔴 >30s (stale)
            The banner is purely presentational; the server always
            serves the best available price. */}
        {(() => {
          // Determine market-open state from whichever source
          // actually has data. `kiteStatus` usually arrives first // @deprecated marker
          // (5s poll cadence, no DB reads) so prefer it. Only fall
          // back to `freshness` if the status poll hasn't landed.
          // The previous `freshness?.market_open !== false` check
          // returned `true` when freshness was null — which made
          // the banner claim "Live" even when the market was
          // closed and no data had loaded yet.
          let marketOpen: boolean;
          if (typeof kiteStatus?.marketIsOpen === 'boolean') { // @deprecated marker
            marketOpen = kiteStatus.marketIsOpen; // @deprecated marker
          } else if (typeof freshness?.market_open === 'boolean') {
            marketOpen = freshness.market_open;
          } else {
            // No data yet — optimistic default, immediately
            // corrected by the first status or freshness poll.
            marketOpen = true;
          }
          const marketLabel =
            kiteStatus?.marketLabel ?? // @deprecated marker
            freshness?.market_label ??
            (marketOpen ? 'Open' : 'Closed');
          // Kite-only mode: tick telemetry available via the WS layer // @deprecated marker
          // when subscribed; for the dashboard summary we keep the
          // simple two-state badge (live vs no-stream).
          const lastTickIST: string | null = null;
          const tickDot = '#10B981';
          const tickDotLabel = 'kite stream'; // @deprecated marker

          let bg = '#FFFBEB', fg = '#92400E', border = '#FDE68A';
          let dot = '#F59E0B';
          let headline: string;
          let sub: string;
          // Spec SIGNAL_ENGINE_FIXED_AND_CLEAN §6 — provider-aware
          // banner copy. The closed-mode payload exposes data_source,
          // and `last_close_signals` means the dashboard is reading
          // bootstrap-seeded NSE rows (not the prior Yahoo fallback).
          // Default to the live IndianAPI string when the market is
          // open and no closed-mode envelope is set.
          const closedDataSource = marketClosed?.data_source ?? null;
          const isBootstrapData = isBootstrap || closedDataSource === 'last_close_signals'
                                || closedDataSource === 'market_close_snapshot';
          if (!marketOpen) {
            headline = `Market ${marketLabel}`;
            const approvedZero = (counters?.approvedTotal ?? 0) === 0;
            sub = approvedZero && (watchlistTotal > 0 || highPotential.length > 0)
              ? 'Market Closed — Showing last-close watchlist candidates'
              : isBootstrap
                ? 'Operating on Bootstrap Data (NSE manual seed)'
                : closedDataSource === 'last_close_signals'
                  ? 'Showing last market signals (NSE Bootstrap)'
                  : closedDataSource === 'market_close_snapshot'
                    ? 'Showing last-close prices (NSE Bootstrap snapshot)'
                    : 'Market closed — no stored signals to show.';
          } else {
            // SIGNAL-ENGINE-COPY-2026-05 — use the unified
            // providerInFallback so the banner can't read "Live Mode"
            // while the badge above reads Fallback: Yes (or vice versa).
            headline = providerInFallback ? 'Live Engine (Fallback Mode)' : 'Live Engine (Live Mode)';
            sub = providerInFallback
              ? 'Provider operating in fallback mode. Signal approval is restricted until live data health is restored.'
              : 'Primary feed active. All institutional gates clear.';
          }

          return (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              padding: '10px 14px', borderRadius: 8,
              background: bg, color: fg, border: `1px solid ${border}`,
              marginBottom: 16, fontSize: 13,
            }}>
              <span style={{
                display: 'inline-block', width: 10, height: 10, borderRadius: 99,
                background: dot, flexShrink: 0,
              }} />
              <div style={{ flex: 1, minWidth: 260 }}>
                <strong>{headline}</strong>
                <span style={{ opacity: 0.85, marginLeft: 8 }}>{sub}</span>
                {/* Spec §7 — visible badge when the dashboard is reading
                    bootstrap-seeded rows. Disambiguates "real live data"
                    from "one-time NSE seed" so operators don't trade off
                    the seed during off-hours. */}
                {isBootstrapData && (
                  <span style={{
                    display: 'inline-block',
                    marginLeft: 10, padding: '2px 8px',
                    borderRadius: 99,
                    background: '#FEF3C7', color: '#92400E',
                    border: '1px solid #FDE68A',
                    fontSize: 11, fontWeight: 600,
                  }}>
                    ⚠️ Bootstrap Data (Temporary)
                  </span>
                )}
              </div>
              {/* IST wall clock + tri-state freshness dot — always
                  rendered so the operator can verify the feed at a
                  glance. When the market is closed or no tick has
                  arrived yet, the dot goes grey with "no ticks". */}
              <div
                title={`tick age: ${tickDotLabel}`}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '2px 10px', borderRadius: 99,
                  background: 'rgba(255,255,255,0.55)',
                  border: `1px solid ${border}`,
                  fontSize: 12, fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                <span style={{
                  display: 'inline-block', width: 8, height: 8, borderRadius: 99,
                  background: tickDot, flexShrink: 0,
                }} />
                <span>Last Tick: {lastTickIST ?? '—'}</span>
              </div>
            </div>
          );
        })()}

        {/* ── Deep signal lookup ── */}
        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 4 }}>
            <Search size={16} color="#94A3B8" style={{ flexShrink: 0 }} />
            <input
              className="input"
              placeholder="Deep analysis: type any equity symbol (e.g. RELIANCE, TCS, HDFC)…"
              value={query}
              onChange={e => handleSearch(e.target.value)}
              style={{ height: 44 }}
            />
          </div>
          <div style={{ fontSize: 11, color: '#94A3B8', paddingLeft: 26 }}>
            Runs full signal engine live — factor scoring, confidence, R:R levels, rejection analysis
          </div>
          {srLoading && (
            <div style={{ marginTop: 12, fontSize: 13, color: '#64748B', display: 'flex', alignItems: 'center', gap: 6 }}>
              <Activity size={13} /> Analysing {query.toUpperCase()}…
            </div>
          )}
          {srResult && !srLoading && <SearchResult data={srResult} symbol={query.toUpperCase()} />}
        </Card>

        {/* PHASE_3_DAILY_INTELLIGENCE_2026-05 — link to the full report.
            Shows a tiny ready/partial chip so the operator can see
            whether the daily report is populated before clicking. */}
        {(() => {
          const ready    = dailyReportPreview?.ready === true;
          const status   = dailyReportPreview?.reportStatus ?? 'INSUFFICIENT_DATA';
          const chipPal: Record<string, { bg: string; color: string; border: string }> = {
            COMPLETE:          { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0' },
            PARTIAL:           { bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
            PENDING:           { bg: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE' },
            INSUFFICIENT_DATA: { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1' },
          };
          const pal = chipPal[status] ?? chipPal.INSUFFICIENT_DATA;
          const subtext = status === 'COMPLETE'
            ? 'Daily report ready'
            : status === 'PARTIAL'
              ? 'Daily report partial — outcome data still pending'
              : status === 'PENDING'
                ? 'Daily report pending'
                : 'Daily report awaiting post-signal data';
          return (
            <div style={{
              margin: '0 0 12px 0',
              padding: '10px 14px',
              background: '#FFFFFF',
              border: '1px solid #E2E8F0',
              borderRadius: 8,
              display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
              fontSize: 12.5,
            }}>
              <FileText size={16} color="#1D4ED8" />
              <span style={{ fontWeight: 800, color: '#0F172A', letterSpacing: 0.3 }}>
                Daily Signal Intelligence Report
              </span>
              <span style={{
                padding: '2px 8px', borderRadius: 999,
                background: pal.bg, color: pal.color,
                border: `1px solid ${pal.border}`,
                fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
              }}>
                {status === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT DATA' : status}
              </span>
              <span style={{ color: '#475569' }}>{subtext}</span>
              {dailyReportPreview?.topBlockReason && (
                <span style={{ color: '#94A3B8', fontSize: 11 }}>
                  · Top block: <strong style={{ color: '#B91C1C' }}>{dailyReportPreview.topBlockReason}</strong>
                </span>
              )}
              <div style={{ flex: 1 }} />
              <Link
                href="/signals/daily-report"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 6,
                  background: ready ? '#1D4ED8' : '#F8FAFC',
                  color: ready ? '#FFFFFF' : '#475569',
                  border: `1px solid ${ready ? '#1D4ED8' : '#E2E8F0'}`,
                  fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
                  textDecoration: 'none',
                }}
                title="Open the full Daily Signal Intelligence Report"
              >
                View Daily Report <ChevronRight size={12} />
              </Link>
              <Link
                href="/signals/backtesting"
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 6,
                  background: '#F8FAFC', color: '#475569',
                  border: '1px solid #E2E8F0',
                  fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
                  textDecoration: 'none',
                }}
                title="Open the Signal Backtesting Lab"
              >
                <FlaskConical size={12} /> Open Backtesting Lab
              </Link>
              {/* PHASE_5_HEALTH_OBSERVABILITY_2026-05 — Engine Health link.
                  Color reflects the overall health preview so an operator
                  sees a warning hint without leaving the dashboard. */}
              {(() => {
                const hp = healthPreview;
                const overall = hp?.overallStatus ?? 'UNKNOWN';
                const pal: Record<string, { bg: string; color: string; border: string }> = {
                  HEALTHY:  { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0' },
                  WARNING:  { bg: '#FFFBEB', color: '#92400E', border: '#FDE68A' },
                  DEGRADED: { bg: '#FEF2F2', color: '#991B1B', border: '#FECACA' },
                  BROKEN:   { bg: '#FEE2E2', color: '#7F1D1D', border: '#FCA5A5' },
                  UNKNOWN:  { bg: '#F8FAFC', color: '#475569', border: '#E2E8F0' },
                };
                const p = pal[overall] ?? pal.UNKNOWN;
                return (
                  <Link
                    href="/signals/engine-health"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '6px 12px', borderRadius: 6,
                      background: p.bg, color: p.color,
                      border: `1px solid ${p.border}`,
                      fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
                      textDecoration: 'none',
                    }}
                    title={hp?.primaryBlockingReason ?? 'Open the Engine Health Map'}
                  >
                    <Activity size={12} /> Engine Health · {overall}
                  </Link>
                );
              })()}
            </div>
          );
        })()}

        {/* PHASE_5_HEALTH_OBSERVABILITY_2026-05 — inline warning banner
            when the engine health preview reports DEGRADED/BROKEN/STALE
            so the operator sees the problem without clicking through. */}
        {healthPreview
          && (healthPreview.overallStatus === 'DEGRADED' || healthPreview.overallStatus === 'BROKEN')
          && (
          <div style={{
            margin: '0 0 12px 0',
            padding: '8px 12px',
            background: healthPreview.overallStatus === 'BROKEN' ? '#FEE2E2' : '#FEF2F2',
            border: `1px solid ${healthPreview.overallStatus === 'BROKEN' ? '#FCA5A5' : '#FECACA'}`,
            borderRadius: 6,
            color: healthPreview.overallStatus === 'BROKEN' ? '#7F1D1D' : '#991B1B',
            fontSize: 12, fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
          }}>
            <AlertTriangle size={14} />
            <strong>Engine Health Warning ({healthPreview.overallStatus}):</strong>
            {/* SIGNAL-ENGINE-COPY-2026-05 — when the unified
                providerInFallback flag is true, use the controlled
                institutional copy so the warning never contradicts the
                Fallback badge / Live Engine banner. Otherwise fall
                through to whatever the health preview reported. */}
            <span>
              {providerInFallback
                ? 'Provider operating in fallback mode. Signal approval is restricted until live data health is restored.'
                : (healthPreview.primaryBlockingReason
                    ?? 'Pipeline is not at full health — see Engine Health Map.')}
            </span>
            <Link href="/signals/engine-health" style={{ color: 'inherit', textDecoration: 'underline', fontWeight: 700 }}>
              View Engine Health →
            </Link>
          </div>
        )}

        {/* PHASE_2_DUE_DILIGENCE_2026-05 — top-level Due Diligence Summary.
            Shows the aggregate stats (top block reason, high-score-not-
            approved count, low-RR blocked, stale-blocked, etc.) so the
            operator can see WHY the engine produced what it produced
            before drilling into the per-row analysis. */}
        <DueDiligenceSummaryStrip summary={dueDiligenceSummary} />

        {/* PHASE_1_RANKING_AND_NEAREST_SIGNAL_2026-05 — Closest to Approval.
            Renders only when no approved signal is currently available so
            the dashboard never looks empty. Each card explains the gap
            between the candidate and the institutional bar. Warning copy
            makes it explicit these are NOT execution-ready. */}
        {(counters?.approvedTotal ?? validRows.length) === 0 && nearestSignals && nearestSignals.length > 0 && (
          <Card style={{ marginBottom: 20, borderColor: '#FCD34D', background: '#FFFBEB' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <Target size={18} color="#B45309" style={{ marginTop: 2, flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 800, color: '#92400E', letterSpacing: 0.3 }}>
                    Closest to Approval
                  </h3>
                  <span style={{
                    fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                    padding: '2px 8px', borderRadius: 999,
                    background: '#FEF3C7', color: '#92400E',
                    border: '1px solid #FDE68A',
                  }}>
                    {nearestSignals.length} CANDIDATE{nearestSignals.length === 1 ? '' : 'S'}
                  </span>
                  {marketStatus && !marketStatus.isOpen && (
                    <span style={{
                      fontSize: 10, fontWeight: 700,
                      padding: '2px 8px', borderRadius: 999,
                      background: '#F1F5F9', color: '#475569',
                      border: '1px solid #CBD5E1',
                    }}>
                      MARKET CLOSED
                    </span>
                  )}
                </div>
                <div style={{ marginTop: 4, fontSize: 12.5, color: '#78350F', fontWeight: 500 }}>
                  {closestToApproval?.reason
                    ?? (marketStatus && !marketStatus.isOpen
                        ? 'Market Closed — nearest candidates from last close. Awaiting fresh market confirmation.'
                        : 'No approved signal is available right now. Showing the nearest institutional candidates by final score and approval gap.')}
                </div>
                <div style={{ marginTop: 4, fontSize: 11, color: '#A16207', fontWeight: 600 }}>
                  These are not execution-ready signals. They are nearest candidates awaiting institutional confirmation.
                </div>
              </div>
            </div>
            <div style={{
              marginTop: 14,
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
              gap: 12,
            }}>
              {nearestSignals.map((row, idx) => {
                const dirStyle =
                  row.direction === 'BUY'  ? { color: '#16A34A', bg: '#F0FDF4' } :
                  row.direction === 'SELL' ? { color: '#DC2626', bg: '#FEF2F2' } :
                                              { color: '#475569', bg: '#F1F5F9' };
                const fs = row.final_score != null ? Number(row.final_score).toFixed(1) : '—';
                const cs = row.confidence_score != null ? Number(row.confidence_score).toFixed(1) : '—';
                const rr = row.risk_reward != null ? Number(row.risk_reward).toFixed(2) : '—';
                const gap = Number(row.approvalGap ?? 0).toFixed(1);
                return (
                  <div key={`${row.symbol}-${idx}`} style={{
                    background: '#FFFFFF',
                    border: '1px solid #FDE68A',
                    borderRadius: 8,
                    padding: '12px 14px',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                        <span style={{ fontWeight: 800, fontSize: 14, color: '#0F172A', letterSpacing: 0.4 }}>
                          {row.symbol}
                        </span>
                        {row.direction && (
                          <span style={{
                            fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                            padding: '2px 6px', borderRadius: 4,
                            color: dirStyle.color, background: dirStyle.bg,
                            border: `1px solid ${dirStyle.color}33`,
                          }}>
                            {row.direction}
                          </span>
                        )}
                      </div>
                      <span style={{
                        fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                        padding: '2px 6px', borderRadius: 4,
                        color: '#92400E', background: '#FEF3C7',
                        border: '1px solid #FDE68A',
                      }} title={`Status: ${row.status}`}>
                        {row.status.toUpperCase()}
                      </span>
                    </div>
                    <div style={{
                      marginTop: 8,
                      display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
                      gap: 6, fontSize: 11, color: '#475569',
                    }}>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 600, color: '#94A3B8' }}>FINAL</div>
                        <div style={{ fontWeight: 700, color: '#0F172A' }}>{fs}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 600, color: '#94A3B8' }}>CONF</div>
                        <div style={{ fontWeight: 700, color: '#0F172A' }}>{cs}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 600, color: '#94A3B8' }}>R:R</div>
                        <div style={{ fontWeight: 700, color: '#0F172A' }}>{rr}</div>
                      </div>
                    </div>
                    <div style={{
                      marginTop: 8,
                      display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
                    }}>
                      <span style={{ color: '#94A3B8', fontWeight: 600 }}>APPROVAL GAP</span>
                      <span style={{ fontWeight: 800, color: '#B45309' }}>{gap}</span>
                      <span style={{
                        fontSize: 10, fontWeight: 600, letterSpacing: 0.3,
                        padding: '1px 5px', borderRadius: 4,
                        background: '#FEF3C7', color: '#92400E',
                      }}>
                        Not Approved Yet
                      </span>
                    </div>
                    {row.missingApprovalFactors && row.missingApprovalFactors.length > 0 && (
                      <div style={{
                        marginTop: 6,
                        fontSize: 11, color: '#78350F', lineHeight: 1.4,
                      }}>
                        <span style={{ fontWeight: 700, color: '#92400E' }}>Missing:</span>{' '}
                        {row.missingApprovalFactors.join(', ')}
                      </div>
                    )}
                    <div style={{
                      marginTop: 6,
                      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                    }}>
                      {row.is_stale && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                          padding: '1px 6px', borderRadius: 999,
                          background: '#F1F5F9', color: '#475569',
                          border: '1px solid #CBD5E1',
                        }} title="Awaiting fresh tick confirmation">
                          Stale / Awaiting Fresh Confirmation
                        </span>
                      )}
                      {row.is_bootstrap && (
                        <span style={{
                          fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                          padding: '1px 6px', borderRadius: 999,
                          background: '#FEF3C7', color: '#92400E',
                          border: '1px solid #FDE68A',
                        }} title="Surfaced from bootstrap-seeded NSE data">
                          Bootstrap Candidate
                        </span>
                      )}
                    </div>
                    {/* PHASE_2_DUE_DILIGENCE_2026-05 — nearest signal
                        per-card analysis toggle. Shows the same panel
                        used by the row tables so reasoning is consistent. */}
                    {row.dueDiligence && (() => {
                      const cardKey = `nearest-${row.symbol}-${idx}`;
                      const isOpen = expandedDDRows.has(cardKey);
                      return (
                        <div style={{ marginTop: 8 }}>
                          <button
                            type="button"
                            onClick={() => toggleDDRow(cardKey)}
                            style={{
                              fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
                              padding: '4px 10px', borderRadius: 6,
                              background: '#FFFFFF', color: '#92400E',
                              border: '1px solid #FDE68A', cursor: 'pointer',
                            }}
                            title="Why is this candidate not yet approved?"
                          >
                            {isOpen ? 'Hide Analysis' : 'View Analysis'}
                          </button>
                          {isOpen && (
                            <div style={{ marginTop: 8 }}>
                              <DueDiligencePanel
                                dueDiligence={row.dueDiligence}
                                performanceReview={row.performanceReview}
                                manipulationRisk={(row as { manipulationRisk?: WireManipulationRisk | null }).manipulationRisk}
                              />
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                );
              })}
            </div>
          </Card>
        )}

        {/* PRODUCTION_TABS_2026-05 — 4-tab production layout. Backend
            tier fields stay granular; the UI groups them so users
            always see meaningful data without 6 sparse tabs.
              APPROVED       → signals[] (strict)
              HIGH_POTENTIAL → high_potential[] (conditional)
              WATCHLIST      → developing[] + scanner_candidates[] + watchlist[]
              REJECTED       → rejected[] + risk_restricted[]
            Counts shown on each tab match the underlying tier sums. */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {([
            // Use max(server, local) so a zero/stale server counter never
            // disables a tab whose underlying arrays actually have rows.
            // The server's counters block can lag behind the granular
            // arrays (different code paths populate them), and we'd
            // rather over-count by one than hide a populated tab.
            { key: 'APPROVED'       as const, label: 'APPROVED',       count: Math.max(counters?.approvedTotal       ?? 0, validRows.length),       icon: <Shield        size={13} /> },
            { key: 'HIGH_POTENTIAL' as const, label: 'HIGH POTENTIAL', count: Math.max(counters?.highPotentialTotal  ?? 0, highPotential.length),   icon: <Zap           size={13} /> },
            { key: 'WATCHLIST'      as const, label: 'WATCHLIST',      count: Math.max(counters?.watchlistTotal      ?? 0, watchlistTotal),         icon: <Activity      size={13} /> },
            { key: 'REJECTED'       as const, label: 'REJECTED',       count: Math.max(counters?.rejectedTotal       ?? 0, rejectedTotal),          icon: <AlertTriangle size={13} /> },
          ]).map(t => {
            const isActive   = activeTab === t.key;
            const isEmpty    = t.count === 0;
            const isHiPotTab = t.key === 'HIGH_POTENTIAL';
            // HIGH_POTENTIAL gets a subtle amber accent when the
            // conditional fallback is active so the operator's eye
            // catches the "non-strict" tab even before clicking it.
            const accent =
              isHiPotTab && conditionalModeActive && !isActive
                ? { borderColor: '#F59E0B', color: '#92400E', background: '#FFFBEB' }
                : undefined;
            return (
              <button key={t.key}
                className={`btn btn--sm ${isActive ? 'btn--primary' : 'btn--secondary'}`}
                onClick={() => {
                  // Strict lock — any explicit in-session click suppresses
                  // both the userSelected gate and the once-per-mount
                  // auto-rescue, so the operator's deliberate choice is
                  // never overridden by a subsequent poll's data shift.
                  userSelectedTabRef.current = true;
                  didAutoSelectRef.current   = true;
                  sessionStorage.setItem('q365_signals_active_tab', t.key);
                  // eslint-disable-next-line no-console
                  console.log('[TAB_USER_SWITCH]', { from: activeTab, to: t.key });
                  setActiveTab(t.key);
                }}
                disabled={isEmpty && !isActive}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  fontWeight: 700, letterSpacing: 0.3,
                  opacity: isEmpty && !isActive ? 0.45 : 1,
                  cursor: isEmpty && !isActive ? 'not-allowed' : 'pointer',
                  ...(accent ?? {}),
                }}
                title={isEmpty ? `${t.label} — no rows in this tier this cycle` : t.label}
              >
                {t.icon}
                {t.label} ({t.count})
              </button>
            );
          })}
        </div>

        {/* APPROVED-tab direction filter — only relevant when there are
            tradable signals to slice. Hidden in the REJECTED view. */}
        {activeTab === 'APPROVED' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          {(['ALL', 'BUY', 'SELL'] as const).map(t => (
            <button key={t}
              className={`btn btn--sm ${tab === t ? 'btn--primary' : 'btn--secondary'}`}
              onClick={() => setTab(t)}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {t === 'BUY' && <TrendingUp size={13} />}
              {t === 'SELL' && <TrendingDown size={13} />}
              {t} ({t === 'ALL' ? validRows.length : t === 'BUY' ? buySignals.length : sellSignals.length})
            </button>
          ))}
          {/* Spec ELITE-2026-05 — single elite-only quality badge. The
              previous "High Confidence" / "Medium Confidence" tiers
              are retired: the elite gate admits only INSTITUTIONAL_
              HIGH_CONVICTION + HIGH_CONVICTION at the strict elite
              floors, so there is no second tier to label. RELAXED is
              gone too — the closed-market fallback now goes through
              the elite gate and ships empty if nothing qualifies. The
              badge fires whenever the table is non-empty so the user
              sees explicit confirmation that what's on screen is
              elite-grade. */}
          {validRows.length > 0 && (
            <span style={{
              padding: '4px 10px', borderRadius: 999,
              fontSize: 11, fontWeight: 700,
              background: '#EDE9FE', color: '#5B21B6',
              border: '1px solid #C4B5FD',
              display: 'inline-flex', alignItems: 'center', gap: 4,
            }} title="elite institutional gate — confidence ≥ 75, institutional_score ≥ 80, rr ≥ 2.0, stress ≥ 75, freshness fresh, live VALID">
              <Shield size={12} /> Institutional Grade
            </span>
          )}
        </div>
        )}

        {/* PRODUCTION_TABS_2026-05 — REJECTED engine-funnel panel was
            here; moved BELOW the row table so the operator sees the
            concrete risk_restricted rows first, then the explanation
            funnel for everything else the engine rejected. */}

        {/* PRODUCTION_TABS_2026-05 — banners per tab. APPROVED has no
            banner (strict default state); HIGH_POTENTIAL / WATCHLIST /
            REJECTED each cite their purpose so users immediately
            understand what they're looking at. WATCHLIST + REJECTED
            also surface a per-source count strip so the merged view
            doesn't hide where each row came from. */}
        {activeTab === 'HIGH_POTENTIAL' && (
          <div style={{
            margin: '0 0 12px 0', padding: '10px 14px',
            background: '#FFFBEB',
            border: '1px solid #FCD34D',
            borderRadius: 8, color: '#92400E',
            display: 'flex', alignItems: 'flex-start', gap: 10,
            fontSize: 13, fontWeight: 600,
          }}>
            <Zap size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 2 }}>
                High Potential — Not Approved Yet
              </div>
              <div style={{ fontWeight: 500, color: '#78350F' }}>
                {emptyStateMessage
                  ?? `No fully confirmed signals. Showing ${highPotential.length} strongest conditional opportunit${highPotential.length === 1 ? 'y' : 'ies'}.`}
              </div>
              {conditionalFloors && (
                <div style={{ fontWeight: 500, color: '#A16207', fontSize: 11.5, marginTop: 4 }}>
                  Softer floors: confidence ≥ {conditionalFloors.confidence}, RR ≥ {conditionalFloors.rr}, max {conditionalFloors.max_rows} rows. Strict APPROVED tab remains pure.
                </div>
              )}
            </div>
          </div>
        )}
        {activeTab === 'WATCHLIST' && watchlistTotal > 0 && (
          <div style={{
            margin: '0 0 12px 0', padding: '10px 14px',
            background: '#EFF6FF',
            border: '1px solid #BFDBFE',
            borderRadius: 8, color: '#1E40AF',
            display: 'flex', alignItems: 'flex-start', gap: 10,
            fontSize: 13, fontWeight: 600,
          }}>
            <Activity size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5 }}>Watchlist — early-stage opportunities & setups under monitoring</div>
              <div style={{ fontWeight: 500, color: '#1E3A8A' }}>
                Not actionable yet. Approval requires confirmation, clean provider health, and risk-gate clearance.
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6, fontSize: 11.5, fontWeight: 600 }}>
                <span style={{ background: '#DBEAFE', color: '#1E3A8A', padding: '2px 8px', borderRadius: 999 }}>
                  Awaiting Confirmation: {developing.length}
                </span>
                <span style={{ background: '#E0E7FF', color: '#3730A3', padding: '2px 8px', borderRadius: 999 }}>
                  Emerging Opportunity: {scannerCandidates.length}
                </span>
                <span style={{ background: '#E2E8F0', color: '#334155', padding: '2px 8px', borderRadius: 999 }}>
                  Monitor: {watchlist.length}
                </span>
              </div>
            </div>
          </div>
        )}
        {activeTab === 'REJECTED' && rejectedTotal > 0 && (
          <div style={{
            margin: '0 0 12px 0', padding: '10px 14px',
            background: '#FEF2F2',
            border: '1px solid #FECACA',
            borderRadius: 8, color: '#991B1B',
            display: 'flex', alignItems: 'flex-start', gap: 10,
            fontSize: 13, fontWeight: 600,
          }}>
            <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13.5 }}>Rejected — why these signals are blocked or downgraded</div>
              <div style={{ fontWeight: 500, color: '#7F1D1D' }}>
                Audit only. DO NOT trade these — surfaced so the operator can see exactly which gate caught each row.
              </div>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 6, fontSize: 11.5, fontWeight: 600 }}>
                <span style={{ background: '#FECACA', color: '#7F1D1D', padding: '2px 8px', borderRadius: 999 }}>
                  Risk Restricted: {riskRestricted.length}
                </span>
                <span style={{ background: '#FEE2E2', color: '#991B1B', padding: '2px 8px', borderRadius: 999 }}>
                  Rejected by Engine: {rejected.length}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* PRODUCTION_TABS_2026-05 — main row table renders for all
            four tabs. REJECTED additionally shows the engine-funnel
            panel beneath (see below). */}
        {(<>
        {/* ── Signal table (ALL merges in live stocks as synthetic rows) ── */}
        <Card flush>
          {/*
            Last-Known-Good banner. Set by acceptResponse() whenever
            the gate refuses an empty/partial/stale response. Stays up
            until the next response is verified non-empty (cleared in
            commitAccepted). Keeps the user informed that the table
            they see is the prior good snapshot, not the most recent
            (degraded) wire payload.
          */}
          {/* Live scan-progress badge. Visible only while a Yahoo // @deprecated marker
              auto-rebuild is in flight; rendered above any other
              banner so the operator always knows the page is doing
              work in the background even when the table is fully
              populated from the prior batch. */}
          {scanProgress && scanProgress.total > 0 && (
            <div style={{
              padding: '8px 14px',
              background: '#ECFDF5',
              color: '#065F46',
              fontSize: 12,
              fontWeight: 600,
              borderBottom: '1px solid #A7F3D0',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <RefreshCw
                size={13}
                style={{ animation: 'sig-empty-spin 1s linear infinite' }}
              />
              <style>{`
                @keyframes sig-empty-spin {
                  from { transform: rotate(0deg); }
                  to   { transform: rotate(360deg); }
                }
              `}</style>
              <span>
                Yahoo scan: {scanProgress.done.toLocaleString()} / {scanProgress.total.toLocaleString()} stocks // @deprecated marker
                {' '}({Math.round((scanProgress.done / scanProgress.total) * 100)}%)
              </span>
              {scanProgress.lastSymbol && (
                <span style={{ color: '#047857', fontWeight: 500 }}>
                  · last: {scanProgress.lastSymbol}
                </span>
              )}
              <span style={{ marginLeft: 'auto', color: '#047857', fontWeight: 500 }}>
                {Math.round((Date.now() - scanProgress.startedAt) / 1000)}s elapsed
              </span>
            </div>
          )}
          {lkgWarning && shown.length > 0 && (
            <div style={{
              padding: '8px 14px',
              background: '#FEF3C7',
              color: '#92400E',
              fontSize: 12,
              fontWeight: 600,
              borderBottom: '1px solid #FDE68A',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}>
              <AlertTriangle size={13} />
              {lkgWarning}
            </div>
          )}
          {pipelineRunning && shown.length > 0 && (
            <div style={{
              padding: '8px 14px',
              background: '#DBEAFE',
              color: '#1E40AF',
              fontSize: 12,
              fontWeight: 600,
              borderBottom: '1px solid #BFDBFE',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}>
              <RefreshCw size={13} className="sig-skel-spin" />
              Pipeline running — keeping last validated signals visible until the new batch lands.
            </div>
          )}
          {activeTab === 'HIGH_POTENTIAL' && (
            <div style={{
              margin: '0 0 16px 0', padding: '12px 16px',
              background: 'rgba(59, 130, 246, 0.1)',
              border: '1px solid rgba(59, 130, 246, 0.4)',
              borderRadius: 8, color: '#1E40AF',
            }}>
              <strong>High Potential — Not Approved Yet</strong>
              <div style={{ fontSize: 12, marginTop: 4, opacity: 0.9 }}>
                These candidates cleared the conditional entry gate (Confidence &gt;60) but have not yet reached the institutional 75% threshold. Monitor for momentum expansion.
              </div>
            </div>
          )}
          {/*
            Live-data status banner.

            ROOT CAUSE BUG (Apr 2026): the previous condition was
            `!wsConnected && !loading`, which depended on the
            useLivePrices hook's per-tick WebSocket. That WS is
            INTENTIONALLY DISABLED in Yahoo-only / signal-only mode // @deprecated marker
            (tick_ws_state='disabled' in the freshness probe). So
            wsConnected was permanently false → the "Connecting to
            live market data…" banner stayed up forever even when
            the page was actually receiving live data via SSE + the
            10s HTTP poll. Operator perception: "data isn't updating"
            because the warning banner contradicted the live numbers.

            New behaviour: gate the banner on the actual live-data
            transport — the SSE signal stream. Show "connecting" only
            when:
              1. We don't have any data yet (shown.length === 0), AND
              2. The SSE stream isn't pushing frames (either never
                 connected, or last push was more than 20s ago — well
                 past the 5s SSE cadence + jitter buffer).
            This keeps the banner useful (true SSE outage) without
            firing on the WS-disabled-by-design state. The 5s heartbeat
            from setUiTick re-evaluates the staleness check so the
            banner appears within seconds of an SSE outage.
          */}
          {(() => {
            if (loading) return null;
            if (shown.length > 0) return null;
            const ssePushAge = stream.lastPushAt
              ? Date.now() - stream.lastPushAt
              : Number.POSITIVE_INFINITY;
            const sseAlive = stream.connected && ssePushAge < 20_000;
            if (sseAlive) return null;
            return (
              <div style={{
                padding: '8px 14px',
                background: '#FEF9C3',
                color: '#A16207',
                fontSize: 12,
                fontWeight: 600,
                borderBottom: '1px solid #FDE68A',
              }}>
                Connecting to live signal stream… rows will appear as soon as the first frame lands.
              </div>
            );
          })()}
          {/*
            Three-state render. The previous binary `loading || empty`
            check flashed "No signals in database" prematurely while the
            SSE stream was still establishing OR while the initial DB
            query was returning an empty fallback (cold cache, slow query).
            The new condition keeps the skeleton up until either:
              - real data arrives (shown.length > 0), OR
              - the SSE stream has fully resolved (connecting=false) AND
                the initial HTTP load has finished (loading=false), AND
                we still have no rows AND no pipeline is running.
            That means the user only sees the "No signals" CTA when
            we're genuinely sure the DB is empty, not during transient
            loading windows.
          */}
          {(() => {
            // Spec §3 — skeleton ONLY when we have zero rows AND are
            // genuinely loading. Once `shown.length > 0` we always
            // render the table, so a slow background poll can't
            // re-trigger the "Loading signals from database…" splash
            // and replace the populated table.
            const hasData   = shown.length > 0;
            const isLoading = !hasData && (loading || stream.connecting);
            const isEmpty   = !isLoading && !hasData;

            if (isLoading) {
              // Animated skeleton table — gives the user immediate
              // visual feedback that the page is alive and working,
              // instead of a blank box or a single spinner. The pulse
              // animation runs via the same `sig-skeleton-pulse` keyframes
              // defined in the global stylesheet (added below).
              return (
                <div style={{ padding: 12 }}>
                  <style>{`
                    @keyframes sig-skeleton-pulse {
                      0%, 100% { opacity: 0.55; }
                      50%      { opacity: 0.95; }
                    }
                    .sig-skel {
                      background: linear-gradient(90deg, #E2E8F0 0%, #F1F5F9 50%, #E2E8F0 100%);
                      background-size: 200% 100%;
                      animation: sig-skeleton-shimmer 1.4s ease-in-out infinite;
                      border-radius: 4px;
                    }
                    @keyframes sig-skeleton-shimmer {
                      0%   { background-position:  100% 0; }
                      100% { background-position: -100% 0; }
                    }
                    @keyframes sig-skeleton-spin {
                      from { transform: rotate(0deg); }
                      to   { transform: rotate(360deg); }
                    }
                    .sig-skel-spin {
                      animation: sig-skeleton-spin 1s linear infinite;
                      transform-origin: center;
                    }
                  `}</style>
                  <div style={{ marginBottom: 14, display: 'flex', alignItems: 'center', gap: 10, color: '#64748B', fontSize: 13 }}>
                    {/* Inline spin class instead of `styles.spin` —
                        styles isn't imported in this file, which threw
                        "styles is not defined" at runtime. */}
                    <RefreshCw size={14} className="sig-skel-spin" />
                    <span>Loading signals from database…</span>
                  </div>
                  {/* Header row skeleton */}
                  <div style={{ display: 'grid', gridTemplateColumns: '32px 110px 60px 110px 80px repeat(6, 1fr)', gap: 12, padding: '10px 12px', background: '#F8FAFC', borderRadius: 6, marginBottom: 8 }}>
                    {Array.from({ length: 11 }).map((_, i) => (
                      <div key={`h-${i}`} className="sig-skel" style={{ height: 10 }} />
                    ))}
                  </div>
                  {/* Data row skeletons */}
                  {Array.from({ length: 8 }).map((_, r) => (
                    <div
                      key={`r-${r}`}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '32px 110px 60px 110px 80px repeat(6, 1fr)',
                        gap: 12,
                        padding: '12px',
                        borderBottom: '1px solid #F1F5F9',
                        animation: `sig-skeleton-pulse 1.6s ease-in-out infinite`,
                        animationDelay: `${r * 0.08}s`,
                      }}
                    >
                      {Array.from({ length: 11 }).map((_, c) => (
                        <div key={`r${r}-c${c}`} className="sig-skel" style={{ height: 14 }} />
                      ))}
                    </div>
                  ))}
                </div>
              );
            }

            if (isEmpty) {
              // Per-tab visibility fix (2026-05): the generic "No signals
              // in database" splash below is APPROVED-tab framing. When
              // the operator is on REJECTED / HIGH_POTENTIAL / WATCHLIST
              // and that tier's row table is empty but data exists for
              // the tab (rejected funnel panel below, or sister arrays
              // that didn't make it into `shown`), this splash hides the
              // actual content. Render a lightweight per-tab line
              // instead — or nothing, when a sibling panel below will
              // do the talking.
              if (activeTab === 'REJECTED') {
                // The funnel-shape rejected[] panel renders BELOW this
                // card via RejectedSignalsPanel. If it has rows or a
                // funnel summary, the table card stays quiet so the
                // panel reads as the primary view.
                if (rejected.length > 0 || funnel) return null;
                return (
                  <div style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
                    No rejected rows in the current scan window.
                  </div>
                );
              }
              if (activeTab === 'HIGH_POTENTIAL') {
                return (
                  <div style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
                    {emptyStateMessage
                      ?? 'No conditional-tier setups this cycle. Strict APPROVED tab remains the trade source.'}
                  </div>
                );
              }
              if (activeTab === 'WATCHLIST') {
                return (
                  <div style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
                    {emptyStateMessage
                      ?? 'No symbols on the watchlist this cycle.'}
                  </div>
                );
              }
              // Diagnose WHY the main table is empty so the user
              // doesn't think the page is broken when the API is
              // working correctly. Three common cases:
              //   1. Partial scan (last batch covered <80% of universe
              //      → most signals never reached the strict gate).
              //   2. Stale batch (last_pipeline_run > 12h ago →
              //      decay_state has aged everything to 'stale').
              //   3. DB really empty (total_stored_signals=0 → first
              //      ever run, fresh deploy, etc.).
              // In every non-(3) case we also point at any emerging
              // setups that DID survive — the row is rendered below
              // but the user might miss it because the main table
              // banner makes the page look empty.
              const totalStored      = freshness?.total_stored_signals ?? null;
              const persistedCount   = freshness?.latest_batch_symbols ?? null;
              const universeSize     = freshness?.universe_size ?? null;
              const lastRun          = freshness?.last_pipeline_run ?? null;
              // Honest partial-scan flag from the API (now driven by the
              // scanner's own partialScanWarning, not persistence %).
              const isPartial        = freshness?.is_partial_scan === true;
              const lastRunAgeH      = lastRun ? Math.round((Date.now() - new Date(lastRun).getTime()) / 3_600_000 * 10) / 10 : null;
              const isStaleBatch     = lastRunAgeH != null && lastRunAgeH > 12;
              const isScannerBatch   = freshness?.latest_batch_engine_kind === 'scanner';
              const emergingAvailable = emerging.length;

              // Spec ELITE-2026-05 §EMPTY — when the elite gate filters
              // the table to zero, the operator sees the canonical
              // "No institutional-grade setups available." line. The
              // diagnostic copy below adapts based on what the gate
              // dropped (input rows present but elite-filtered vs no
              // rows at all) so the user knows whether the engine ran.
              const eliteFilteredOut = signalRows.length > 0 && validRows.length === 0;
              let title    = eliteFilteredOut
                ? 'No institutional-grade setups available.'
                : 'No signals in database';
              let subtitle = eliteFilteredOut
                ? `Quality > quantity. ${signalRows.length} row${signalRows.length === 1 ? '' : 's'} reached the response but none cleared the elite institutional floors (confidence ≥ 75, institutional_score ≥ 80, RR ≥ 2.0, stress ≥ 75, freshness fresh, live VALID, classification ∈ {INSTITUTIONAL_HIGH_CONVICTION, HIGH_CONVICTION}).`
                : 'Click "Run Pipeline" to generate fresh signals';
              // Market-closed mode wins over the stored-signal heuristics
              // below — without this, the page reports "Stored signals are
              // stale (37h since last pipeline)" off-hours, which is
              // technically true (last regen was 37h ago) but completely
              // misleading: the snapshot table above is the correct view
              // and a fresh scan WILL run automatically at 09:15 IST.
              if (marketClosed && !eliteFilteredOut) {
                // Spec EMPTY-UI — when the main signals array is empty
                // off-hours and no elite-grade rows survive, the
                // dashboard surfaces a clear empty state. Scanner-
                // candidate references are intentionally NOT mentioned
                // here per ELITE-2026-05 (no fallback candidates
                // visible).
                title    = 'No institutional-grade setups available.';
                subtitle = 'Market is closed. The next pre-open scan will refresh the elite tier.';
                if (marketClosed.market_data.length > 0) {
                  subtitle += ` Last-close prices for ${marketClosed.market_data.length} symbols are shown above.`;
                }
              } else if (!eliteFilteredOut && totalStored != null && totalStored > 0) {
                if (isPartial) {
                  title    = `Partial scan — Yahoo coverage incomplete`; // @deprecated marker
                  subtitle = `The most recent scanner run reported a partial-scan warning (Yahoo fetch failures pushed coverage below the 80% floor). ${totalStored} stored signal${totalStored === 1 ? '' : 's'} all failed the strict quality gate. A fresh scan is auto-running — the table will populate when it lands.`; // @deprecated marker
                } else if (isStaleBatch) {
                  title    = `Stored signals are stale (${lastRunAgeH}h since last pipeline)`;
                  subtitle = `${totalStored} stored signal${totalStored === 1 ? '' : 's'} aged into decay_state='stale' and were dropped from the main table. A fresh pipeline is auto-running.`;
                } else if (isScannerBatch && persistedCount != null && universeSize != null) {
                  // Scanner ran fully across the universe; rejection
                  // engine + pre-filters culled most rows before persist;
                  // none of the survivors cleared the strict gate.
                  title    = `Scan complete — ${persistedCount} of ${universeSize} symbols passed pre-filters, none cleared the strict gate`;
                  subtitle = `The scanner reviewed every symbol in the universe. Pre-filters and the rejection engine reduced the candidate pool to ${persistedCount}, and all of them fell below the strict gate's confidence (≥60), risk (≤70), R:R (≥1.5), or final-score (≥65) thresholds. A fresh scan is auto-running.`;
                } else {
                  title    = `${totalStored} stored signal${totalStored === 1 ? '' : 's'} failed the quality gate`;
                  subtitle = 'Every stored row was below the minimum confidence / R:R / freshness thresholds. A fresh scan is auto-running.';
                }
              }

              // Spec UI-SIMPLIFY §1 — single unified table; no more per-bucket
              // empty states. When the table is empty the operator just sees
              // the engine-status copy + a Generate-Signals button.
              return (
                <div style={{ padding: 32, textAlign: 'center', color: '#94A3B8' }}>
                  <Zap size={32} style={{ marginBottom: 12, opacity: 0.3 }} />
                  <div style={{ fontWeight: 600, marginBottom: 4, color: '#475569' }}>
                    {title}
                  </div>
                  <div style={{ fontSize: 13, marginBottom: 12, maxWidth: 520, marginLeft: 'auto', marginRight: 'auto' }}>
                    {subtitle}
                  </div>
                  <div>
                    <button
                      className="btn btn--primary btn--sm"
                      onClick={runPipeline}
                      disabled={pipelineRunning || (manualRunStatus.used && !manualRunStatus.inProgress)}
                      title={
                        manualRunStatus.used && !manualRunStatus.inProgress
                          ? `Manual run used today. Next available ${manualRunStatus.nextAllowedAt ?? 'tomorrow'}.`
                          : undefined
                      }
                    >
                      <Zap size={13} /> Generate Signals
                    </button>
                  </div>
                </div>
              );
            }

            // hasData → fall through to the actual table below
            return null;
          })()}

          {/* The table renders separately below so the existing JSX
              keeps working unchanged when data IS present. */}
          {shown.length > 0 && (
            <div style={{ overflow: 'auto', maxHeight: 720 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ position: 'sticky', top: 0, zIndex: 1 }}>
                  <tr style={{ background: '#F8FAFC' }}>
                    {/* Live column intentionally removed — it caused
                        per-tick re-renders that fought the SSE/HTTP
                        update cadence and visually flickered the row.
                        Live price still flows in `s.livePrice` on the
                        row object for any downstream code that needs
                        it; it just isn't rendered as its own column. */}
                    {/* Edge % is positioned as a primary column (immediately
                        after Final) so the trade's expected edge reads at a
                        glance, before the operator scrolls into the
                        secondary trade-math group. */}
                    {['#', 'Symbol', 'Direction', 'Strategy', 'Confidence',
                      'Final', 'Edge %', 'Class', 'Risk', 'PFit', 'Stress',
                      'Entry', 'Stop Loss', 'Target', 'R:R',
                      'Profit %', 'Loss %', 'Win Prob %',
                      'Maturity', 'Age', 'Conviction', 'Stable',
                      'Gates', 'Valid Till', 'Status',
                      'Opp Score', 'Conv Band', ''].map(h => (
                      <th key={h} style={{
                        padding: '9px 12px',
                        textAlign: ['Entry', 'Stop Loss', 'Target', 'R:R', 'Opp Score',
                                    'Final', 'Risk', 'PFit', 'Stress',
                                    'Profit %', 'Loss %', 'Edge %', 'Win Prob %',
                                    'Maturity', 'Age',
                                    'Gates'].includes(h) ? 'right' : 'left',
                        fontSize: 10, color: '#94A3B8', fontWeight: 700, whiteSpace: 'nowrap',
                        background: '#F8FAFC',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {shown.map((s, i) => {
                    // STABLE React key — id-based (or symbol fallback).
                    //
                    // CRITICAL bug fix: previously the key embedded
                    // `stream.lastPushAt`, so every SSE frame remounted
                    // every animated row. Operators perceived this as
                    // the table "switching stocks" — actually the
                    // unmount/remount cycle was flashing the same
                    // symbol but losing all in-flight CSS transitions
                    // and re-running the row layout. Stable keys keep
                    // React's reconciler in patch mode (touch only the
                    // changed cells) instead of replace mode (rebuild
                    // the whole row).
                    const isChanged   = s.id != null && stream.changedIds.has(s.id);
                    const isNew       = s.id != null && stream.newIds.has(s.id);
                    const flippedToBuy  = s.id != null && directionFlips.sellToBuy.has(s.id);
                    const flippedToSell = s.id != null && directionFlips.buyToSell.has(s.id);
                    // Priority: direction flip (most meaningful) > new entrant > score update.
                    const animClass = flippedToSell ? 'sig-row-direction-down'
                                    : flippedToBuy  ? 'sig-row-direction-up'
                                    : isNew         ? 'sig-row-new'
                                    : isChanged     ? 'sig-row-updated'
                                    : '';
                    const rowKey = s.id != null ? `sig-${s.id}` : `sym-${s.tradingsymbol ?? i}`;
                    // PHASE_2_DUE_DILIGENCE_2026-05 — per-row expansion.
                    const ddKey = `${activeTab}-${rowKey}`;
                    const ddOpen = expandedDDRows.has(ddKey);
                    const ddRow = (s as { dueDiligence?: DueDiligenceReview }).dueDiligence;
                    const perfRow = (s as { performanceReview?: PerformanceReview }).performanceReview;
                    return (
                    <Fragment key={rowKey}>
                    <tr
                      className={animClass}
                      style={{
                        borderTop: '1px solid #F1F5F9',
                        background: s.direction === 'BUY' ? '#FAFFFE'
                                  : s.direction === 'SELL' ? '#FFFAFA'
                                  : '#fff',
                        contentVisibility: 'auto',
                        containIntrinsicSize: '48px',
                      } as React.CSSProperties}>
                      <td style={{ padding: '10px 12px', fontSize: 11, color: '#94A3B8', fontWeight: 600 }}>{i + 1}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <Link href={`/market/NSE_EQ|${s.tradingsymbol}`}
                          style={{ fontWeight: 800, color: '#1E3A5F', textDecoration: 'none' }}>
                          {s.tradingsymbol}
                        </Link>
                        <div style={{ fontSize: 10, color: '#94A3B8' }}>{s.exchange}</div>
                        {/* Provenance badge — distinguishes rows surfaced
                            via the relaxed/scanner-candidate bypass from
                            true strict-approved rows. Without this badge
                            the table painted both with the same green
                            BUY/SELL chip, leaving users confused when the
                            stock-detail page rendered "Setup is developing"
                            or "Approved with caveats" for a relaxed row.
                            Both surfaces now read from the same flags. */}
                        {(() => {
                          // Provenance badge — uses the SAME professional
                          // labels as the Class column and the stock-detail
                          // Execution Readiness panel (UX-PROFESSIONAL-LABELS
                          // spec). Internal enums ("developing", "scanner
                          // candidate") are no longer surfaced verbatim.
                          const isScannerCandidate = (s as any).is_scanner_candidate === true;
                          const isRelaxed          = (s as any).is_relaxed === true;
                          const ss   = String((s as any).signal_status ?? '').toUpperCase();
                          const cls  = String((s as any).classification ?? '').toUpperCase();
                          const rawCls = String((s as any).raw_classification ?? '').toUpperCase();
                          const isDeveloping = ss === 'DEVELOPING_SETUP';
                          const isBlocked    = cls === 'NO_TRADE' || cls === 'WATCHLIST_ONLY'
                                            || rawCls === 'NO_TRADE' || rawCls === 'WATCHLIST_ONLY';
                          if (!isScannerCandidate && !isRelaxed && !isDeveloping && !isBlocked) return null;
                          // Priority matches toProfessionalLabel's override
                          // order: scanner-candidate → "Emerging Opportunity",
                          // is_relaxed → "Early Opportunity", DEVELOPING →
                          // "Awaiting Confirmation", WATCHLIST → "Monitor".
                          const label = isScannerCandidate
                            ? 'Emerging Opportunity'
                            : isRelaxed
                              ? 'Early Opportunity'
                              : isDeveloping
                                ? 'Awaiting Confirmation'
                                : (cls === 'WATCHLIST_ONLY' || rawCls === 'WATCHLIST_ONLY')
                                  ? 'Monitor'
                                  : 'Awaiting Confirmation';
                          const titleHint = `${label} — open detail page for engine-side context`;
                          return (
                            <div
                              title={titleHint}
                              style={{
                                display:        'inline-block',
                                marginTop:      2,
                                padding:        '1px 6px',
                                fontSize:       9,
                                fontWeight:     700,
                                letterSpacing:  0.3,
                                color:          '#A16207',
                                background:     '#FEF3C7',
                                border:         '1px solid #FDE68A',
                                borderRadius:   4,
                              }}
                            >
                              {label}
                            </div>
                          );
                        })()}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <SignalChip dir={s.direction} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <ScenarioTag tag={s.scenario_tag} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <ConfBar value={s.confidence_score ?? s.confidence} />
                      </td>
                      {/* ── Phase-12 columns ───────────────────── */}
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                        <FinalScorePill value={s.final_score} />
                      </td>
                      {/* Primary Edge % — promoted out of the trade-math
                          group so the expected edge is visible without
                          scrolling. The cell formerly between Loss % and
                          Win Prob % was removed; this is the canonical
                          render of expected_edge_percent. */}
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800,
                            color: (s.expected_edge_percent ?? 0) >= 1 ? '#065F46'
                                 : (s.expected_edge_percent ?? 0) > 0 ? '#1D4ED8' : '#94A3B8' }}>
                        {s.expected_edge_percent != null
                          ? `${Number(s.expected_edge_percent) >= 0 ? '+' : ''}${Number(s.expected_edge_percent).toFixed(2)}%`
                          : <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        {/* Pass rejection_codes + rejection_reasons + signal_status
                            + scenario_tag + provenance flags so the badge can
                            render the user-facing professional label
                            ("Liquidity Blocked", "Awaiting Confirmation",
                            "Emerging Opportunity", "Early Opportunity",
                            "Monitor", "Risk Restricted", etc.) per the UX-
                            PROFESSIONAL-LABELS spec. Production users never see
                            internal enums like NO_TRADE / DEVELOPING_SETUP /
                            REJECTED_LOW_CONFIDENCE — the technical code is
                            preserved on the tooltip for operator inspection. */}
                        <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', gap: 3 }}>
                          <ClassificationBadge
                            value={s.classification}
                            rejectionCodes={s.rejection_codes}
                            rejectionReasons={s.rejection_reasons}
                            signalStatus={(s as any).signal_status}
                            scenarioTag={s.scenario_tag}
                            isRelaxed={(s as any).is_relaxed}
                            isScannerCandidate={(s as any).is_scanner_candidate}
                            executionAllowed={(s as any).execution_allowed}
                            effectiveApprovalStatus={s.effectiveApprovalStatus ?? null}
                            rawApprovalStatus={s.rawApprovalStatus ?? null}
                            decisionChanged={s.decisionChanged ?? null}
                            demotionReason={s.demotionReason ?? null}
                            institutionalBlockers={s.institutionalBlockers ?? null}
                          />
                          {/* SIGNAL-ENGINE-COPY-2026-05 — visible
                              indicator when the institutional decision
                              gate altered the raw classification. The
                              badge already swaps the label; this
                              annotation makes the override explicit so
                              the operator does not have to hover. */}
                          {s.decisionChanged === true && (
                            <span
                              title={s.demotionReason ?? 'Adjusted by institutional gate'}
                              style={{
                                display: 'inline-block',
                                background: '#F1F5F9',
                                color: '#475569',
                                border: '1px solid #CBD5E1',
                                fontSize: 9,
                                fontWeight: 700,
                                letterSpacing: 0.3,
                                padding: '1px 6px',
                                borderRadius: 4,
                                whiteSpace: 'nowrap',
                              }}
                            >
                              ⚙ Adjusted by institutional gate
                            </span>
                          )}
                        </div>
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                        <RiskScorePill value={s.risk_score} />
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                        <PortfolioFitPill value={s.portfolio_fit_score} />
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                        <StressSurvivalPill value={s.stress_survival_score} />
                      </td>
                      {/* ── ENTRY (frozen at signal generation) ── */}
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 700, color: '#1E3A5F' }}>
                        {s.ltp != null && s.ltp > 0
                          ? fmt.currency(s.ltp)
                          : s.entry_price ? fmt.currency(s.entry_price) : '—'}
                      </td>

                      {/* LIVE column removed — async price ticks were
                          mounting/unmounting the cell and visually
                          flickering the row. Price data still lives on
                          `s.livePrice` for any downstream consumer. */}

                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#DC2626', fontWeight: 600 }}>
                        {s.stop_loss ? fmt.currency(s.stop_loss) : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#15803D', fontWeight: 600 }}>
                        {s.target1 ? fmt.currency(s.target1) : '—'}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600 }}>
                        <RiskRewardCell value={s.risk_reward} />
                      </td>
                      {/* ── Confirmed-snapshot columns ────────── */}
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#15803D', fontWeight: 600 }}>
                        {s.profit_percent != null
                          ? `+${Number(s.profit_percent).toFixed(2)}%`
                          : <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', color: '#DC2626', fontWeight: 600 }}>
                        {s.loss_percent != null
                          ? `−${Number(s.loss_percent).toFixed(2)}%`
                          : <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>}
                      </td>
                      {/* Edge % moved to primary position above (right after
                          Final). Win Prob % stays here as part of the
                          trade-math triad with Profit % / Loss %. */}
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600 }}>
                        {s.win_probability != null
                          ? `${(Number(s.win_probability) * 100).toFixed(1)}%`
                          : <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>}
                      </td>
                      {/* ── Maturity layer ────────────────────── */}
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                        {(() => {
                          const m = s.maturity_score;
                          if (m == null) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
                          const score = Number(m);
                          const color = score >= 92 ? '#7C3AED'
                                      : score >= 85 ? '#065F46'
                                      : score >= 70 ? '#1D4ED8'
                                      : '#94A3B8';
                          return (
                            <span style={{ fontWeight: 800, fontSize: 13, color }}>
                              {score.toFixed(0)}
                            </span>
                          );
                        })()}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontSize: 11, color: '#1E3A5F', fontWeight: 600 }}>
                        {(() => {
                          const age = s.signal_age_minutes_at_promotion;
                          if (age == null) return <span style={{ color: '#CBD5E1' }}>—</span>;
                          if (age < 60) return `${age}m`;
                          const h = Math.floor(age / 60);
                          const m = age % 60;
                          return `${h}h ${m}m`;
                        })()}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        {(() => {
                          const c = String(s.conviction_level ?? '').toUpperCase();
                          if (!c) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
                          const styleMap: Record<string, { bg: string; color: string; label: string }> = {
                            INSTITUTIONAL: { bg: '#EDE9FE', color: '#5B21B6', label: 'Institutional' },
                            HIGH:          { bg: '#DCFCE7', color: '#166534', label: 'High' },
                            MEDIUM:        { bg: '#FEF3C7', color: '#92400E', label: 'Medium' },
                          };
                          const cfg = styleMap[c] ?? { bg: '#F1F5F9', color: '#475569', label: c };
                          return (
                            <span style={{
                              background: cfg.bg, color: cfg.color,
                              padding: '2px 8px', borderRadius: 4,
                              fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                            }}>{cfg.label}</span>
                          );
                        })()}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        {s.stability_passed === true ? (
                          <span style={{
                            background: '#DCFCE7', color: '#166534',
                            padding: '2px 8px', borderRadius: 4,
                            fontSize: 10, fontWeight: 700,
                          }}>Yes</span>
                        ) : s.stability_passed === false ? (
                          <span style={{
                            background: '#FEE2E2', color: '#991B1B',
                            padding: '2px 8px', borderRadius: 4,
                            fontSize: 10, fontWeight: 700,
                          }}>No</span>
                        ) : (
                          <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 600, fontSize: 12, color: '#1E3A5F' }}>
                        {s.validation_gates_passed != null
                          ? `${s.validation_gates_passed}/13`
                          : <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>}
                      </td>
                      <td style={{ padding: '10px 12px', fontSize: 11, color: '#64748B' }}>
                        {(() => {
                          if (!s.valid_until) return <span style={{ color: '#CBD5E1' }}>—</span>;
                          const ms = Date.parse(s.valid_until);
                          if (!Number.isFinite(ms)) return <span style={{ color: '#CBD5E1' }}>—</span>;
                          const minutesLeft = Math.round((ms - Date.now()) / 60_000);
                          if (minutesLeft <= 0) return <span style={{ color: '#DC2626', fontWeight: 600 }}>expired</span>;
                          if (minutesLeft < 60)  return <span style={{ color: '#D97706', fontWeight: 600 }}>{minutesLeft}m</span>;
                          const h = Math.floor(minutesLeft / 60);
                          const m = minutesLeft % 60;
                          return <span style={{ color: '#1E3A5F', fontWeight: 600 }}>{h}h {m}m</span>;
                        })()}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        {(() => {
                          const status = String(s.status ?? '').toUpperCase();
                          if (!status) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
                          // Spec SMART-RELAXED — when the row passed only
                          // the relaxed tier the engine tags it
                          // `is_relaxed=true`. Override the badge so the
                          // operator sees "⚠️ Early Signal" instead of
                          // "Mature Confirmed", which would imply the
                          // strict gate cleared (it didn't).
                          if (status === 'ACTIVE' && (s as { is_relaxed?: boolean }).is_relaxed) {
                            // Sub-3-cycle rows are NOT confirmed — they
                            // need repeated detection (3+ cycles per
                            // mainTableApproved) before the engine
                            // promotes them. The badge surfaces the
                            // exact cycle count and a hover tooltip so
                            // the operator never confuses a Cycle 1
                            // scanner detection with a confirmed trade
                            // signal. Spec UI §7.
                            const cycles = Number(
                              (s as { validation_cycles_passed?: number | null })
                                .validation_cycles_passed ?? 0,
                            );
                            const sourceKind = String(
                              (s as { source_kind?: string }).source_kind ?? '',
                            );
                            const isEarly = cycles < 3 || sourceKind === 'q365_signals_early';
                            const cyclesLabel = Number.isFinite(cycles) && cycles > 0
                              ? `Cycle ${cycles}` : 'Cycle ?';
                            // Spec UI §7 — Cycle 1 rows get a literal
                            // "Cycle 1 · Needs validation" suffix in the
                            // tooltip so the operator sees the exact
                            // pipeline state, not a generic "Early Signal".
                            // The string also matches the contract regex in
                            // closedMarketSignalsExpiry.vitest.ts which pins
                            // the literal "passed only 1 validation cycle"
                            // form for the cycle=1 case.
                            const tooltipCycle1 =
                              'This signal has passed only 1 validation cycle (Cycle 1 · Needs validation). ' +
                              'It needs repeated detection across at least 3 cycles before it becomes a confirmed trade signal.';
                            const tooltipMulti =
                              `This signal has passed only ${Number.isFinite(cycles) ? cycles : 0} validation cycle(s). ` +
                              'It needs repeated detection across at least 3 cycles before it becomes a confirmed trade signal.';
                            const tooltip = !isEarly
                              ? 'Promoted from confirmed-snapshot pool under relaxed tier (matured but did not clear the strict gate).'
                              : cycles === 1
                                ? `${tooltipCycle1} Source: ${sourceKind || 'q365_signals_early'}.`
                                : `${tooltipMulti} Source: ${sourceKind || 'q365_signals_early'}.`;
                            const label = !isEarly
                              ? `⚠️ Early Signal · ${cyclesLabel}`
                              : cycles === 1
                                ? '⚠️ Early Scanner Candidate · Cycle 1 · Needs validation · Not Confirmed · Last Close'
                                : `⚠️ Early Scanner Candidate · ${cyclesLabel} · Not Confirmed · Last Close`;
                            return (
                              <span title={tooltip} style={{
                                background: '#FEF3C7', color: '#92400E',
                                padding: '2px 8px', borderRadius: 4,
                                fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                                border: '1px solid #FDE68A',
                                whiteSpace: 'nowrap',
                                cursor: 'help',
                              }}>{label}</span>
                            );
                          }
                          // ACTIVE rows that passed strict are confirmed — surface
                          // explicitly so the operator sees "Confirmed" instead
                          // of the generic "ACTIVE".
                          const styleMap: Record<string, { bg: string; color: string; label: string }> = {
                            ACTIVE:        { bg: '#DCFCE7', color: '#166534', label: 'Confirmed' },
                            TARGET_HIT:    { bg: '#DBEAFE', color: '#1E40AF', label: 'Target Hit' },
                            STOP_LOSS_HIT: { bg: '#FEE2E2', color: '#991B1B', label: 'Stop Loss Hit' },
                            INVALIDATED:   { bg: '#FEF3C7', color: '#92400E', label: 'Invalidated' },
                            EXPIRED:       { bg: '#F1F5F9', color: '#475569', label: 'Expired' },
                          };
                          const cfg = styleMap[status] ?? { bg: '#F1F5F9', color: '#475569', label: status.replace(/_/g, ' ') };
                          return (
                            <span style={{
                              background: cfg.bg, color: cfg.color,
                              padding: '2px 8px', borderRadius: 4,
                              fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                            }}>{cfg.label}</span>
                          );
                        })()}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                        {s.opportunity_score > 0 ? (
                          <span style={{ fontWeight: 700, fontSize: 13,
                            color: s.opportunity_score >= 80 ? '#065F46' : s.opportunity_score >= 60 ? '#1D4ED8' : '#D97706' }}>
                            {s.opportunity_score}
                          </span>
                        ) : (
                          <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>
                        )}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <ConvictionBadge band={s.conviction_band} />
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <Link href={`/market/NSE_EQ|${s.tradingsymbol}`}
                          style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, color: '#2E75B6', textDecoration: 'none' }}>
                          <Target size={11} /> Chart <ChevronRight size={10} />
                        </Link>
                        {/* PHASE_2_DUE_DILIGENCE_2026-05 — per-row toggle.
                            Only renders when the row carries a dueDiligence
                            payload from the backend; older payloads degrade
                            silently (no button shown). */}
                        {ddRow && (
                          <button
                            type="button"
                            onClick={() => toggleDDRow(ddKey)}
                            style={{
                              marginTop: 4,
                              display: 'inline-flex', alignItems: 'center', gap: 4,
                              padding: '2px 8px', borderRadius: 4,
                              background: ddOpen ? '#EEF2FF' : '#FFFFFF',
                              color: '#1D4ED8',
                              border: '1px solid #C7D2FE',
                              fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                              cursor: 'pointer',
                            }}
                            title={ddOpen ? 'Hide due diligence' : 'Why? View due diligence'}
                          >
                            {ddOpen ? 'Hide' : 'Why?'}
                          </button>
                        )}
                      </td>
                    </tr>
                    {ddOpen && ddRow && (
                      <tr key={`${rowKey}-dd`} style={{ background: '#F8FAFC' }}>
                        <td colSpan={28} style={{ padding: '10px 12px' }}>
                          <DueDiligencePanel
                            dueDiligence={ddRow}
                            performanceReview={perfRow}
                            manipulationRisk={(row as { manipulationRisk?: WireManipulationRisk | null }).manipulationRisk}
                          />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* ── Scanner Candidates (Not Yet Tradable) ───────────────────
             Spec EMPTY-UI — q365_signals strict-tier rows that did NOT
             clear the main-table maturity gate. Surfaced as a separate
             informational panel so operators can see what the engine is
             watching without confusing them with confirmed (tradable)
             signals. Renders ONLY in market-closed mode and only when
             the API returned at least one candidate. Never mixed with
             the main signals table. */}
        {/* Spec ELITE-2026-05 §UI — scanner_candidates panel retired.
            The previous "Scanner Candidates (Not Yet Tradable)" panel
            rendered DEFERRED_WAIT_TRIGGER / DEVELOPING / sub-floor rows
            below the main table, which the operator perceived as part
            of the actionable signals view. Per spec "no fallback
            candidates visible" — the panel is removed entirely. The
            elite gate is the only visible bucket. The condition below
            is now `false &&` so the JSX is preserved as comment context
            but never renders; if a future spec wants the panel back,
            flip the constant. */}
        {false
          && marketClosed
          && Array.isArray(marketClosed.scanner_candidates)
          && marketClosed.scanner_candidates.length > 0 && (
          <Card style={{ marginTop: 16 }}>
            <div style={{
              padding: '12px 16px',
              borderBottom: '1px solid #F1F5F9',
              display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#1E3A5F' }}>
                Scanner Candidates (Not Yet Tradable)
              </div>
              <span style={{
                background: '#FEF3C7', color: '#92400E',
                padding: '2px 8px', borderRadius: 99,
                fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                border: '1px solid #FDE68A',
              }}>
                ⚠️ Not Confirmed
              </span>
              <span style={{ fontSize: 11, color: '#64748B' }}>
                {marketClosed.scanner_candidates.length} symbol{marketClosed.scanner_candidates.length === 1 ? '' : 's'} —
                {' '}informational only. Will become tradable once they clear the maturity gate
                {' '}(maturity ≥ 85, cycles ≥ 3, stability passed).
              </span>
            </div>
            <div style={{ overflow: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#F8FAFC' }}>
                    {['Symbol', 'Direction', 'Confidence', 'R:R', 'Status'].map((h) => (
                      <th key={h} style={{
                        padding: '9px 12px',
                        textAlign: ['Confidence', 'R:R'].includes(h) ? 'right' : 'left',
                        fontSize: 10, color: '#94A3B8', fontWeight: 700,
                        whiteSpace: 'nowrap',
                      }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {marketClosed.scanner_candidates.map((s, i) => {
                    const sym = s.tradingsymbol ?? s.symbol ?? '—';
                    const dir = String(s.direction ?? '').toUpperCase();
                    const conf = s.confidence_score ?? s.confidence ?? null;
                    const rr   = s.risk_reward ?? null;
                    return (
                      <tr key={`cand-${s.id ?? sym}-${i}`} style={{ borderTop: '1px solid #F1F5F9' }}>
                        <td style={{ padding: '8px 12px', fontWeight: 600, color: '#1E3A5F' }}>
                          {sym}
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          <span style={{
                            background: dir === 'BUY' ? '#DCFCE7' : dir === 'SELL' ? '#FEE2E2' : '#F1F5F9',
                            color:      dir === 'BUY' ? '#166534' : dir === 'SELL' ? '#991B1B' : '#475569',
                            padding: '2px 8px', borderRadius: 4,
                            fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                          }}>
                            {dir || '—'}
                          </span>
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#1E3A5F' }}>
                          {conf != null ? Math.round(Number(conf)) : <span style={{ color: '#CBD5E1' }}>—</span>}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#1E3A5F' }}>
                          {rr != null && Number.isFinite(Number(rr))
                            ? Number(rr).toFixed(2)
                            : <span style={{ color: '#CBD5E1' }}>—</span>}
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          <span style={{
                            background: '#FEF3C7', color: '#92400E',
                            padding: '2px 8px', borderRadius: 4,
                            fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                          }}>
                            Developing
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* ── Per-row maturity metadata + explanation ─────────────── */}
        {/* Surfaces the three maturity signals — Signal Age, Maturity
             Score, Conviction Tier — alongside the Phase-10 explanation.
             Shown for every confirmed row that has maturity metadata
             (which is every active confirmed snapshot post-maturity-layer
             rollout), regardless of whether the explanation engine
             produced a summary line. */}
        {!loading && shown.some((s) => s.maturity_score != null || s.explanation?.summary_reason) && (
          <Card style={{ marginTop: 16 }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid #F1F5F9' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#1E3A5F' }}>
                Why these signals
              </div>
              <div style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>
                Maturity metadata — Signal Age, Maturity Score, Conviction Tier — plus the Phase-10 one-line explanation per confirmed signal.
              </div>
            </div>
            <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              {shown
                .filter((s) => s.maturity_score != null || s.explanation?.summary_reason)
                .slice(0, 25)
                .map((s) => {
                  const matScore = s.maturity_score != null ? Number(s.maturity_score) : null;
                  const matColor = matScore == null ? '#94A3B8'
                                 : matScore >= 92 ? '#7C3AED'
                                 : matScore >= 85 ? '#065F46'
                                 : matScore >= 70 ? '#1D4ED8'
                                 : '#94A3B8';
                  const ageMin = s.signal_age_minutes_at_promotion;
                  const ageLabel = ageMin == null ? null
                                 : ageMin < 60 ? `${ageMin} min`
                                 : `${Math.floor(ageMin / 60)}h ${ageMin % 60}m`;
                  const conviction = String(s.conviction_level ?? '').toUpperCase();
                  const convStyleMap: Record<string, { bg: string; color: string; label: string }> = {
                    INSTITUTIONAL: { bg: '#EDE9FE', color: '#5B21B6', label: 'Institutional' },
                    HIGH:          { bg: '#DCFCE7', color: '#166534', label: 'High' },
                    MEDIUM:        { bg: '#FEF3C7', color: '#92400E', label: 'Medium' },
                  };
                  const convCfg = convStyleMap[conviction];

                  return (
                    <div key={`exp-${s.id ?? s.tradingsymbol}`} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                      <span style={{
                        minWidth: 70, fontSize: 11, fontWeight: 700, color: '#1E3A5F',
                        paddingTop: 8,
                      }}>{s.tradingsymbol}</span>
                      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {/* Maturity strip */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 11 }}>
                          {matScore != null && (
                            <span style={{ color: '#64748B' }}>
                              Maturity:&nbsp;
                              <span style={{ color: matColor, fontWeight: 800 }}>{matScore.toFixed(0)}</span>
                            </span>
                          )}
                          {ageLabel != null && (
                            <span style={{ color: '#64748B' }}>
                              Signal Age:&nbsp;
                              <span style={{ color: '#1E3A5F', fontWeight: 700 }}>{ageLabel}</span>
                            </span>
                          )}
                          {s.validation_cycles_passed != null && (
                            <span style={{ color: '#64748B' }}>
                              Cycles:&nbsp;
                              <span style={{ color: '#1E3A5F', fontWeight: 700 }}>{s.validation_cycles_passed}</span>
                            </span>
                          )}
                          {convCfg && (
                            <span style={{ color: '#64748B' }}>
                              Conviction:&nbsp;
                              <span style={{
                                background: convCfg.bg, color: convCfg.color,
                                padding: '1px 8px', borderRadius: 4,
                                fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                              }}>{convCfg.label}</span>
                            </span>
                          )}
                          {s.stability_passed != null && (
                            <span style={{ color: '#64748B' }}>
                              Stability:&nbsp;
                              <span style={{
                                color: s.stability_passed ? '#166534' : '#991B1B',
                                fontWeight: 700,
                              }}>{s.stability_passed ? 'Passed' : 'Failed'}</span>
                            </span>
                          )}
                        </div>
                        {/* Explanation (when present) */}
                        {s.explanation?.summary_reason && (
                          <ExplanationSummary explanation={s.explanation} />
                        )}
                      </div>
                    </div>
                  );
                })}
            </div>
          </Card>
        )}

        {/* PRODUCTION_TABS_2026-05 — REJECTED tab also renders the
            engine-funnel panel beneath the row table. The row table
            above shows concrete risk_restricted rows (full SignalRow
            shape, can render entry/stop/target like the APPROVED
            table); RejectedSignalsPanel below explains every other
            row the engine downgraded with per-row rejection_code
            sub-badges (REJECTED_LOW_CONFIDENCE / REJECTED_LOW_RR /
            DEVELOPING_SETUP / etc). */}
        {activeTab === 'REJECTED' && (rejected.length > 0 || funnel) && (
          <RejectedSignalsPanel rows={rejected} funnel={funnel} />
        )}
        </>)}

        <div style={{ marginTop: 16, fontSize: 11, color: '#94A3B8', textAlign: 'center' }}>
          Signals generated by centralized pipeline. Run Pipeline to refresh.
          Not investment advice.
        </div>
      </div>
    </AppShell>
  );
}

// ════════════════════════════════════════════════════════════════
//  RejectedSignalsPanel — Spec INSTITUTIONAL §UX-SIMPLIFY (2026-05).
//  Renders the single REJECTED bucket: every scanned row that did NOT
//  pass institutional approval, surfaced with its specific
//  rejection_code (REJECTED_LOW_CONFIDENCE / REJECTED_LOW_RR /
//  REJECTED_MARKET_REGIME / DEVELOPING_SETUP / DEFERRED_WAIT_TRIGGER /
//  etc) and a one-sentence display_reason.
//
//  Wire fields preserved per spec §3:
//      symbol, rejection_code, display_reason, confidence,
//      final_score, rr, regime, approval_stage
//
//  Pure presentation — no fetches, no governance bypass. The data
//  comes from the same `/api/signals` payload that ships signals[].
// ════════════════════════════════════════════════════════════════
function RejectedSignalsPanel({
  rows,
  funnel,
}: {
  rows:   RejectedDisplayRow[];
  funnel: SignalFunnelSummary | null;
}) {
  // Stable code → label / color map. The label is shown verbatim as
  // the badge text per spec §4 — never the legacy "NO_TRADE" string.
  const CODE_STYLE: Record<string, { bg: string; color: string; border: string }> = {
    REJECTED_LOW_CONFIDENCE:   { bg: '#FEE2E2', color: '#991B1B', border: '#FCA5A5' },
    REJECTED_LOW_FINAL_SCORE:  { bg: '#FEE2E2', color: '#991B1B', border: '#FCA5A5' },
    REJECTED_LOW_RR:           { bg: '#FEE2E2', color: '#991B1B', border: '#FCA5A5' },
    REJECTED_MARKET_REGIME:    { bg: '#FFE4E6', color: '#9F1239', border: '#FDA4AF' },
    REJECTED_HIGH_VOLATILITY:  { bg: '#FEE2E2', color: '#991B1B', border: '#FCA5A5' },
    REJECTED_STALE_DATA:       { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1' },
    REJECTED_FAILED_STABILITY: { bg: '#FEE2E2', color: '#991B1B', border: '#FCA5A5' },
    REJECTED_LIVE_INVALIDATED: { bg: '#FFEDD5', color: '#9A3412', border: '#FDBA74' },
    REJECTED_PORTFOLIO_FIT:    { bg: '#FEE2E2', color: '#991B1B', border: '#FCA5A5' },
    REJECTED_RISK_TOO_HIGH:    { bg: '#FEE2E2', color: '#991B1B', border: '#FCA5A5' },
    REJECTED_INVALID_PRICES:   { bg: '#FEE2E2', color: '#991B1B', border: '#FCA5A5' },
    REJECTED_NO_STRATEGY:      { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1' },
    REJECTED_DUPLICATE:        { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1' },
    REJECTED_LOW_LIQUIDITY:    { bg: '#FEE2E2', color: '#991B1B', border: '#FCA5A5' },
    REJECTED_LOW_MATURITY:     { bg: '#FEF3C7', color: '#92400E', border: '#FDE68A' },
    REJECTED_LOW_CYCLES:       { bg: '#FEF3C7', color: '#92400E', border: '#FDE68A' },
    REJECTED_NO_EDGE:          { bg: '#FEE2E2', color: '#991B1B', border: '#FCA5A5' },
    DEFERRED_WAIT_TRIGGER:     { bg: '#FEF3C7', color: '#92400E', border: '#FDE68A' },
    DEVELOPING_SETUP:          { bg: '#FEF3C7', color: '#92400E', border: '#FDE68A' },
    UNKNOWN:                   { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1' },
  };

  return (
    <Card flush style={{ marginBottom: 20 }}>
      <div style={{
        padding: '12px 16px', borderBottom: '1px solid #F1F5F9',
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
      }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: '#1E3A5F', letterSpacing: 0.3 }}>
          REJECTED
        </div>
        <span style={{ fontSize: 11, color: '#64748B' }}>
          {rows.length} symbol{rows.length === 1 ? '' : 's'} scanned but failed institutional approval.
          Each row carries a specific cause code — never a generic “No Trade”.
        </span>
        {funnel && (
          <div style={{
            marginLeft: 'auto', display: 'flex', gap: 6, flexWrap: 'wrap',
            fontSize: 10, fontWeight: 700, letterSpacing: 0.2,
          }}>
            {([
              ['scanned',                funnel.scanned],
              ['matched',                funnel.matched],
              ['approved',               funnel.approved],
              ['rejected',               funnel.rejected],
              ['low_confidence',         funnel.rejected_low_confidence],
              ['rr',                     funnel.rejected_rr],
              ['market_regime',          funnel.rejected_market_regime],
              ['stale',                  funnel.rejected_stale],
              ['stability',              funnel.rejected_stability],
              ['other',                  funnel.rejected_other],
            ] as const).filter(([, v]) => Number(v) > 0).map(([k, v]) => (
              <span key={k} style={{
                background: '#F1F5F9', color: '#475569',
                padding: '2px 8px', borderRadius: 99,
                border: '1px solid #E2E8F0',
              }}>{k.replace(/_/g, ' ')}: {v}</span>
            ))}
          </div>
        )}
      </div>
      {rows.length === 0 ? (
        <div style={{ padding: '24px 16px', textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
          No rejected signals in the current scan window.
        </div>
      ) : (
        <div style={{ overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#F8FAFC' }}>
                {['Symbol', 'Rejection Code', 'Reason', 'Confidence', 'Final', 'R:R', 'Regime', 'Stage'].map((h) => (
                  <th key={h} style={{
                    padding: '9px 12px',
                    textAlign: ['Confidence', 'Final', 'R:R'].includes(h) ? 'right' : 'left',
                    fontSize: 10, color: '#94A3B8', fontWeight: 700,
                    whiteSpace: 'nowrap',
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const cs = CODE_STYLE[r.rejection_code] ?? CODE_STYLE.UNKNOWN;
                return (
                  <tr key={`${r.symbol}-${i}`} style={{ borderTop: '1px solid #F1F5F9' }}>
                    <td style={{ padding: '8px 12px', fontWeight: 700, color: '#1E3A5F' }}>
                      <Link href={`/market/NSE_EQ|${r.symbol}`} style={{ color: '#1E3A5F', textDecoration: 'none' }}>
                        {r.symbol}
                      </Link>
                    </td>
                    <td style={{ padding: '8px 12px' }}>
                      <span style={{
                        background: cs.bg, color: cs.color,
                        padding: '2px 8px', borderRadius: 4,
                        fontSize: 10, fontWeight: 800, letterSpacing: 0.3,
                        border: `1px solid ${cs.border}`,
                        whiteSpace: 'nowrap',
                      }}>{r.rejection_code}</span>
                    </td>
                    <td style={{ padding: '8px 12px', color: '#475569', fontSize: 12 }}>
                      {r.display_reason}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#1E3A5F' }}>
                      {r.confidence != null ? Math.round(Number(r.confidence)) : <span style={{ color: '#CBD5E1' }}>—</span>}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#1E3A5F' }}>
                      {r.final_score != null ? Math.round(Number(r.final_score)) : <span style={{ color: '#CBD5E1' }}>—</span>}
                    </td>
                    <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: '#1E3A5F' }}>
                      {r.rr != null && Number.isFinite(Number(r.rr))
                        ? Number(r.rr).toFixed(2)
                        : <span style={{ color: '#CBD5E1' }}>—</span>}
                    </td>
                    <td style={{ padding: '8px 12px', color: '#475569', fontSize: 11 }}>
                      {r.regime ?? <span style={{ color: '#CBD5E1' }}>—</span>}
                    </td>
                    <td style={{ padding: '8px 12px', color: '#475569', fontSize: 11 }}>
                      {r.approval_stage}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
