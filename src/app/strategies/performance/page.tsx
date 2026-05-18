'use client';
// ════════════════════════════════════════════════════════════════
//  /strategies/performance — Phase 2 Strategy Performance Intelligence
//
//  Evidence-based performance dashboard backed by /api/strategies/
//  performance. No fabricated metrics: every cell is sourced from
//  observed snapshots, backtest trades, or surfaces an explicit
//  INSUFFICIENT_DATA state.
//
//  Sections:
//   1. Header + window selector
//   2. Strategy leaderboard table
//   3. Strategy health cards (best / weakest / most reliable category /
//      confidence calibration)
//   4. Detail panel for the selected strategy (sector / regime /
//      confidence / status breakdown)
//   5. Empty state when no evaluated signals exist yet
// ════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import AppShell from '@/components/layout/AppShell';
import { Card } from '@/components/ui';
import {
  Activity, AlertTriangle, ArrowUpRight, BarChart3, CheckCircle2,
  ChevronRight, Gauge, RefreshCw, Sparkles, Target,
} from 'lucide-react';

// ── Wire types (mirror /api/strategies/performance) ───────────

type Window = '7D' | '30D' | '90D' | '180D' | '1Y' | 'ALL';
type DataStatus = 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT';
type HealthLabel = 'EXCELLENT' | 'STRONG' | 'STABLE' | 'WEAK' | 'INSUFFICIENT_DATA';
type Recommendation =
  | 'Promote' | 'Keep Active' | 'Watch Carefully'
  | 'Reduce Approval Weight' | 'Insufficient Data';
type PerformanceStatus = 'SUFFICIENT' | 'LIMITED' | 'INSUFFICIENT_DATA';
type PerformanceSource =
  | 'direct' | 'observed' | 'strategy_snapshot'
  | 'backtest' | 'mixed'
  | 'derived_from_candles' | 'estimated' | 'insufficient_data';

interface LeaderboardEntry {
  rank: number;
  strategyId: string;
  strategyName: string;
  category: string;
  direction: 'BUY' | 'SELL';
  totalSignals: number;
  evaluatedSignals: number;
  winRate: number;
  averageReturnPct: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdownPct: number;
  averageHoldingPeriod: number;
  strategyHealthScore: number;
  healthLabel: HealthLabel;
  recommendation: Recommendation;
  performanceStatus: PerformanceStatus;
}

interface StrategyPerformance extends LeaderboardEntry {
  approvedSignals: number;
  watchlistedSignals: number;
  rejectedSignals: number;
  openSignals: number;
  lossRate: number;
  averageWinPct: number;
  averageLossPct: number;
  medianReturnPct: number;
  bestReturnPct: number;
  worstReturnPct: number;
  falseSignalRate: number;
  approvalAccuracy: number;
  averageRiskReward: number;
  stopHitRate: number;
  targetHitRate: number;
  maxAdverseExcursionAvg: number;
  maxFavorableExcursionAvg: number;
  performanceSource: PerformanceSource;
  healthExplanation: string;
  warnings: string[];
}

interface SectorBucket    { sector: string; signals: number; evaluatedSignals: number; winRate: number; averageReturnPct: number; expectancy: number; healthLabel: HealthLabel; }
interface RegimeBucket    { regime: string; signals: number; evaluatedSignals: number; winRate: number; averageReturnPct: number; expectancy: number; recommendation: Recommendation; }
interface ConfBucket      { bucket: string; lowerBound: number; upperBound: number; signals: number; evaluatedSignals: number; winRate: number; averageReturnPct: number; expectancy: number; }
interface StatusBucket    { status: 'APPROVED' | 'WATCHLIST' | 'REJECTED'; signals: number; evaluatedSignals: number; winRate: number; averageReturnPct: number; expectancy: number; }

interface DetailBlock {
  sectorPerformance?: SectorBucket[];
  sectorPerformanceStatus?: 'AVAILABLE' | 'UNAVAILABLE';
  sectorPerformanceMessage?: string;
  regimePerformance?: RegimeBucket[];
  regimePerformanceStatus?: 'AVAILABLE' | 'INSUFFICIENT_DATA';
  regimePerformanceMessage?: string;
  confidenceBuckets?: ConfBucket[];
  confidenceCalibrationWarning?: string;
  statusBreakdown?: StatusBucket[];
}

interface PerformancePayload {
  generatedAt: string;
  timeWindow: Window;
  dataStatus: DataStatus;
  message: string;
  performanceSource: PerformanceSource;
  totalStrategies: number;
  totalSignalsEvaluated: number;
  minimumRequiredSignals: number;
  leaderboard: LeaderboardEntry[];
  strategies: StrategyPerformance[];
  warnings: string[];
  dataQuality: { status: DataStatus; evaluatedSignals: number; minimumRequiredSignals: number; coveragePct: number; warnings: string[] };
  detail?: Record<string, DetailBlock>;
  selectedStrategy?: StrategyPerformance | null;
}

// ── Helpers ────────────────────────────────────────────────────

const WINDOWS: Window[] = ['7D', '30D', '90D', '180D', '1Y', 'ALL'];

const fmtPct = (n: number): string =>
  Number.isFinite(n) ? `${n >= 0 ? '' : ''}${n.toFixed(1)}%` : '—';

const fmtSigned = (n: number): string => {
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(2)}`;
};

const toneForHealth = (l: HealthLabel): 'green' | 'amber' | 'red' | 'grey' => {
  switch (l) {
    case 'EXCELLENT':         return 'green';
    case 'STRONG':            return 'green';
    case 'STABLE':            return 'amber';
    case 'WEAK':              return 'red';
    case 'INSUFFICIENT_DATA': return 'grey';
  }
};

const recommendationTone = (r: Recommendation): 'green' | 'amber' | 'red' | 'grey' => {
  switch (r) {
    case 'Promote':                return 'green';
    case 'Keep Active':            return 'green';
    case 'Watch Carefully':        return 'amber';
    case 'Reduce Approval Weight': return 'red';
    case 'Insufficient Data':      return 'grey';
  }
};

// ── Inline visual primitives (kept local — no UI redesign) ────

function Chip({
  tone, children,
}: {
  tone: 'green' | 'amber' | 'red' | 'blue' | 'grey';
  children: React.ReactNode;
}) {
  const pal = TONE_PALETTE[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 8px', borderRadius: 99,
      background: pal.bg, color: pal.color,
      border: `1px solid ${pal.border}`,
      fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
      textTransform: 'uppercase',
    }}>{children}</span>
  );
}

const TONE_PALETTE: Record<
  'green' | 'amber' | 'red' | 'blue' | 'grey',
  { bg: string; color: string; border: string }
> = {
  green: { bg: '#E8F8F0', color: '#047857', border: '#BCEBD0' },
  amber: { bg: '#FEF4E1', color: '#92400E', border: '#F8DDA1' },
  red:   { bg: '#FEECEC', color: '#B91C1C', border: '#F5C2C2' },
  blue:  { bg: '#E7F0FF', color: '#1D4ED8', border: '#C1D5F5' },
  grey:  { bg: '#F1F4F8', color: '#475569', border: '#D8DFE8' },
};

// ── Page ───────────────────────────────────────────────────────

export default function StrategyPerformancePage() {
  const [data, setData]       = useState<PerformancePayload | null>(null);
  const [window, setWindow]   = useState<Window>('90D');
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = new URLSearchParams({
        window,
        include: 'leaderboard,sector,regime,confidence,statusBreakdown',
      });
      if (selected) params.set('strategyId', selected);
      const res = await fetch(`/api/strategies/performance?${params.toString()}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error ?? `HTTP ${res.status}`);
        setData(null);
      } else {
        setData(json as PerformancePayload);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [window, selected]);

  useEffect(() => { void load(); }, [load]);

  // Derived display values
  const leaderboard   = data?.leaderboard ?? [];
  const strategies    = data?.strategies  ?? [];
  const selectedDetail = selected && data?.detail ? data.detail[selected] : null;
  const selectedStrategy = data?.selectedStrategy ?? (selected
    ? strategies.find((s) => s.strategyId === selected) ?? null
    : null);

  // Cards for "best / weakest / most reliable category / calibration"
  const headlineCards = useMemo(() => {
    if (leaderboard.length === 0) return null;
    const ranked = leaderboard.filter((e) => e.performanceStatus !== 'INSUFFICIENT_DATA');
    const best  = ranked[0] ?? null;
    const worst = [...ranked].reverse()[0] ?? null;
    const byCategory = new Map<string, { totalEval: number; expSum: number; n: number }>();
    for (const e of ranked) {
      const c = byCategory.get(e.category) ?? { totalEval: 0, expSum: 0, n: 0 };
      c.totalEval += e.evaluatedSignals;
      c.expSum    += e.expectancy;
      c.n         += 1;
      byCategory.set(e.category, c);
    }
    let bestCategory: string | null = null;
    let bestCategoryExp = -Infinity;
    for (const [cat, agg] of byCategory.entries()) {
      const avg = agg.n > 0 ? agg.expSum / agg.n : 0;
      if (agg.totalEval >= 5 && avg > bestCategoryExp) { bestCategoryExp = avg; bestCategory = cat; }
    }
    return { best, worst, bestCategory, bestCategoryExp };
  }, [leaderboard]);

  return (
    <AppShell title="Strategy Performance">
      <div className="page">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0F172A', display: 'flex', alignItems: 'center', gap: 8 }}>
              <Sparkles size={18} color="#1D4ED8" />
              Strategy Performance Intelligence
            </h1>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: '#64748B' }}>
              Evidence-based performance tracking across strategy families, sectors, regimes, and confidence buckets.
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', gap: 4, background: '#F1F5F9', padding: 3, borderRadius: 8 }}>
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  onClick={() => setWindow(w)}
                  style={{
                    padding: '6px 12px', borderRadius: 6, border: 'none',
                    background: w === window ? '#FFFFFF' : 'transparent',
                    color: w === window ? '#0F172A' : '#475569',
                    fontWeight: w === window ? 700 : 500,
                    fontSize: 11, cursor: 'pointer',
                    boxShadow: w === window ? '0 1px 2px rgba(15,23,42,0.08)' : 'none',
                  }}
                >{w}</button>
              ))}
            </div>
            <button
              className="btn btn--sm btn--secondary"
              onClick={() => void load()}
              disabled={loading}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
            >
              <RefreshCw size={13} className={loading ? 'spin' : ''} />
              Refresh
            </button>
          </div>
        </div>

        {/* Data status banner — only when not fully sufficient. */}
        {data && data.dataStatus !== 'SUFFICIENT' && (
          <Card style={{ marginBottom: 16, borderLeft: '3px solid #D97706' }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <AlertTriangle size={16} color="#D97706" style={{ marginTop: 2, flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>
                  {data.dataStatus === 'INSUFFICIENT'
                    ? 'Strategy performance requires more evaluated signals'
                    : 'Strategy performance is calculated on a limited sample'}
                </div>
                <div style={{ fontSize: 12, color: '#475569', marginTop: 4 }}>
                  {data.message} ({data.totalSignalsEvaluated}/{data.minimumRequiredSignals} evaluated signals)
                </div>
                {data.warnings.length > 0 && (
                  <ul style={{ margin: '6px 0 0 0', paddingLeft: 18, fontSize: 12, color: '#92400E', lineHeight: 1.5 }}>
                    {data.warnings.slice(0, 4).map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* Loading / error / empty states */}
        {loading && !data && (
          <Card>
            <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}>
              <RefreshCw size={20} className="spin" style={{ marginBottom: 8 }} />
              <div>Loading strategy performance…</div>
            </div>
          </Card>
        )}
        {error && (
          <Card style={{ marginBottom: 16, borderLeft: '3px solid #DC2626' }}>
            <div style={{ padding: 12, color: '#991B1B', fontSize: 13 }}>
              <strong>Could not load performance:</strong> {error}
            </div>
          </Card>
        )}

        {/* Headline cards */}
        {data && headlineCards && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
            <HeadlineCard
              icon={CheckCircle2} tone="green"
              label="Best Performing"
              value={headlineCards.best?.strategyName ?? 'Insufficient data'}
              sub={headlineCards.best
                ? `${headlineCards.best.winRate.toFixed(0)}% win · Exp ${headlineCards.best.expectancy.toFixed(2)}`
                : 'Awaiting evaluated signals'}
            />
            <HeadlineCard
              icon={Target} tone="amber"
              label="Weakest Strategy"
              value={headlineCards.worst?.strategyName ?? 'Insufficient data'}
              sub={headlineCards.worst
                ? `${headlineCards.worst.winRate.toFixed(0)}% win · Exp ${headlineCards.worst.expectancy.toFixed(2)}`
                : 'Awaiting evaluated signals'}
            />
            <HeadlineCard
              icon={BarChart3} tone="blue"
              label="Most Reliable Category"
              value={headlineCards.bestCategory ?? 'Insufficient data'}
              sub={headlineCards.bestCategory
                ? `Avg expectancy ${headlineCards.bestCategoryExp.toFixed(2)}R`
                : 'Need more evaluated signals'}
            />
            <HeadlineCard
              icon={Gauge} tone="grey"
              label="Data Source"
              value={data.performanceSource.replace(/_/g, ' ').toUpperCase()}
              sub={`${data.totalSignalsEvaluated} evaluated · ${data.dataQuality.coveragePct}% coverage`}
            />
          </div>
        )}

        {/* Leaderboard */}
        <Card title="Strategy Leaderboard" style={{ marginBottom: 16 }}>
          {leaderboard.length === 0 ? (
            <EmptyLeaderboard window={window} />
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#F8FAFC' }}>
                    {['#', 'Strategy', 'Category', 'Signals', 'Win %', 'Avg Return', 'Expectancy', 'PF', 'Max DD', 'Health', 'Recommendation'].map((h) => (
                      <th key={h} style={{ padding: '8px 10px', textAlign: ['#', 'Strategy', 'Category', 'Health', 'Recommendation'].includes(h) ? 'left' : 'right', fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.4 }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {leaderboard.map((e) => {
                    const isSelected = selected === e.strategyId;
                    return (
                      <tr
                        key={e.strategyId}
                        onClick={() => setSelected(isSelected ? null : e.strategyId)}
                        style={{
                          borderTop: '1px solid #F1F5F9',
                          cursor: 'pointer',
                          background: isSelected ? '#EFF6FF' : 'transparent',
                        }}
                      >
                        <td style={{ padding: '8px 10px', fontWeight: 700, color: '#0F172A' }}>{e.rank}</td>
                        <td style={{ padding: '8px 10px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <Chip tone={e.direction === 'BUY' ? 'green' : 'red'}>{e.direction}</Chip>
                            <span style={{ fontWeight: 600, color: '#0F172A' }}>{e.strategyName}</span>
                          </div>
                        </td>
                        <td style={{ padding: '8px 10px', color: '#64748B' }}>{e.category.replace(/_/g, ' ')}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: '#475569' }}>
                          {e.evaluatedSignals}/{e.totalSignals}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          {e.performanceStatus === 'INSUFFICIENT_DATA' ? '—' : fmtPct(e.winRate)}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: e.averageReturnPct >= 0 ? '#047857' : '#B91C1C' }}>
                          {e.performanceStatus === 'INSUFFICIENT_DATA' ? '—' : fmtPct(e.averageReturnPct)}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          {e.performanceStatus === 'INSUFFICIENT_DATA' ? '—' : fmtSigned(e.expectancy)}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>
                          {e.performanceStatus === 'INSUFFICIENT_DATA' ? '—' : e.profitFactor.toFixed(2)}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: '#B91C1C' }}>
                          {e.performanceStatus === 'INSUFFICIENT_DATA' ? '—' : `${e.maxDrawdownPct.toFixed(1)}%`}
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <Chip tone={toneForHealth(e.healthLabel)}>
                            {e.healthLabel === 'INSUFFICIENT_DATA' ? 'NEED DATA' : e.healthLabel}
                            {e.performanceStatus !== 'INSUFFICIENT_DATA' && ` · ${e.strategyHealthScore}`}
                          </Chip>
                        </td>
                        <td style={{ padding: '8px 10px' }}>
                          <Chip tone={recommendationTone(e.recommendation)}>{e.recommendation}</Chip>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Detail panel — only when a strategy is selected. */}
        {selected && selectedStrategy && (
          <Card
            title={`${selectedStrategy.strategyName} — Detail`}
            action={
              <button
                onClick={() => setSelected(null)}
                style={{ background: 'transparent', border: 'none', color: '#1D4ED8', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}
              >Close ×</button>
            }
            style={{ marginBottom: 16 }}
          >
            <DetailContent
              perf={selectedStrategy}
              detail={selectedDetail ?? null}
            />
          </Card>
        )}

        <div style={{ marginTop: 16, fontSize: 10, color: '#94A3B8', textAlign: 'center' }}>
          Strategy performance is observational only and is not financial advice.
        </div>
      </div>
    </AppShell>
  );
}

// ── Subcomponents ──────────────────────────────────────────────

function HeadlineCard({
  icon: Icon, tone, label, value, sub,
}: {
  icon: React.ElementType;
  tone: 'green' | 'amber' | 'red' | 'blue' | 'grey';
  label: string;
  value: string;
  sub: string;
}) {
  const pal = TONE_PALETTE[tone];
  return (
    <div style={{
      padding: '14px 16px', background: '#FFFFFF',
      border: '1px solid #E2E8F0', borderTop: `3px solid ${pal.border}`,
      borderRadius: 8, boxShadow: '0 1px 2px rgba(15,23,42,0.04)',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 22, height: 22, borderRadius: 4, background: pal.bg, color: pal.color }}>
          <Icon size={13} />
        </span>
        <span style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</span>
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: '#0F172A', lineHeight: 1.3, marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 11, color: '#64748B' }}>{sub}</div>
    </div>
  );
}

function EmptyLeaderboard({ window }: { window: Window }) {
  return (
    <div style={{ padding: '32px 20px', textAlign: 'center', color: '#475569' }}>
      <Activity size={28} color="#94A3B8" style={{ marginBottom: 8 }} />
      <div style={{ fontSize: 14, fontWeight: 700, color: '#0F172A', marginBottom: 4 }}>
        Strategy performance requires more evaluated signals
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.5 }}>
        Run the scanner and allow generated signals to mature across future candles before ranking strategy quality.
        Selected window: <strong>{window}</strong>.
      </div>
      <div style={{ marginTop: 12 }}>
        <Link href="/backtesting" style={{ fontSize: 11, fontWeight: 700, color: '#1D4ED8', textDecoration: 'none' }}>
          Run a backtest <ChevronRight size={11} style={{ verticalAlign: -1 }} />
        </Link>
      </div>
    </div>
  );
}

function DetailContent({ perf, detail }: { perf: StrategyPerformance; detail: DetailBlock | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Summary */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10 }}>
        <Metric label="Total" value={String(perf.totalSignals)} />
        <Metric label="Evaluated" value={String(perf.evaluatedSignals)} />
        <Metric label="Win Rate" value={perf.performanceStatus === 'INSUFFICIENT_DATA' ? '—' : `${perf.winRate.toFixed(1)}%`} />
        <Metric label="Expectancy" value={perf.performanceStatus === 'INSUFFICIENT_DATA' ? '—' : fmtSigned(perf.expectancy)} />
        <Metric label="Profit Factor" value={perf.performanceStatus === 'INSUFFICIENT_DATA' ? '—' : perf.profitFactor.toFixed(2)} />
        <Metric label="Max DD" value={perf.performanceStatus === 'INSUFFICIENT_DATA' ? '—' : `${perf.maxDrawdownPct.toFixed(1)}%`} />
      </div>

      <div style={{ padding: '10px 14px', background: '#F8FAFC', borderLeft: '3px solid #1D4ED8', borderRadius: 6, fontSize: 12, color: '#334155', lineHeight: 1.5 }}>
        <strong>Health:</strong> {perf.healthExplanation}
      </div>

      {/* Status breakdown */}
      {detail?.statusBreakdown && detail.statusBreakdown.length > 0 && (
        <Section title="Approved vs Watchlist vs Rejected">
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead><tr style={{ background: '#F8FAFC' }}>
              {['Status', 'Signals', 'Evaluated', 'Win %', 'Avg Return', 'Expectancy'].map((h) => (
                <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontSize: 10, color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase' }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {detail.statusBreakdown.map((b) => (
                <tr key={b.status} style={{ borderTop: '1px solid #F1F5F9' }}>
                  <td style={{ padding: '6px 10px' }}><Chip tone={b.status === 'APPROVED' ? 'green' : b.status === 'WATCHLIST' ? 'amber' : 'red'}>{b.status}</Chip></td>
                  <td style={{ padding: '6px 10px' }}>{b.signals}</td>
                  <td style={{ padding: '6px 10px' }}>{b.evaluatedSignals}</td>
                  <td style={{ padding: '6px 10px' }}>{b.evaluatedSignals > 0 ? fmtPct(b.winRate) : '—'}</td>
                  <td style={{ padding: '6px 10px', color: b.averageReturnPct >= 0 ? '#047857' : '#B91C1C' }}>{b.evaluatedSignals > 0 ? fmtPct(b.averageReturnPct) : '—'}</td>
                  <td style={{ padding: '6px 10px' }}>{b.evaluatedSignals > 0 ? fmtSigned(b.expectancy) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* Sector breakdown */}
      <Section title="Sector Performance">
        {detail?.sectorPerformanceStatus === 'UNAVAILABLE' || !detail?.sectorPerformance?.length ? (
          <EmptyHint>{detail?.sectorPerformanceMessage ?? 'Sector mapping is not available for historical signals.'}</EmptyHint>
        ) : (
          <BucketTable
            rows={detail.sectorPerformance.map((b) => ({
              label: b.sector, signals: b.signals, evaluated: b.evaluatedSignals,
              winRate: b.winRate, avgReturn: b.averageReturnPct, expectancy: b.expectancy,
              trailingChip: <Chip tone={toneForHealth(b.healthLabel)}>{b.healthLabel}</Chip>,
            }))}
            keyHeader="Sector"
          />
        )}
      </Section>

      {/* Regime breakdown */}
      <Section title="Market Regime Performance">
        {detail?.regimePerformanceStatus === 'INSUFFICIENT_DATA' || !detail?.regimePerformance?.length ? (
          <EmptyHint>{detail?.regimePerformanceMessage ?? 'Market regime not recorded on historical signals — regime-wise analysis unavailable.'}</EmptyHint>
        ) : (
          <BucketTable
            rows={detail.regimePerformance.map((b) => ({
              label: b.regime, signals: b.signals, evaluated: b.evaluatedSignals,
              winRate: b.winRate, avgReturn: b.averageReturnPct, expectancy: b.expectancy,
              trailingChip: <Chip tone={recommendationTone(b.recommendation)}>{b.recommendation}</Chip>,
            }))}
            keyHeader="Regime"
          />
        )}
      </Section>

      {/* Confidence buckets */}
      <Section title="Confidence Bucket Performance">
        {!detail?.confidenceBuckets?.length ? (
          <EmptyHint>Confidence-bucketed performance unavailable.</EmptyHint>
        ) : (
          <>
            {detail.confidenceCalibrationWarning && (
              <div style={{ marginBottom: 8, padding: '8px 12px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, fontSize: 11, color: '#92400E' }}>
                <AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 4 }} />
                {detail.confidenceCalibrationWarning}
              </div>
            )}
            <BucketTable
              rows={detail.confidenceBuckets.map((b) => ({
                label: b.bucket, signals: b.signals, evaluated: b.evaluatedSignals,
                winRate: b.winRate, avgReturn: b.averageReturnPct, expectancy: b.expectancy,
              }))}
              keyHeader="Confidence"
            />
          </>
        )}
      </Section>

      {/* Warnings */}
      {perf.warnings.length > 0 && (
        <div style={{ padding: '8px 12px', background: '#FFFBEB', border: '1px solid #FDE68A', borderRadius: 6, fontSize: 11, color: '#92400E', lineHeight: 1.5 }}>
          <strong>Notes:</strong>
          <ul style={{ margin: '4px 0 0 0', paddingLeft: 16 }}>
            {perf.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '12px 14px', background: '#F8FAFC', border: '1px dashed #CBD5E1', borderRadius: 6, color: '#64748B', fontSize: 12, lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: '10px 12px', background: '#F8FAFC', border: '1px solid #E2E8F0', borderRadius: 6 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: '#0F172A', marginTop: 2 }}>{value}</div>
    </div>
  );
}

function BucketTable({
  rows, keyHeader,
}: {
  rows: Array<{
    label: string;
    signals: number;
    evaluated: number;
    winRate: number;
    avgReturn: number;
    expectancy: number;
    trailingChip?: React.ReactNode;
  }>;
  keyHeader: string;
}) {
  return (
    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
      <thead><tr style={{ background: '#F8FAFC' }}>
        {[keyHeader, 'Signals', 'Evaluated', 'Win %', 'Avg Return', 'Expectancy', ...(rows.some((r) => r.trailingChip) ? ['Tag'] : [])].map((h) => (
          <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontSize: 10, color: '#94A3B8', fontWeight: 700, textTransform: 'uppercase' }}>{h}</th>
        ))}
      </tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
            <td style={{ padding: '6px 10px', fontWeight: 600 }}>{r.label}</td>
            <td style={{ padding: '6px 10px' }}>{r.signals}</td>
            <td style={{ padding: '6px 10px' }}>{r.evaluated}</td>
            <td style={{ padding: '6px 10px' }}>{r.evaluated > 0 ? fmtPct(r.winRate) : '—'}</td>
            <td style={{ padding: '6px 10px', color: r.avgReturn >= 0 ? '#047857' : '#B91C1C' }}>{r.evaluated > 0 ? fmtPct(r.avgReturn) : '—'}</td>
            <td style={{ padding: '6px 10px' }}>{r.evaluated > 0 ? fmtSigned(r.expectancy) : '—'}</td>
            {r.trailingChip && <td style={{ padding: '6px 10px' }}>{r.trailingChip}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
