'use client';

/**
 * Quantorus365 — Command Center
 *
 * Single-screen executive dashboard. Consumes the aggregated
 * /api/dashboard response (Signal Engine, Engine Health, Daily Report,
 * Backtest, News, Manipulation, Options) and presents a compact,
 * institution-grade overview:
 *
 *   • Command Status Bar    — Market / Signal Engine / Data / Trust Score
 *   • Signal Summary Grid   — Approved / High Potential / Watchlist /
 *                             Rejected / Nearest to Approval / Top Blocker
 *   • Intelligence Fusion   — News · Manipulation · Options · Backtest · Engine
 *   • Opportunity ↔ Risk    — top 5 nearest candidates vs top blockers
 *   • Strategy Snapshot     — regime · bias · best · avoid
 *   • Recommended Actions   — max 5 actionable items, deep-linked
 *
 * The page is purely a consumer of the canonical Signal Engine
 * outputs — it never duplicates approval logic, never fabricates
 * data, and degrades gracefully when any module is unavailable.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import AppShell from '@/components/layout/AppShell';
import {
  Activity, AlertTriangle, ArrowRight, ArrowUpRight, BarChart3,
  CheckCircle2, ChevronRight, Cpu, Database, FlaskConical,
  Gauge, Info, LineChart, Lock, Moon, Newspaper, RefreshCw,
  Shield, ShieldAlert, ShieldCheck, Sparkles, Target,
  TrendingDown, TrendingUp, Zap,
} from 'lucide-react';
import styles from './dashboard.module.scss';

// ── Wire types (mirror /api/dashboard) ─────────────────────────────

type FusionStatus =
  | 'HEALTHY' | 'WARNING' | 'PARTIAL' | 'STALE' | 'DEGRADED'
  | 'TIMEOUT' | 'BROKEN' | 'AUTH_REQUIRED'
  | 'NOT_CONFIGURED' | 'INSUFFICIENT_DATA' | 'RUNNING' | 'UNKNOWN';

type TrustLabel    = 'HIGH' | 'MEDIUM' | 'LOW' | 'INSUFFICIENT_DATA';
type ActionPrio    = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
type DirectionBias = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNKNOWN';

interface FusionItem {
  status: FusionStatus; label: string; detail: string;
  reason?: string; action?: string;
  href: string; lastUpdated: string | null;
}

interface DashboardPayload {
  ok: boolean;
  generatedAt: string;
  marketStatus: {
    status: 'OPEN' | 'CLOSED' | 'UNKNOWN'; label: string;
    lastClose: string | null; nextOpen: string | null;
  };
  trustScore: { score: number | null; label: TrustLabel; reasons: string[] };
  signalSummary: {
    approvedTotal: number; approvedBuy: number; approvedSell: number;
    highPotentialTotal: number; watchlistTotal: number;
    rejectedTotal: number; candidateTotal: number;
    topBlockingReason: string | null; latestSignalAt: string | null;
  };
  nearestOpportunities: Array<{
    symbol: string; direction: string | null;
    finalScore: number | null; confidenceScore: number | null;
    riskReward: number | null; approvalGap: number | null;
    reason: string | null; status: string | null;
    manipulationRisk: string | null; newsImpact: string | null;
  }>;
  riskSummary: {
    staleData: boolean;
    manipulationWarningCount: number;
    newsRiskCount: number;
    optionRiskStatus: string;
    rejectedTopReasons: Array<{ reason: string; count: number }>;
  };
  intelligenceFusion: {
    signalEngine: FusionItem; newsIntelligence: FusionItem;
    manipulationWatch: FusionItem; optionIntelligence: FusionItem;
    backtesting: FusionItem; engineHealth: FusionItem;
  };
  strategySnapshot: {
    marketRegime: string; directionBias: DirectionBias;
    bestStrategy: string | null; weakStrategy: string | null;
    backtestSupportedSetup: string | null; avoidSetup: string | null;
  };
  engineHealth: {
    overallStatus: string; overallSummary: string;
    canGenerateApprovedSignals: boolean; canGenerateCandidates: boolean;
    primaryBlockingReason: string | null;
    topBrokenEngine: string | null;
  } | null;
  recommendedActions: Array<{
    title: string; reason: string; priority: ActionPrio; href: string;
  }>;
  warnings: string[];
  moduleStatusCounts?: {
    timeout: number; broken: number; stale: number;
    notConfigured: number; insufficient: number; partial: number;
  };
  sourceStatus: Record<string, {
    ok: boolean; status: number; error: string | null;
    timedOut?: boolean; elapsedMs?: number; timeoutMs?: number;
  }>;
}

// ── Formatting helpers (display only) ──────────────────────────────

const fmtTime = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const fmtRelative = (iso: string | null): string => {
  if (!iso) return 'never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'never';
  const diff = Date.now() - d.getTime();
  if (diff < 0) return 'just now';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
};

const fmtScore = (n: number | null | undefined, digits = 1): string =>
  (typeof n === 'number' && Number.isFinite(n)) ? n.toFixed(digits) : '—';

// Map fusion status → palette tone used by chips, dots, rings.
const toneFor = (s: FusionStatus): 'green' | 'amber' | 'red' | 'blue' | 'grey' | 'purple' => {
  switch (s) {
    case 'HEALTHY':           return 'green';
    case 'RUNNING':           return 'blue';
    case 'WARNING':           return 'amber';
    case 'PARTIAL':           return 'amber';
    case 'STALE':             return 'amber';
    case 'DEGRADED':          return 'amber';
    case 'TIMEOUT':           return 'amber';
    case 'BROKEN':            return 'red';
    case 'AUTH_REQUIRED':     return 'red';
    case 'NOT_CONFIGURED':    return 'grey';
    case 'INSUFFICIENT_DATA': return 'grey';
    default:                  return 'blue';
  }
};

const trustTone = (l: TrustLabel): 'green' | 'amber' | 'red' | 'grey' => {
  switch (l) {
    case 'HIGH':              return 'green';
    case 'MEDIUM':            return 'amber';
    case 'LOW':               return 'red';
    case 'INSUFFICIENT_DATA': return 'grey';
  }
};

const prioTone = (p: ActionPrio): 'red' | 'amber' | 'blue' | 'grey' => {
  switch (p) {
    case 'CRITICAL': return 'red';
    case 'HIGH':     return 'amber';
    case 'MEDIUM':   return 'blue';
    case 'LOW':      return 'grey';
  }
};

const directionTone = (d: string | null | undefined): 'green' | 'red' | 'grey' => {
  const u = String(d ?? '').toUpperCase();
  if (u === 'BUY' || u === 'BULLISH' || u === 'LONG') return 'green';
  if (u === 'SELL' || u === 'BEARISH' || u === 'SHORT') return 'red';
  return 'grey';
};

// ── Institutional copy helpers ─────────────────────────────────────
//
// The aggregator returns precise but neutral statuses (HEALTHY,
// TIMEOUT, INSUFFICIENT_DATA, etc.). The command-center UI reframes
// these into operator-facing copy so the dashboard reads as an
// intelligence cockpit even when modules are degraded. No business
// logic — these are pure display transformations.

const NICE_EMPTY = 'Awaiting fresh data';

// Sanitises any value that's about to land in the UI so the
// dashboard never renders raw placeholders ("—", "UNKNOWN",
// "undefined", "null", whitespace, etc.) or stutter punctuation
// (double spaces, trailing " ."). All user-facing copy that derives
// from upstream payloads should pass through this helper.
const niceText = (
  v: string | null | undefined,
  fallback: string = NICE_EMPTY,
): string => {
  if (v === null || v === undefined) return fallback;
  const trimmed = String(v).replace(/\s+/g, ' ').trim();
  if (!trimmed) return fallback;
  const lower = trimmed.toLowerCase();
  if (
    trimmed === '—' || trimmed === '-' || trimmed === '–' ||
    lower === 'unknown' || lower === 'undefined' || lower === 'null' ||
    lower === 'n/a' || lower === 'na' || lower === 'none'
  ) {
    return fallback;
  }
  return trimmed;
};

// Reframe market state into institutional copy ("Weekend Mode",
// "Market Closed — monitoring paused…"). Uses the existing
// marketStatus.label / nextOpen the API already returns.
interface MarketDescriptor {
  value: string;
  sub:   string;
  tone:  'green' | 'amber' | 'red' | 'blue' | 'grey' | 'purple';
  icon:  React.ElementType;
}

function describeMarket(
  market: { status: 'OPEN' | 'CLOSED' | 'UNKNOWN'; label: string; nextOpen: string | null } | undefined,
): MarketDescriptor {
  if (!market || market.status === 'UNKNOWN') {
    return { value: 'PENDING', sub: 'Market session status pending.', tone: 'grey', icon: Activity };
  }
  if (market.status === 'OPEN') {
    return {
      value: 'OPEN',
      sub:   market.label ? `${market.label} · live session.` : 'Live session in progress.',
      tone:  'green',
      icon:  Activity,
    };
  }
  // CLOSED — distinguish weekend / holiday / after-hours from label text.
  const lower = (market.label ?? '').toLowerCase();
  const isWeekend = /sat|sun|weekend/.test(lower);
  const isHoliday = /holiday/.test(lower);
  return {
    value: isWeekend ? 'WEEKEND MODE' : isHoliday ? 'HOLIDAY MODE' : 'CLOSED',
    sub:   'Monitoring paused until next session.',
    tone:  'blue',
    icon:  isWeekend ? Moon : Activity,
  };
}

// Reframe Signal Engine state. TIMEOUT / DEGRADED / WARNING become
// "Partial Intelligence Mode" — the engine is alive but missing
// confirmation from one or more upstream modules.
interface EngineDescriptor {
  value: string;
  sub:   string;
  tone:  'green' | 'amber' | 'red' | 'blue' | 'grey' | 'purple';
  mode:  string;  // headline label used in the header chip + system notice
}

function describeSignalEngine(
  status: FusionStatus,
  primaryBlockingReason: string | null | undefined,
  canApproved: boolean | undefined,
  canCandidates: boolean | undefined,
): EngineDescriptor {
  switch (status) {
    case 'HEALTHY':
      return {
        value: 'OPERATIONAL',
        sub:   canApproved ? 'Approval pipeline ready.' : canCandidates ? 'Generating candidates.' : 'Status nominal.',
        tone:  'green',
        mode:  'Full Intelligence Mode',
      };
    case 'WARNING':
    case 'PARTIAL':
    case 'DEGRADED':
      return {
        value: 'PARTIAL',
        sub:   niceText(primaryBlockingReason, 'Running with delayed modules.'),
        tone:  'amber',
        mode:  'Partial Intelligence Mode',
      };
    case 'TIMEOUT':
      return {
        value: 'PARTIAL',
        sub:   'Engine summary delayed — retry to refresh.',
        tone:  'amber',
        mode:  'Partial Intelligence Mode',
      };
    case 'BROKEN':
    case 'AUTH_REQUIRED':
      return {
        value: 'RECOVERY',
        sub:   status === 'AUTH_REQUIRED' ? 'Re-authentication required.' : 'Signal engine unreachable.',
        tone:  'red',
        mode:  'Recovery Mode',
      };
    default:
      return {
        value: 'PENDING',
        sub:   'Awaiting first engine response.',
        tone:  'grey',
        mode:  'Standby',
      };
  }
}

// Data freshness — present STALE as actionable, not catastrophic.
interface FreshnessDescriptor {
  value: string;
  sub:   string;
  tone:  'green' | 'amber' | 'red' | 'blue' | 'grey' | 'purple';
}

function describeFreshness(
  stale: boolean | undefined,
  latestSignalAt: string | null | undefined,
): FreshnessDescriptor {
  if (stale) return { value: 'STALE', sub: 'Latest candle validation pending.', tone: 'amber' };
  if (latestSignalAt) {
    return { value: 'FRESH', sub: `Last signal ${fmtRelative(latestSignalAt)}.`, tone: 'green' };
  }
  return { value: 'PENDING', sub: 'Awaiting fresh candle validation.', tone: 'blue' };
}

// Trust Score — emit a context line so the operator knows *why* a low
// score landed where it did. Pulls from trust.reasons (already
// computed by the aggregator) so no business logic is duplicated.
interface TrustDescriptor {
  value: string;
  sub:   string;
  tone:  'green' | 'amber' | 'red' | 'blue' | 'grey' | 'purple';
}

// Build the Trust Score explanation deterministically from the
// underlying state — stale data + engine status — instead of
// regex-scanning the free-form `reasons[]` array (the previous
// implementation could produce "Low due to ." when a reason matched
// the regex but rendered to an empty string after trimming).
//
// Phrasings mirror the spec: stale-only / engine-only / both / fallback.
function describeTrust(
  trust: { score: number | null; label: TrustLabel; reasons: string[] } | undefined,
  staleData: boolean,
  engineStatus: FusionStatus,
): TrustDescriptor {
  if (!trust) return { value: '—', sub: 'Trust score unavailable.', tone: 'grey' };
  if (trust.label === 'INSUFFICIENT_DATA') {
    return { value: 'INSUFFICIENT', sub: 'Core signal engine offline.', tone: 'grey' };
  }
  const tone = trustTone(trust.label);
  const value = trust.score !== null && trust.score !== undefined ? String(trust.score) : '—';

  if (trust.label === 'HIGH') {
    return { value, sub: 'High confidence — approval pipeline operating normally.', tone };
  }
  if (trust.label === 'MEDIUM') {
    return { value, sub: 'Moderate confidence — awaiting stronger confirmation.', tone };
  }

  // LOW — pick the most accurate phrasing for the active detractors.
  // Engine is considered "delayed" when it's not in a fully healthy
  // state (timeout / partial / warning / degraded etc.).
  const engineDelayed =
    engineStatus !== 'HEALTHY' &&
    engineStatus !== 'RUNNING' &&
    engineStatus !== 'UNKNOWN';

  let sub: string;
  if (staleData && engineDelayed) {
    sub = 'Low due to stale market data and delayed intelligence modules.';
  } else if (staleData) {
    sub = 'Low due to stale market data and pending candle validation.';
  } else if (engineDelayed) {
    sub = 'Low due to delayed intelligence modules and incomplete confirmation.';
  } else {
    sub = 'Confidence restricted until fresh validation completes.';
  }
  return { value, sub, tone };
}

// Module-status counts shape from /api/dashboard.
interface ModuleStatusCounts {
  timeout: number; broken: number; stale: number;
  notConfigured: number; insufficient: number; partial: number;
}

// Build the System Notice content from the aggregator's counts + warnings.
// Returns null when nothing notable is happening (banner stays hidden).
interface SystemNoticeContent {
  mode:   string;
  kicker: string;
  reason: string;
  impact: string;
  tone:   'amber' | 'red' | 'blue' | 'grey' | 'green' | 'purple';
  icon:   React.ElementType;
}

function buildSystemNotice(
  counts: ModuleStatusCounts | undefined,
  warnings: string[],
  engineMode: string,
  engineTone: 'green' | 'amber' | 'red' | 'blue' | 'grey' | 'purple',
  staleData: boolean,
): SystemNoticeContent | null {
  const c = counts ?? { timeout: 0, broken: 0, stale: 0, notConfigured: 0, insufficient: 0, partial: 0 };
  const anyTimeout = c.timeout > 0;
  const anyBroken  = c.broken  > 0;
  const anyStale   = c.stale   > 0 || staleData;
  const anyPartial = c.partial > 0;
  const anyInsuf   = c.insufficient > 0;
  const anyNotCfg  = c.notConfigured > 0;

  if (!anyTimeout && !anyBroken && !anyStale && !anyPartial && !anyInsuf && !anyNotCfg && warnings.length === 0) {
    return null;
  }

  // Headline mode mirrors the Signal Engine descriptor so the
  // header chip and notice stay in lockstep.
  const mode = engineMode;
  const kicker = 'System Notice';

  // Reason — single most prominent issue type. "Delayed" reads as
  // a controlled operational state, "timed out" reads as failure.
  const reasonParts: string[] = [];
  if (anyTimeout) reasonParts.push(`${c.timeout} module${c.timeout === 1 ? '' : 's'} delayed`);
  if (anyBroken)  reasonParts.push(`${c.broken} module${c.broken === 1 ? '' : 's'} unreachable`);
  if (anyStale) {
    const n = c.stale > 0 ? c.stale : 1;
    reasonParts.push(`${n} stale data source${n === 1 ? '' : 's'}`);
  }
  if (anyPartial && !anyTimeout && !anyBroken) reasonParts.push(`${c.partial} module${c.partial === 1 ? '' : 's'} partial`);
  if (anyInsuf)   reasonParts.push(`${c.insufficient} awaiting data`);
  if (anyNotCfg)  reasonParts.push(`${c.notConfigured} not configured`);
  const reason = reasonParts.length > 0
    ? reasonParts.join(' · ')
    : 'Some modules did not respond within expected time.';

  // Impact — describe what this means for the operator.
  let impact = 'Dashboard is operational; some intelligence is delayed.';
  if (anyBroken || anyTimeout) {
    impact = 'Signal approval is temporarily restricted while validation completes.';
  } else if (anyStale) {
    impact = 'Engine is operating on aged candles — refresh recommended.';
  } else if (anyInsuf) {
    impact = 'Some intelligence modules are still collecting data.';
  }

  // Tone preference: red > amber > blue. Engine tone informs the
  // accent stripe to keep the dashboard cohesive.
  const tone: 'amber' | 'red' | 'blue' | 'grey' | 'green' | 'purple' =
    anyBroken ? 'red' : (anyTimeout || anyStale || anyPartial) ? 'amber' : (engineTone === 'green' ? 'blue' : engineTone);

  return { mode, kicker, reason, impact, tone, icon: anyBroken ? AlertTriangle : anyTimeout ? RefreshCw : Info };
}

// ── Small presentational primitives (kept local) ───────────────────

function StatusDot({ tone }: { tone: 'green' | 'amber' | 'red' | 'blue' | 'grey' | 'purple' }) {
  return <span className={`${styles.dot} ${styles[`dot--${tone}`]}`} />;
}

function Chip({
  tone, children, icon,
}: {
  tone: 'green' | 'amber' | 'red' | 'blue' | 'grey' | 'purple';
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <span className={`${styles.chip} ${styles[`chip--${tone}`]}`}>
      {icon}{children}
    </span>
  );
}

// ── Section primitives ─────────────────────────────────────────────

function CommandTile({
  label, value, sub, tone, icon: Icon, href,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone: 'green' | 'amber' | 'red' | 'blue' | 'grey' | 'purple';
  icon: React.ElementType;
  href?: string;
}) {
  const inner = (
    <div className={styles.cmdTile}>
      <div className={styles.cmdTileTop}>
        <span className={`${styles.cmdTileIcon} ${styles[`cmdTileIcon--${tone}`]}`}>
          <Icon size={14} />
        </span>
        <span className={styles.cmdTileLabel}>{label}</span>
        {href && <ChevronRight size={12} className={styles.cmdTileChevron} />}
      </div>
      <div className={styles.cmdTileValue}>{value}</div>
      {sub && <div className={styles.cmdTileSub}>{sub}</div>}
    </div>
  );
  return href ? <Link href={href} className={styles.cmdTileLink}>{inner}</Link> : inner;
}

function FusionCard({ item }: { item: FusionItem }) {
  const tone = toneFor(item.status);
  // Default action text per status — only used if the server didn't
  // ship one (older payloads). All current /api/dashboard responses
  // populate `item.action`.
  const defaultAction =
    item.status === 'HEALTHY' || item.status === 'RUNNING' ? 'Details'
      : item.status === 'TIMEOUT' ? 'Retry'
      : item.status === 'NOT_CONFIGURED' ? 'Configure'
      : 'View';
  const action = item.action ?? defaultAction;
  return (
    <Link href={item.href} className={`${styles.fusionCard} ${styles[`fusionCard--${tone}`]}`}>
      <div className={styles.fusionTop}>
        <span className={styles.fusionLabel}>{item.label}</span>
        <Chip tone={tone}><StatusDot tone={tone} />{item.status.replace(/_/g, ' ')}</Chip>
      </div>
      <div className={styles.fusionDetail} title={item.reason ?? item.detail}>{item.detail}</div>
      <div className={styles.fusionFoot}>
        <span>{item.lastUpdated ? `Last ${fmtRelative(item.lastUpdated)}` : 'Pending'}</span>
        <span className={styles.fusionAction}>{action} <ArrowUpRight size={11} /></span>
      </div>
    </Link>
  );
}

// ── Page ───────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [data,    setData]    = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/dashboard?_=${Date.now()}`, { cache: 'no-store' });
      const json = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        setError((json && (json.error || json.message)) || `HTTP ${res.status}`);
        return;
      }
      if (!json || json.ok !== true) {
        setError('Dashboard response not OK');
        return;
      }
      setData(json as DashboardPayload);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    }
  }, []);

  useEffect(() => {
    (async () => {
      setLoading(true);
      await load();
      setLoading(false);
    })();
  }, [load]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  // Auto-refresh every 60s while the tab is visible.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  // ── Derived display values (defensive defaults so we never crash on a partial payload) ──
  const market         = data?.marketStatus;
  const trust          = data?.trustScore;
  const summary        = data?.signalSummary;
  const fusion         = data?.intelligenceFusion;
  const strategy       = data?.strategySnapshot;
  const engineHealth   = data?.engineHealth;
  const risk           = data?.riskSummary;
  const opps           = data?.nearestOpportunities ?? [];
  const actions        = data?.recommendedActions ?? [];
  const warnings       = data?.warnings ?? [];
  const moduleCounts   = data?.moduleStatusCounts;

  const signalEngineStatus = fusion?.signalEngine.status ?? 'UNKNOWN';

  // Institutional copy descriptors — pure display transformations on
  // the existing payload, no business logic.
  const marketDesc = describeMarket(market);
  const engineDesc = describeSignalEngine(
    signalEngineStatus,
    engineHealth?.primaryBlockingReason,
    engineHealth?.canGenerateApprovedSignals,
    engineHealth?.canGenerateCandidates,
  );
  const freshnessDesc = describeFreshness(risk?.staleData, summary?.latestSignalAt);
  const trustDesc     = describeTrust(trust, !!risk?.staleData, signalEngineStatus);

  // Signal Readiness — count of candidates the engine is actively
  // tracking but hasn't yet approved. Derived from the existing
  // signalSummary fields, no new data.
  const readinessCount = (summary?.highPotentialTotal ?? 0) + (summary?.watchlistTotal ?? 0);
  const readinessTone: 'blue' | 'grey' = readinessCount > 0 ? 'blue' : 'grey';
  const readinessSub = readinessCount > 0
    ? 'Candidates awaiting confirmation.'
    : 'No active candidates this cycle.';

  // Risk Gate — surfaces the institutional gate state. Active when
  // the engine is currently blocking trades (rejected pool non-zero
  // or due-diligence has logged blocker reasons).
  const riskGateActive =
    (summary?.rejectedTotal ?? 0) > 0 ||
    (risk?.rejectedTopReasons?.length ?? 0) > 0;
  const riskGateTone: 'amber' | 'green' = riskGateActive ? 'amber' : 'green';
  const riskGateValue = riskGateActive ? 'ACTIVE' : 'OPEN';
  const riskGateSub   = riskGateActive
    ? 'Blocking low-confidence trades.'
    : 'No active rejections this cycle.';

  const biasTone = directionTone(strategy?.directionBias);

  const noApproved   = (summary?.approvedTotal ?? 0) === 0;
  const hasCandidates = (summary?.candidateTotal ?? 0) > 0;

  // Session / engine-mode chips for the header right cluster.
  const sessionPillTone: 'green' | 'blue' | 'grey' =
    market?.status === 'OPEN' ? 'green' : market?.status === 'CLOSED' ? 'blue' : 'grey';
  const sessionPillLabel =
    market?.status === 'OPEN' ? 'Live Session' :
    marketDesc.value === 'WEEKEND MODE' ? 'Weekend Mode' :
    marketDesc.value === 'HOLIDAY MODE' ? 'Holiday Mode' :
    market?.status === 'CLOSED' ? 'Session Closed' : 'Session Pending';
  const engineModeTone = engineDesc.tone;

  // System Notice content — replaces the legacy warning strip with
  // a structured status / reason / impact / action card.
  const notice = buildSystemNotice(
    moduleCounts,
    warnings,
    engineDesc.mode,
    engineDesc.tone,
    !!risk?.staleData,
  );

  // ── Loading skeleton ─────────────────────────────────────────────
  if (loading && !data) {
    return (
      <AppShell title="Command Center">
        <div className={styles.page}>
          <SkeletonShell />
        </div>
      </AppShell>
    );
  }

  // ── Hard failure (still keep shell) ──────────────────────────────
  if (error && !data) {
    return (
      <AppShell title="Command Center">
        <div className={styles.page}>
          <div className={styles.errorPanel}>
            <AlertTriangle size={28} />
            <div>
              <div className={styles.errorTitle}>Dashboard temporarily unavailable</div>
              <div className={styles.errorBody}>{error}</div>
            </div>
            <button className={styles.btnPrimary} onClick={refresh} disabled={refreshing}>
              <RefreshCw size={14} className={refreshing ? styles.spin : undefined} />
              Retry
            </button>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title="Command Center">
      <div className={styles.page}>

        {/* ── Header ──────────────────────────────────────────────── */}
        <header className={styles.header}>
          <div>
            <h1 className={styles.title}>
              <Sparkles size={18} className={styles.titleSpark} />
              Quantorus365 Market Intelligence Center
            </h1>
            <p className={styles.subtitle}>
              AI-powered signal intelligence, risk validation, and market readiness command layer.
            </p>
          </div>
          <div className={styles.headerRight}>
            <div className={styles.headerStatusCluster}>
              <span className={`${styles.statusPill} ${styles[`statusPill--${sessionPillTone}`]}`}>
                <StatusDot tone={sessionPillTone} />
                {sessionPillLabel}
              </span>
              <span className={`${styles.statusPill} ${styles[`statusPill--${engineModeTone}`]}`}>
                <Cpu size={11} />
                {engineDesc.mode}
              </span>
            </div>
            <div className={styles.updatedAt}>
              <span className={styles.updatedAtLabel}>Last updated</span>
              <span className={styles.updatedAtValue}>{fmtTime(data?.generatedAt ?? null)}</span>
            </div>
            <button
              className={styles.btnPrimary}
              onClick={refresh}
              disabled={refreshing}
              title="Refresh dashboard"
            >
              <RefreshCw size={14} className={refreshing ? styles.spin : undefined} />
              Refresh
            </button>
          </div>
        </header>

        {/* ── System Notice ────────────────────────────────────────
            Premium replacement for the legacy warning strip. Surfaces
            four facets — mode / reason / impact / action — so a
            partial intelligence state reads as a controlled operating
            condition rather than a product failure. The full set of
            operator-facing reasons is exposed via the tooltip on the
            "Reason" field so nothing is hidden from the operator. */}
        {notice && (
          <div
            className={`${styles.systemNotice} ${styles[`systemNotice--${notice.tone}`]}`}
            role="status"
          >
            <div className={styles.systemNoticeLeft}>
              <span className={styles.systemNoticeKicker}>{notice.kicker}</span>
              <span className={styles.systemNoticeMode}>
                <notice.icon size={14} />
                {notice.mode}
              </span>
            </div>
            <div className={styles.systemNoticeBody}>
              <div className={styles.systemNoticeField}>
                <span className={styles.systemNoticeFieldLabel}>Reason</span>
                <span
                  className={styles.systemNoticeFieldValue}
                  title={warnings.length > 0 ? warnings.join('\n') : undefined}
                >
                  {notice.reason}
                </span>
              </div>
              <div className={styles.systemNoticeField}>
                <span className={styles.systemNoticeFieldLabel}>Impact</span>
                <span className={styles.systemNoticeFieldValue}>{notice.impact}</span>
              </div>
            </div>
            <div className={styles.systemNoticeCtas}>
              <button
                type="button"
                className={`${styles.systemNoticeCta} ${styles['systemNoticeCta--primary']}`}
                onClick={refresh}
                disabled={refreshing}
              >
                <RefreshCw size={12} className={refreshing ? styles.spin : undefined} />
                Refresh Data
              </button>
              <Link href="/signals/engine-health" className={styles.systemNoticeCta}>
                <Gauge size={12} />
                View Engine Health
              </Link>
            </div>
          </div>
        )}

        {/* ── Section B: Command Status Bar ─────────────────────────
            Six operational intelligence widgets. Reframed values
            ("Weekend Mode", "Partial", "Stale") + actionable subtitles
            so the bar reads as a cockpit, not a list of error states. */}
        <section className={styles.cmdBar}>
          <CommandTile
            label="Market State"
            tone={marketDesc.tone}
            icon={marketDesc.icon}
            value={marketDesc.value}
            sub={marketDesc.sub}
          />
          <CommandTile
            label="Signal Engine"
            tone={engineDesc.tone}
            icon={Zap}
            href="/signals"
            value={engineDesc.value}
            sub={engineDesc.sub}
          />
          <CommandTile
            label="Data Freshness"
            tone={freshnessDesc.tone}
            icon={Database}
            value={freshnessDesc.value}
            sub={freshnessDesc.sub}
          />
          <CommandTile
            label="Trust Score"
            tone={trustDesc.tone}
            icon={Gauge}
            value={trustDesc.value}
            sub={trustDesc.sub}
          />
          <CommandTile
            label="Signal Readiness"
            tone={readinessTone}
            icon={Target}
            href="/signals"
            value={`${readinessCount} Developing`}
            sub={readinessSub}
          />
          <CommandTile
            label="Risk Gate"
            tone={riskGateTone}
            icon={riskGateActive ? Lock : ShieldCheck}
            href="/signals/engine-health"
            value={riskGateValue}
            sub={riskGateSub}
          />
        </section>

        {/* ── Section C: Signal Summary Grid ──────────────────────── */}
        <section className={styles.signalGrid}>
          <SummaryCard
            tone="green"
            icon={CheckCircle2}
            label="Approved"
            value={summary?.approvedTotal ?? 0}
            sub={
              (summary?.approvedTotal ?? 0) > 0
                ? `${summary?.approvedBuy ?? 0} buy · ${summary?.approvedSell ?? 0} sell`
                : 'No signals passed risk gate yet.'
            }
            href="/signals"
          />
          <SummaryCard
            tone="blue"
            icon={Target}
            label="High Potential"
            value={summary?.highPotentialTotal ?? 0}
            sub={
              (summary?.highPotentialTotal ?? 0) > 0
                ? 'Strong but unconfirmed setups.'
                : 'Awaiting confirmation from fresh market data.'
            }
            href="/signals"
          />
          <SummaryCard
            tone="amber"
            icon={ShieldAlert}
            label="Watchlist"
            value={summary?.watchlistTotal ?? 0}
            sub={
              (summary?.watchlistTotal ?? 0) > 0
                ? 'Developing setups under review.'
                : 'No developing setups this cycle.'
            }
            href="/watchlist"
          />
          <SummaryCard
            tone="red"
            icon={TrendingDown}
            label="Rejected"
            value={summary?.rejectedTotal ?? 0}
            sub={
              (summary?.rejectedTotal ?? 0) > 0
                ? 'Risk gate restricted these candidates.'
                : 'No active rejected signals in current cycle.'
            }
            href="/signals"
          />
          <SummaryCard
            tone="purple"
            icon={ArrowUpRight}
            label="Nearest to Approval"
            value={opps.length}
            sub={opps[0]?.symbol ? `Top candidate: ${opps[0].symbol}` : 'No candidates within striking distance.'}
            href="/signals"
          />
          <SummaryCard
            tone="grey"
            icon={AlertTriangle}
            label="Top Blocker"
            value={summary?.topBlockingReason
              ? <span className={styles.blockerTxt}>{summary.topBlockingReason}</span>
              : 'None'
            }
            sub={
              (risk?.rejectedTopReasons?.[0]?.count ?? 0) > 0
                ? `${risk?.rejectedTopReasons?.[0]?.count ?? 0} rejected for this reason.`
                : 'No dominant block reason this cycle.'
            }
            href="/signals/engine-health"
          />
        </section>

        {/* ── Section D: Intelligence Fusion ─────────────────────── */}
        <section className={styles.fusionStrip}>
          <div className={styles.sectionHead}>
            <Cpu size={14} />
            <span>Intelligence Fusion</span>
            <span className={styles.sectionHeadDim}>5 modules</span>
          </div>
          <div className={styles.fusionGrid}>
            {fusion ? (
              <>
                <FusionCard item={fusion.newsIntelligence} />
                <FusionCard item={fusion.manipulationWatch} />
                <FusionCard item={fusion.optionIntelligence} />
                <FusionCard item={fusion.backtesting} />
                <FusionCard item={fusion.engineHealth} />
              </>
            ) : (
              <div className={styles.muted}>Intelligence modules unavailable.</div>
            )}
          </div>
        </section>

        {/* ── Section E: Opportunity vs Risk ─────────────────────── */}
        <section className={styles.split}>
          {/* Opportunities */}
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <div className={styles.panelTitle}>
                <ArrowUpRight size={14} />
                <span>Nearest Trade Opportunities</span>
              </div>
              <Link href="/signals" className={styles.panelLink}>
                Open Signals <ChevronRight size={12} />
              </Link>
            </div>
            <p className={styles.panelHelper}>
              Candidates closest to approval based on confidence, gap, and risk filters.
            </p>

            {opps.length === 0 ? (
              <div className={styles.panelEmpty}>
                {noApproved && hasCandidates
                  ? 'Candidates under review — none within striking distance of approval thresholds yet.'
                  : noApproved
                    ? 'No approved signals currently. Awaiting candidates that clear the institutional gate.'
                    : 'Signal data is loading. Refresh or open Engine Health for details.'}
              </div>
            ) : (
              <ul className={styles.oppList}>
                {opps.slice(0, 5).map((o) => (
                  <li key={`${o.symbol}-${o.direction ?? 'na'}`} className={styles.oppRow}>
                    <div className={styles.oppSym}>
                      <span className={styles.oppSymTxt}>{o.symbol}</span>
                      <Chip tone={directionTone(o.direction)}>
                        {o.direction === 'BUY'
                          ? <TrendingUp size={10} />
                          : o.direction === 'SELL'
                            ? <TrendingDown size={10} />
                            : null}
                        {o.direction ?? '—'}
                      </Chip>
                    </div>
                    <div className={styles.oppMetrics}>
                      <Metric label="Score"   value={fmtScore(o.finalScore)} />
                      <Metric label="Conf"    value={fmtScore(o.confidenceScore)} />
                      <Metric label="R:R"     value={fmtScore(o.riskReward, 2)} />
                      <Metric label="Gap"     value={fmtScore(o.approvalGap, 2)} />
                    </div>
                    <div className={styles.oppReason} title={o.reason ?? undefined}>
                      {o.reason ?? '—'}
                    </div>
                    {(o.manipulationRisk || o.newsImpact) && (
                      <div className={styles.oppTags}>
                        {o.manipulationRisk && (
                          <Chip tone={o.manipulationRisk === 'SEVERE' ? 'red' : 'amber'}>
                            <Shield size={10} />
                            {o.manipulationRisk}
                          </Chip>
                        )}
                        {o.newsImpact && (
                          <Chip tone="blue">
                            <Newspaper size={10} />
                            {o.newsImpact}
                          </Chip>
                        )}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Risk blockers */}
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <div className={styles.panelTitle}>
                <ShieldAlert size={14} />
                <span>Risk &amp; Approval Blockers</span>
              </div>
              <Link href="/signals/engine-health" className={styles.panelLink}>
                Engine Health <ChevronRight size={12} />
              </Link>
            </div>
            <p className={styles.panelHelper}>
              Risk governance view — the institutional gate that protects you from low-confidence trades.
            </p>

            <RiskRow
              label="Top rejection reasons"
              empty="No blocker dominates rejections."
              items={(risk?.rejectedTopReasons ?? []).slice(0, 5).map((r) => ({
                primary: r.reason,
                secondary: `${r.count} rejected`,
                tone: 'amber' as const,
                icon: <AlertTriangle size={12} />,
              }))}
            />

            <RiskRow
              label="Module risk"
              empty="No active module risk."
              items={[
                risk?.staleData && {
                  primary: 'Data freshness STALE',
                  secondary: 'Engine running on aged candles.',
                  tone: 'red' as const,
                  icon: <Database size={12} />,
                },
                (risk?.manipulationWarningCount ?? 0) > 0 && {
                  primary: `${risk?.manipulationWarningCount} manipulation flags`,
                  secondary: fusion?.manipulationWatch.detail ?? 'Surveillance flagged risk.',
                  tone: 'red' as const,
                  icon: <ShieldAlert size={12} />,
                },
                fusion?.newsIntelligence.status === 'WARNING' && {
                  primary: 'News coverage partial',
                  secondary: fusion.newsIntelligence.detail,
                  tone: 'amber' as const,
                  icon: <Newspaper size={12} />,
                },
                fusion?.optionIntelligence.status === 'NOT_CONFIGURED' && {
                  primary: 'Option Intelligence not configured',
                  secondary: 'No F&O confirmation applied.',
                  tone: 'grey' as const,
                  icon: <LineChart size={12} />,
                },
                fusion?.backtesting.status === 'INSUFFICIENT_DATA' && {
                  primary: 'Backtesting insufficient data',
                  secondary: 'Cannot validate setup historically.',
                  tone: 'grey' as const,
                  icon: <FlaskConical size={12} />,
                },
                engineHealth?.topBrokenEngine && {
                  primary: `Engine degraded: ${engineHealth.topBrokenEngine}`,
                  secondary: engineHealth.primaryBlockingReason ?? 'See Engine Health',
                  tone: 'red' as const,
                  icon: <Cpu size={12} />,
                },
              ].filter(Boolean) as Array<{ primary: string; secondary: string; tone: 'red' | 'amber' | 'grey' | 'blue' | 'green' | 'purple'; icon: React.ReactNode }>}
            />

            {/* Approval Gate Explanation — reframes blocked trades as
                protective governance instead of a system error. */}
            <div className={styles.riskGroup}>
              <div className={styles.riskGroupLabel}>Approval Gate Explanation</div>
              <div className={styles.approvalNote}>
                <ShieldCheck size={14} />
                <span>
                  <strong>Risk gate active</strong> — the institutional approval pipeline is filtering low-confidence trades so only setups that clear confidence, risk, and confirmation thresholds reach the approved list.
                  {riskGateActive && (summary?.rejectedTotal ?? 0) > 0 && (
                    <> Currently restricting <strong>{summary?.rejectedTotal}</strong> candidate{summary?.rejectedTotal === 1 ? '' : 's'} this cycle.</>
                  )}
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* ── Section F + G: Strategy & Actions ───────────────────── */}
        <section className={styles.split}>
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <div className={styles.panelTitle}>
                <BarChart3 size={14} />
                <span>Strategy Snapshot</span>
              </div>
              <Link href="/intelligence" className={styles.panelLink}>
                Intelligence Hub <ChevronRight size={12} />
              </Link>
            </div>

            <div className={styles.snapshotGrid}>
              <SnapItem
                label="Market Regime"
                value={niceText(strategy?.marketRegime, 'Awaiting session data')}
                tone={strategy?.marketRegime && strategy.marketRegime !== 'UNKNOWN' ? 'blue' : 'grey'}
              />
              <SnapItem
                label="Direction Bias"
                value={niceText(strategy?.directionBias, 'Pending validation')}
                tone={biasTone}
              />
              <SnapItem
                label="Best Strategy"
                value={niceText(strategy?.bestStrategy, 'Pending validation')}
                tone={strategy?.bestStrategy ? 'green' : 'grey'}
              />
              <SnapItem
                label="Weak Strategy"
                value={niceText(strategy?.weakStrategy, 'Not enough confidence')}
                tone={strategy?.weakStrategy ? 'amber' : 'grey'}
              />
              <SnapItem
                label="Backtest Setup"
                value={niceText(strategy?.backtestSupportedSetup, 'Insufficient validated data')}
                tone={strategy?.backtestSupportedSetup ? 'purple' : 'grey'}
              />
              <SnapItem
                label="Avoid Setup"
                value={niceText(strategy?.avoidSetup, 'Awaiting confirmation')}
                tone={strategy?.avoidSetup ? 'red' : 'grey'}
              />
            </div>
          </div>

          {/* Recommended Actions */}
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <div className={styles.panelTitle}>
                <ArrowRight size={14} />
                <span>Recommended Actions</span>
              </div>
              <span className={styles.sectionHeadDim}>
                {actions.length === 0 ? 'all clear' : `top ${Math.min(actions.length, 5)}`}
              </span>
            </div>

            {actions.length === 0 ? (
              <div className={styles.panelEmpty}>
                All core checks passing — no operator action required.
              </div>
            ) : (
              <ul className={styles.actionList}>
                {actions.slice(0, 5).map((a, i) => {
                  const tone = prioTone(a.priority);
                  return (
                    <li key={`${a.title}-${i}`}>
                      <Link href={a.href} className={`${styles.actionItem} ${styles[`actionItem--${tone}`]}`}>
                        <span className={`${styles.actionPrio} ${styles[`actionPrio--${tone}`]}`}>
                          {a.priority}
                        </span>
                        <div className={styles.actionBody}>
                          <span className={styles.actionTitle}>{a.title}</span>
                          <span className={styles.actionReason}>{a.reason}</span>
                        </div>
                        <ChevronRight size={14} className={styles.actionChev} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      </div>
    </AppShell>
  );
}

// ── Local helpers used only by this page ───────────────────────────

function SummaryCard({
  label, value, sub, tone, icon: Icon, href,
}: {
  label: string;
  value: React.ReactNode;
  sub: React.ReactNode;
  tone: 'green' | 'blue' | 'amber' | 'red' | 'purple' | 'grey';
  icon: React.ElementType;
  href: string;
}) {
  return (
    <Link href={href} className={`${styles.sumCard} ${styles[`sumCard--${tone}`]}`}>
      <div className={styles.sumCardTop}>
        <span className={`${styles.sumCardIcon} ${styles[`sumCardIcon--${tone}`]}`}>
          <Icon size={14} />
        </span>
        <span className={styles.sumCardLabel}>{label}</span>
      </div>
      <div className={styles.sumCardValue}>{value}</div>
      <div className={styles.sumCardSub}>{sub}</div>
    </Link>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className={styles.metric}>
      <span className={styles.metricLabel}>{label}</span>
      <span className={styles.metricValue}>{value}</span>
    </span>
  );
}

function SnapItem({
  label, value, tone,
}: {
  label: string;
  value: string;
  tone: 'green' | 'blue' | 'amber' | 'red' | 'purple' | 'grey';
}) {
  return (
    <div className={`${styles.snapItem} ${styles[`snapItem--${tone}`]}`}>
      <span className={styles.snapLabel}>{label}</span>
      <span className={styles.snapValue} title={value}>{value}</span>
    </div>
  );
}

function RiskRow({
  label, items, empty,
}: {
  label: string;
  empty: string;
  items: Array<{ primary: string; secondary: string; tone: 'red' | 'amber' | 'grey' | 'blue' | 'green' | 'purple'; icon: React.ReactNode }>;
}) {
  return (
    <div className={styles.riskGroup}>
      <div className={styles.riskGroupLabel}>{label}</div>
      {items.length === 0 ? (
        <div className={styles.riskEmpty}>{empty}</div>
      ) : (
        <ul className={styles.riskList}>
          {items.map((it, i) => (
            <li key={i} className={`${styles.riskItem} ${styles[`riskItem--${it.tone}`]}`}>
              <span className={`${styles.riskIcon} ${styles[`riskIcon--${it.tone}`]}`}>{it.icon}</span>
              <div className={styles.riskBody}>
                <span className={styles.riskPrimary}>{it.primary}</span>
                <span className={styles.riskSecondary}>{it.secondary}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function SkeletonShell() {
  return (
    <>
      <div className={styles.skelHeader} />
      <div className={styles.skelRow} style={{ gridTemplateColumns: 'repeat(4,1fr)' }}>
        <div className={styles.skelBlock} /><div className={styles.skelBlock} />
        <div className={styles.skelBlock} /><div className={styles.skelBlock} />
      </div>
      <div className={styles.skelRow} style={{ gridTemplateColumns: 'repeat(6,1fr)' }}>
        <div className={styles.skelBlock} /><div className={styles.skelBlock} />
        <div className={styles.skelBlock} /><div className={styles.skelBlock} />
        <div className={styles.skelBlock} /><div className={styles.skelBlock} />
      </div>
      <div className={styles.skelRow} style={{ gridTemplateColumns: 'repeat(5,1fr)' }}>
        <div className={styles.skelBlock} /><div className={styles.skelBlock} />
        <div className={styles.skelBlock} /><div className={styles.skelBlock} />
        <div className={styles.skelBlock} />
      </div>
      <div className={styles.skelRow} style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className={styles.skelBlockTall} /><div className={styles.skelBlockTall} />
      </div>
    </>
  );
}
