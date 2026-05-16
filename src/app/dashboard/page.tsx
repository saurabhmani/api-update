'use client';
import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty } from '@/components/ui';
import { fmt, changeClass } from '@/lib/utils';
import {
  TrendingUp, TrendingDown, BarChart2, Zap, Target,
  RefreshCw, ArrowUpRight, ArrowDownRight, Minus,
  Shield, Activity, AlertTriangle, CheckCircle,
  FlaskConical, Play, Database, Download, ShieldAlert, Scan,
  Briefcase, Scale, Gavel,
  // Closed-market badge icons — used on the slate pills so each
  // section header gets a glanceable category icon next to its text.
  Clock, Archive, History as HistoryIcon,
} from 'lucide-react';
import ConvictionDistribution from '@/components/dashboard/ConvictionDistribution';
import styles from './dashboard.module.scss';

interface MarketIntel {
  marketTrend:    string;
  trendScore:     number;
  regime:         string;
  regimeConfidence: number | null;
  regimeReason:   string | null;
  weakMarket:     boolean;
  breadth:        { advancing: number; declining: number; unchanged: number; ratio: number | null };
  sectorStrength: Array<{ sector: string; change_percent: number; trend: string }>;
  topGainers:     Array<{ symbol: string; name: string; ltp: number; change_percent: number }>;
  topLosers:      Array<{ symbol: string; name: string; ltp: number; change_percent: number }>;
  fiiDii:         Array<{ date: string; fii_net: number; dii_net: number; fii_label: string; dii_label: string }>;
  volatility:     { nifty_vix: number | null; avg_range_pct: number; volatility_label: string };
  scenario:       { tag: string; confidence: number; stance_hint: string; allowed_strategies: string[] } | null;
  market_stance:  { stance: string; confidence: number; guidance: string; rationale: string; config: any } | null;
  meta:           { asOf: string; dataSource: string; cacheAgeSec: number | null };
}

interface RankingRow {
  symbol: string; name: string; exchange: string;
  score: number;
  // ltp / pct_change are widened to `number | string` because
  // /api/rankings can ship them as numeric strings under certain
  // mysql2 driver configs (`decimalNumbers: false`, the default for
  // many setups, returns DECIMAL columns as strings). The dashboard's
  // movers derivation coerces via `toFiniteNum` so both shapes work
  // identically — this widening is just to keep TS honest about what
  // can actually arrive over the wire.
  ltp: number | string;
  pct_change: number | string;
  signal_type: string | null; confidence: number | null;
  confidence_score: number | null; conviction_band: string | null;
  portfolio_fit_score: number | null; market_stance: string | null;
  // Multi-dimensional rank from /api/rankings — this is the actual
  // sort key the service uses (`compareRanked` in rankingsService.ts
  // sorts opportunity_rank DESC, then conviction, then confidence…).
  // The dashboard table used to show `score` next to a rank order
  // driven by opportunity_rank, which produced the screenshot bug
  // (ASHOKLEY 75.3 below ADANIGREEN 73.7).
  opportunity_rank?: number | null;
  rank_position?:    number | null;
}

interface OpportunityRow {
  tradingsymbol: string; exchange: string; direction: string;
  confidence: number; entry_price: number | null;
  stop_loss: number | null; target1: number | null;
  risk_reward: number | null; opportunity_score: number;
  conviction_band: string | null; scenario_tag: string | null;
  // Maturity-tracker fields. Optional because they only ship on rows
  // sourced from /api/signals (the dashboard's compact opps preview);
  // /api/opportunities/evaluate-style payloads do NOT carry them.
  // The dashboard reads them defensively to render the
  // "Early Scanner Candidate · Cycle N · Not Confirmed · Last Close"
  // badge instead of a normal BUY/SELL trade card when the row hasn't
  // matured to 3+ cycles. Spec UI §7.
  validation_cycles_passed?: number | null;
  maturity_score?:           number | null;
  conviction_level?:         string | null;
  stability_passed?:         boolean | null;
  is_relaxed?:               boolean;
  source_kind?:              'confirmed_snapshot' | 'q365_signals_early' | 'scanner_candidate';
  // Spec NO-TRADE-PRECEDENCE §7 — every signal returned by the API
  // carries the source-visibility envelope. The dashboard reads
  // is_trade_ready as the single discriminator for "show in main
  // panel vs. side panel"; a row with is_trade_ready=false is
  // routed to the Early Scanner Candidates / No-Trade panels.
  source_table?:             'q365_confirmed_signal_snapshots' | 'q365_signals';
  source_type?:              'confirmed_snapshot' | 'early_candidate' | 'no_trade';
  raw_classification?:       string | null;
  effective_signal_status?:  'NO_TRADE' | 'WATCHLIST_ONLY' | 'APPROVED_SIGNAL' | 'DEVELOPING_SETUP' | 'EXPIRED' | 'UNKNOWN';
  display_bucket?:           'confirmed' | 'early_candidate' | 'no_trade' | 'rejected' | 'scanner_candidate';
  is_confirmed?:             boolean;
  is_trade_ready?:           boolean;
  is_stale_candidate?:       boolean;
  minutes_since_seen?:       number | null;
}

interface BacktestRunRow {
  run_id: string;
  name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  signal_count: number;
  trade_count: number;
  config_json: any;
  summary_json: any;
  strategy_breakdown_json: any;
}

interface BacktestSummaryData {
  totalSignalsGenerated: number;
  totalTradesTaken: number;
  winRate: number;
  profitFactor: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  expectancyR: number;
  avgBarsInTrade: number;
  target1HitRate: number;
  target2HitRate: number;
  target3HitRate: number;
  initialCapital: number;
  finalEquity: number;
  annualizedReturnPct: number;
  sortinoRatio: number;
  calmarRatio: number;
  avgWinPct: number;
  avgLossPct: number;
  totalWins: number;
  totalLosses: number;
}

interface BacktestTradeRow {
  trade_id: string;
  symbol: string;
  direction: string;
  strategy: string;
  entry_date: string | null;
  exit_date: string | null;
  entry_price: number;
  exit_price: number | null;
  net_pnl: number;
  return_pct: number;
  return_r: number;
  outcome: string;
  exit_reason: string | null;
}

// ── Portfolio / Risk / Decision interfaces ────────────────────
interface PortfolioHolding {
  ticker: string; instrumentId: number; quantity: number; avgCost: number;
  marketPrice: number; marketValue: number; weight: number;
  unrealizedPnl: number; unrealizedPnlPct: number; sector: string | null;
}
interface PortfolioOverviewData {
  portfolioId: number; portfolioName: string; holdings: PortfolioHolding[];
  pnl: { totalInvested: number; currentValue: number; unrealizedPnl: number; unrealizedPnlPct: number; realizedPnl: number; totalPnl: number; totalPnlPct: number };
  positionsCount: number; totalAum: number;
}
interface RiskSummaryData {
  riskScore: number; overallSeverity: string;
  metrics: { metric: string; value: number; threshold: number; severity: string; explanation: string }[];
}
interface BreachAlert {
  id: number; category: string; severity: string; metric: string;
  currentValue: number; threshold: number; message: string; detectedAt: string;
}
interface DecisionTraceRow {
  decisionId: string; ticker: string; decision: string;
  fitScore: number | null; riskScore: number | null; createdAt: string;
}

const TREND_META: Record<string, { color: string; bg: string; Icon: React.ElementType }> = {
  'Strong Bull': { color: '#15803D', bg: '#DCFCE7', Icon: TrendingUp   },
  'Bull':        { color: '#16A34A', bg: '#F0FDF4', Icon: TrendingUp   },
  'Neutral':     { color: '#64748B', bg: '#F1F5F9', Icon: Minus        },
  'Bear':        { color: '#DC2626', bg: '#FEF2F2', Icon: TrendingDown },
  'Strong Bear': { color: '#B91C1C', bg: '#FEE2E2', Icon: TrendingDown },
};

const STANCE_STYLE: Record<string, { bg: string; color: string; label: string }> = {
  aggressive:          { bg: '#DCFCE7', color: '#15803D', label: 'Aggressive' },
  selective:           { bg: '#DBEAFE', color: '#1D4ED8', label: 'Selective' },
  defensive:           { bg: '#FEF3C7', color: '#D97706', label: 'Defensive' },
  capital_preservation:{ bg: '#FEE2E2', color: '#DC2626', label: 'Capital Preservation' },
};

function TrendBar({ score }: { score: number }) {
  const pct   = Math.min(100, Math.max(0, (score + 100) / 2));
  const color = score > 25 ? '#16A34A' : score < -25 ? '#DC2626' : '#D97706';
  return (
    <div style={{ height: 6, background: '#E2E8F0', borderRadius: 99, overflow: 'hidden', marginTop: 8 }}>
      <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 99, transition: 'width 0.6s' }} />
    </div>
  );
}

function SignalPill({ type }: { type: string | null }) {
  if (!type) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  const s = { BUY: ['#DCFCE7','#15803D'], SELL: ['#FEE2E2','#DC2626'], HOLD: ['#F1F5F9','#64748B'] }[type] ?? ['#F1F5F9','#64748B'];
  return <span style={{ background: s[0], color: s[1], fontWeight: 700, fontSize: 10, padding: '2px 8px', borderRadius: 99 }}>{type}</span>;
}

// Below-action-threshold signal indicator. When opportunity_rank < 60
// the row does NOT meet the actionable bar — surfacing it as "BUY"
// (in green) misleads operators into thinking the row is a trade
// call. Instead we render "Model Bias: Buy/Sell/Watch" in muted
// slate so the row reads as model output, not a recommendation.
// HOLD becomes "Watch" because HOLD on a sub-threshold row is
// neither a hold-the-position-you-have nor an open-new call — it's
// "model has no view, monitor."
function ModelBiasPill({ type }: { type: string | null }) {
  const t = (type ?? '').toUpperCase();
  if (!t || (t !== 'BUY' && t !== 'SELL' && t !== 'HOLD')) {
    return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  }
  const label = t === 'HOLD' ? 'Watch' : `Model Bias: ${t === 'BUY' ? 'Buy' : 'Sell'}`;
  return (
    <span
      title="Below action threshold — model output for context, not a trade call."
      style={{
        background: '#F1F5F9',
        color: '#475569',
        fontWeight: 600,
        fontSize: 10,
        padding: '2px 8px',
        borderRadius: 99,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}

// Universe-scan tier badge — flags rows whose opportunity_rank is
// below the 60 actionable threshold. Renders next to the rank
// number so a glance can't confuse a sub-threshold row with a
// genuine top-pick. The label is intentionally neutral ("Universe
// Scan") to convey "this is what the universe has, not a buy list."
function BelowThresholdBadge() {
  return (
    <span
      title="Opportunity rank is below the 60-point action threshold. Surfaced for visibility, not as a trade call."
      style={{
        background: '#FEF3C7',
        color: '#92400E',
        border: '1px solid #FDE68A',
        fontWeight: 700,
        fontSize: 9,
        letterSpacing: 0.3,
        padding: '1px 6px',
        borderRadius: 99,
        marginLeft: 4,
        whiteSpace: 'nowrap',
      }}
    >
      Universe Scan
    </span>
  );
}

// Conviction-band vocabulary varies across sources (see comment in
// /rankings/page.tsx). Normalise to the 4 visible tiers so the badge
// renders for every legitimate value the API can carry. Previously
// only matched 4 lowercase strings and dropped the badge for
// 'HIGH'/'MEDIUM'/'LOW'/'INSTITUTIONAL' coming from the engine.
const CONVICTION_DOTS: Record<'high'|'actionable'|'watchlist', readonly [string, string, string]> = {
  high:       ['#D1FAE5', '#065F46', '●●●●'],
  actionable: ['#DBEAFE', '#1D4ED8', '●●●○'],
  watchlist:  ['#FEF3C7', '#92400E', '●●○○'],
};

function ConvictionBadge({ band }: { band: string | null }) {
  if (!band) return null;
  const raw = band.trim().toLowerCase();
  if (!raw || raw === 'reject' || raw === 'rejected' || raw === 'no_trade') return null;

  let key: 'high' | 'actionable' | 'watchlist' | null = null;
  if (raw === 'high_conviction' || raw === 'high' || raw === 'institutional') key = 'high';
  else if (raw === 'actionable' || raw === 'medium' || raw === 'med')          key = 'actionable';
  else if (raw === 'watchlist'  || raw === 'low' || raw === 'developing')      key = 'watchlist';
  if (!key) return null;

  const cfg = CONVICTION_DOTS[key];
  return <span style={{ background:cfg[0], color:cfg[1], fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:99 }}>{cfg[2]}</span>;
}

function ConfBar({ val }: { val: number | null }) {
  if (val == null) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  const c = val >= 75 ? '#065F46' : val >= 65 ? '#1D4ED8' : val >= 55 ? '#D97706' : '#DC2626';
  return (
    <div style={{ display:'flex', alignItems:'center', gap:5 }}>
      <div style={{ width:44, height:4, background:'#E2E8F0', borderRadius:99, overflow:'hidden' }}>
        <div style={{ height:'100%', width:`${val}%`, background:c, borderRadius:99 }} />
      </div>
      <span style={{ fontSize:11, fontWeight:600, color:c }}>{val}%</span>
    </div>
  );
}

export default function DashboardPage() {
  const [intel,    setIntel]    = useState<MarketIntel | null>(null);
  const [rankings, setRankings] = useState<RankingRow[]>([]);
  const [opps,     setOpps]     = useState<OpportunityRow[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [lastAt,   setLastAt]   = useState<string | null>(null);

  // Spec MARKET-AWARENESS — central market state. Driven by
  // /api/market-status (re-derived from src/lib/marketData/marketHours).
  // We poll it on the same cadence as the rest of the dashboard data
  // so the "LIVE" / "Closed" badge can never drift from the wall clock.
  // Safe-default market status — used as the initial state AND as the
  // fallback when /api/market-status fetch fails or returns malformed
  // data. The contract is "if we cannot prove the market is open,
  // assume closed" — the UI's LIVE pill is gated by `mode === 'live'`,
  // so a network failure can never accidentally label cached data as
  // live. `bypassActive: false` keeps the operator-warning pill out of
  // the UI for a fallback (vs an actual bypass env).
  type MarketStatusShape = {
    mode:         'live' | 'pre_open' | 'post_close' | 'holiday' | 'weekend' | 'market_closed';
    isOpen:       boolean;
    state:        string;
    label:        string;
    nowIst:       string;
    isHoliday:    boolean;
    reason:       string | null;
    bypassActive: boolean;
    bypassReason: string | null;
  };
  const FALLBACK_MARKET_STATUS: MarketStatusShape = {
    mode:         'market_closed',
    isOpen:       false,
    state:        'closed',
    label:        'Market Status Unavailable — Showing Cached Data',
    nowIst:       new Date().toISOString(),
    isHoliday:    false,
    reason:       'Could not reach /api/market-status — defaulting to closed for safety',
    bypassActive: false,
    bypassReason: null,
  };
  const [marketStatus, setMarketStatus] = useState<MarketStatusShape | null>(null);
  const [rankingsDataSource, setRankingsDataSource] = useState<'live_feed' | 'last_rankings_db' | 'cached_rankings' | 'eod_snapshot' | null>(null);
  const [signalsClosedMode,  setSignalsClosedMode]  = useState<boolean>(false);

  // ── Backtesting state ───────────────────────────────────
  const [btRuns,       setBtRuns]       = useState<BacktestRunRow[]>([]);
  const [btSelected,   setBtSelected]   = useState<string | null>(null);
  const [btSummary,    setBtSummary]    = useState<BacktestSummaryData | null>(null);
  const [btTrades,     setBtTrades]     = useState<BacktestTradeRow[]>([]);
  const [btLoading,    setBtLoading]    = useState(false);
  const [btRunning,    setBtRunning]    = useState(false);
  const [btError,      setBtError]      = useState<string | null>(null);
  const [btStratBreak, setBtStratBreak] = useState<any[]>([]);

  // ── Data seeding state ──────────────────────────────────
  const [dataReady,    setDataReady]    = useState<number | null>(null);
  const [dataTotal,    setDataTotal]    = useState<number>(0);
  const [dataSeeding,  setDataSeeding]  = useState(false);
  const [seedStatus,   setSeedStatus]   = useState<string | null>(null);

  // ── Portfolio / Risk / Decisions state ───────────────
  const [portfolio,     setPortfolio]    = useState<PortfolioOverviewData | null>(null);
  const [riskSummary,   setRiskSummary]  = useState<RiskSummaryData | null>(null);
  const [breaches,      setBreaches]     = useState<BreachAlert[]>([]);
  const [decisions,     setDecisions]    = useState<DecisionTraceRow[]>([]);
  const [evalRunning,   setEvalRunning]  = useState(false);
  const [evalError,     setEvalError]    = useState<string | null>(null);

  // ── Manipulation detection state ────────────────────────
  const [mdAlerts,     setMdAlerts]     = useState<any[]>([]);
  const [mdLoading,    setMdLoading]    = useState(false);
  const [mdScanning,   setMdScanning]   = useState(false);
  const [mdSummary,    setMdSummary]    = useState<{ totalAlerts: number; bySeverity: Record<string, number> } | null>(null);

  const checkDataAvailability = useCallback(async () => {
    try {
      const res = await fetch('/api/backtests/seed-data');
      const data = await res.json();
      setDataReady(data.readySymbols ?? 0);
      setDataTotal(data.totalSymbols ?? 0);
      return data.readySymbols ?? 0;
    } catch { return 0; }
  }, []);

  const seedData = async () => {
    setDataSeeding(true);
    setSeedStatus('Fetching historical data from Yahoo Finance...');
    setBtError(null);
    try {
      const res = await fetch('/api/backtests/seed-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: '2y' }),
      });
      const data = await res.json();
      if (!res.ok) { setBtError(data.error || 'Seed failed'); return; }
      setSeedStatus(`Done: ${data.seeded} symbols seeded, ${data.totalCandles} candles loaded (${(data.durationMs / 1000).toFixed(0)}s)`);
      await checkDataAvailability();
    } catch (err) {
      setBtError(err instanceof Error ? err.message : 'Seed failed');
    } finally {
      setDataSeeding(false);
    }
  };

  const loadManipulationAlerts = useCallback(async () => {
    try {
      const res = await fetch('/api/manipulation?action=summary');
      const data = await res.json();
      setMdSummary({ totalAlerts: data.totalAlerts ?? 0, bySeverity: data.bySeverity ?? {} });
      setMdAlerts(data.topAlerts ?? []);
    } catch { /* ignore */ }
  }, []);

  const runManipulationScan = async () => {
    setMdScanning(true);
    try {
      const res = await fetch('/api/manipulation', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const data = await res.json();
      if (data.alerts) setMdAlerts(data.alerts.slice(0, 10));
      setMdSummary({ totalAlerts: data.alertsGenerated ?? 0, bySeverity: {} });
      await loadManipulationAlerts();
    } catch { /* ignore */ }
    finally { setMdScanning(false); }
  };

  // Track whether the user has manually chosen a run. When false,
  // the auto-poll is free to jump to the newest completed run so
  // the panel always reflects the latest backtest without a click.
  const btUserPickedRef = useRef(false);

  const loadBacktestRuns = useCallback(async (opts: { silent?: boolean } = {}) => {
    try {
      const res = await fetch('/api/backtests');
      const data = await res.json();
      const runs: BacktestRunRow[] = data.runs ?? [];
      setBtRuns(runs);
      // Auto-select the newest completed run unless the user has
      // picked one manually. We re-check on every poll so a freshly
      // finished run takes over the panel automatically.
      const completed = runs
        .filter(r => r.status === 'completed')
        .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
      const latest = completed[0];
      if (latest && !btUserPickedRef.current) {
        setBtSelected(prev => {
          if (prev !== latest.run_id) {
            loadBacktestDetail(latest.run_id, { silent: opts.silent, keepAuto: true });
          }
          return prev;
        });
      }
    } catch { /* ignore */ }
  }, []);

  const loadBacktestDetail = async (runId: string, opts: { silent?: boolean; keepAuto?: boolean } = {}) => {
    setBtSelected(runId);
    if (!opts.keepAuto) btUserPickedRef.current = true;
    if (!opts.silent) setBtLoading(true);
    setBtError(null);
    try {
      const [detailRes, tradesRes] = await Promise.allSettled([
        fetch(`/api/backtests/${runId}/analytics`).then(r => r.json()),
        fetch(`/api/backtests/${runId}/trades`).then(r => r.json()),
      ]);
      if (detailRes.status === 'fulfilled') {
        // Coerce all numeric fields — DB JSON columns can return strings
        const rawSummary = detailRes.value.summary;
        if (rawSummary) {
          const numericKeys: (keyof BacktestSummaryData)[] = [
            'totalSignalsGenerated', 'totalTradesTaken', 'winRate', 'profitFactor',
            'totalReturnPct', 'maxDrawdownPct', 'sharpeRatio', 'expectancyR',
            'avgBarsInTrade', 'target1HitRate', 'target2HitRate', 'target3HitRate',
            'initialCapital', 'finalEquity', 'annualizedReturnPct', 'sortinoRatio',
            'calmarRatio', 'avgWinPct', 'avgLossPct', 'totalWins', 'totalLosses',
          ];
          const normalized = { ...rawSummary };
          for (const k of numericKeys) {
            normalized[k] = Number(rawSummary[k] ?? 0);
          }
          setBtSummary(normalized);
        } else {
          setBtSummary(null);
        }
        setBtStratBreak(detailRes.value.strategyBreakdown ?? []);
      }
      if (tradesRes.status === 'fulfilled') {
        setBtTrades(tradesRes.value.trades ?? []);
      }
    } catch (err) {
      setBtError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      if (!opts.silent) setBtLoading(false);
    }
  };

  const cleanupFailedRuns = async () => {
    const failed = btRuns.filter(r => r.status === 'failed');
    if (failed.length === 0) return;
    if (!confirm(`Delete ${failed.length} failed backtest run(s)?`)) return;

    try {
      await Promise.all(failed.map(r =>
        fetch(`/api/backtests/${r.run_id}`, { method: 'DELETE' }),
      ));
      await loadBacktestRuns();
    } catch (err) {
      setBtError(err instanceof Error ? err.message : 'Cleanup failed');
    }
  };

  const runNewBacktest = async () => {
    setBtRunning(true);
    setBtError(null);
    try {
      const res = await fetch('/api/backtests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: {} }) });
      const data = await res.json();
      if (!res.ok) { setBtError(data.error || 'Backtest failed'); return; }
      // Reload runs and select the new one
      await loadBacktestRuns();
      if (data.runId) loadBacktestDetail(data.runId);
    } catch (err) {
      setBtError(err instanceof Error ? err.message : 'Failed to run backtest');
    } finally {
      setBtRunning(false);
    }
  };

  const load = useCallback(async (spinner = true) => {
    if (spinner) setLoading(true);
    try {
      const [iRes, rRes, oRes, pRes, rkRes, bRes, dRes, msRes] = await Promise.allSettled([
        fetch('/api/market-intelligence').then(r => r.json()),
        // Limit history:
        //   • 10  — original; almost never carried any negative movers
        //           because the top 10 by opportunity_rank are all BUY
        //           setups, so the Top Losers card stayed empty.
        //   • 50  — improved the local case but production still had
        //           strongly bullish dispersion in the top-50 by
        //           opportunity_rank, so the loser fallback returned
        //           [] and the dashboard rendered "Last close losers
        //           unavailable" while the Rankings page (limit=100)
        //           showed both positives and negatives clearly.
        //   • 200 — current. Wide enough that even a strongly bullish
        //           tape includes genuine decliners somewhere in the
        //           opportunity_rank window, so the rankings-derived
        //           fallback can ALWAYS find losers when they exist
        //           in the underlying rankings table. The Top Rankings
        //           panel still slices to the top 10 (slice applied in
        //           the JSX below) and the rankings service caps the
        //           candidate pool at 800, so this is well within the
        //           supported envelope.
        fetch('/api/rankings?limit=200').then(r => r.json()),
        fetch('/api/signals?action=top&limit=6').then(r => r.json()),
        fetch('/api/portfolio/overview').then(r => r.json()),
        fetch('/api/risk/summary').then(r => r.json()),
        fetch('/api/alerts/breaches').then(r => r.json()),
        fetch('/api/decisions/traces?limit=10').then(r => r.json()),
        fetch('/api/market-status').then(r => r.json()),
      ]);
      if (iRes.status === 'fulfilled') setIntel(iRes.value);
      if (rRes.status === 'fulfilled') {
        setRankings(rRes.value.data ?? []);
        // Spec §5 — capture the data_source label so the Top Rankings
        // section can render "Last Close Data" off-hours. Includes
        // 'cached_rankings' / 'eod_snapshot' which were previously
        // dropped — that's why the yellow badge sometimes rendered
        // empty (the conditional was true but the union was wrong).
        const v: any = rRes.value;
        if (v.data_source === 'live_feed' ||
            v.data_source === 'last_rankings_db' ||
            v.data_source === 'cached_rankings' ||
            v.data_source === 'eod_snapshot') {
          setRankingsDataSource(v.data_source);
        }
      }
      if (oRes.status === 'fulfilled') {
        setOpps(oRes.value.signals ?? []);
        // Spec §6 — closed-market signals stay rendered (so the
        // operator can review last-close setups) but the panel
        // header gets a "Last Close Signals" label.
        setSignalsClosedMode(oRes.value.mode === 'market_closed');
      }
      // Defensive market-status handling. Three failure paths are
      // covered so the UI can NEVER stay on a stale "loading" state
      // or accidentally render LIVE just because an API hiccup
      // returned no data:
      //   1. Promise rejected (network down, 500, 401)         → fallback
      //   2. Promise fulfilled but body has no usable `mode`   → fallback
      //   3. Body has unrecognised mode value                  → fallback
      // In every fallback path we set `mode: 'market_closed'` so the
      // header pill renders "MARKET CLOSED" instead of the green
      // LIVE pill. `mode === 'live'` is the only path that flips the
      // UI to the live state, and that requires an explicit valid
      // response from the central market-status endpoint.
      const VALID_MODES = ['live', 'pre_open', 'post_close', 'holiday', 'weekend', 'market_closed'] as const;
      if (msRes.status === 'fulfilled'
          && msRes.value
          && typeof msRes.value === 'object'
          && (VALID_MODES as readonly string[]).includes(msRes.value.mode)) {
        setMarketStatus(msRes.value);
        if (msRes.value?.bypassActive) {
          // Loud warning — the runtime is forcing market state away
          // from the wall clock. The UI still renders truthful
          // labels (mode is derived from the calendar in the API),
          // but operators should know.
          // eslint-disable-next-line no-console
          console.warn('[dashboard] market bypass env active:', msRes.value.bypassReason);
        }
      } else {
        // eslint-disable-next-line no-console
        console.warn(
          '[dashboard] /api/market-status unavailable — defaulting to closed/cached',
          msRes.status === 'rejected' ? (msRes as PromiseRejectedResult).reason : 'malformed response',
        );
        setMarketStatus(FALLBACK_MARKET_STATUS);
      }
      // The portfolio/risk/breaches endpoints now return
      //   { data: null|<value>, hasPortfolio: boolean }
      // for users who haven't created a portfolio yet (was a 400).
      // The previous `pRes.value.data ?? pRes.value` fallback would
      // assign the WHOLE envelope object when data was null, leaving
      // `portfolio` truthy and breaking every "if (portfolio) … " check
      // downstream — most visibly the Evaluate button which kept firing
      // POST /api/opportunities/evaluate → 400 "No portfolio found".
      // Treat hasPortfolio === false as "set null", and only fall back
      // to the raw value when the response isn't using the new shape.
      if (pRes.status === 'fulfilled') {
        const v: any = pRes.value;
        setPortfolio(v?.hasPortfolio === false ? null : (v?.data ?? v));
      }
      if (rkRes.status === 'fulfilled') {
        const v: any = rkRes.value;
        setRiskSummary(v?.hasPortfolio === false ? null : (v?.data ?? v));
      }
      if (bRes.status === 'fulfilled') {
        const v: any = bRes.value;
        // Breaches always has a list shape ([] when no portfolio).
        setBreaches(v?.hasPortfolio === false ? [] : (v?.data ?? v?.breaches ?? []));
      }
      if (dRes.status === 'fulfilled') setDecisions(dRes.value.data ?? []);
      setLastAt(new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }));
    } finally {
      if (spinner) setLoading(false);
    }
  }, []);

  const evaluateTopOpportunities = useCallback(async () => {
    if (!opps.length || evalRunning) return;
    // Guard: POST /api/opportunities/evaluate 400s with "No portfolio
    // found" when the user has no portfolio. The button is also disabled
    // in that state, but defend the callback in case the button state
    // ever desyncs (stale closure, devtools-triggered call, etc).
    if (!portfolio) {
      setEvalError('Create a portfolio first — evaluation needs your book to size trades.');
      return;
    }
    setEvalRunning(true);
    setEvalError(null);
    try {
      const targets = opps.filter(o => o.entry_price && o.entry_price > 0);
      if (!targets.length) {
        setEvalError('No opportunities have a usable entry price to evaluate.');
        return;
      }
      const results = await Promise.allSettled(
        targets.map(o =>
          fetch('/api/opportunities/evaluate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              ticker: o.tradingsymbol,
              quantity: 1,
              price: o.entry_price,
            }),
          }).then(async r => {
            if (!r.ok) {
              const body = await r.json().catch(() => ({}));
              throw new Error(body?.error ?? `HTTP ${r.status}`);
            }
            return r.json();
          }),
        ),
      );
      const failed = results.filter(r => r.status === 'rejected');
      if (failed.length === results.length) {
        const firstErr = (failed[0] as PromiseRejectedResult).reason;
        setEvalError(firstErr instanceof Error ? firstErr.message : 'Evaluation failed');
      }
      const dRes = await fetch('/api/decisions/traces?limit=10').then(r => r.json());
      setDecisions(dRes.data ?? []);
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : 'Evaluation failed');
    } finally {
      setEvalRunning(false);
    }
  }, [opps, evalRunning, portfolio]);

  // Adaptive polling cadence: when the market is closed, last-close
  // data is immutable until the next session, so polling every 10s
  // burns CPU and bandwidth for nothing. We slow to 3 min off-hours
  // and keep 10 s during the live session. The cadence re-arms
  // whenever marketStatus.isOpen flips, so the moment the session
  // opens the dashboard automatically speeds up.
  useEffect(() => {
    load();
    loadBacktestRuns();
    checkDataAvailability();
    loadManipulationAlerts();

    const isOpen = marketStatus?.isOpen === true;
    const mainMs = isOpen ? 10_000  : 3 * 60_000;
    const btMs   = isOpen ? 15_000  : 5 * 60_000;

    const main = setInterval(() => {
      if (!document.hidden) {
        load();
        loadManipulationAlerts();
      }
    }, mainMs);
    const bt = setInterval(() => {
      loadBacktestRuns({ silent: true });
      setBtSelected(prev => {
        if (prev) loadBacktestDetail(prev, { silent: true, keepAuto: !btUserPickedRef.current });
        return prev;
      });
    }, btMs);
    return () => { clearInterval(main); clearInterval(bt); };
  }, [load, loadBacktestRuns, checkDataAvailability, loadManipulationAlerts, marketStatus?.isOpen]);

  // ── Data validation layer — prevent contradictory display ──────
  // Validate breadth: if advancing + declining is 0, breadth is unreliable
  const breadthValid = (intel?.breadth?.advancing ?? 0) + (intel?.breadth?.declining ?? 0) > 10;
  const validatedBreadth = breadthValid ? intel?.breadth : {
    advancing: 0, declining: 0, unchanged: 0, ratio: null,
  };

  // Validate gainers/losers: losers must actually be negative.
  //
  // Fallback: when the market-intelligence service returns an empty
  // gainers/losers list (which happens off-hours when the EOD
  // top-movers table hasn't been refreshed) but the rankings array
  // DOES contain movers, derive the lists from rankings. Without this
  // the dashboard showed "No gaining stocks in current data" while
  // the ticker / Top Rankings table next to it had plenty of green
  // and red numbers — the production "Last close losers unavailable"
  // bug in the screenshot.
  //
  // Numeric coercion subtlety:
  //   `Number.isFinite(x)` returns FALSE for numeric strings like
  //   "-1.25" — a real production failure mode because the rankings
  //   table's `pct_change` is DECIMAL(8,4) and the mysql2 driver
  //   default `decimalNumbers: false` ships those values as strings
  //   over the wire when caching is involved. We coerce with
  //   `Number(...)` first and check `Number.isFinite` against the
  //   coerced value, so both "-1.25" (string) and -1.25 (number)
  //   produce the same filter outcome.
  const toFiniteNum = (v: unknown): number | null => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const intelGainers = (intel?.topGainers ?? []).filter(m => {
    const n = toFiniteNum(m.change_percent);
    return n != null && n > 0;
  });
  const intelLosers  = (intel?.topLosers  ?? []).filter(m => {
    const n = toFiniteNum(m.change_percent);
    return n != null && n < 0;
  });
  const rankingsGainers = rankings
    .map(r => {
      const pct = toFiniteNum(r.pct_change);
      const ltp = toFiniteNum(r.ltp) ?? 0;
      return pct == null
        ? null
        : { symbol: r.symbol, name: r.name, ltp, change_percent: pct };
    })
    .filter((r): r is NonNullable<typeof r> => r != null && r.change_percent > 0)
    .sort((a, b) => b.change_percent - a.change_percent)
    .slice(0, 5);
  const rankingsLosers = rankings
    .map(r => {
      const pct = toFiniteNum(r.pct_change);
      const ltp = toFiniteNum(r.ltp) ?? 0;
      return pct == null
        ? null
        : { symbol: r.symbol, name: r.name, ltp, change_percent: pct };
    })
    .filter((r): r is NonNullable<typeof r> => r != null && r.change_percent < 0)
    .sort((a, b) => a.change_percent - b.change_percent)
    .slice(0, 5);
  const validatedGainers = intelGainers.length > 0 ? intelGainers : rankingsGainers;
  const validatedLosers  = intelLosers.length  > 0 ? intelLosers  : rankingsLosers;
  const gainersFromRankings = intelGainers.length === 0 && rankingsGainers.length > 0;
  const losersFromRankings  = intelLosers.length  === 0 && rankingsLosers.length  > 0;

  // Client-side diagnostic — surfaces the exact counts that drive the
  // "Last close losers unavailable" empty state, so a future regression
  // (or a production-only drift) can be diagnosed from the browser
  // console without re-deploying. Only warns when the resulting lists
  // are empty AND the rankings array is non-empty, which is the
  // contradictory condition the user originally reported.
  if (typeof window !== 'undefined' &&
      rankings.length > 0 &&
      (validatedGainers.length === 0 || validatedLosers.length === 0)) {
    const negCount = rankings.filter(r => {
      const n = toFiniteNum(r.pct_change);
      return n != null && n < 0;
    }).length;
    const posCount = rankings.filter(r => {
      const n = toFiniteNum(r.pct_change);
      return n != null && n > 0;
    }).length;
    // eslint-disable-next-line no-console
    console.warn(
      '[dashboard] movers empty-state — rankings=' + rankings.length +
      ' positives=' + posCount + ' negatives=' + negCount +
      ' intelGainers=' + intelGainers.length + ' intelLosers=' + intelLosers.length +
      ' validatedGainers=' + validatedGainers.length +
      ' validatedLosers=' + validatedLosers.length
    );
  }

  // Defensive client-side sort. The /api/rankings response is already
  // ordered by `compareRanked` server-side (see rankingsService.ts),
  // but if a future regression ever ships rows out of order — or a
  // 60s redis cache returns a snapshot from before the comparator
  // change — this guarantees the UI ranking column never disagrees
  // with the visible primary field. Sort key MIRRORS the canonical
  // server comparator exactly:
  //   1. opportunity_rank DESC
  //   2. conviction band rank DESC
  //   3. confidence_score DESC
  //   4. risk_score ASC (lower wins ties)
  //   5. volume DESC
  //   6. symbol ASC
  // Drift between this comparator and the server one is exactly the
  // class of bug ISSUE 11 is meant to defend against, so the two
  // comparators are kept in lockstep.
  const CONVICTION_RANK_LOCAL: Record<string, number> = {
    high_conviction: 4, actionable: 3, watchlist: 2, reject: 0,
  };
  const sortedRankings = useMemo(() => {
    return [...(rankings ?? [])].sort((a, b) => {
      const aOpp = Number(a.opportunity_rank ?? a.score ?? 0);
      const bOpp = Number(b.opportunity_rank ?? b.score ?? 0);
      if (aOpp !== bOpp) return bOpp - aOpp;                 // 1. opp_rank DESC
      const cb = (CONVICTION_RANK_LOCAL[(b.conviction_band ?? '').toLowerCase()] ?? 1)
               - (CONVICTION_RANK_LOCAL[(a.conviction_band ?? '').toLowerCase()] ?? 1);
      if (cb !== 0) return cb;                               // 2. conviction DESC
      const aConf = Number(a.confidence_score ?? a.confidence ?? -1);
      const bConf = Number(b.confidence_score ?? b.confidence ?? -1);
      if (aConf !== bConf) return bConf - aConf;             // 3. confidence DESC
      const aRisk = Number((a as any).risk_score ?? Number.POSITIVE_INFINITY);
      const bRisk = Number((b as any).risk_score ?? Number.POSITIVE_INFINITY);
      if (aRisk !== bRisk) return aRisk - bRisk;             // 4. risk ASC
      const aVol = Number((a as any).volume ?? 0);
      const bVol = Number((b as any).volume ?? 0);
      if (aVol !== bVol) return bVol - aVol;                 // 5. volume DESC
      return String(a.symbol ?? '').localeCompare(String(b.symbol ?? '')); // 6. symbol ASC
    });
  }, [rankings]);

  // Validate stance vs signals consistency: if stance is defensive/capital_preservation
  // but we have high-conviction BUY signals, flag the inconsistency
  const stanceIsDefensive = intel?.market_stance?.stance === 'defensive' || intel?.market_stance?.stance === 'capital_preservation';
  const hasAggressiveSignals = opps.some(o => o.conviction_band === 'high_conviction' && o.direction === 'BUY');
  const stanceSignalConflict = stanceIsDefensive && hasAggressiveSignals;

  const trend = intel?.marketTrend ?? 'Neutral';
  const tm    = TREND_META[trend] ?? TREND_META['Neutral'];
  const stanceKey = intel?.market_stance?.stance ?? 'selective';
  const stanceStyle = STANCE_STYLE[stanceKey] ?? STANCE_STYLE.selective;

  return (
    <AppShell title="Dashboard">
      <div className="page">
        <div className="page__header">
          <div>
            <h1>Dashboard</h1>
            <p style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              Quantorus365 — Institutional Intelligence{lastAt ? ` · ${lastAt}` : ''}
              {/* Spec MARKET-AWARENESS §2 — the badge derives its label
                  from /api/market-status. LIVE only when isOpen=true.
                  Closed states (weekend / holiday / pre-open / post-close)
                  render an amber pill with the wall-clock truth. */}
              {(() => {
                const ms = marketStatus;
                const isLive    = ms?.isOpen === true;
                const isLoading = ms == null;
                // Defensive: every branch returns a non-empty string.
                // The previous `!ms ? '—'` produced a near-blank pill
                // (just an em dash) during the loading window or after
                // an API failure — the user reported "yellow label not
                // showing data" because of that. The unknown-mode
                // branch also explicitly returns 'CLOSED' rather than
                // falling through to '—'.
                const label = (() => {
                  if (isLoading)              return 'LOADING…';
                  if (ms!.mode === 'live')        return 'LIVE';
                  if (ms!.mode === 'pre_open')    return 'PRE-OPEN';
                  if (ms!.mode === 'post_close')  return 'MARKET CLOSED';
                  if (ms!.mode === 'holiday')     return 'HOLIDAY';
                  if (ms!.mode === 'weekend')     return 'WEEKEND';
                  if (ms!.mode === 'market_closed') return 'CLOSED';
                  return 'CLOSED';                // unknown mode → safe default
                })();
                const bg    = isLoading ? '#F1F5F9' : isLive ? '#DCFCE7' : '#FEF3C7';
                const fg    = isLoading ? '#475569' : isLive ? '#15803D' : '#92400E';
                const dot   = isLoading ? '#94A3B8' : isLive ? '#15803D' : '#D97706';
                const pulse = isLive ? 'pulse 1.5s ease-in-out infinite' : 'none';
                return (
                  <span
                    title={ms?.label ?? 'Market status loading…'}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 5,
                      padding: '2px 8px', borderRadius: 99,
                      background: bg, color: fg,
                      fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
                    }}
                  >
                    <span style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: dot, animation: pulse,
                    }} />
                    {label}
                  </span>
                );
              })()}
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn--secondary btn--sm" onClick={() => load(true)} disabled={loading}>
              <RefreshCw size={13} className={loading ? styles.spin : ''} /> Refresh
            </button>
          </div>
        </div>

        {/* ── MARKET-CLOSED BANNER (spec §2) ────────────────────────
             When the wall clock is outside regular session, surface a
             clear amber banner explaining what the dashboard is showing
             and why it is not live. The banner does NOT remove data —
             rankings / signals / market_data still render below so the
             operator can review last-close setups. */}
        {marketStatus && !marketStatus.isOpen && (
          <div style={{
            background: '#FEF3C7', borderRadius: 10, padding: '12px 18px',
            marginBottom: 20, border: '1px solid #FDE68A',
            display: 'flex', alignItems: 'flex-start', gap: 12,
          }}>
            <AlertTriangle size={20} color="#B45309" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: '#92400E' }}>
                  Market Closed — Showing last available data
                </span>
                {/* Defensive: fallback when marketStatus.label is empty
                    or missing — the pill used to render as a blank
                    rounded white shape inside the yellow banner. Now
                    always carries readable text derived from `mode`. */}
                <span style={{ fontSize: 11, color: '#92400E', background: 'white', padding: '1px 8px', borderRadius: 99, fontWeight: 600 }}>
                  {marketStatus.label && marketStatus.label.trim()
                    ? marketStatus.label
                    : marketStatus.mode === 'weekend'      ? 'Weekend'
                    : marketStatus.mode === 'holiday'      ? 'Holiday'
                    : marketStatus.mode === 'pre_open'     ? 'Pre-open'
                    : marketStatus.mode === 'post_close'   ? 'Post-close'
                    : marketStatus.mode === 'market_closed'? 'Market Closed'
                    :                                        'Market Closed'}
                </span>
                {marketStatus.bypassActive && (
                  <span title={marketStatus.bypassReason ?? ''} style={{
                    fontSize: 10, color: '#7C2D12', background: '#FEE2E2',
                    padding: '1px 8px', borderRadius: 99, fontWeight: 700,
                  }}>
                    ⚠️ BYPASS ENV SET
                  </span>
                )}
              </div>
              <p style={{ fontSize: 12, color: '#78350F', margin: 0 }}>
                Do not treat this as live intraday data. Prices, rankings, and ticker
                items are sourced from the last close (or the most recent cached snapshot)
                and will refresh automatically when regular session resumes
                {marketStatus.reason ? ` (${marketStatus.reason})` : '.'}
              </p>
            </div>
          </div>
        )}

        {/* ── MARKET STANCE BANNER ─────────────────────────────── */}
        {intel?.market_stance && (
          <div style={{
            background: stanceStyle.bg, borderRadius: 10, padding: '12px 18px',
            marginBottom: 20, border: `1px solid ${stanceStyle.color}33`,
            display: 'flex', alignItems: 'flex-start', gap: 14,
          }}>
            <Shield size={20} color={stanceStyle.color} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                <span style={{ fontWeight: 700, fontSize: 14, color: stanceStyle.color }}>
                  Market Stance: {stanceStyle.label}
                </span>
                <span style={{ fontSize: 11, color: stanceStyle.color, background: 'white', padding: '1px 8px', borderRadius: 99, fontWeight: 600 }}>
                  {intel.market_stance.confidence}% confidence
                </span>
                {intel.scenario && (
                  <span style={{ fontSize: 11, color: '#64748B', background: '#F1F5F9', padding: '1px 8px', borderRadius: 99 }}>
                    {intel.scenario.tag.replace(/_/g,' ')}
                  </span>
                )}
              </div>
              <p style={{ fontSize: 12, color: '#475569', margin: 0 }}>
                {intel.market_stance.guidance}
              </p>
              {intel.market_stance.config && (
                <div style={{ display: 'flex', gap: 16, marginTop: 6 }}>
                  {[
                    [`Min confidence: ${intel.market_stance.config.min_confidence}%`, ''],
                    [`Min R:R: ${intel.market_stance.config.min_rr}`, ''],
                    [`Max positions: ${intel.market_stance.config.max_positions}`, ''],
                    [`Risk multiplier: ${intel.market_stance.config.risk_multiplier}×`, ''],
                  ].map(([t]) => (
                    <span key={t} style={{ fontSize: 10, color: stanceStyle.color, fontWeight: 600 }}>{t}</span>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── STANCE / SIGNAL CONFLICT BANNER ──────────────────── */}
        {stanceSignalConflict && (
          <div style={{
            background: '#FFF7ED', borderRadius: 8, padding: '10px 14px',
            marginBottom: 12, border: '1px solid #FDBA7433',
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <AlertTriangle size={16} color="#C2410C" style={{ flexShrink: 0 }} />
            <div style={{ fontSize: 12, color: '#9A3412' }}>
              <strong>Data conflict:</strong> Market stance is {stanceStyle.label} but high-conviction BUY signals are present.
              Signals were generated from a different data snapshot. Exercise caution — verify both views before acting.
            </div>
          </div>
        )}

        {/* ── WEAK MARKET WARNING BANNER ───────────────────────── */}
        {intel?.weakMarket && (
          <div style={{
            background:    '#FEF3C7',
            border:        '1px solid #F59E0B',
            borderLeft:    '4px solid #B45309',
            borderRadius:  8,
            padding:       '10px 14px',
            marginBottom:  16,
            display:       'flex',
            alignItems:    'flex-start',
            gap:           10,
          }}>
            <AlertTriangle size={18} color="#B45309" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#92400E' }}>
                ⚠️ Market conditions are weak — signals have lower reliability
              </div>
              <div style={{ fontSize: 11, color: '#78350F', marginTop: 2 }}>
                {intel.regimeReason ?? 'Composite regime gates raised; stance engine has tightened thresholds.'}
                {intel.regimeConfidence != null && (
                  <> · regime confidence <strong>{intel.regimeConfidence}%</strong></>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ════════════════════════════════════════════════════════
            SECTION 1: PORTFOLIO OVERVIEW — First visible section
            PRD: "Portfolio is the first visible section"
            ════════════════════════════════════════════════════════ */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <Briefcase size={14} />
            <span>Portfolio Overview</span>
          </div>
          {portfolio ? (
            <>
              {(() => { const pnl = portfolio.pnl ?? { totalInvested: 0, currentValue: 0, unrealizedPnl: 0, unrealizedPnlPct: 0, realizedPnl: 0, totalPnl: 0, totalPnlPct: 0 }; return (
              <div className={styles.intelRow}>
                {[
                  { label: 'Total AUM', value: fmt.currency(portfolio.totalAum ?? 0), color: '#1E293B' },
                  { label: 'Invested', value: fmt.currency(pnl.totalInvested ?? 0), color: '#64748B' },
                  { label: 'Unrealized P&L', value: `${(pnl.unrealizedPnl ?? 0) >= 0 ? '+' : ''}${fmt.currency(pnl.unrealizedPnl ?? 0)}`, color: (pnl.unrealizedPnl ?? 0) >= 0 ? '#15803D' : '#DC2626', sub: `${(pnl.unrealizedPnlPct ?? 0) >= 0 ? '+' : ''}${Number(pnl.unrealizedPnlPct ?? 0).toFixed(2)}%` },
                  { label: 'Positions', value: String(portfolio.positionsCount ?? 0), color: '#1E293B', sub: portfolio.portfolioName },
                ].map(s => (
                  <div key={s.label} className={styles.intelBox}>
                    <div className={styles.boxLabel}>{s.label}</div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: s.color, marginTop: 6 }}>{s.value}</div>
                    {(s as any).sub && <div style={{ fontSize: 11, color: '#94A3B8', marginTop: 2 }}>{(s as any).sub}</div>}
                  </div>
                ))}
              </div>
              ); })()}
              {(portfolio.holdings ?? []).length > 0 && (
                <Card>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#F8FAFC' }}>
                        {['TICKER', 'QTY', 'AVG COST', 'MKT PRICE', 'VALUE', 'WEIGHT', 'P&L', 'P&L%'].map(h => (
                          <th key={h} style={{ padding: '6px 10px', textAlign: h === 'TICKER' ? 'left' : 'right', fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(portfolio.holdings ?? []).slice(0, 10).map(h => (
                        <tr key={h.ticker} style={{ borderTop: '1px solid #F8FAFC' }}>
                          <td style={{ padding: '7px 10px', fontWeight: 700, fontSize: 12 }}>
                            {h.ticker}
                            {h.sector && <span style={{ fontSize: 9, color: '#94A3B8', marginLeft: 6 }}>{h.sector}</span>}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12 }}>{h.quantity}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12 }}>{fmt.currency(h.avgCost)}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12 }}>{fmt.currency(h.marketPrice)}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12, fontWeight: 600 }}>{fmt.currency(h.marketValue)}</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 11, color: '#64748B' }}>{h.weight.toFixed(1)}%</td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12, fontWeight: 700, color: h.unrealizedPnl >= 0 ? '#15803D' : '#DC2626' }}>
                            {h.unrealizedPnl >= 0 ? '+' : ''}{fmt.currency(h.unrealizedPnl)}
                          </td>
                          <td style={{ padding: '7px 10px', textAlign: 'right', fontSize: 12, color: h.unrealizedPnlPct >= 0 ? '#15803D' : '#DC2626' }}>
                            {h.unrealizedPnlPct >= 0 ? '+' : ''}{h.unrealizedPnlPct.toFixed(2)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {(portfolio.holdings ?? []).length > 10 && (
                    <div style={{ padding: '6px 12px', fontSize: 11, color: '#94A3B8', textAlign: 'center', borderTop: '1px solid #F1F5F9' }}>
                      Showing 10 of {(portfolio.holdings ?? []).length} positions · <a href="/portfolio" style={{ color: '#3B82F6' }}>View all</a>
                    </div>
                  )}
                </Card>
              )}
            </>
          ) : loading ? (
            <div className={styles.intelRow}>
              {[1,2,3,4].map(i => <div key={i} className={styles.intelBox}><div className="skeleton" style={{ height: 72 }} /></div>)}
            </div>
          ) : (
            <Card><div style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>No portfolio data available. <a href="/portfolio" style={{ color: '#3B82F6' }}>Set up portfolio</a></div></Card>
          )}
        </section>

        {/* ════════════════════════════════════════════════════════
            SECTION 2: RISK & ACTIVE ALERTS — Always visible
            PRD: "Risk is always visible" + "Alerts influence UI prominently"
            ════════════════════════════════════════════════════════ */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <Shield size={14} />
            <span>Risk & Active Alerts</span>
            {breaches.filter(b => b.severity === 'critical').length > 0 && (
              <span style={{ background: '#FEE2E2', color: '#DC2626', fontSize: 10, fontWeight: 800, padding: '2px 10px', borderRadius: 99, marginLeft: 8, animation: 'pulse 1.5s ease-in-out infinite' }}>
                {breaches.filter(b => b.severity === 'critical').length} CRITICAL
              </span>
            )}
          </div>

          {/* Active breach alerts — prominent when present */}
          {breaches.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              {breaches.filter(b => b.severity === 'critical').map((b, i) => (
                <div key={b.id ?? i} style={{
                  background: '#FEF2F2', border: '1px solid #FECACA', borderLeft: '4px solid #DC2626',
                  borderRadius: 8, padding: '10px 14px', marginBottom: 8,
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <AlertTriangle size={16} color="#DC2626" />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#991B1B' }}>CRITICAL: {b.message}</div>
                    <div style={{ fontSize: 10, color: '#B91C1C' }}>{(b.category ?? '').replace(/_/g, ' ')} · {b.metric}</div>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: '#DC2626' }}>{Number(b.currentValue ?? 0).toFixed(1)} / {b.threshold ?? 0}</span>
                </div>
              ))}
              {breaches.filter(b => b.severity === 'warning').map((b, i) => (
                <div key={b.id ?? `w${i}`} style={{
                  background: '#FFFBEB', border: '1px solid #FDE68A', borderLeft: '3px solid #D97706',
                  borderRadius: 8, padding: '8px 14px', marginBottom: 6,
                  display: 'flex', alignItems: 'center', gap: 10, fontSize: 12,
                }}>
                  <AlertTriangle size={14} color="#D97706" />
                  <span style={{ flex: 1, color: '#92400E' }}>{b.message}</span>
                  <span style={{ fontSize: 11, color: '#D97706', fontWeight: 600 }}>{Number(b.currentValue ?? 0).toFixed(1)} / {b.threshold ?? 0}</span>
                </div>
              ))}
            </div>
          )}

          {/* Risk metrics row — always visible */}
          {riskSummary ? (
            <div className={styles.intelRow}>
              <div className={styles.intelBox} style={{
                borderColor: riskSummary.overallSeverity === 'critical' ? '#FCA5A5' : riskSummary.overallSeverity === 'warning' ? '#FDE68A' : '#BBF7D0',
                background: riskSummary.overallSeverity === 'critical' ? '#FEF2F2' : riskSummary.overallSeverity === 'warning' ? '#FFFBEB' : '#F0FDF4',
              }}>
                <div className={styles.boxLabel}>Overall Risk</div>
                <div style={{
                  fontSize: 28, fontWeight: 800, marginTop: 6,
                  color: riskSummary.riskScore > 60 ? '#DC2626' : riskSummary.riskScore > 35 ? '#D97706' : '#15803D',
                }}>
                  {riskSummary.riskScore}/100
                </div>
                <div style={{ fontSize: 11, color: '#64748B', marginTop: 2, textTransform: 'uppercase', fontWeight: 700 }}>{riskSummary.overallSeverity}</div>
              </div>
              {(riskSummary.metrics ?? []).slice(0, 3).map((m, i) => (
                <div key={m.metric ?? i} className={styles.intelBox}>
                  <div className={styles.boxLabel}>{(m.metric ?? '').replace(/_/g, ' ')}</div>
                  <div style={{ fontSize: 18, fontWeight: 700, marginTop: 6, color: m.severity === 'critical' ? '#DC2626' : m.severity === 'warning' ? '#D97706' : '#1E293B' }}>
                    {Number(m.value ?? 0).toFixed(1)}%
                  </div>
                  <div style={{ fontSize: 10, color: '#94A3B8', marginTop: 2 }}>Limit: {m.threshold ?? 0}%</div>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.intelRow}>
              <div className={styles.intelBox} style={{ background: '#F0FDF4', borderColor: '#BBF7D0' }}>
                <div className={styles.boxLabel}>Overall Risk</div>
                <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6, color: '#15803D' }}>Clear</div>
                <div style={{ fontSize: 11, color: '#64748B', marginTop: 2 }}>No active risk breaches</div>
              </div>
              <div className={styles.intelBox}>
                <div className={styles.boxLabel}>Active Alerts</div>
                <div style={{ fontSize: 22, fontWeight: 800, marginTop: 6, color: breaches.length > 0 ? '#D97706' : '#15803D' }}>{breaches.length}</div>
              </div>
            </div>
          )}
        </section>

        {/* ════════════════════════════════════════════════════════
            SECTION 3: RECENT DECISIONS — Primary actionable items
            PRD: "Decisions are primary actionable items"
            ════════════════════════════════════════════════════════ */}
        {(() => {
          // Spec §8 — surface the snapshot timestamp + closed-market
          // context so a row from 24 Apr doesn't look like a fresh
          // decision when the user is viewing on 02 May.
          const newestDecisionAt = decisions
            .map(d => new Date(d.createdAt).getTime())
            .filter(t => Number.isFinite(t))
            .reduce((m, t) => (t > m ? t : m), 0);
          const decisionAgeDays = newestDecisionAt
            ? Math.floor((Date.now() - newestDecisionAt) / 86_400_000) : null;
          const decisionsStale = decisionAgeDays != null && decisionAgeDays >= 2;
          const newestDecisionLabel = newestDecisionAt
            ? new Date(newestDecisionAt).toLocaleString('en-IN', {
                day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
              })
            : null;
          return (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <Gavel size={14} />
            <span>Recent Decisions</span>
            {decisionsStale && (
              <span style={{
                marginLeft: 8, padding: '1px 8px', borderRadius: 99,
                // Saturated amber + white text for legibility.
                //
                // The three -webkit overrides + backgroundImage:'none'
                // are NECESSARY because the
                //   `.sectionHead span { @include gradient-text }`
                // rule in dashboard.module.scss applies a gradient
                // fill via `-webkit-text-fill-color: transparent` to
                // every span descendant of the section header. Inline
                // `color` alone does NOT override that fill — the
                // pill rendered with invisible text until these were
                // added. backgroundImage:'none' clears the inherited
                // gradient so the amber background is visible.
                // Yellow background with white text. The four WebKit
                // overrides are still required to defeat the
                // .sectionHead gradient-text mixin — without them,
                // inline `color` is overridden by
                // `-webkit-text-fill-color: transparent` from the
                // mixin and the text renders invisible.
                // Slate-700 pill with white text — professional
                // institutional look, ~12:1 contrast (passes WCAG
                // AAA). Neutral palette doesn't fight the dashboard's
                // cyan accent. The WebKit overrides defeat the
                // .sectionHead gradient-text mixin which would
                // otherwise make inline `color` transparent.
                background: '#334155', color: '#FFFFFF',
                backgroundImage: 'none',
                WebkitTextFillColor: '#FFFFFF',
                WebkitBackgroundClip: 'border-box',
                backgroundClip: 'border-box',
                fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                border: '1px solid #475569',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                {/* Lucide icons accept `color` directly which sets
                    stroke on the SVG. That bypasses the .sectionHead
                    gradient-text mixin (which only affects -webkit-
                    text-fill-color on text), so the icon renders
                    crisp white regardless of the parent's text fill. */}
                <Clock size={10} color="#FFFFFF" /> Last Snapshot
              </span>
            )}
            {newestDecisionLabel && (
              <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 400, marginLeft: 8 }}>
                Latest: {newestDecisionLabel}
                {decisionAgeDays != null && decisionAgeDays > 0 ? ` · ${decisionAgeDays}d ago` : ''}
              </span>
            )}
            {marketStatus?.isOpen === false && decisions.length > 0 && (
              <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 400, marginLeft: 'auto' }}>
                No fresh decisions until next session opens
              </span>
            )}
          </div>
          {decisions.length > 0 ? (
            <Card>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#F8FAFC' }}>
                    {['DECISION ID', 'TICKER', 'VERDICT', 'FIT', 'RISK', 'TIME'].map(h => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: h === 'DECISION ID' || h === 'TICKER' ? 'left' : 'right', fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {decisions.slice(0, 8).map(d => {
                    const dec = d.decision ?? '';
                    const isApproved = dec === 'approved' || dec === 'approved_with_conditions';
                    const isRejected = dec.startsWith('rejected');
                    const isReview = dec === 'manual_review';
                    const verdictColor = isApproved ? '#15803D' : isRejected ? '#DC2626' : '#D97706';
                    const verdictBg = isApproved ? '#DCFCE7' : isRejected ? '#FEE2E2' : '#FEF3C7';
                    return (
                      <tr key={d.decisionId} style={{ borderTop: '1px solid #F8FAFC' }}>
                        <td style={{ padding: '8px 12px', fontSize: 11, fontFamily: 'monospace', color: '#64748B' }}>{d.decisionId}</td>
                        <td style={{ padding: '8px 12px', fontWeight: 700, fontSize: 13 }}>{d.ticker}</td>
                        <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                          <span style={{ background: verdictBg, color: verdictColor, fontWeight: 800, fontSize: 10, padding: '3px 10px', borderRadius: 99 }}>
                            {dec.replace(/_/g, ' ').toUpperCase()}
                          </span>
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontSize: 12, fontWeight: 600, color: (d.fitScore ?? 0) >= 60 ? '#15803D' : (d.fitScore ?? 0) >= 30 ? '#D97706' : '#DC2626' }}>
                          {d.fitScore != null ? `${d.fitScore}/100` : '—'}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontSize: 12, fontWeight: 600, color: (d.riskScore ?? 0) > 50 ? '#DC2626' : (d.riskScore ?? 0) > 25 ? '#D97706' : '#15803D' }}>
                          {d.riskScore != null ? `${d.riskScore}/100` : '—'}
                        </td>
                        <td style={{ padding: '8px 12px', textAlign: 'right', fontSize: 11, color: '#94A3B8' }}>
                          {new Date(d.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          ) : (
            <Card>
              <div style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>
                <Gavel size={20} style={{ marginBottom: 6, opacity: 0.5 }} />
                {/*
                  Tailor the empty-state copy to the actual blocker so the
                  user knows what to do, instead of a generic "no decisions
                  yet" line that leaves them stuck. Three states:
                    1. No portfolio   → ask them to create one
                    2. No opportunities → ask them to recompute signals
                    3. Both present, just nothing evaluated yet → ask them
                       to click Evaluate
                */}
                {/* Closed-market evaluation must be presented as
                    last-close work, not live trade decisions. The
                    button label and helper copy flip when
                    marketStatus.isOpen === false so the operator
                    can never confuse a Saturday gate-chain run with
                    an intraday execution decision. */}
                {(() => {
                  const isClosed = marketStatus != null && marketStatus.isOpen === false;
                  return (
                <>
                {!portfolio ? (
                  <div>
                    No decisions yet — you don&apos;t have a portfolio. The gate chain needs your book to size and risk-check each trade.
                    {' '}<a href="/portfolio" style={{ color: '#3B82F6' }}>Create a portfolio</a> to enable evaluation.
                  </div>
                ) : !opps.length ? (
                  <div>
                    No decisions yet — there are no opportunities to evaluate. Generate signals first from <a href="/admin" style={{ color: '#3B82F6' }}>Admin → Recompute Signals</a>.
                  </div>
                ) : isClosed ? (
                  <div>
                    No fresh decisions in the current market-closed session.
                    You can evaluate last-close candidates, but these
                    should not be treated as live trade decisions.
                  </div>
                ) : (
                  <div>
                    No decisions yet. Click <strong>Evaluate</strong> below to run your top opportunities through the gate chain.
                  </div>
                )}
                <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                  {/*
                    Evaluation calls POST /api/opportunities/evaluate which
                    requires a portfolio (the gate chain prices each trade
                    against your book). When the user has no portfolio yet
                    the click would always 400 with "No portfolio found";
                    surface that as a clear empty-state instead of a button
                    that errors on every press.
                  */}
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={evaluateTopOpportunities}
                    disabled={evalRunning || !opps.length || !portfolio}
                    title={isClosed
                      ? 'Runs the gate chain on last-close candidates. Output is not a live trade decision.'
                      : 'Runs the gate chain on the current top opportunities.'}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    {evalRunning ? <RefreshCw size={13} className={styles.spin} /> : <Play size={13} />}
                    {evalRunning
                      ? 'Evaluating…'
                      : isClosed
                        ? 'Evaluate Last-Close Candidates'
                        : `Evaluate ${opps.length || ''} top opportunit${opps.length === 1 ? 'y' : 'ies'}`}
                  </button>
                  {isClosed && opps.length > 0 && portfolio && (
                    <div style={{ fontSize: 11, color: '#92400E' }}>
                      Off-hours evaluation uses last-close prices — output is reference, not execution.
                    </div>
                  )}
                  {!opps.length && (
                    <div style={{ fontSize: 11, color: '#94A3B8' }}>Generate signals first from Admin → Recompute Signals.</div>
                  )}
                  {opps.length > 0 && !portfolio && (
                    <div style={{ fontSize: 11, color: '#94A3B8' }}>
                      Create a portfolio first — the gate chain needs your book to size each trade.
                    </div>
                  )}
                  {evalError && (
                    <div style={{ fontSize: 11, color: '#DC2626' }}>{evalError}</div>
                  )}
                </div>
                </>
                  );
                })()}
              </div>
            </Card>
          )}
        </section>
        );
        })()}

        {/* ── SECTION 4: MARKET INTELLIGENCE (moved down) ──────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <BarChart2 size={14} />
            <span>Market Intelligence</span>
          </div>

          <div className={styles.intelRow}>
            {/* Trend — never permanently skeletons. Skeleton shown only
                during the very first load (loading && intel == null).
                Once intel is null *after* loading completes, an honest
                "data unavailable" fallback renders. */}
            <div className={styles.intelBox} style={{ borderColor: tm.color + '55', background: tm.bg }}>
              {loading && !intel ? <div className="skeleton" style={{ height:72 }} /> : !intel ? (
                <div style={{ fontSize:12, color:'#94A3B8', marginTop:10, textAlign:'center' }}>
                  Trend data unavailable — last close snapshot not loaded
                </div>
              ) : (<>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:4 }}>
                  <tm.Icon size={18} color={tm.color} />
                  <span style={{ fontSize:20, fontWeight:800, color:tm.color }}>{trend}</span>
                  <Badge variant={trend.includes('Bull')?'green':trend.includes('Bear')?'red':'gray'}>
                    {intel?.trendScore != null ? (intel.trendScore > 0 ? '+' : '') + intel.trendScore : '—'}
                  </Badge>
                </div>
                <TrendBar score={intel?.trendScore ?? 0} />
                <div style={{ fontSize:11, color:'#64748B', marginTop:4 }}>
                  Regime: {intel?.regime ?? '—'}
                  {marketStatus?.isOpen === false && intel?.regime && (
                    <span style={{ marginLeft: 6, color: '#92400E' }}>· last close</span>
                  )}
                </div>
              </>)}
            </div>

            {/* Breadth */}
            <div className={styles.intelBox}>
              <div className={styles.boxLabel}>Market Breadth</div>
              {loading && !intel ? <div className="skeleton" style={{ height:60 }} /> : !breadthValid ? (
                <div style={{ fontSize:12, color:'#94A3B8', marginTop:10, textAlign:'center' }}>
                  Breadth data unavailable — insufficient sample
                </div>
              ) : (<>
                <div style={{ display:'flex', alignItems:'center', gap:8, marginTop:6 }}>
                  <span style={{ color:'#16A34A', fontWeight:700 }}>▲ {validatedBreadth?.advancing ?? 0}</span>
                  <div style={{ flex:1, height:6, background:'#E2E8F0', borderRadius:99, overflow:'hidden' }}>
                    <div style={{ height:'100%', borderRadius:99, background:'linear-gradient(to right,#16A34A,#DC2626)', width:`${(validatedBreadth?.ratio ?? 0.5)*100}%` }} />
                  </div>
                  <span style={{ color:'#DC2626', fontWeight:700 }}>▼ {validatedBreadth?.declining ?? 0}</span>
                </div>
                <div style={{ fontSize:11, color:'#94A3B8', marginTop:4, textAlign:'center' }}>
                  {validatedBreadth?.unchanged ?? 0} unchanged
                  {validatedBreadth?.ratio != null && ` · ${(validatedBreadth.ratio*100).toFixed(0)}% advancing`}
                  {marketStatus?.isOpen === false && breadthValid && (
                    <span style={{ marginLeft: 6, color: '#92400E' }}>· last close</span>
                  )}
                </div>
              </>)}
            </div>

            {/* Volatility */}
            <div className={styles.intelBox}>
              <div className={styles.boxLabel}>Volatility</div>
              {loading && !intel ? <div className="skeleton" style={{ height:60 }} /> : !intel?.volatility ? (
                <div style={{ fontSize:12, color:'#94A3B8', marginTop:10, textAlign:'center' }}>
                  Volatility unavailable — cached snapshot missing
                </div>
              ) : (<>
                <div style={{ display:'flex', alignItems:'baseline', gap:8, marginTop:6 }}>
                  <span style={{ fontSize:20, fontWeight:700 }}>{intel.volatility.volatility_label ?? '—'}</span>
                  {intel.volatility.nifty_vix != null && (
                    <span style={{ fontSize:12, color:'#64748B' }}>VIX {intel.volatility.nifty_vix.toFixed(1)}</span>
                  )}
                </div>
                <div style={{ fontSize:11, color:'#64748B', marginTop:4 }}>
                  Avg range {intel.volatility.avg_range_pct != null ? `${intel.volatility.avg_range_pct.toFixed(2)}%` : '—'}
                  {marketStatus?.isOpen === false && (
                    <span style={{ marginLeft: 6, color: '#92400E' }}>· cached</span>
                  )}
                </div>
              </>)}
            </div>

            {/* FII / DII */}
            <div className={styles.intelBox}>
              <div className={styles.boxLabel}>Institutional Flow</div>
              {loading && !intel ? <div className="skeleton" style={{ height:60 }} /> : (
                intel?.fiiDii?.length ? (<>
                  <div style={{ fontSize:13, fontWeight:700, color: intel.fiiDii[0].fii_net > 0 ? '#16A34A' : '#DC2626', marginTop:6 }}>
                    {intel.fiiDii[0].fii_label || `FII ${intel.fiiDii[0].fii_net > 0 ? '+' : ''}${fmt.number(intel.fiiDii[0].fii_net)} Cr`}
                  </div>
                  <div style={{ fontSize:12, color: '#64748B', marginTop:3 }}>
                    {intel.fiiDii[0].dii_label || `DII ${intel.fiiDii[0].dii_net > 0 ? '+' : ''}${fmt.number(intel.fiiDii[0].dii_net)} Cr`}
                  </div>
                  {intel.fiiDii[0].date && (
                    <div style={{ fontSize: 10, color: '#94A3B8', marginTop: 3 }}>
                      As of: {new Date(intel.fiiDii[0].date).toLocaleDateString('en-IN', { day:'2-digit', month:'short' })}
                      {marketStatus?.isOpen === false && ' · last close'}
                    </div>
                  )}
                </>) : <div style={{ color:'#94A3B8', fontSize:12, marginTop:8 }}>FII/DII data unavailable</div>
              )}
            </div>
          </div>

          {/* Sector chips */}
          <div className={styles.sectorGrid}>
            {(intel?.sectorStrength ?? []).map(s => (
              <div key={s.sector} className={styles.sectorChip}
                style={{ background: s.change_percent > 0 ? '#F0FDF4' : s.change_percent < 0 ? '#FFF1F2' : '#F8FAFC',
                         borderColor: s.change_percent > 0 ? '#BBF7D0' : s.change_percent < 0 ? '#FECACA' : '#E2E8F0' }}>
                <div className="sc-name" style={{ fontSize:10, color:'#64748B' }}>{s.sector}</div>
                <div style={{ fontSize:13, fontWeight:700, color: s.change_percent > 0 ? '#15803D' : s.change_percent < 0 ? '#DC2626' : '#64748B' }}>
                  {s.change_percent > 0 ? '+' : ''}{s.change_percent.toFixed(1)}%
                </div>
              </div>
            ))}
          </div>

          {/* Gainers / Losers — using validated data (losers guaranteed
              negative). Off-hours the title flips to "Last Close Top
              Gainers/Losers" so the badge can never imply intraday
              movement. When derived from rankings (because the
              market-intelligence top-movers table was empty), we show a
              "from rankings" tag so operators know the source.
              Title flip uses an explicit closed-market guard rather
              than the bare `=== false` check so the prefix appears for
              any non-live state (weekend, post_close, pre_open,
              holiday) — the "Last Close Top Losers" header was
              previously absent during the brief loading window where
              marketStatus is still null. */}
          {(() => {
            const isClosedKnown = marketStatus != null && marketStatus.isOpen !== true;
            return (
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:4 }}>
            {([
              { key: 'gainers' as const, label: isClosedKnown ? 'Last Close Top Gainers' : 'Top Gainers', data: validatedGainers, fromRankings: gainersFromRankings },
              { key: 'losers'  as const, label: isClosedKnown ? 'Last Close Top Losers'  : 'Top Losers',  data: validatedLosers,  fromRankings: losersFromRankings  },
            ]).map(({ key, label, data, fromRankings }) => (
              <Card key={key}>
                <div style={{ padding:'12px 16px', borderBottom:'1px solid #F1F5F9', display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
                  <span style={{ fontWeight:700, fontSize:13 }}>{label}</span>
                  {fromRankings && (
                    <span style={{
                      fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:99,
                      background:'#DBEAFE', color:'#1D4ED8', letterSpacing:0.3,
                    }}>
                      derived from rankings
                    </span>
                  )}
                  {marketStatus?.isOpen === false && data.length > 0 && (
                    <span style={{
                      fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:99,
                      background:'#334155', color:'#FFFFFF', letterSpacing:0.3,
                      border:'1px solid #475569',
                      display:'inline-flex', alignItems:'center', gap:3,
                    }}>
                      <Clock size={9} color="#FFFFFF" /> Last Close
                    </span>
                  )}
                </div>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead>
                    <tr style={{ background:'#F8FAFC' }}>
                      <th style={{ padding:'6px 12px', textAlign:'left', fontSize:10, color:'#94A3B8', fontWeight:700 }}>SYMBOL</th>
                      <th style={{ padding:'6px 12px', textAlign:'right', fontSize:10, color:'#94A3B8', fontWeight:700 }}>
                        {marketStatus?.isOpen === false ? 'LAST LTP' : 'LTP'}
                      </th>
                      <th style={{ padding:'6px 12px', textAlign:'right', fontSize:10, color:'#94A3B8', fontWeight:700 }}>CHG%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.slice(0,5).map(m => {
                      const ltp = Number(m.ltp);
                      const pct = Number(m.change_percent);
                      return (
                      <tr key={m.symbol} style={{ borderTop:'1px solid #F8FAFC' }}>
                        <td style={{ padding:'7px 12px', fontWeight:600, fontSize:12 }}>{m.symbol}</td>
                        <td style={{ padding:'7px 12px', textAlign:'right', fontSize:12, fontVariantNumeric:'tabular-nums' }}>
                          {Number.isFinite(ltp) && ltp > 0 ? fmt.currency(ltp) : '—'}
                        </td>
                        <td style={{ padding:'7px 12px', textAlign:'right', fontWeight:700, fontSize:12, color: pct >= 0 ? '#16A34A' : '#DC2626' }}>
                          {Number.isFinite(pct) ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}
                        </td>
                      </tr>
                    );
                    })}
                    {data.length === 0 && (
                      <tr><td colSpan={3} style={{ padding:16, textAlign:'center', color:'#94A3B8', fontSize:11 }}>
                        {isClosedKnown
                          ? `Last close ${key === 'gainers' ? 'gainers' : 'losers'} unavailable — refreshes after the next session close (Admin → Sync Rankings to retry now)`
                          : `No ${key === 'gainers' ? 'gaining' : 'declining'} stocks in current data`}
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </Card>
            ))}
          </div>
            );
          })()}
        </section>

        {/* ── SECTION 2: RANKINGS ───────────────────────────────── */}
        {(() => {
          // Adaptive heading based on the strongest visible
          // opportunity_rank. Without this, a section titled "Top
          // Rankings" would happily display rows with rank=57 as if
          // they were premium opportunities — operators correctly
          // flagged that this misrepresents weak setups as strong
          // ones. Three tiers, mirroring the rankings page bucketing:
          //   ≥ 75 → High-Conviction Rankings (real institutional setups)
          //   60–74 → Actionable Watchlist Rankings (needs confirmation)
          //   < 60 → Best Available — explicit "no high-conviction
          //          setups available" copy so the user understands
          //          why rank-57 is still on screen.
          const topOppRank = sortedRankings.length > 0
            ? Number(sortedRankings[0].opportunity_rank ?? sortedRankings[0].score ?? 0)
            : 0;
          const rankingTier: 'high' | 'actionable' | 'best_available' =
              topOppRank >= 75 ? 'high'
            : topOppRank >= 60 ? 'actionable'
            : 'best_available';
          const rankingTitle =
              rankingTier === 'high'           ? 'High-Conviction Rankings'
            : rankingTier === 'actionable'     ? 'Actionable Watchlist Rankings'
            : 'Best Available Rankings — No High-Conviction Setups';
          // Subtitle policy (item 4 polish):
          //   The detailed "below 60 threshold / not a buy list /
          //   universe state" explanation lives in the yellow banner
          //   rendered under the header for the best_available tier.
          //   Repeating it in the grey subtitle was visual duplication
          //   and crowded the row. The grey subtitle now stays a
          //   single short caption ("Sorted by Opportunity Rank")
          //   regardless of tier; the tier-specific copy lives in the
          //   amber banner so users read it once, in the right place.
          const rankingSubtitle = 'Sorted by Opportunity Rank';
          return (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <TrendingUp size={14} />
            <span>{rankingTitle}</span>
            {/* Spec §2 — data-source label. Shows for ANY closed-market
                source (last_rankings_db OR cached_rankings OR
                eod_snapshot) so the badge can never appear empty.
                Live runs stay un-cluttered. */}
            {rankingsDataSource && rankingsDataSource !== 'live_feed' && (
              <span style={{
                marginLeft: 8, padding: '1px 8px', borderRadius: 99,
                // Saturated amber + white text for legibility.
                //
                // The three -webkit overrides + backgroundImage:'none'
                // are NECESSARY because the
                //   `.sectionHead span { @include gradient-text }`
                // rule in dashboard.module.scss applies a gradient
                // fill via `-webkit-text-fill-color: transparent` to
                // every span descendant of the section header. Inline
                // `color` alone does NOT override that fill — the
                // pill rendered with invisible text until these were
                // added. backgroundImage:'none' clears the inherited
                // gradient so the amber background is visible.
                // Yellow background with white text. The four WebKit
                // overrides are still required to defeat the
                // .sectionHead gradient-text mixin — without them,
                // inline `color` is overridden by
                // `-webkit-text-fill-color: transparent` from the
                // mixin and the text renders invisible.
                // Slate-700 pill with white text — professional
                // institutional look, ~12:1 contrast (passes WCAG
                // AAA). Neutral palette doesn't fight the dashboard's
                // cyan accent. The WebKit overrides defeat the
                // .sectionHead gradient-text mixin which would
                // otherwise make inline `color` transparent.
                background: '#334155', color: '#FFFFFF',
                backgroundImage: 'none',
                WebkitTextFillColor: '#FFFFFF',
                WebkitBackgroundClip: 'border-box',
                backgroundClip: 'border-box',
                fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                border: '1px solid #475569',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <Database size={10} color="#FFFFFF" />
                {rankingsDataSource === 'cached_rankings' ? 'Cached'
                 : rankingsDataSource === 'eod_snapshot'  ? 'EOD Snapshot'
                 : 'Last Close'}
              </span>
            )}
            <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 400, marginLeft: 8 }}>
              {rankingSubtitle}
            </span>
          </div>

          {/* Best-available banner. Surfaces the truth that no row in
              this universe currently meets the high-conviction bar so
              the operator interprets the table correctly: "see what's
              the strongest" not "buy these." */}
          {rankingTier === 'best_available' && (
            <div style={{
              background: '#FEF3C7', border: '1px solid #FDE68A',
              borderLeft: '3px solid #B45309',
              borderRadius: 8, padding: '8px 14px', marginBottom: 12,
              display: 'flex', alignItems: 'flex-start', gap: 10,
              fontSize: 11, color: '#78350F',
            }}>
              <AlertTriangle size={14} color="#B45309" style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                <strong style={{ color: '#92400E' }}>No High-Conviction Rankings Available — </strong>
                Showing best available {marketStatus?.isOpen === false ? 'last-close ' : ''}candidates.
                Top opportunity rank is {topOppRank.toFixed(0)} (high-conviction threshold is 75).
                Treat as universe scan, not a buy list.
              </span>
             </div>
          )}
          <Card>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr style={{ background:'#F8FAFC' }}>
                  {/* SCORE column was renamed to RANK because /api/rankings
                      sorts by opportunity_rank, not score. Showing "SCORE"
                      next to a rank-ordered list let a 75.3 row appear
                      below a 73.7 row (the screenshot bug). Q365 score
                      stays as a secondary column for transparency. */}
                  {['#','SYMBOL','RANK','Q365','LTP','CHANGE','SIGNAL','CONVICTION','CONF'].map(h => (
                    <th key={h} style={{ padding:'8px 12px', textAlign: h==='#'||h==='SYMBOL'?'left':'right', fontSize:10, color:'#94A3B8', fontWeight:700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Top 10 only — we fetch 200 rows so the gainers/losers
                    fallback below has enough decliners to choose from
                    even on strongly bullish days, but the Top Rankings
                    panel itself stays compact.
                    Uses sortedRankings (client-side defensive sort) so
                    the visible "RANK" column can never disagree with
                    the row order, even if the API regresses. */}
                {sortedRankings.slice(0, 10).map((r, i) => {
                  const opp = r.opportunity_rank ?? r.score;
                  const sc  = Number(r.score);
                  const ltp = Number(r.ltp);
                  const pct = Number(r.pct_change);
                  const oppDisplay = Number.isFinite(opp) ? Number(opp).toFixed(0) : '—';
                  const scDisplay  = Number.isFinite(sc)  ? sc.toFixed(1) : '—';
                  // Below action threshold: opportunity_rank < 60.
                  // Mirrors the tier ladder above — these rows lose
                  // their BUY/SELL pill (replaced with neutral
                  // "Model Bias: …" label) and gain a "Universe Scan"
                  // tag so they are not mistaken for trade calls.
                  // Rows with no rank at all are conservative-treated
                  // as below threshold.
                  const oppNum = Number(opp);
                  const belowThreshold = !Number.isFinite(oppNum) || oppNum < 60;
                  return (
                  <tr
                    key={r.symbol}
                    style={{
                      borderTop: '1px solid #F8FAFC',
                      // Subtle muted background for sub-threshold
                      // rows so the eye groups them as "for context"
                      // rather than reading them at the same weight
                      // as actionable rows.
                      background: belowThreshold ? '#FAFAFA' : undefined,
                    }}
                  >
                    <td style={{ padding:'8px 12px', color:'#CBD5E1', fontSize:12 }}>{r.rank_position ?? i+1}</td>
                    <td style={{ padding:'8px 12px' }}>
                      <div style={{ display:'flex', alignItems:'center', gap:4, flexWrap:'wrap' }}>
                        <span style={{ fontWeight:700, fontSize:13 }}>{r.symbol}</span>
                        {belowThreshold && <BelowThresholdBadge />}
                      </div>
                      <div style={{ fontSize:10, color:'#94A3B8' }}>{r.exchange}</div>
                    </td>
                    <td style={{
                      padding:'8px 12px', textAlign:'right', fontWeight:700, fontSize:13,
                      // Sub-threshold ranks render in muted slate so a
                      // bold black "57" doesn't visually outweigh a
                      // legitimate "82".
                      color: belowThreshold ? '#94A3B8' : '#0F172A',
                    }}>
                      {oppDisplay}
                    </td>
                    <td style={{ padding:'8px 12px', textAlign:'right', fontSize:11, color:'#64748B' }}>{scDisplay}</td>
                    <td style={{ padding:'8px 12px', textAlign:'right', fontSize:12, fontVariantNumeric:'tabular-nums' }}>
                      {Number.isFinite(ltp) && ltp > 0 ? fmt.currency(ltp) : '—'}
                    </td>
                    <td style={{ padding:'8px 12px', textAlign:'right', fontWeight:700, fontSize:12, color: pct >= 0 ? '#16A34A' : '#DC2626' }}>
                      {Number.isFinite(pct) ? `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%` : '—'}
                    </td>
                    <td style={{ padding:'8px 12px', textAlign:'right' }}>
                      {/* SignalPill (green BUY / red SELL) only for
                          rows that meet the action threshold; sub-
                          threshold rows get the neutral ModelBiasPill
                          so the dashboard cannot present a 57-rank
                          row as if it were a real BUY call. */}
                      {belowThreshold
                        ? <ModelBiasPill type={r.signal_type} />
                        : <SignalPill type={r.signal_type} />}
                    </td>
                    <td style={{ padding:'8px 12px', textAlign:'right' }}>
                      {/* Conviction badge is meaningful only on action-
                          tier rows; the sub-threshold rows show a "—"
                          dash so the column doesn't accidentally claim
                          high/medium conviction for a row the model
                          itself rated below the action threshold. */}
                      {belowThreshold
                        ? <span style={{ color:'#CBD5E1', fontSize:11 }}>—</span>
                        : <ConvictionBadge band={r.conviction_band} />}
                    </td>
                    <td style={{ padding:'8px 12px', textAlign:'right' }}><ConfBar val={r.confidence_score ?? r.confidence} /></td>
                  </tr>
                  );
                })}
                {!rankings.length && !loading && (
                  <tr><td colSpan={9} style={{ padding:24, textAlign:'center', color:'#94A3B8', fontSize:12 }}>
                    No ranked instruments. Run Admin → Data → Sync Rankings.
                  </td></tr>
                )}
              </tbody>
            </table>
          </Card>
        </section>
        );
        })()}

        {/* ── SECTION: CONVICTION DISTRIBUTION ──────────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <Target size={14} />
            <span>Conviction Distribution</span>
          </div>
          <ConvictionDistribution
            signals={[
              ...rankings.map(r => ({
                conviction_band: r.conviction_band,
                confidence_score: r.confidence_score ?? r.confidence,
              })),
              ...opps.map(o => ({
                conviction_band: o.conviction_band,
                confidence_score: o.confidence,
              })),
            ]}
            loading={loading}
            totalScanned={intel ? 50 : undefined}
          />
        </section>

        {/* ── SIGNALS & OPPORTUNITIES (secondary) ────────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <Zap size={14} />
            <span>Signals & Opportunities</span>
            {/* Spec §6 — when /api/signals returns mode:'market_closed'
                we keep the panel rendered (operators want to review
                last-close setups) but the badge surfaces the staleness. */}
            {signalsClosedMode && (
              <span style={{
                marginLeft: 8, padding: '1px 8px', borderRadius: 99,
                // Saturated amber + white text for legibility.
                //
                // The four overrides below (backgroundImage,
                // WebkitTextFillColor, WebkitBackgroundClip,
                // backgroundClip) defeat the
                //   `.sectionHead span { @include gradient-text }`
                // rule in dashboard.module.scss, which applies a
                // gradient via `-webkit-text-fill-color: transparent`
                // to every span descendant of a section header.
                // Without these, the white text rendered as fully
                // transparent against the amber background — the
                // exact "text not showing" symptom reported.
                // Yellow background with white text. The four WebKit
                // overrides are still required to defeat the
                // .sectionHead gradient-text mixin — without them,
                // inline `color` is overridden by
                // `-webkit-text-fill-color: transparent` from the
                // mixin and the text renders invisible.
                // Slate-700 pill with white text — professional
                // institutional look, ~12:1 contrast (passes WCAG
                // AAA). Neutral palette doesn't fight the dashboard's
                // cyan accent. The WebKit overrides defeat the
                // .sectionHead gradient-text mixin which would
                // otherwise make inline `color` transparent.
                background: '#334155', color: '#FFFFFF',
                backgroundImage: 'none',
                WebkitTextFillColor: '#FFFFFF',
                WebkitBackgroundClip: 'border-box',
                backgroundClip: 'border-box',
                fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                border: '1px solid #475569',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <Archive size={10} color="#FFFFFF" /> Last Close Signals
              </span>
            )}
            <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 400, marginLeft: 8 }}>
              Signal ≠ permission · every opportunity must pass through the decision gate chain
            </span>
          </div>
          {/* Compact dashboard preview — only top 3 trade-ready signals
              render here. The full per-card detail (chart, narrative,
              decision trace) lives on /signals so the dashboard stays
              a glanceable intelligence summary instead of a
              scroll-forever feed. Operators correctly reported the
              previous full-card 6-up grid pushed the rest of the
              dashboard far below the fold.

              Spec NO-TRADE-PRECEDENCE §8 — main panel shows ONLY
              `is_trade_ready === true`. Everything else (early
              candidates, no-trade rows, expired) routes to the
              compact "Early Scanner Candidates" strip below the
              empty-state, never to the main BUY/SELL grid. */}
          {(() => {
            // Defensive default: rows that pre-date the source-visibility
            // envelope (e.g. /api/opportunities/evaluate payloads) carry
            // no `is_trade_ready` flag. Treat them as trade-ready when
            // we have no information either way — same as before this
            // change. The new envelope flips the gate strict for any
            // row that does carry the flag.
            const tradeReady = opps.filter(o =>
              o.is_trade_ready !== false &&
              o.effective_signal_status !== 'NO_TRADE' &&
              o.is_stale_candidate !== true,
            );
            const earlyCandidates = opps.filter(o => !tradeReady.includes(o));
            return (
              <>
          <div className={styles.grid3}>
            {tradeReady.slice(0, 3).map(o => {
              const isBuy = o.direction === 'BUY';
              const accentColor = isBuy ? '#15803D' : '#DC2626';
              const conf = Number(o.confidence) || 0;
              return (
                <div
                  key={o.tradingsymbol}
                  className={styles.oppRowCompact}
                  style={{ borderLeftColor: accentColor }}
                >
                  {/* Symbol + exchange */}
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 800, fontSize: 13, color: '#0F172A' }}>{o.tradingsymbol}</div>
                    <div style={{ fontSize: 10, color: '#94A3B8' }}>{o.exchange}</div>
                  </div>

                  {/* Direction pill */}
                  <span style={{
                    background: isBuy ? '#DCFCE7' : '#FEE2E2',
                    color: accentColor, fontWeight: 800, fontSize: 11,
                    padding: '2px 10px', borderRadius: 99, textAlign: 'center',
                  }}>
                    {o.direction}
                  </span>

                  {/* Confidence */}
                  <div>
                    <div style={{ fontSize: 9, color: '#94A3B8', fontWeight: 700, letterSpacing: 0.3 }}>CONF</div>
                    <div style={{
                      fontSize: 12, fontWeight: 700,
                      color: conf >= 75 ? '#065F46' : conf >= 60 ? '#1D4ED8' : '#D97706',
                    }}>{conf}%</div>
                  </div>

                  {/* Entry / SL / Target — compact stats */}
                  {[
                    ['Entry',  o.entry_price, '#1E3A5F'],
                    ['SL',     o.stop_loss,   '#DC2626'],
                    ['Target', o.target1,     '#15803D'],
                  ].map(([l, v, c]) => (
                    <div key={String(l)}>
                      <div style={{ fontSize: 9, color: '#94A3B8', fontWeight: 700, letterSpacing: 0.3 }}>{l}</div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: c as string }}>
                        {v ? fmt.currency(v as number) : '—'}
                      </div>
                    </div>
                  ))}

                  {/* R:R */}
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 9, color: '#94A3B8', fontWeight: 700, letterSpacing: 0.3 }}>R:R</div>
                    <div style={{ fontSize: 12, fontWeight: 700, color: '#1E3A5F' }}>
                      {o.risk_reward ? Number(o.risk_reward).toFixed(2) : '—'}
                    </div>
                  </div>

                  {/* Closed-market badge — small, right-aligned, never
                      visually competes with a live actionable badge.
                      Spec UI §7: when the row is an early-tier scanner
                      candidate (cycles < 3 OR source_kind tag), render
                      the explicit "Early Scanner Candidate · Cycle N ·
                      Not Confirmed · Last Close" badge with a hover
                      tooltip instead of the bare "Last Close" pill, so
                      operators never read a single-detection scanner row
                      as a confirmed trade. */}
                  {signalsClosedMode ? (() => {
                    const cycles = Number(o.validation_cycles_passed ?? 0);
                    const isEarly =
                      o.is_relaxed === true ||
                      o.source_kind === 'q365_signals_early' ||
                      (Number.isFinite(cycles) && cycles < 3);
                    if (isEarly) {
                      const cyclesLabel = Number.isFinite(cycles) && cycles > 0
                        ? `Cycle ${cycles}` : 'Cycle ?';
                      const tooltip =
                        `This signal has passed only ${Number.isFinite(cycles) ? cycles : 0} validation cycle(s). ` +
                        'It needs repeated detection across at least 3 cycles before it becomes a confirmed trade signal.';
                      return (
                        <span title={tooltip} style={{
                          background: '#FEF3C7', color: '#92400E',
                          fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
                          padding: '2px 8px', borderRadius: 99,
                          border: '1px solid #FDE68A',
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          whiteSpace: 'nowrap',
                          cursor: 'help',
                        }}>
                          <AlertTriangle size={9} color="#92400E" />
                          Early Scanner Candidate · {cyclesLabel} · Not Confirmed · Last Close
                        </span>
                      );
                    }
                    return (
                      <span style={{
                        background: '#334155', color: '#FFFFFF',
                        fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
                        padding: '2px 8px', borderRadius: 99,
                        border: '1px solid #475569',
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        whiteSpace: 'nowrap',
                      }}>
                        <AlertTriangle size={9} color="#FFFFFF" /> Last Close
                      </span>
                    );
                  })() : (
                    o.conviction_band && <ConvictionBadge band={o.conviction_band} />
                  )}
                </div>
              );
            })}
            {!tradeReady.length && !loading && (
              <div style={{ textAlign: 'center', padding: 24, color: '#94A3B8', fontSize: 12 }}>
                {signalsClosedMode
                  ? 'No confirmed last-close opportunities.'
                  : 'No confirmed opportunities. Run Admin → Recompute Signals.'}
              </div>
            )}
          </div>

          {/* Early Scanner Candidates strip — Spec UI §8. Renders only
              when the main trade-ready grid is empty (or limited) AND
              there are non-trade-ready candidates the operator should
              still see for situational awareness. Each row is clearly
              labeled (cycle count, no-trade, last close) and never
              styled like a confirmed opportunity. */}
          {earlyCandidates.length > 0 && (
            <div style={{ marginTop: 12, paddingTop: 8, borderTop: '1px dashed #E2E8F0' }}>
              <div style={{
                fontSize: 11, fontWeight: 700, color: '#64748B',
                letterSpacing: 0.3, marginBottom: 6,
              }}>
                EARLY SCANNER CANDIDATES — {earlyCandidates.length} row{earlyCandidates.length === 1 ? '' : 's'}
                <span style={{ marginLeft: 6, fontWeight: 400 }}>
                  · informational only · not confirmed trade signals
                </span>
              </div>
              <div className={styles.grid3}>
                {earlyCandidates.slice(0, 3).map(o => {
                  const cycles  = Number(o.validation_cycles_passed ?? 0);
                  const isNoTrade = o.effective_signal_status === 'NO_TRADE'
                                  || o.raw_classification === 'NO_TRADE'
                                  || o.display_bucket === 'no_trade';
                  const cyclesLabel = Number.isFinite(cycles) && cycles > 0
                    ? `Cycle ${cycles}` : 'Cycle ?';
                  const tooltip = isNoTrade
                    ? `Engine classified this row as NO_TRADE. ${cyclesLabel}. Source: ${o.source_table ?? 'q365_signals'}.`
                    : `${cyclesLabel}. Detected once or not yet matured. It needs repeated detection across at least 3 cycles before it becomes a confirmed trade signal.`;
                  return (
                    <div key={`early-${o.tradingsymbol}-${o.direction}`}
                         className={styles.oppRowCompact}
                         style={{ borderLeftColor: '#92400E', opacity: 0.95 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 800, fontSize: 13, color: '#0F172A' }}>{o.tradingsymbol}</div>
                        <div style={{ fontSize: 10, color: '#94A3B8' }}>{o.exchange}</div>
                      </div>
                      {/* Neutral "Model Bias" label per spec §3 — never the aggressive BUY/SELL pill. */}
                      <span style={{
                        background: '#F1F5F9', color: '#475569',
                        fontWeight: 700, fontSize: 10, letterSpacing: 0.3,
                        padding: '2px 8px', borderRadius: 99, whiteSpace: 'nowrap',
                      }}>
                        Model Bias: {o.direction === 'BUY' ? 'Buy' : 'Sell'}
                      </span>
                      <span title={tooltip} style={{
                        background: isNoTrade ? '#FEE2E2' : '#FEF3C7',
                        color:      isNoTrade ? '#991B1B' : '#92400E',
                        fontSize: 9, fontWeight: 700, letterSpacing: 0.3,
                        padding: '2px 8px', borderRadius: 99,
                        border: `1px solid ${isNoTrade ? '#FECACA' : '#FDE68A'}`,
                        display: 'inline-flex', alignItems: 'center', gap: 4,
                        whiteSpace: 'nowrap', cursor: 'help',
                      }}>
                        <AlertTriangle size={9} />
                        {isNoTrade
                          ? `No Trade · ${cyclesLabel} · Last Close`
                          : `${cyclesLabel} · Not Confirmed · Last Close`}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* View-all link — operators jump to /signals for the full
              detailed cards (chart, narrative, decision trace). The
              dashboard preview is intentionally only the top 3 so the
              rest of the institutional intelligence stays above the
              fold. The +N affordance surfaces how many additional
              signals are available without rendering them. */}
          {opps.length > 0 && (
            <a href="/signals" className={styles.viewAllLink}>
              View all signals
              {opps.length > 3 && (
                <span style={{
                  background: '#DBEAFE', color: '#1D4ED8',
                  fontSize: 10, fontWeight: 700,
                  padding: '1px 8px', borderRadius: 99,
                }}>
                  +{opps.length - 3} more
                </span>
              )}
              <ArrowUpRight size={12} />
            </a>
          )}
              </>
            );
          })()}
        </section>

        {/* ── SECTION: MANIPULATION DETECTION ───────────────── */}
        {(() => {
          // Spec §7 — surface an as-of timestamp + historical badge
          // when the most recent alert is more than ~3 days old. Without
          // this, a row with detectedAt=26/04/2026 looks current on
          // 02/05/2026.
          const newestAt = mdAlerts
            .map((a: any) => new Date(a.detectedAt ?? a.detected_at).getTime())
            .filter((t: number) => Number.isFinite(t))
            .reduce((m: number, t: number) => (t > m ? t : m), 0);
          const ageDays = newestAt ? Math.floor((Date.now() - newestAt) / 86_400_000) : null;
          const isHistorical = ageDays != null && ageDays >= 3;
          const newestLabel = newestAt
            ? new Date(newestAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
            : null;
          return (
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <ShieldAlert size={14} />
            <span>Manipulation Detection</span>
            {isHistorical && (
              <span style={{
                marginLeft: 8, padding: '1px 8px', borderRadius: 99,
                // Saturated amber/brown + white text for legibility.
                //
                // The four -webkit overrides defeat the
                //   `.sectionHead span { @include gradient-text }`
                // rule in dashboard.module.scss, which applies a
                // gradient via `-webkit-text-fill-color: transparent`
                // to every span descendant of a section header.
                // Without these, the white text rendered transparent
                // against the brown background.
                // Yellow background with white text — same styling
                // as the other section-head pills. The WebKit
                // overrides defeat the .sectionHead gradient-text
                // mixin which makes inline `color` transparent.
                // Slate-700 pill with white text — professional
                // institutional look, ~12:1 contrast (passes WCAG
                // AAA). Neutral palette doesn't fight the dashboard's
                // cyan accent. The WebKit overrides defeat the
                // .sectionHead gradient-text mixin which would
                // otherwise make inline `color` transparent.
                background: '#334155', color: '#FFFFFF',
                backgroundImage: 'none',
                WebkitTextFillColor: '#FFFFFF',
                WebkitBackgroundClip: 'border-box',
                backgroundClip: 'border-box',
                fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                border: '1px solid #475569',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}>
                <HistoryIcon size={10} color="#FFFFFF" /> Historical · Cached
              </span>
            )}
            {newestLabel && (
              <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 400, marginLeft: 8 }}>
                As of: {newestLabel}{ageDays != null && ageDays > 0 ? ` · ${ageDays}d ago` : ''}
              </span>
            )}
          </div>

          {(() => {
            // Closed-market scan wording: even though the operator
            // CAN trigger a scan, the underlying detection runs on
            // last-close ticks — so it is not a "fresh live detection."
            // The button title and helper copy flip when
            // marketStatus.isOpen === false so the operator never
            // believes a Saturday button click produced a new live
            // signal.
            const isClosed = marketStatus != null && marketStatus.isOpen === false;
            // When the market is closed OR the most recent alert is
            // ≥ 3 days old, the counts row labels itself as
            // "Historical …" so the operator cannot read a Saturday
            // dashboard's "Critical: 4" as four live critical alerts.
            // ISSUE 2 polish — keep the numbers accurate, change the
            // noun so they cannot be misread.
            const useHistoricalLabels = isClosed || isHistorical;
            const totalLabel    = useHistoricalLabels ? 'Historical Alerts'    : 'Alerts';
            const criticalLabel = useHistoricalLabels ? 'Historical Critical'  : 'Critical';
            const warningLabel  = useHistoricalLabels ? 'Historical Warnings'  : 'Warning';
            const scanTitle = isClosed
              ? 'Uses last available/cached data while market is closed.'
              : 'Runs the manipulation engine on the live universe.';
            return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
            <button
              className="btn btn--secondary btn--sm"
              onClick={runManipulationScan}
              disabled={mdScanning}
              title={scanTitle}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {mdScanning ? <RefreshCw size={13} className={styles.spin} /> : <Scan size={13} />}
              {mdScanning ? 'Scanning...' : 'Run Scan'}
            </button>
            {mdSummary && (
              <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                <span>{totalLabel}: <strong>{mdSummary.totalAlerts}</strong></span>
                {mdSummary.bySeverity?.critical > 0 && (
                  <span style={{ color: '#DC2626', fontWeight: 700 }}>{criticalLabel}: {mdSummary.bySeverity.critical}</span>
                )}
                {mdSummary.bySeverity?.warning > 0 && (
                  <span style={{ color: '#D97706', fontWeight: 700 }}>{warningLabel}: {mdSummary.bySeverity.warning}</span>
                )}
              </div>
            )}
            {isHistorical && (
              <span style={{ fontSize: 11, color: '#92400E', fontStyle: 'italic' }}>
                {isClosed
                  ? 'Historical alerts from last available scan. Fresh live detection resumes during market hours.'
                  : 'Historical alerts from last available scan — click "Run Scan" for fresh detection.'}
              </span>
            )}
          </div>
            );
          })()}

          {/* Dashboard preview is capped at top 5 — the full operational
              workspace is /manipulation. Operators reported the
              dashboard showing 10 rows pushed signals + decisions far
              below the fold. Same pattern as the Signals & Opportunities
              compact preview. */}
          {mdAlerts.length > 0 ? (
            <>
            <Card>
              <table className={styles.btTradeTable}>
                <thead>
                  <tr>
                    {['SYMBOL', 'TYPE', 'SEVERITY', 'SCORE', 'HEADLINE', 'DETECTED'].map(h => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {mdAlerts.slice(0, 5).map((a: any) => (
                    <tr key={a.alertId ?? a.alert_id}>
                      <td style={{ fontWeight: 700 }}>{a.symbol}</td>
                      <td style={{ fontSize: 11 }}>{(a.type ?? '').replace(/_/g, ' ')}</td>
                      <td>
                        <span style={{
                          background: a.severity === 'critical' ? '#FEE2E2' : a.severity === 'warning' ? '#FEF3C7' : '#F1F5F9',
                          color: a.severity === 'critical' ? '#DC2626' : a.severity === 'warning' ? '#D97706' : '#64748B',
                          fontWeight: 700, fontSize: 10, padding: '2px 8px', borderRadius: 99,
                        }}>
                          {(a.severity ?? '').toUpperCase()}
                        </span>
                      </td>
                      <td style={{ fontWeight: 700, color: a.score >= 70 ? '#DC2626' : a.score >= 45 ? '#D97706' : '#64748B' }}>
                        {a.score}
                      </td>
                      <td style={{ fontSize: 11, maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {a.headline}
                      </td>
                      <td style={{ fontSize: 11, color: '#94A3B8' }}>
                        {a.detectedAt || a.detected_at ? new Date(a.detectedAt ?? a.detected_at).toLocaleDateString('en-IN') : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            {/* "View all" affordance — same pattern + class as the
                signals preview. Routes to the canonical /manipulation
                page (the AppShell sidebar labels it "Manipulation
                Watch"; the URL stayed as /manipulation when the
                feature was renamed). */}
            <a href="/manipulation" className={styles.viewAllLink}>
              View all manipulation alerts
              {mdAlerts.length > 5 && (
                <span style={{
                  background: '#FEE2E2', color: '#B91C1C',
                  fontSize: 10, fontWeight: 700,
                  padding: '1px 8px', borderRadius: 99,
                }}>
                  +{mdAlerts.length - 5} more
                </span>
              )}
              <ArrowUpRight size={12} />
            </a>
            </>
          ) : (
            <Card>
              <div style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>
                <ShieldAlert size={20} style={{ marginBottom: 6, opacity: 0.5 }} />
                <div>No manipulation alerts. Click "Run Scan" to analyze the universe.</div>
              </div>
            </Card>
          )}
        </section>
        );
        })()}

        {/* Backtesting moved to dedicated /backtesting page — not primary dashboard content */}

        {/* ── COLLAPSED: BACKTESTING ENGINE (link only) ────── */}
        <section className={styles.section} style={{ marginBottom: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', background: '#F8FAFC', borderRadius: 10, border: '1px solid #E2E8F0' }}>
            <FlaskConical size={14} color="#64748B" />
            <span style={{ fontSize: 13, fontWeight: 600, color: '#64748B' }}>Backtesting Engine</span>
            <a href="/backtesting" style={{ fontSize: 12, color: '#3B82F6', marginLeft: 'auto', fontWeight: 600 }}>Open Backtesting →</a>
          </div>
        </section>

        {/* eslint-disable-next-line @typescript-eslint/no-unused-vars -- backtesting state kept for /backtesting page compatibility */}
        <div style={{ display: 'none' }}>{/* BACKTESTING SECTION REMOVED FROM DASHBOARD */}</div>
        {false && <section className={styles.section}>
          <div className={styles.sectionHead}>
            <FlaskConical size={14} />
            <span>Backtesting Engine</span>
          </div>

          {/* Data availability banner */}
          {/* typeof check (instead of !== null) so TS narrows dataReady
              to number for the comparison below — the !== null variant
              tripped the build with "dataReady is possibly null" under
              Next's bundled TS, even though logically equivalent. */}
          {typeof dataReady === 'number' && dataReady < dataTotal && (
            <div style={{
              background: '#FEF3C7', borderRadius: 8, padding: '10px 16px', marginBottom: 16,
              border: '1px solid #F59E0B33', display: 'flex', alignItems: 'center', gap: 12,
            }}>
              <Database size={16} color="#D97706" />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#92400E' }}>
                  Historical data: {dataReady}/{dataTotal} symbols ready
                </div>
                <div style={{ fontSize: 11, color: '#92400E' }}>
                  {dataReady === 0
                    ? 'No EOD candle data found. Seed historical data before running backtests.'
                    : `${dataTotal - dataReady} symbols missing data. Seed to fetch from Yahoo Finance.`}
                </div>
              </div>
              <button
                className="btn btn--secondary btn--sm"
                onClick={seedData}
                disabled={dataSeeding}
                style={{ display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}
              >
                {dataSeeding ? <RefreshCw size={12} className={styles.spin} /> : <Download size={12} />}
                {dataSeeding ? 'Seeding...' : 'Seed Data'}
              </button>
            </div>
          )}

          {typeof dataReady === 'number' && dataReady >= dataTotal && dataTotal > 0 && (
            <div style={{
              background: '#F0FDF4', borderRadius: 8, padding: '8px 16px', marginBottom: 16,
              border: '1px solid #16A34A33', display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
            }}>
              <CheckCircle size={14} color="#15803D" />
              <span style={{ color: '#065F46', fontWeight: 600 }}>All {dataTotal} symbols have historical data</span>
            </div>
          )}

          {seedStatus && (
            <div style={{ fontSize: 11, color: '#1D4ED8', marginBottom: 12, padding: '6px 12px', background: '#EFF6FF', borderRadius: 6, border: '1px solid #BFDBFE' }}>
              {seedStatus}
            </div>
          )}

          {/* Run button + run selector */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <button
              className="btn btn--primary btn--sm"
              onClick={runNewBacktest}
              disabled={btRunning || dataSeeding}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {btRunning ? <RefreshCw size={13} className={styles.spin} /> : <Play size={13} />}
              {btRunning ? 'Running...' : 'Run Backtest'}
            </button>

            {btRuns.filter(r => r.status === 'completed').length > 0 && (
              <>
                <select
                  value={btSelected ?? ''}
                  onChange={e => { if (e.target.value) loadBacktestDetail(e.target.value); }}
                  style={{ fontSize: 12, padding: '6px 10px', borderRadius: 6, border: '1px solid #E2E8F0', background: '#F8FAFC', color: '#1E293B' }}
                >
                  <option value="">Select a run...</option>
                  {btRuns
                    .filter(r => r.status === 'completed')
                    .slice()
                    .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime())
                    .map(r => {
                      const d = new Date(r.started_at);
                      const label = `${d.toLocaleDateString('en-IN')} ${d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
                      return (
                        <option key={r.run_id} value={r.run_id}>
                          {r.name} — {r.trade_count} trades — {label}
                        </option>
                      );
                    })}
                </select>
                <button
                  onClick={() => { btUserPickedRef.current = false; loadBacktestRuns({ silent: true }); }}
                  style={{ fontSize: 10, color: '#64748B', background: 'transparent', border: '1px solid #E2E8F0', padding: '4px 8px', borderRadius: 4, cursor: 'pointer' }}
                  title="Follow latest completed run automatically"
                >
                  {btUserPickedRef.current ? 'Follow latest' : 'Auto ✓'}
                </button>
                <span style={{ fontSize: 10, color: '#94A3B8', display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{
                    width: 6, height: 6, borderRadius: 99,
                    background: '#10B981',
                    animation: 'pulse 1.5s ease-in-out infinite',
                  }} />
                  auto-refresh 15s
                </span>
              </>
            )}

            {/* Cleanup failed runs */}
            {btRuns.filter(r => r.status === 'failed').length > 0 && (
              <button
                className="btn btn--secondary btn--sm"
                onClick={cleanupFailedRuns}
                style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11 }}
                title="Delete all failed backtest runs"
              >
                <AlertTriangle size={11} />
                Delete {btRuns.filter(r => r.status === 'failed').length} failed
              </button>
            )}

            {btError && (
              <span style={{ fontSize: 11, color: '#DC2626', fontWeight: 600 }}>
                <AlertTriangle size={12} style={{ verticalAlign: -2 }} /> {btError}
              </span>
            )}
          </div>

          {/* Summary stats */}
          {btLoading && (
            <div style={{ padding: 32, textAlign: 'center', color: '#94A3B8' }}>
              <RefreshCw size={18} className={styles.spin} style={{ marginBottom: 8 }} />
              <div style={{ fontSize: 12 }}>Loading backtest results...</div>
            </div>
          )}

          {!btLoading && btSummary && (
            <>
              {/* KPI row */}
              <div className={styles.btGrid}>
                {[
                  { label: 'Total Return', value: `${btSummary.totalReturnPct >= 0 ? '+' : ''}${btSummary.totalReturnPct.toFixed(2)}%`, color: btSummary.totalReturnPct >= 0 ? '#15803D' : '#DC2626', sub: `Annual: ${btSummary.annualizedReturnPct?.toFixed(1) ?? '—'}%` },
                  { label: 'Win Rate', value: `${(btSummary.winRate * 100).toFixed(1)}%`, color: btSummary.winRate >= 0.5 ? '#15803D' : '#DC2626', sub: `${btSummary.totalWins}W / ${btSummary.totalLosses}L` },
                  { label: 'Profit Factor', value: btSummary.profitFactor.toFixed(2), color: btSummary.profitFactor >= 1.5 ? '#15803D' : btSummary.profitFactor >= 1 ? '#D97706' : '#DC2626', sub: `Expectancy: ${btSummary.expectancyR.toFixed(2)}R` },
                  { label: 'Max Drawdown', value: `${btSummary.maxDrawdownPct.toFixed(2)}%`, color: btSummary.maxDrawdownPct <= 10 ? '#15803D' : btSummary.maxDrawdownPct <= 20 ? '#D97706' : '#DC2626', sub: `Sharpe: ${btSummary.sharpeRatio.toFixed(2)}` },
                ].map(s => (
                  <div key={s.label} className={styles.btStatBox}>
                    <div className={styles.btStatLabel}>{s.label}</div>
                    <div className={styles.btStatValue} style={{ color: s.color }}>{s.value}</div>
                    <div className={styles.btStatSub}>{s.sub}</div>
                  </div>
                ))}
              </div>

              {/* Secondary metrics row */}
              <div className={styles.btGrid}>
                {[
                  { label: 'Trades', value: btSummary.totalTradesTaken.toString(), sub: `Signals: ${btSummary.totalSignalsGenerated}` },
                  { label: 'Avg Win', value: `+${btSummary.avgWinPct.toFixed(2)}%`, sub: `Avg Loss: ${btSummary.avgLossPct.toFixed(2)}%` },
                  { label: 'Avg Holding', value: `${btSummary.avgBarsInTrade.toFixed(1)} bars`, sub: `Sortino: ${btSummary.sortinoRatio?.toFixed(2) ?? '—'}` },
                  { label: 'Target Hit Rates', value: `T1: ${(btSummary.target1HitRate * 100).toFixed(0)}%`, sub: `T2: ${(btSummary.target2HitRate * 100).toFixed(0)}% · T3: ${(btSummary.target3HitRate * 100).toFixed(0)}%` },
                ].map(s => (
                  <div key={s.label} className={styles.btStatBox}>
                    <div className={styles.btStatLabel}>{s.label}</div>
                    <div className={styles.btStatValue} style={{ color: '#1E293B', fontSize: '1.2rem' }}>{s.value}</div>
                    <div className={styles.btStatSub}>{s.sub}</div>
                  </div>
                ))}
              </div>

              {/* Capital summary */}
              <div style={{ display: 'flex', gap: 16, marginBottom: 16, padding: '10px 16px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E2E8F0', fontSize: 12 }}>
                <span>Initial: <strong style={{ color: '#1E293B' }}>{fmt.currency(btSummary.initialCapital)}</strong></span>
                <span>Final: <strong style={{ color: btSummary.finalEquity >= btSummary.initialCapital ? '#15803D' : '#DC2626' }}>{fmt.currency(btSummary.finalEquity)}</strong></span>
                <span>P&L: <strong style={{ color: btSummary.finalEquity >= btSummary.initialCapital ? '#15803D' : '#DC2626' }}>
                  {btSummary.finalEquity >= btSummary.initialCapital ? '+' : ''}{fmt.currency(btSummary.finalEquity - btSummary.initialCapital)}
                </strong></span>
                <span>Calmar: <strong>{btSummary.calmarRatio?.toFixed(2) ?? '—'}</strong></span>
              </div>

              {/* Strategy breakdown table */}
              {btStratBreak.length > 0 && (
                <Card title="Strategy Breakdown">
                  <table className={styles.btTradeTable}>
                    <thead>
                      <tr>
                        {['STRATEGY','TRADES','WIN RATE','AVG R','PF','T1 HIT','T2 HIT','MFE','MAE'].map(h => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {btStratBreak.map((sb: any) => {
                        const winRate = Number(sb.winRate ?? sb.win_rate ?? 0);
                        const avgR = Number(sb.avgReturnR ?? sb.avg_return_r ?? 0);
                        const pf = Number(sb.profitFactor ?? sb.profit_factor ?? 0);
                        const t1Hit = Number(sb.target1HitRate ?? sb.target1_hit_rate ?? 0);
                        const t2Hit = Number(sb.target2HitRate ?? sb.target2_hit_rate ?? 0);
                        const mfe = Number(sb.avgMfePct ?? sb.avg_mfe_pct ?? 0);
                        const mae = Number(sb.avgMaePct ?? sb.avg_mae_pct ?? 0);
                        return (
                          <tr key={sb.strategy}>
                            <td style={{ fontWeight: 700 }}>{sb.strategy?.replace(/_/g, ' ')}</td>
                            <td>{sb.totalTrades ?? sb.total_trades ?? 0}</td>
                            <td style={{ color: winRate >= 0.5 ? '#15803D' : '#DC2626', fontWeight: 700 }}>
                              {(winRate * 100).toFixed(0)}%
                            </td>
                            <td>{avgR.toFixed(2)}R</td>
                            <td style={{ color: pf >= 1 ? '#15803D' : '#DC2626' }}>{pf.toFixed(2)}</td>
                            <td>{(t1Hit * 100).toFixed(0)}%</td>
                            <td>{(t2Hit * 100).toFixed(0)}%</td>
                            <td style={{ color: '#15803D' }}>+{mfe.toFixed(2)}%</td>
                            <td style={{ color: '#DC2626' }}>-{Math.abs(mae).toFixed(2)}%</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Card>
              )}

              {/* Recent trades table */}
              {btTrades.length > 0 && (
                <Card title={`Recent Trades (${btTrades.length} total)`} style={{ marginTop: 16 }}>
                  <table className={styles.btTradeTable}>
                    <thead>
                      <tr>
                        {['SYMBOL','STRATEGY','DIR','ENTRY','EXIT','P&L','RETURN','R-MULT','OUTCOME','EXIT REASON'].map(h => (
                          <th key={h}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {btTrades.slice(0, 20).map((t: any) => {
                        // DECIMAL columns from MySQL come back as strings — coerce
                        const pnl = Number(t.net_pnl ?? t.netPnl ?? 0);
                        const retPct = Number(t.return_pct ?? t.returnPct ?? 0);
                        const retR = Number(t.return_r ?? t.returnR ?? 0);
                        const entryPrice = Number(t.entry_price ?? t.entryPrice ?? 0);
                        const exitPrice = t.exit_price ?? t.exitPrice;
                        const outcome = t.outcome ?? '';
                        const isWin = outcome === 'win';
                        return (
                          <tr key={t.trade_id ?? t.tradeId}>
                            <td style={{ fontWeight: 700 }}>{t.symbol}</td>
                            <td style={{ fontSize: 11, color: '#64748B' }}>{(t.strategy ?? '').replace(/_/g, ' ')}</td>
                            <td>
                              <span style={{
                                background: t.direction === 'long' ? '#DCFCE7' : '#FEE2E2',
                                color: t.direction === 'long' ? '#15803D' : '#DC2626',
                                fontWeight: 700, fontSize: 10, padding: '2px 6px', borderRadius: 99,
                              }}>
                                {(t.direction ?? '').toUpperCase()}
                              </span>
                            </td>
                            <td>{fmt.currency(entryPrice)}</td>
                            <td>{exitPrice != null ? fmt.currency(Number(exitPrice)) : '—'}</td>
                            <td style={{ fontWeight: 700, color: pnl >= 0 ? '#15803D' : '#DC2626' }}>
                              {pnl >= 0 ? '+' : ''}{fmt.currency(pnl)}
                            </td>
                            <td style={{ color: retPct >= 0 ? '#15803D' : '#DC2626' }}>
                              {retPct >= 0 ? '+' : ''}{retPct.toFixed(2)}%
                            </td>
                            <td style={{ fontWeight: 600, color: retR >= 0 ? '#15803D' : '#DC2626' }}>
                              {retR >= 0 ? '+' : ''}{retR.toFixed(2)}R
                            </td>
                            <td>
                              <span style={{
                                background: isWin ? '#DCFCE7' : '#FEE2E2',
                                color: isWin ? '#15803D' : '#DC2626',
                                fontWeight: 700, fontSize: 10, padding: '2px 8px', borderRadius: 99,
                              }}>
                                {outcome.toUpperCase()}
                              </span>
                            </td>
                            <td style={{ fontSize: 11, color: '#64748B' }}>
                              {(t.exit_reason ?? t.exitReason ?? '—').replace(/_/g, ' ')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {btTrades.length > 20 && (
                    <div style={{ padding: '8px 12px', fontSize: 11, color: '#94A3B8', textAlign: 'center', borderTop: '1px solid #F1F5F9' }}>
                      Showing 20 of {btTrades.length} trades
                    </div>
                  )}
                </Card>
              )}
            </>
          )}

          {!btLoading && !btSummary && btRuns.length === 0 && (
            <Card>
              <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}>
                <FlaskConical size={28} style={{ marginBottom: 8, opacity: 0.5 }} />
                <div style={{ fontSize: 13, marginBottom: 4 }}>No backtest runs yet</div>
                <div style={{ fontSize: 11 }}>
                  {dataReady === 0
                    ? 'First seed historical data above, then click "Run Backtest".'
                    : 'Click "Run Backtest" to start your first simulation with default settings.'}
                </div>
              </div>
            </Card>
          )}

          {/* Show failed runs info */}
          {!btLoading && !btSummary && btRuns.length > 0 && (
            <Card>
              <div style={{ padding: 16 }}>
                {btRuns.filter(r => r.status === 'completed').length === 0 ? (
                  <div style={{ textAlign: 'center', color: '#D97706' }}>
                    <AlertTriangle size={20} style={{ marginBottom: 6 }} />
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>No successful backtest runs yet</div>
                    <div style={{ fontSize: 11, color: '#94A3B8' }}>
                      {btRuns.map(r => (
                        <div key={r.run_id} style={{ marginTop: 4 }}>
                          <span style={{ fontWeight: 600 }}>{r.name}</span>
                          {' — '}
                          <span style={{ color: r.status === 'failed' ? '#DC2626' : '#D97706' }}>{r.status}</span>
                        </div>
                      ))}
                    </div>
                    <div style={{ fontSize: 11, color: '#64748B', marginTop: 8 }}>
                      {typeof dataReady === 'number' && dataReady > 0
                        ? 'Historical data is ready. Click "Run Backtest" to try again.'
                        : 'Seed historical data first, then run a new backtest.'}
                    </div>
                  </div>
                ) : !btSelected ? (
                  <div style={{ textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>
                    Select a backtest run above to view results.
                  </div>
                ) : null}
              </div>
            </Card>
          )}
        </section>}

      </div>
    </AppShell>
  );
}
