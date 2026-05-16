'use client';
// ════════════════════════════════════════════════════════════════
//  /signals/backtesting — Phase 4 Backtesting Lab.
//
//  Reads /api/signals/backtest and renders performance, tier
//  comparison, indicator analysis, threshold simulation, regime
//  performance, missed-opportunity backtest, and recommendations.
//
//  Empty / INSUFFICIENT_DATA states are rendered explicitly — no
//  fabricated win-rates, no fabricated outcomes.
// ════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import AppShell from '@/components/layout/AppShell';
import { Card } from '@/components/ui';
import {
  ChevronLeft, RefreshCw, FlaskConical, AlertTriangle,
  Shield, Activity, BarChart3, Target, Database,
} from 'lucide-react';

type BacktestStatus = 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA' | 'FAILED';
type GovernanceFlag = 'REVIEW_ONLY' | 'REVIEW_REQUIRED' | 'DO_NOT_APPLY_AUTOMATICALLY';
type BacktestWindow = 'INTRADAY' | '1D' | '7D' | '30D' | '90D' | 'CUSTOM';

interface BacktestPerformance {
  totalTrades:           number;
  wins:                  number;
  losses:                number;
  neutral:               number;
  pending:               number;
  insufficientData:      number;
  winRate:               number | null;
  avgReturnPercent:      number | null;
  medianReturnPercent:   number | null;
  bestReturnPercent:     number | null;
  worstReturnPercent:    number | null;
  avgMfePercent:         number | null;
  avgMaePercent:         number | null;
  targetHitRate:         number | null;
  stopHitRate:           number | null;
  expectancy:            number | null;
  profitFactor:          number | null;
  maxDrawdownPercent:    number | null;
}
interface BacktestTierPerformance {
  tier:               'APPROVED' | 'HIGH_POTENTIAL' | 'WATCHLIST' | 'REJECTED';
  total:              number;
  wins:               number;
  losses:             number;
  winRate:            number | null;
  avgReturnPercent:   number | null;
  targetHitRate:      number | null;
  stopHitRate:        number | null;
  notes:              string[];
}
interface BacktestIndicatorPerformance {
  indicator:        string;
  totalSignals:     number;
  wins:             number;
  losses:           number;
  pending:          number;
  winRate:          number | null;
  avgReturnPercent: number | null;
  bestWindow:       string | null;
  notes:            string[];
}
interface BacktestIndicatorCombination {
  combination:      string;
  totalSignals:     number;
  wins:             number;
  losses:           number;
  winRate:          number | null;
  avgReturnPercent: number | null;
  notes:            string[];
}
interface ThresholdSimulationResult {
  simulationName:           string;
  finalScoreThreshold:      number;
  confidenceThreshold:      number;
  riskRewardThreshold:      number;
  simulatedSignalCount:     number;
  wins:                     number;
  losses:                   number;
  winRate:                  number | null;
  avgReturnPercent:         number | null;
  falsePositiveRate:        number | null;
  notes:                    string[];
  governanceStatus:         GovernanceFlag;
}
interface MarketRegimeBacktestResult {
  regime:              string;
  totalSignals:        number;
  wins:                number;
  losses:              number;
  winRate:             number | null;
  avgReturnPercent:    number | null;
  bestIndicators:      string[];
  weakIndicators:      string[];
  notes:               string[];
}
interface MissedOpportunityBacktestItem {
  symbol:              string;
  date:                string;
  actualMovePercent:   number | null;
  highestTierReached:  string;
  reasonNotApproved:   string;
  failedConditions:    string[];
  backtestFinding:     string;
  learningPriority:    'LOW' | 'MEDIUM' | 'HIGH';
  suggestedReview:     string;
}
interface BacktestRecommendation {
  title:               string;
  observation:         string;
  evidence:            string;
  suggestedAction:     string;
  governanceStatus:    string;
  priority:            string;
}

// PHASE_B_MANIPULATION — shells for the manipulation-filter backtest.
type ManipulationBacktestStatus = 'AVAILABLE' | 'INSUFFICIENT_DATA' | 'NOT_CONFIGURED';
type ManipulationBand           = 'LOW' | 'WATCH' | 'ELEVATED' | 'HIGH' | 'SEVERE';

interface ManipulationBacktestSlice {
  totalSignals:       number;
  winRate:            number | null;
  avgReturnPercent:   number | null;
  maxDrawdownPercent: number | null;
}

interface ManipulationBacktestReview {
  status:                  ManipulationBacktestStatus;
  withFilter:              ManipulationBacktestSlice | null;
  withoutFilter:           ManipulationBacktestSlice | null;
  blockedButPerformed:     number;
  blockedAndFailed:        number;
  warningOnlyCount:        number;
  scoreBucketPerformance:  Array<{
    band:               ManipulationBand;
    total:              number;
    winRate:            number | null;
    avgReturnPercent:   number | null;
  }>;
  notes:                   string[];
}
interface BacktestResult {
  backtestId:                 string;
  runDate:                    string;
  generatedAt:                string;
  window:                     BacktestWindow;
  startDate:                  string;
  endDate:                    string;
  status:                     BacktestStatus;
  universe: {
    symbolsTested:              number;
    approvedSignalsTested:      number;
    highPotentialTested:        number;
    watchlistTested:            number;
    rejectedTested:             number;
    simulatedCandidatesTested:  number;
  };
  performance:                BacktestPerformance;
  tierPerformance: {
    approved:        BacktestTierPerformance;
    highPotential:   BacktestTierPerformance;
    watchlist:       BacktestTierPerformance;
    rejected:        BacktestTierPerformance;
  };
  indicatorPerformance:       BacktestIndicatorPerformance[];
  indicatorCombinations:      BacktestIndicatorCombination[];
  thresholdSimulation:        ThresholdSimulationResult[];
  marketRegimePerformance:    MarketRegimeBacktestResult[];
  missedOpportunityBacktest:  MissedOpportunityBacktestItem[];
  warnings:                   string[];
  recommendations:            BacktestRecommendation[];
  manipulationBacktest?:      ManipulationBacktestReview | null;
}
interface ApiEnvelope {
  ok:           boolean;
  source?:      string;
  generatedAt?: string;
  backtest?:    BacktestResult | null;
  warnings?:    string[];
}

const statusBadge = (status: BacktestStatus): { bg: string; color: string; border: string; label: string } => {
  switch (status) {
    case 'COMPLETE':          return { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0', label: 'COMPLETE' };
    case 'PARTIAL':           return { bg: '#FFFBEB', color: '#92400E', border: '#FDE68A', label: 'PARTIAL' };
    case 'INSUFFICIENT_DATA': return { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1', label: 'INSUFFICIENT DATA' };
    case 'FAILED':            return { bg: '#FEF2F2', color: '#991B1B', border: '#FECACA', label: 'FAILED' };
  }
};

const fmtPct = (n: number | null | undefined): string => (n != null ? `${n}%` : '—');
const fmtNum = (n: number | null | undefined): string => (n != null ? String(n) : '—');

function Badge({ palette, children }: { palette: { bg: string; color: string; border: string }; children: React.ReactNode }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 10px', borderRadius: 999,
      background: palette.bg, color: palette.color,
      border: `1px solid ${palette.border}`,
      fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
    }}>{children}</span>
  );
}

function SectionHeader({ title, status }: { title: string; status?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: '#0F172A', letterSpacing: 0.4 }}>{title}</h2>
      {status && (
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
          padding: '2px 8px', borderRadius: 999,
          background: status === 'COMPLETE' ? '#F0FDF4' : status === 'PARTIAL' ? '#FFFBEB' : '#F1F5F9',
          color: status === 'COMPLETE' ? '#15803D' : status === 'PARTIAL' ? '#92400E' : '#475569',
          border: `1px solid ${status === 'COMPLETE' ? '#BBF7D0' : status === 'PARTIAL' ? '#FDE68A' : '#CBD5E1'}`,
        }}>
          {status === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT DATA' : status}
        </span>
      )}
    </div>
  );
}

function EmptySection({ message }: { message: string }) {
  return (
    <div style={{
      padding: '14px 16px', background: '#F8FAFC',
      border: '1px dashed #CBD5E1', borderRadius: 8,
      color: '#475569', fontSize: 12,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <AlertTriangle size={14} color="#94A3B8" />
      <span>{message}</span>
    </div>
  );
}

const th: React.CSSProperties = {
  textAlign: 'left', padding: '8px 10px',
  fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
  color: '#94A3B8', textTransform: 'uppercase',
};
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 12, color: '#0F172A' };

function StatCard({ label, value, accent, hint }: {
  label: string; value: string; accent: string; hint?: string;
}) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: 8, background: '#FFFFFF', border: '1px solid #E2E8F0' }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: '#94A3B8', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent, marginTop: 2 }}>{value}</div>
      {hint && <div style={{ fontSize: 10, color: '#94A3B8', marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

// PHASE_B_MANIPULATION — slice renderer for with-filter / without-filter
// blocks. Renders 'Insufficient data' rather than '0' / '—' so the user
// can never mistake a missing value for a real measurement.
function ManipulationSliceTable({ title, slice, accent }: {
  title: string; slice: ManipulationBacktestSlice | null; accent: string;
}) {
  return (
    <div style={{ padding: '10px 12px', borderRadius: 8, background: '#FFFFFF', border: '1px solid #E2E8F0' }}>
      <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: 0.4, color: accent, textTransform: 'uppercase', marginBottom: 6 }}>
        {title}
      </div>
      {slice ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', rowGap: 4, columnGap: 10, fontSize: 12, color: '#0F172A' }}>
          <div>Signals: <strong>{slice.totalSignals}</strong></div>
          <div>Win Rate: <strong>{slice.winRate != null ? `${slice.winRate}%` : 'Insufficient data'}</strong></div>
          <div>Avg Return: <strong>{slice.avgReturnPercent != null ? `${slice.avgReturnPercent}%` : 'Insufficient data'}</strong></div>
          <div>Max DD: <strong>{slice.maxDrawdownPercent != null ? `${slice.maxDrawdownPercent}%` : 'Insufficient data'}</strong></div>
        </div>
      ) : (
        <div style={{ fontSize: 11.5, color: '#475569' }}>Insufficient data</div>
      )}
    </div>
  );
}

const WINDOWS: BacktestWindow[] = ['INTRADAY', '1D', '7D', '30D', '90D'];

export default function BacktestingLabPage() {
  const [window, setWindow]   = useState<BacktestWindow>('1D');
  const [data, setData]       = useState<ApiEnvelope | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const loadAbortRef = useRef<AbortController | null>(null);

  const load = async (w: BacktestWindow) => {
    loadAbortRef.current?.abort('superseded');
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/signals/backtest?window=${encodeURIComponent(w)}`,
        { cache: 'no-store', signal: controller.signal },
      );
      if (!res.ok) {
        setError(`API returned ${res.status}`);
        setData(null);
        return;
      }
      if (!controller.signal.aborted) setData(await res.json() as ApiEnvelope);
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') return;
      setError(err.message ?? 'Failed to load backtest');
      setData(null);
    } finally {
      if (loadAbortRef.current === controller) setLoading(false);
    }
  };

  useEffect(() => {
    void load(window);
    return () => { loadAbortRef.current?.abort('unmount'); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [window]);

  const bt = data?.backtest ?? null;
  const status: BacktestStatus = bt?.status ?? 'INSUFFICIENT_DATA';

  return (
    <AppShell title="Signal Backtesting Lab">
      <div className="page">
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
          <Link href="/signals" style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontSize: 12, color: '#475569', textDecoration: 'none',
            padding: '6px 10px', borderRadius: 6,
            background: '#F8FAFC', border: '1px solid #E2E8F0',
          }}>
            <ChevronLeft size={14} /> Back to Signal Engine
          </Link>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: '#0F172A' }}>
            Signal Backtesting Lab
          </h1>
          <div style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 4 }}>
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                className={`btn btn--sm ${window === w ? 'btn--primary' : 'btn--secondary'}`}
                onClick={() => setWindow(w)}
                style={{ minWidth: 60 }}
              >{w}</button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            onClick={() => void load(window)}
            disabled={loading}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
            Refresh
          </button>
          {/* PRE_PHASE_6_STABILIZATION — full cross-page nav */}
          <Link href="/signals/daily-report" style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 10px', borderRadius: 6,
            background: '#F8FAFC', color: '#475569', textDecoration: 'none',
            border: '1px solid #E2E8F0',
            fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
          }} title="Open the Daily Signal Intelligence Report">
            View Daily Report
          </Link>
          <Link href="/signals/engine-health" style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 10px', borderRadius: 6,
            background: '#F8FAFC', color: '#475569', textDecoration: 'none',
            border: '1px solid #E2E8F0',
            fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
          }} title="Open the Engine Health Map">
            View Engine Health
          </Link>
        </div>

        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
            <FlaskConical size={18} color="#475569" />
            <div style={{ fontSize: 13, color: '#0F172A' }}>
              <strong>Window: {bt?.window ?? window}</strong>
              <span style={{ marginLeft: 8, color: '#94A3B8' }}>
                · {bt?.startDate ?? '—'} → {bt?.endDate ?? '—'}
              </span>
            </div>
            <Badge palette={statusBadge(status)}>{statusBadge(status).label}</Badge>
            {bt?.generatedAt && (
              <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 'auto' }}>
                Generated {new Date(bt.generatedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          {error && <div style={{ marginTop: 10, color: '#B91C1C', fontSize: 12 }}>{error}</div>}
          {bt?.warnings && bt.warnings.length > 0 && (
            <ul style={{ marginTop: 10, marginBottom: 0, paddingLeft: 18, color: '#92400E', fontSize: 11.5, lineHeight: 1.5 }}>
              {bt.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
          <div style={{ marginTop: 10, fontSize: 10, color: '#94A3B8' }}>
            Simulations and recommendations are <strong>governance-flagged</strong>. No live thresholds or scoring weights are modified by this page.
          </div>
        </Card>

        {/* Performance Overview */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Performance Overview" />
          {bt ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
              <StatCard label="Total Tested"        value={String(bt.universe.symbolsTested)}                accent="#1D4ED8" />
              <StatCard label="Win Rate"            value={fmtPct(bt.performance.winRate)}                   accent="#15803D" />
              <StatCard label="Avg Return"          value={bt.performance.avgReturnPercent != null ? `${bt.performance.avgReturnPercent}%` : '—'} accent="#15803D" />
              <StatCard label="Target Hit Rate"     value={fmtPct(bt.performance.targetHitRate)}             accent="#15803D" />
              <StatCard label="Stop Hit Rate"       value={fmtPct(bt.performance.stopHitRate)}               accent="#B91C1C" />
              <StatCard label="Profit Factor"       value={fmtNum(bt.performance.profitFactor)}              accent="#1D4ED8" />
              <StatCard label="Expectancy"          value={fmtNum(bt.performance.expectancy)}                accent="#7C3AED" />
              <StatCard label="Max Drawdown"        value={fmtPct(bt.performance.maxDrawdownPercent)}        accent="#B91C1C" />
              <StatCard label="Insufficient Data"   value={String(bt.performance.insufficientData)}          accent="#475569" hint={`of ${bt.performance.totalTrades}`} />
            </div>
          ) : (
            <EmptySection message={loading ? 'Loading…' : 'No backtest available.'} />
          )}
        </Card>

        {/* Tier Performance */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Tier Performance" />
          {bt ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#F8FAFC' }}>
                  <th style={th}>Tier</th>
                  <th style={th}>Total</th>
                  <th style={th}>Wins</th>
                  <th style={th}>Losses</th>
                  <th style={th}>Win Rate</th>
                  <th style={th}>Avg Return</th>
                  <th style={th}>Target Hit</th>
                  <th style={th}>Stop Hit</th>
                </tr>
              </thead>
              <tbody>
                {(['approved', 'highPotential', 'watchlist', 'rejected'] as const).map((k) => {
                  const t = bt.tierPerformance[k];
                  return (
                    <tr key={k} style={{ borderTop: '1px solid #F1F5F9' }}>
                      <td style={td}><strong>{t.tier.replace('_', ' ')}</strong></td>
                      <td style={td}>{t.total}</td>
                      <td style={td}>{t.wins}</td>
                      <td style={td}>{t.losses}</td>
                      <td style={td}>{fmtPct(t.winRate)}</td>
                      <td style={td}>{t.avgReturnPercent != null ? `${t.avgReturnPercent}%` : '—'}</td>
                      <td style={td}>{fmtPct(t.targetHitRate)}</td>
                      <td style={td}>{fmtPct(t.stopHitRate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <EmptySection message="No tier data available." />
          )}
        </Card>

        {/* Indicator Backtest */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Indicator Backtest" />
          {bt && bt.indicatorPerformance.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#F8FAFC' }}>
                  <th style={th}>Indicator</th>
                  <th style={th}>Signals</th>
                  <th style={th}>Wins</th>
                  <th style={th}>Losses</th>
                  <th style={th}>Win Rate</th>
                  <th style={th}>Avg Return</th>
                </tr>
              </thead>
              <tbody>
                {bt.indicatorPerformance.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                    <td style={td}><strong>{r.indicator}</strong></td>
                    <td style={td}>{r.totalSignals}</td>
                    <td style={td}>{r.wins}</td>
                    <td style={td}>{r.losses}</td>
                    <td style={td}>{fmtPct(r.winRate)}</td>
                    <td style={td}>{r.avgReturnPercent != null ? `${r.avgReturnPercent}%` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptySection message="Indicator outcome data unavailable for this window." />
          )}
          {bt && bt.indicatorCombinations.length > 0 && (
            <div style={{ marginTop: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 800, color: '#0F172A', letterSpacing: 0.4, marginBottom: 6 }}>
                INDICATOR COMBINATIONS
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: '#F8FAFC' }}>
                    <th style={th}>Combination</th>
                    <th style={th}>Signals</th>
                    <th style={th}>Win Rate</th>
                    <th style={th}>Avg Return</th>
                  </tr>
                </thead>
                <tbody>
                  {bt.indicatorCombinations.map((c, i) => (
                    <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                      <td style={td}><strong>{c.combination}</strong></td>
                      <td style={td}>{c.totalSignals}</td>
                      <td style={td}>{fmtPct(c.winRate)}</td>
                      <td style={td}>{c.avgReturnPercent != null ? `${c.avgReturnPercent}%` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Threshold Simulation */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Threshold Simulation" />
          <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 10 }}>
            <Shield size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            REVIEW ONLY — simulations do not modify live approval policy.
          </div>
          {bt && bt.thresholdSimulation.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#F8FAFC' }}>
                  <th style={th}>Hypothesis</th>
                  <th style={th}>Signals</th>
                  <th style={th}>Win Rate</th>
                  <th style={th}>Avg Return</th>
                  <th style={th}>False Positive</th>
                  <th style={th}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {bt.thresholdSimulation.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                    <td style={td}><strong>{r.simulationName}</strong></td>
                    <td style={td}>{r.simulatedSignalCount}</td>
                    <td style={td}>{fmtPct(r.winRate)}</td>
                    <td style={td}>{r.avgReturnPercent != null ? `${r.avgReturnPercent}%` : '—'}</td>
                    <td style={td}>{fmtPct(r.falsePositiveRate)}</td>
                    <td style={{ ...td, color: '#475569' }}>{r.notes.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptySection message="No threshold simulations available." />
          )}
        </Card>

        {/* PHASE_B_MANIPULATION — Manipulation Filter Backtest */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader
            title="Manipulation Filter Backtest"
            status={bt?.manipulationBacktest?.status === 'AVAILABLE' ? 'COMPLETE'
              : bt?.manipulationBacktest?.status === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT_DATA'
              : bt?.manipulationBacktest?.status === 'NOT_CONFIGURED' ? 'INSUFFICIENT_DATA'
              : undefined}
          />
          <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 10 }}>
            <Shield size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Surveillance review only — manipulation gate stays in warning-only mode when data is missing or stale.
          </div>
          {bt?.manipulationBacktest ? (
            bt.manipulationBacktest.status !== 'AVAILABLE' ? (
              <>
                <EmptySection message="Manipulation backtest unavailable — historical manipulation risk memory not configured." />
                {bt.manipulationBacktest.notes.length > 0 && (
                  <ul style={{ marginTop: 8, paddingLeft: 18, color: '#94A3B8', fontSize: 11, lineHeight: 1.5 }}>
                    {bt.manipulationBacktest.notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                )}
              </>
            ) : (
              <>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
                  gap: 12,
                }}>
                  <ManipulationSliceTable title="With Filter"    slice={bt.manipulationBacktest.withFilter}    accent="#15803D" />
                  <ManipulationSliceTable title="Without Filter" slice={bt.manipulationBacktest.withoutFilter} accent="#B45309" />
                </div>
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                  gap: 12, marginTop: 12,
                }}>
                  <StatCard label="Blocked but Performed" value={String(bt.manipulationBacktest.blockedButPerformed)} accent="#B45309" />
                  <StatCard label="Blocked and Failed"    value={String(bt.manipulationBacktest.blockedAndFailed)}    accent="#15803D" />
                  <StatCard label="Warning-Only"          value={String(bt.manipulationBacktest.warningOnlyCount)}    accent="#475569" />
                </div>
                {bt.manipulationBacktest.scoreBucketPerformance.length > 0 && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 800, color: '#0F172A', letterSpacing: 0.4, marginBottom: 6 }}>
                      SCORE BUCKET PERFORMANCE
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: '#F8FAFC' }}>
                          <th style={th}>Band</th>
                          <th style={th}>Signals</th>
                          <th style={th}>Win Rate</th>
                          <th style={th}>Avg Return</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bt.manipulationBacktest.scoreBucketPerformance.map((b, i) => (
                          <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                            <td style={td}><strong>{b.band}</strong></td>
                            <td style={td}>{b.total}</td>
                            <td style={td}>{b.winRate != null ? `${b.winRate}%` : 'Insufficient data'}</td>
                            <td style={td}>{b.avgReturnPercent != null ? `${b.avgReturnPercent}%` : 'Insufficient data'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {bt.manipulationBacktest.notes.length > 0 && (
                  <ul style={{ marginTop: 10, paddingLeft: 18, color: '#94A3B8', fontSize: 11, lineHeight: 1.5 }}>
                    {bt.manipulationBacktest.notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                )}
              </>
            )
          ) : (
            <EmptySection message="Manipulation backtest unavailable — historical manipulation risk memory not configured." />
          )}
        </Card>

        {/* Market Regime */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Market Regime Performance" />
          {bt && bt.marketRegimePerformance.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#F8FAFC' }}>
                  <th style={th}>Regime</th>
                  <th style={th}>Signals</th>
                  <th style={th}>Win Rate</th>
                  <th style={th}>Best Indicators</th>
                  <th style={th}>Weak Indicators</th>
                </tr>
              </thead>
              <tbody>
                {bt.marketRegimePerformance.map((r, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                    <td style={td}><strong>{r.regime}</strong></td>
                    <td style={td}>{r.totalSignals}</td>
                    <td style={td}>{fmtPct(r.winRate)}</td>
                    <td style={{ ...td, color: '#15803D' }}>{r.bestIndicators.join(', ') || '—'}</td>
                    <td style={{ ...td, color: '#B91C1C' }}>{r.weakIndicators.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptySection message="No regime data available." />
          )}
        </Card>

        {/* Missed Opportunities */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Missed Opportunity Backtest" />
          {bt && bt.missedOpportunityBacktest.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#F8FAFC' }}>
                  <th style={th}>Symbol</th>
                  <th style={th}>Move</th>
                  <th style={th}>Tier Reached</th>
                  <th style={th}>Reason Missed</th>
                  <th style={th}>Backtest Finding</th>
                  <th style={th}>Priority</th>
                </tr>
              </thead>
              <tbody>
                {bt.missedOpportunityBacktest.map((m, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                    <td style={td}><strong>{m.symbol}</strong></td>
                    <td style={{ ...td, color: (m.actualMovePercent ?? 0) >= 0 ? '#15803D' : '#B91C1C' }}>
                      {m.actualMovePercent != null ? `${m.actualMovePercent.toFixed(2)}%` : '—'}
                    </td>
                    <td style={td}>{m.highestTierReached}</td>
                    <td style={{ ...td, color: '#475569' }}>{m.reasonNotApproved}</td>
                    <td style={{ ...td, color: '#475569' }}>{m.backtestFinding}</td>
                    <td style={td}>
                      <span style={{
                        padding: '2px 8px', borderRadius: 4,
                        background: m.learningPriority === 'HIGH' ? '#FEE2E2'
                                  : m.learningPriority === 'MEDIUM' ? '#FEF3C7' : '#F1F5F9',
                        color: m.learningPriority === 'HIGH' ? '#7F1D1D'
                              : m.learningPriority === 'MEDIUM' ? '#92400E' : '#475569',
                        fontWeight: 700, fontSize: 10, letterSpacing: 0.4,
                      }}>{m.learningPriority}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptySection message="Market movers feed not configured — missed-opportunity backtest is empty." />
          )}
        </Card>

        {/* Recommendations */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Recommendations" />
          <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 10 }}>
            All recommendations require analyst review. Scoring weights are <strong>not</strong> modified automatically.
          </div>
          {bt && bt.recommendations.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
              {bt.recommendations.map((r, i) => (
                <div key={i} style={{
                  padding: '12px 14px', borderRadius: 8,
                  background: '#FFFFFF', border: '1px solid #E2E8F0',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13, color: '#0F172A' }}>{r.title}</strong>
                    <span style={{
                      padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: 0.4,
                      background: r.priority === 'CRITICAL' ? '#FEE2E2'
                                : r.priority === 'HIGH' ? '#FEF3C7'
                                : r.priority === 'MEDIUM' ? '#EFF6FF' : '#F1F5F9',
                      color: r.priority === 'CRITICAL' ? '#7F1D1D'
                            : r.priority === 'HIGH' ? '#92400E'
                            : r.priority === 'MEDIUM' ? '#1D4ED8' : '#475569',
                    }}>{r.priority}</span>
                    <span style={{
                      padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 700,
                      background: '#F8FAFC', color: '#475569', border: '1px solid #CBD5E1',
                    }}>{r.governanceStatus}</span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: '#334155' }}>{r.observation}</div>
                  <div style={{ marginTop: 4, fontSize: 11, color: '#64748B' }}>
                    <strong>Evidence:</strong> {r.evidence}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: '#0F172A' }}>
                    <strong>Suggested action:</strong> {r.suggestedAction}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptySection message="No recommendations available." />
          )}
        </Card>

        {/* Data Quality */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Data Quality" />
          {bt ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <StatCard label="Symbols Tested"      value={String(bt.universe.symbolsTested)}            accent="#1D4ED8" />
              <StatCard label="Approved"            value={String(bt.universe.approvedSignalsTested)}    accent="#15803D" />
              <StatCard label="High Potential"      value={String(bt.universe.highPotentialTested)}      accent="#B45309" />
              <StatCard label="Watchlist"           value={String(bt.universe.watchlistTested)}          accent="#1D4ED8" />
              <StatCard label="Rejected"            value={String(bt.universe.rejectedTested)}           accent="#7F1D1D" />
              <StatCard label="Insufficient Data"   value={String(bt.performance.insufficientData)}      accent="#475569" />
            </div>
          ) : (
            <EmptySection message="No data-quality breakdown available." />
          )}
          {bt && bt.warnings.length > 0 && (
            <ul style={{ marginTop: 10, paddingLeft: 18, color: '#B45309', fontSize: 12, lineHeight: 1.5 }}>
              {bt.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </Card>

        <div style={{ marginTop: 16, fontSize: 10, color: '#94A3B8', textAlign: 'center' }}>
          Backtest is for institutional explainability only and is not financial advice.
        </div>
      </div>
    </AppShell>
  );
}
