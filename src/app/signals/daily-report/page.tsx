'use client';
// ════════════════════════════════════════════════════════════════
//  /signals/daily-report
//
//  Phase 3 — Daily Signal Intelligence Report page.
//
//  Reads /api/signals/daily-report and renders:
//   1. Header (date selector + status badges)
//   2. Executive summary
//   3. Signal performance overview
//   4. Indicator performance
//   5. Missed opportunities
//   6. Sector & market regime
//   7. Top block reasons
//   8. Learning recommendations
//   9. Data quality & reliability
//
//  Empty / INSUFFICIENT_DATA states are rendered explicitly — the
//  page never paints fabricated numbers in place of missing data.
// ════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import AppShell from '@/components/layout/AppShell';
import { Card } from '@/components/ui';
import {
  ChevronLeft, RefreshCw, FileText, AlertTriangle, Activity,
  CheckCircle2, Clock, Shield, Database, Target,
} from 'lucide-react';

// Mirrors src/lib/signals/dailySignalReport.ts. Duplicated structurally
// here so the page doesn't pull server-side modules into the client
// bundle.
type DailyReportStatus = 'COMPLETE' | 'PARTIAL' | 'PENDING' | 'INSUFFICIENT_DATA';
type DailyReportDataStatus = 'LIVE' | 'STALE' | 'FALLBACK' | 'BOOTSTRAP' | 'INSUFFICIENT_DATA';

interface DailyReportBacktestPreview {
  status:                  'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA' | 'FAILED';
  window:                  string;
  totalTested:             number;
  winRate:                 number | null;
  approvedWinRate:         number | null;
  highPotentialWinRate:    number | null;
  topIndicator:            string | null;
  weakestIndicator:        string | null;
  dataSufficiency:         'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA';
  warnings:                string[];
}

type ManipulationFreshnessStatus = 'FRESH' | 'STALE' | 'NO_DATA' | 'PARTIAL' | 'UNKNOWN';

interface ManipulationFilterImpact {
  totalSymbolsChecked:      number;
  cleanSymbols:             number;
  watchSymbols:             number;
  elevatedRiskSymbols:      number;
  highRiskSymbols:          number;
  severeRiskSymbols:        number;
  staleRiskSymbols:         number;
  unknownSymbols:           number;
  candidatesWarned:         number;
  candidatesPenalized:      number;
  candidatesRiskRestricted: number;
  candidatesBlocked:        number;
  warningOnlyCount:         number;
  topManipulationPatterns:  Array<{ pattern: string; count: number; avgScore: number | null }>;
  filterEffectivenessNote:  string;
  dataStatus:               ManipulationFreshnessStatus;
}

interface DailySignalReport {
  reportDate:                string;
  generatedAt:               string;
  marketStatus:              string;
  dataStatus:                DailyReportDataStatus;
  reportStatus:              DailyReportStatus;
  executiveSummary: {
    headline:      string;
    summary:       string;
    keyTakeaways:  string[];
    riskWarnings:  string[];
    tomorrowFocus: string[];
  };
  signalPerformance: {
    approvedTotal:                  number;
    approvedSuccess:                number | null;
    approvedFailed:                 number | null;
    approvedPending:                number | null;
    approvedWinRate:                number | null;
    highPotentialTotal:             number;
    highPotentialPerformed:         number | null;
    highPotentialMissedApproval:    number;
    watchlistTotal:                 number;
    watchlistPerformed:             number | null;
    rejectedTotal:                  number;
    rejectedPerformed:              number | null;
    rejectionFalseNegativeRate:     number | null;
    insufficientDataReasons:        string[];
  };
  indicatorPerformance: {
    bestIndicators:        IndicatorRow[];
    weakIndicators:        IndicatorRow[];
    neutralIndicators:     IndicatorRow[];
    indicatorCombinations: IndicatorComboRow[];
    status:                'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA';
    notes:                 string[];
  };
  missedOpportunities:       MissedItem[];
  missedOpportunitiesStatus: 'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA';
  sectorPerformance: {
    bestSectors:  SectorRow[];
    weakSectors:  SectorRow[];
    status:       'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA';
    notes:        string[];
  };
  timeWindowPerformance: {
    bestTimeWindows:  TimeWindowRow[];
    weakTimeWindows:  TimeWindowRow[];
    status:           'COMPLETE' | 'PARTIAL' | 'INSUFFICIENT_DATA';
    notes:            string[];
  };
  marketRegimeReview: {
    detectedRegime:           string;
    regimeConfidence:         number | null;
    bestStrategyForRegime:    string | null;
    weakStrategyForRegime:    string | null;
    notes:                    string[];
  };
  topBlockReasons: BlockReasonRow[];
  learningRecommendations: LearningRow[];
  dataQuality: {
    provider:           string | null;
    lastSuccessAt:      string | null;
    staleMinutes:       number | null;
    symbolsRequested:   number | null;
    symbolsReturned:    number | null;
    coveragePercent:    number | null;
    warnings:           string[];
  };
  warnings: string[];
  backtestPreview?: DailyReportBacktestPreview | null;
  manipulationFilterImpact?: ManipulationFilterImpact | null;
}

interface IndicatorRow {
  indicator:        string;
  totalSignals:     number;
  successCount:     number | null;
  failedCount:      number | null;
  pendingCount:     number | null;
  winRate:          number | null;
  avgMovePercent:   number | null;
  strongCoverage:   number | null;
  notes:            string;
}
interface IndicatorComboRow {
  combination:    string;
  totalSignals:   number;
  successCount:   number | null;
  failedCount:    number | null;
  winRate:        number | null;
  notes:          string;
}
interface MissedItem {
  symbol:              string;
  movePercent:         number | null;
  direction:           'UP' | 'DOWN' | null;
  wasSignalGenerated:  boolean;
  highestTierReached:  string;
  reasonMissed:        string;
  failedConditions:    string[];
  suggestedReview:     string;
  learningPriority:    'LOW' | 'MEDIUM' | 'HIGH';
}
interface SectorRow {
  sector:           string;
  totalSignals:     number;
  approvedCount:    number;
  performingCount:  number | null;
  winRate:          number | null;
  notes:            string;
}
interface TimeWindowRow {
  window:           string;
  totalSignals:     number;
  approvedCount:    number;
  performingCount:  number | null;
  winRate:          number | null;
  notes:            string;
}
interface BlockReasonRow {
  reason:       string;
  count:        number;
  impact:       'LOW' | 'MEDIUM' | 'HIGH';
  explanation:  string;
}
interface LearningRow {
  title:              string;
  observation:        string;
  evidence:           string;
  suggestedAction:    string;
  governanceStatus:   string;
  priority:           string;
}

interface ApiEnvelope {
  ok:           boolean;
  report?:      DailySignalReport;
  generatedAt?: string;
  source?:      string;
  warnings?:    string[];
}

const todayISO = () => new Date().toISOString().slice(0, 10);

const statusBadge = (status: DailyReportStatus): { bg: string; color: string; border: string; label: string } => {
  switch (status) {
    case 'COMPLETE':          return { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0', label: 'COMPLETE' };
    case 'PARTIAL':           return { bg: '#FFFBEB', color: '#92400E', border: '#FDE68A', label: 'PARTIAL' };
    case 'PENDING':           return { bg: '#EFF6FF', color: '#1D4ED8', border: '#BFDBFE', label: 'PENDING' };
    case 'INSUFFICIENT_DATA': return { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1', label: 'INSUFFICIENT DATA' };
  }
};

const dataStatusBadge = (status: DailyReportDataStatus): { bg: string; color: string; border: string; label: string } => {
  switch (status) {
    case 'LIVE':              return { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0', label: 'LIVE' };
    case 'STALE':             return { bg: '#FEF2F2', color: '#991B1B', border: '#FECACA', label: 'STALE' };
    case 'FALLBACK':          return { bg: '#FFFBEB', color: '#92400E', border: '#FDE68A', label: 'FALLBACK' };
    case 'BOOTSTRAP':         return { bg: '#FEF3C7', color: '#92400E', border: '#FDE68A', label: 'BOOTSTRAP' };
    case 'INSUFFICIENT_DATA': return { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1', label: 'NO DATA' };
  }
};

const impactColor = (impact: BlockReasonRow['impact']): string =>
  impact === 'HIGH' ? '#B91C1C' : impact === 'MEDIUM' ? '#B45309' : '#475569';

// PHASE_B_MANIPULATION — palette for the surveillance freshness badge.
const manipulationStatusBadge = (
  status: ManipulationFreshnessStatus,
): { bg: string; color: string; border: string; label: string } => {
  switch (status) {
    case 'FRESH':   return { bg: '#F0FDF4', color: '#15803D', border: '#BBF7D0', label: 'FRESH' };
    case 'STALE':   return { bg: '#FEF3C7', color: '#B45309', border: '#FDE68A', label: 'STALE' };
    case 'PARTIAL': return { bg: '#FFFBEB', color: '#92400E', border: '#FDE68A', label: 'PARTIAL' };
    case 'NO_DATA': return { bg: '#F1F5F9', color: '#475569', border: '#CBD5E1', label: 'NO DATA' };
    case 'UNKNOWN': return { bg: '#F8FAFC', color: '#94A3B8', border: '#E2E8F0', label: 'UNKNOWN' };
  }
};

const fmtPct = (n: number | null): string => n != null ? `${n}%` : '—';
const fmtNum = (n: number | null): string => n != null ? String(n) : '—';

function Badge({ palette, children, title }: {
  palette: { bg: string; color: string; border: string };
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 10px', borderRadius: 999,
        background: palette.bg, color: palette.color,
        border: `1px solid ${palette.border}`,
        fontSize: 11, fontWeight: 700, letterSpacing: 0.4,
      }}
    >
      {children}
    </span>
  );
}

function SectionHeader({ title, status }: { title: string; status?: string }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
    }}>
      <h2 style={{ margin: 0, fontSize: 15, fontWeight: 800, color: '#0F172A', letterSpacing: 0.4 }}>
        {title}
      </h2>
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
      padding: '14px 16px',
      background: '#F8FAFC', border: '1px dashed #CBD5E1',
      borderRadius: 8, color: '#475569', fontSize: 12,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <AlertTriangle size={14} color="#94A3B8" />
      <span>{message}</span>
    </div>
  );
}

export default function DailySignalReportPage() {
  // SSR-safe init: keep the date empty during the first render so the
  // server-rendered HTML and the client's hydration HTML are identical.
  // The real date is set on mount inside the effect below. Calling
  // `new Date()` in the useState initialiser caused hydration mismatch
  // when the server build was cached across a UTC date boundary.
  const [date, setDate]       = useState<string>('');
  const [data, setData]       = useState<ApiEnvelope | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError]     = useState<string | null>(null);
  const loadAbortRef          = useRef<AbortController | null>(null);

  const load = async (d: string) => {
    // Cancel any in-flight request before starting a new one. Without
    // this, rapid date changes / hot-reloads in dev produced bare
    // AbortError unhandled rejections.
    loadAbortRef.current?.abort('superseded');
    const controller = new AbortController();
    loadAbortRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/signals/daily-report?date=${encodeURIComponent(d)}`,
        { cache: 'no-store', signal: controller.signal },
      );
      if (!res.ok) {
        setError(`API returned ${res.status}`);
        setData(null);
        return;
      }
      const j = await res.json() as ApiEnvelope;
      if (!controller.signal.aborted) setData(j);
    } catch (e) {
      const err = e as Error;
      if (err.name === 'AbortError') return; // expected on supersede / unmount
      setError(err.message ?? 'Failed to load report');
      setData(null);
    } finally {
      if (loadAbortRef.current === controller) setLoading(false);
    }
  };

  // Mount: pin the date to today's UTC date on the client only.
  useEffect(() => {
    setDate(todayISO());
    return () => {
      loadAbortRef.current?.abort('unmount');
    };
  }, []);

  useEffect(() => {
    if (!date) return; // wait for the mount effect to seed the date
    void load(date);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  const report = data?.report ?? null;
  const reportStatus = report?.reportStatus ?? 'INSUFFICIENT_DATA';
  const dataStatus   = report?.dataStatus ?? 'INSUFFICIENT_DATA';

  return (
    <AppShell title="Daily Signal Intelligence Report">
      <div className="page">
        {/* ── Header ───────────────────────────────────────────── */}
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
            Daily Signal Intelligence Report
          </h1>
          <div style={{ flex: 1 }} />
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value || todayISO())}
            style={{
              padding: '6px 10px', borderRadius: 6,
              border: '1px solid #E2E8F0', fontSize: 12,
            }}
          />
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            onClick={() => void load(date)}
            disabled={loading}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            <RefreshCw size={13} className={loading ? 'spin' : ''} />
            Refresh
          </button>
          {/* PRE_PHASE_6_STABILIZATION — full cross-page nav */}
          <Link href="/signals/backtesting" style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '6px 10px', borderRadius: 6,
            background: '#F8FAFC', color: '#475569', textDecoration: 'none',
            border: '1px solid #E2E8F0',
            fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
          }} title="Open the Backtesting Lab">
            Open Backtesting Lab
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

        {/* Status row */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 14 }}>
            <FileText size={18} color="#475569" />
            <div style={{ fontSize: 13, color: '#0F172A' }}>
              <strong>{report?.reportDate ?? date}</strong>
              <span style={{ marginLeft: 8, color: '#94A3B8' }}>
                · Market: {report?.marketStatus ?? '—'}
              </span>
            </div>
            <Badge palette={statusBadge(reportStatus)}>
              REPORT {statusBadge(reportStatus).label}
            </Badge>
            <Badge palette={dataStatusBadge(dataStatus)}>
              DATA {dataStatusBadge(dataStatus).label}
            </Badge>
            {report?.generatedAt && (
              <span style={{ fontSize: 11, color: '#94A3B8', marginLeft: 'auto' }}>
                Generated {new Date(report.generatedAt).toLocaleTimeString()}
              </span>
            )}
          </div>
          {error && (
            <div style={{ marginTop: 10, color: '#B91C1C', fontSize: 12 }}>
              {error}
            </div>
          )}
          {data?.warnings && data.warnings.length > 0 && (
            <ul style={{ marginTop: 10, marginBottom: 0, paddingLeft: 18, color: '#92400E', fontSize: 11.5, lineHeight: 1.5 }}>
              {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </Card>

        {/* ── Executive Summary ────────────────────────────────── */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Executive Summary" />
          {report ? (
            <>
              <div style={{ fontWeight: 800, fontSize: 14.5, color: '#0F172A', marginBottom: 4 }}>
                {report.executiveSummary.headline}
              </div>
              <div style={{ fontSize: 13, color: '#334155', lineHeight: 1.55 }}>
                {report.executiveSummary.summary}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginTop: 12 }}>
                <SummaryList title="Key Takeaways" items={report.executiveSummary.keyTakeaways} icon={<CheckCircle2 size={13} color="#15803D" />} />
                <SummaryList title="Risk Warnings" items={report.executiveSummary.riskWarnings} icon={<AlertTriangle size={13} color="#B45309" />} />
                <SummaryList title="Tomorrow's Focus" items={report.executiveSummary.tomorrowFocus} icon={<Target size={13} color="#1D4ED8" />} />
              </div>
            </>
          ) : (
            <EmptySection message={loading ? 'Loading…' : 'No report available for this date.'} />
          )}
        </Card>

        {/* ── Signal Performance Overview ─────────────────────── */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Signal Performance Overview" />
          {report ? (
            <>
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 12,
              }}>
                <StatCard label="Approved Signals"          value={String(report.signalPerformance.approvedTotal)} accent="#15803D" />
                <StatCard label="Approved Win Rate"         value={fmtPct(report.signalPerformance.approvedWinRate)} accent="#15803D" />
                <StatCard label="High Potential Performed"  value={fmtNum(report.signalPerformance.highPotentialPerformed)} accent="#B45309" hint={`of ${report.signalPerformance.highPotentialTotal}`} />
                <StatCard label="Watchlist Performed"       value={fmtNum(report.signalPerformance.watchlistPerformed)} accent="#1D4ED8" hint={`of ${report.signalPerformance.watchlistTotal}`} />
                <StatCard label="Rejected but Performed"    value={fmtNum(report.signalPerformance.rejectedPerformed)} accent="#7C3AED" hint={`of ${report.signalPerformance.rejectedTotal}`} />
                <StatCard label="Pending Review"            value={fmtNum(report.signalPerformance.approvedPending)} accent="#475569" />
              </div>
              {report.signalPerformance.insufficientDataReasons.length > 0 && (
                <div style={{ marginTop: 10, fontSize: 11, color: '#94A3B8' }}>
                  Notes: {report.signalPerformance.insufficientDataReasons.join('; ')}
                </div>
              )}
            </>
          ) : (
            <EmptySection message={loading ? 'Loading…' : 'No performance data available.'} />
          )}
        </Card>

        {/* ── Indicator Performance ────────────────────────────── */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Indicator Performance" status={report?.indicatorPerformance.status} />
          {report ? (
            <>
              <IndicatorTable title="Best performing" rows={report.indicatorPerformance.bestIndicators} accent="#15803D" />
              <IndicatorTable title="Weak indicators" rows={report.indicatorPerformance.weakIndicators} accent="#B91C1C" />
              <IndicatorTable title="Neutral / pending" rows={report.indicatorPerformance.neutralIndicators} accent="#475569" />
              {report.indicatorPerformance.indicatorCombinations.length > 0 && (
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
                        <th style={th}>Notes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.indicatorPerformance.indicatorCombinations.map((c, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                          <td style={td}><strong>{c.combination}</strong></td>
                          <td style={td}>{c.totalSignals}</td>
                          <td style={td}>{fmtPct(c.winRate)}</td>
                          <td style={{ ...td, color: '#475569' }}>{c.notes}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {report.indicatorPerformance.notes.length > 0 && (
                <ul style={{ marginTop: 10, fontSize: 11, color: '#94A3B8', paddingLeft: 18 }}>
                  {report.indicatorPerformance.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}
            </>
          ) : (
            <EmptySection message="Indicator outcome data is not available yet." />
          )}
        </Card>

        {/* ── Missed Opportunities ─────────────────────────────── */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Missed Opportunities" status={report?.missedOpportunitiesStatus} />
          {report && report.missedOpportunities.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#F8FAFC' }}>
                  <th style={th}>Symbol</th>
                  <th style={th}>Move</th>
                  <th style={th}>Tier</th>
                  <th style={th}>Reason missed</th>
                  <th style={th}>Suggested Review</th>
                  <th style={th}>Priority</th>
                </tr>
              </thead>
              <tbody>
                {report.missedOpportunities.map((m, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                    <td style={td}><strong>{m.symbol}</strong></td>
                    <td style={{ ...td, color: m.direction === 'UP' ? '#15803D' : m.direction === 'DOWN' ? '#B91C1C' : '#475569' }}>
                      {m.movePercent != null ? `${m.movePercent.toFixed(2)}%` : '—'}{' '}{m.direction ?? ''}
                    </td>
                    <td style={td}>{m.highestTierReached}</td>
                    <td style={{ ...td, color: '#475569' }}>{m.reasonMissed}</td>
                    <td style={{ ...td, color: '#475569' }}>{m.suggestedReview}</td>
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
            <EmptySection
              message={
                report?.missedOpportunitiesStatus === 'INSUFFICIENT_DATA'
                  ? 'Market movers dataset is not available yet — missed-opportunity analysis pending.'
                  : 'No notable missed opportunities for the day.'
              }
            />
          )}
        </Card>

        {/* ── Sector + Market Regime ───────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, marginBottom: 16 }}>
          <Card>
            <SectionHeader title="Sector Performance" status={report?.sectorPerformance.status} />
            {report && (report.sectorPerformance.bestSectors.length > 0 || report.sectorPerformance.weakSectors.length > 0) ? (
              <>
                <SectorTable title="Best sectors" rows={report.sectorPerformance.bestSectors} accent="#15803D" />
                <SectorTable title="Weak sectors" rows={report.sectorPerformance.weakSectors} accent="#B91C1C" />
              </>
            ) : (
              <EmptySection message="Sector data is not joined onto signal rows yet — sector breakdown unavailable." />
            )}
          </Card>
          <Card>
            <SectionHeader title="Market Regime Review" />
            {report ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                  <Badge palette={statusBadge(report.marketRegimeReview.detectedRegime === 'UNKNOWN' ? 'INSUFFICIENT_DATA' : 'COMPLETE')}>
                    {report.marketRegimeReview.detectedRegime}
                  </Badge>
                  {report.marketRegimeReview.regimeConfidence != null && (
                    <span style={{ fontSize: 11, color: '#475569' }}>
                      Regime factor: <strong>{report.marketRegimeReview.regimeConfidence}</strong>
                    </span>
                  )}
                </div>
                {report.marketRegimeReview.bestStrategyForRegime && (
                  <div style={{ fontSize: 12, color: '#0F172A', marginBottom: 4 }}>
                    <strong>Best:</strong> {report.marketRegimeReview.bestStrategyForRegime}
                  </div>
                )}
                {report.marketRegimeReview.weakStrategyForRegime && (
                  <div style={{ fontSize: 12, color: '#0F172A' }}>
                    <strong>Weak:</strong> {report.marketRegimeReview.weakStrategyForRegime}
                  </div>
                )}
                {report.marketRegimeReview.notes.length > 0 && (
                  <ul style={{ marginTop: 10, fontSize: 11, color: '#94A3B8', paddingLeft: 18 }}>
                    {report.marketRegimeReview.notes.map((n, i) => <li key={i}>{n}</li>)}
                  </ul>
                )}
              </>
            ) : (
              <EmptySection message="No regime data available." />
            )}
          </Card>
        </div>

        {/* ── Time-Window Performance ──────────────────────────── */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Time-Window Performance" status={report?.timeWindowPerformance.status} />
          {report && (report.timeWindowPerformance.bestTimeWindows.length > 0 || report.timeWindowPerformance.weakTimeWindows.length > 0) ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 14 }}>
              <TimeWindowTable title="Best windows" rows={report.timeWindowPerformance.bestTimeWindows} accent="#15803D" />
              <TimeWindowTable title="Weak windows" rows={report.timeWindowPerformance.weakTimeWindows} accent="#B91C1C" />
            </div>
          ) : (
            <EmptySection message="Time-window outcome data is not yet available." />
          )}
        </Card>

        {/* ── Top Block Reasons ────────────────────────────────── */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Rejection & Block Reason Analysis" />
          {report && report.topBlockReasons.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ background: '#F8FAFC' }}>
                  <th style={th}>Reason</th>
                  <th style={th}>Count</th>
                  <th style={th}>Impact</th>
                  <th style={th}>Explanation</th>
                </tr>
              </thead>
              <tbody>
                {report.topBlockReasons.map((b, i) => (
                  <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                    <td style={td}><strong>{b.reason}</strong></td>
                    <td style={td}>{b.count}</td>
                    <td style={{ ...td, color: impactColor(b.impact), fontWeight: 700 }}>{b.impact}</td>
                    <td style={{ ...td, color: '#475569' }}>{b.explanation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptySection message="No rejection causes recorded for this date." />
          )}
        </Card>

        {/* ── Learning Recommendations ─────────────────────────── */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Learning Recommendations" />
          <div style={{ fontSize: 11, color: '#94A3B8', marginBottom: 10 }}>
            All recommendations require analyst review. Scoring weights are <strong>not</strong> modified automatically.
          </div>
          {report && report.learningRecommendations.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
              {report.learningRecommendations.map((r, i) => (
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
                    }} title="Governance flag">
                      {r.governanceStatus}
                    </span>
                  </div>
                  <div style={{ marginTop: 6, fontSize: 12, color: '#334155' }}>
                    {r.observation}
                  </div>
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
            <EmptySection message="No learning recommendations crossed the threshold today." />
          )}
        </Card>

        {/* ── PHASE_4_BACKTESTING_2026-05 — Backtest preview ─────── */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Backtest Preview" status={report?.backtestPreview?.status} />
          {report?.backtestPreview ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
                <StatCard label="Window"                  value={report.backtestPreview.window}                              accent="#1D4ED8" />
                <StatCard label="Total Tested"            value={String(report.backtestPreview.totalTested)}                 accent="#475569" />
                <StatCard label="Win Rate"                value={fmtPct(report.backtestPreview.winRate)}                     accent="#15803D" />
                <StatCard label="Approved Win Rate"       value={fmtPct(report.backtestPreview.approvedWinRate)}             accent="#15803D" />
                <StatCard label="High-Potential Win Rate" value={fmtPct(report.backtestPreview.highPotentialWinRate)}        accent="#B45309" />
                <StatCard label="Top Indicator"           value={report.backtestPreview.topIndicator ?? '—'}                 accent="#7C3AED" />
                <StatCard label="Weakest Indicator"       value={report.backtestPreview.weakestIndicator ?? '—'}             accent="#B91C1C" />
              </div>
              {report.backtestPreview.warnings.length > 0 && (
                <ul style={{ marginTop: 10, paddingLeft: 18, color: '#B45309', fontSize: 11.5, lineHeight: 1.5 }}>
                  {report.backtestPreview.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
              <div style={{ marginTop: 12 }}>
                <Link href="/signals/backtesting" style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  padding: '6px 12px', borderRadius: 6,
                  background: '#1D4ED8', color: '#FFFFFF',
                  border: '1px solid #1D4ED8',
                  fontSize: 11.5, fontWeight: 700, letterSpacing: 0.4,
                  textDecoration: 'none',
                }}>
                  Open Backtesting Lab
                </Link>
              </div>
            </>
          ) : (
            <EmptySection message="Backtest preview unavailable — historical price data source not configured or backtest run failed." />
          )}
        </Card>

        {/* ── PHASE_B_MANIPULATION — Manipulation Filter Impact ─── */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader
            title="Manipulation Filter Impact"
            status={
              report?.manipulationFilterImpact
                ? report.manipulationFilterImpact.dataStatus === 'FRESH'
                  ? 'COMPLETE'
                  : 'PARTIAL'
                : undefined
            }
          />
          {report?.manipulationFilterImpact ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                <Shield size={14} color="#475569" />
                <Badge palette={manipulationStatusBadge(report.manipulationFilterImpact.dataStatus)}>
                  {manipulationStatusBadge(report.manipulationFilterImpact.dataStatus).label}
                </Badge>
                <span style={{ fontSize: 11.5, color: '#475569' }}>
                  {report.manipulationFilterImpact.filterEffectivenessNote}
                </span>
              </div>
              {report.manipulationFilterImpact.dataStatus === 'STALE' && (
                <div style={{
                  padding: '8px 12px', borderRadius: 6,
                  background: '#FEF3C7', border: '1px solid #FDE68A',
                  color: '#92400E', fontSize: 11.5, marginBottom: 10,
                  display: 'flex', alignItems: 'center', gap: 6,
                }}>
                  <AlertTriangle size={13} />
                  Manipulation filter is warning-only because latest manipulation data is stale.
                </div>
              )}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                gap: 10,
              }}>
                <StatCard label="Symbols Checked"  value={String(report.manipulationFilterImpact.totalSymbolsChecked)}     accent="#1D4ED8" />
                <StatCard label="Clean"            value={String(report.manipulationFilterImpact.cleanSymbols)}            accent="#15803D" />
                <StatCard label="Watch"            value={String(report.manipulationFilterImpact.watchSymbols)}            accent="#475569" />
                <StatCard label="Elevated"         value={String(report.manipulationFilterImpact.elevatedRiskSymbols)}     accent="#B45309" />
                <StatCard label="High Risk"        value={String(report.manipulationFilterImpact.highRiskSymbols)}         accent="#B91C1C" />
                <StatCard label="Severe Risk"     value={String(report.manipulationFilterImpact.severeRiskSymbols)}        accent="#7F1D1D" />
                <StatCard label="Stale Risk"       value={String(report.manipulationFilterImpact.staleRiskSymbols)}        accent="#92400E" />
                <StatCard label="Warned"           value={String(report.manipulationFilterImpact.candidatesWarned)}        accent="#475569" />
                <StatCard label="Penalized"        value={String(report.manipulationFilterImpact.candidatesPenalized)}     accent="#B45309" />
                <StatCard label="Risk-Restricted"  value={String(report.manipulationFilterImpact.candidatesRiskRestricted)} accent="#B91C1C" />
                <StatCard label="Blocked"          value={String(report.manipulationFilterImpact.candidatesBlocked)}       accent="#7F1D1D" />
                <StatCard label="Warning-Only"     value={String(report.manipulationFilterImpact.warningOnlyCount)}        accent="#475569" />
              </div>
              {report.manipulationFilterImpact.topManipulationPatterns.length > 0 && (
                <div style={{ marginTop: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: '#0F172A', letterSpacing: 0.4, marginBottom: 6 }}>
                    TOP MANIPULATION PATTERNS
                  </div>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: '#F8FAFC' }}>
                        <th style={th}>Pattern</th>
                        <th style={th}>Count</th>
                        <th style={th}>Avg Score</th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.manipulationFilterImpact.topManipulationPatterns.map((p, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                          <td style={td}><strong>{p.pattern.replace(/_/g, ' ')}</strong></td>
                          <td style={td}>{p.count}</td>
                          <td style={td}>{p.avgScore != null ? p.avgScore.toFixed(1) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div style={{ marginTop: 10, fontSize: 10, color: '#94A3B8' }}>
                Stale, no-data, or partial freshness caps the recommended action at WARNING_ONLY — surveillance data can never hard-reject a signal unless it is FRESH.
              </div>
            </>
          ) : (
            <EmptySection message="Manipulation filter impact is not available yet." />
          )}
        </Card>

        {/* ── Data Quality ─────────────────────────────────────── */}
        <Card style={{ marginBottom: 16 }}>
          <SectionHeader title="Data Quality & Reliability" />
          {report ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12 }}>
              <StatCard label="Provider" value={report.dataQuality.provider ?? '—'} accent="#475569" />
              <StatCard label="Last Success" value={report.dataQuality.lastSuccessAt ? new Date(report.dataQuality.lastSuccessAt).toLocaleTimeString() : '—'} accent="#475569" />
              <StatCard label="Stale (min)" value={fmtNum(report.dataQuality.staleMinutes)} accent={(report.dataQuality.staleMinutes ?? 0) > 30 ? '#B91C1C' : '#15803D'} />
              <StatCard label="Symbols Requested" value={fmtNum(report.dataQuality.symbolsRequested)} accent="#475569" />
              <StatCard label="Symbols Returned" value={fmtNum(report.dataQuality.symbolsReturned)} accent="#475569" />
              <StatCard label="Coverage" value={fmtPct(report.dataQuality.coveragePercent)} accent="#1D4ED8" />
            </div>
          ) : (
            <EmptySection message="Provider health data unavailable." />
          )}
          {report?.dataQuality.warnings && report.dataQuality.warnings.length > 0 && (
            <ul style={{ marginTop: 10, paddingLeft: 18, color: '#B45309', fontSize: 12, lineHeight: 1.5 }}>
              {report.dataQuality.warnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
          )}
        </Card>

        <div style={{ marginTop: 16, fontSize: 10, color: '#94A3B8', textAlign: 'center' }}>
          Report is for institutional explainability only and is not financial advice.
        </div>
      </div>
    </AppShell>
  );
}

// ── Local helpers ────────────────────────────────────────────────

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
    <div style={{
      padding: '10px 12px', borderRadius: 8,
      background: '#FFFFFF', border: '1px solid #E2E8F0',
    }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, color: '#94A3B8', textTransform: 'uppercase' }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 800, color: accent, marginTop: 2 }}>
        {value}
      </div>
      {hint && (
        <div style={{ fontSize: 10, color: '#94A3B8', marginTop: 2 }}>{hint}</div>
      )}
    </div>
  );
}

function SummaryList({ title, items, icon }: {
  title: string; items: string[]; icon: React.ReactNode;
}) {
  return (
    <div style={{ minWidth: 220, flex: 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 800, color: '#0F172A', letterSpacing: 0.4, marginBottom: 4 }}>
        {icon}
        <span>{title.toUpperCase()}</span>
      </div>
      {items.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#334155', lineHeight: 1.55 }}>
          {items.map((it, i) => <li key={i}>{it}</li>)}
        </ul>
      ) : (
        <div style={{ fontSize: 11, color: '#94A3B8' }}>—</div>
      )}
    </div>
  );
}

function IndicatorTable({ title, rows, accent }: {
  title: string; rows: IndicatorRow[]; accent: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: accent, letterSpacing: 0.4, marginBottom: 6 }}>
        {title.toUpperCase()}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#F8FAFC' }}>
            <th style={th}>Indicator</th>
            <th style={th}>Signals</th>
            <th style={th}>Win Rate</th>
            <th style={th}>Avg Move</th>
            <th style={th}>Coverage</th>
            <th style={th}>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
              <td style={td}><strong>{r.indicator}</strong></td>
              <td style={td}>{r.totalSignals}</td>
              <td style={td}>{fmtPct(r.winRate)}</td>
              <td style={td}>{r.avgMovePercent != null ? `${r.avgMovePercent.toFixed(2)}%` : '—'}</td>
              <td style={td}>{fmtPct(r.strongCoverage)}</td>
              <td style={{ ...td, color: '#475569' }}>{r.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SectorTable({ title, rows, accent }: {
  title: string; rows: SectorRow[]; accent: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: accent, letterSpacing: 0.4, marginBottom: 6 }}>
        {title.toUpperCase()}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#F8FAFC' }}>
            <th style={th}>Sector</th>
            <th style={th}>Signals</th>
            <th style={th}>Approved</th>
            <th style={th}>Win Rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
              <td style={td}><strong>{r.sector}</strong></td>
              <td style={td}>{r.totalSignals}</td>
              <td style={td}>{r.approvedCount}</td>
              <td style={td}>{fmtPct(r.winRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TimeWindowTable({ title, rows, accent }: {
  title: string; rows: TimeWindowRow[]; accent: string;
}) {
  if (rows.length === 0) return null;
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 800, color: accent, letterSpacing: 0.4, marginBottom: 6 }}>
        {title.toUpperCase()}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr style={{ background: '#F8FAFC' }}>
            <th style={th}>Window</th>
            <th style={th}>Signals</th>
            <th style={th}>Approved</th>
            <th style={th}>Win Rate</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
              <td style={td}><strong>{r.window}</strong></td>
              <td style={td}>{r.totalSignals}</td>
              <td style={td}>{r.approvedCount}</td>
              <td style={td}>{fmtPct(r.winRate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
