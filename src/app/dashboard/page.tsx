'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty } from '@/components/ui';
import { fmt, changeClass } from '@/lib/utils';
import {
  TrendingUp, TrendingDown, BarChart2, Zap, Target,
  RefreshCw, ArrowUpRight, ArrowDownRight, Minus,
  Shield, Activity, AlertTriangle, CheckCircle,
  FlaskConical, Play, Database, Download, ShieldAlert, Scan,
  Briefcase, Scale, Gavel,
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
  score: number; ltp: number; pct_change: number;
  signal_type: string | null; confidence: number | null;
  confidence_score: number | null; conviction_band: string | null;
  portfolio_fit_score: number | null; market_stance: string | null;
}

interface OpportunityRow {
  tradingsymbol: string; exchange: string; direction: string;
  confidence: number; entry_price: number | null;
  stop_loss: number | null; target1: number | null;
  risk_reward: number | null; opportunity_score: number;
  conviction_band: string | null; scenario_tag: string | null;
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

function ConvictionBadge({ band }: { band: string | null }) {
  if (!band || band === 'reject') return null;
  const cfg = { high_conviction:['#D1FAE5','#065F46','●●●●'], actionable:['#DBEAFE','#1D4ED8','●●●○'], watchlist:['#FEF3C7','#92400E','●●○○'] }[band];
  if (!cfg) return null;
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
      const [iRes, rRes, oRes, pRes, rkRes, bRes, dRes] = await Promise.allSettled([
        fetch('/api/market-intelligence').then(r => r.json()),
        fetch('/api/rankings?limit=10').then(r => r.json()),
        fetch('/api/signals?action=top&limit=6').then(r => r.json()),
        fetch('/api/portfolio/overview').then(r => r.json()),
        fetch('/api/risk/summary').then(r => r.json()),
        fetch('/api/alerts/breaches').then(r => r.json()),
        fetch('/api/decisions/traces?limit=10').then(r => r.json()),
      ]);
      if (iRes.status === 'fulfilled') setIntel(iRes.value);
      if (rRes.status === 'fulfilled') setRankings(rRes.value.data ?? []);
      if (oRes.status === 'fulfilled') setOpps(oRes.value.signals ?? []);
      if (pRes.status === 'fulfilled') setPortfolio(pRes.value.data ?? pRes.value);
      if (rkRes.status === 'fulfilled') setRiskSummary(rkRes.value.data ?? rkRes.value);
      if (bRes.status === 'fulfilled') setBreaches(bRes.value.data ?? bRes.value.breaches ?? []);
      if (dRes.status === 'fulfilled') setDecisions(dRes.value.data ?? []);
      setLastAt(new Date().toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit' }));
    } finally {
      if (spinner) setLoading(false);
    }
  }, []);

  const evaluateTopOpportunities = useCallback(async () => {
    if (!opps.length || evalRunning) return;
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
  }, [opps, evalRunning]);

  useEffect(() => {
    load();
    loadBacktestRuns();
    checkDataAvailability();
    loadManipulationAlerts();

    // Poll market-intel, manipulation alerts, and opportunities every 10s.
    // Backtests also refresh every 15s so completed runs appear automatically.
    const main = setInterval(() => {
      if (!document.hidden) {
        load();
        loadManipulationAlerts();
      }
    }, 10_000);
    const bt = setInterval(() => {
      loadBacktestRuns({ silent: true });
      setBtSelected(prev => {
        if (prev) loadBacktestDetail(prev, { silent: true, keepAuto: !btUserPickedRef.current });
        return prev;
      });
    }, 15_000);
    return () => { clearInterval(main); clearInterval(bt); };
  }, [load, loadBacktestRuns, checkDataAvailability, loadManipulationAlerts]);

  // ── Data validation layer — prevent contradictory display ──────
  // Validate breadth: if advancing + declining is 0, breadth is unreliable
  const breadthValid = (intel?.breadth?.advancing ?? 0) + (intel?.breadth?.declining ?? 0) > 10;
  const validatedBreadth = breadthValid ? intel?.breadth : {
    advancing: 0, declining: 0, unchanged: 0, ratio: null,
  };

  // Validate gainers/losers: losers must actually be negative
  const validatedGainers = (intel?.topGainers ?? []).filter(m => m.change_percent > 0);
  const validatedLosers  = (intel?.topLosers ?? []).filter(m => m.change_percent < 0);

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
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '2px 8px', borderRadius: 99,
                background: '#DCFCE7', color: '#15803D',
                fontSize: 10, fontWeight: 700, letterSpacing: 0.5,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: '50%',
                  background: '#15803D',
                  animation: 'pulse 1.5s ease-in-out infinite',
                }} />
                LIVE
              </span>
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn--secondary btn--sm" onClick={() => load(true)} disabled={loading}>
              <RefreshCw size={13} className={loading ? styles.spin : ''} /> Refresh
            </button>
          </div>
        </div>

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
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <Gavel size={14} />
            <span>Recent Decisions</span>
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
                <div>No institutional decisions recorded yet. Decisions are created when trades are evaluated through the gate chain.</div>
                <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                  <button
                    className="btn btn--primary btn--sm"
                    onClick={evaluateTopOpportunities}
                    disabled={evalRunning || !opps.length}
                    style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                  >
                    {evalRunning ? <RefreshCw size={13} className={styles.spin} /> : <Play size={13} />}
                    {evalRunning ? 'Evaluating…' : `Evaluate ${opps.length || ''} top opportunit${opps.length === 1 ? 'y' : 'ies'}`}
                  </button>
                  {!opps.length && (
                    <div style={{ fontSize: 11, color: '#94A3B8' }}>Generate signals first from Admin → Recompute Signals.</div>
                  )}
                  {evalError && (
                    <div style={{ fontSize: 11, color: '#DC2626' }}>{evalError}</div>
                  )}
                </div>
              </div>
            </Card>
          )}
        </section>

        {/* ── SECTION 4: MARKET INTELLIGENCE (moved down) ──────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <BarChart2 size={14} />
            <span>Market Intelligence</span>
          </div>

          <div className={styles.intelRow}>
            {/* Trend */}
            <div className={styles.intelBox} style={{ borderColor: tm.color + '55', background: tm.bg }}>
              {loading ? <div className="skeleton" style={{ height:72 }} /> : (<>
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
                </div>
              </>)}
            </div>

            {/* Breadth */}
            <div className={styles.intelBox}>
              <div className={styles.boxLabel}>Market Breadth</div>
              {loading ? <div className="skeleton" style={{ height:60 }} /> : !breadthValid ? (
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
                </div>
              </>)}
            </div>

            {/* Volatility */}
            <div className={styles.intelBox}>
              <div className={styles.boxLabel}>Volatility</div>
              {loading ? <div className="skeleton" style={{ height:60 }} /> : (<>
                <div style={{ display:'flex', alignItems:'baseline', gap:8, marginTop:6 }}>
                  <span style={{ fontSize:20, fontWeight:700 }}>{intel?.volatility?.volatility_label ?? '—'}</span>
                  {intel?.volatility?.nifty_vix != null && (
                    <span style={{ fontSize:12, color:'#64748B' }}>VIX {intel.volatility.nifty_vix.toFixed(1)}</span>
                  )}
                </div>
                <div style={{ fontSize:11, color:'#64748B', marginTop:4 }}>
                  Avg range {intel?.volatility?.avg_range_pct?.toFixed(2) ?? '—'}%
                </div>
              </>)}
            </div>

            {/* FII / DII */}
            <div className={styles.intelBox}>
              <div className={styles.boxLabel}>Institutional Flow</div>
              {loading ? <div className="skeleton" style={{ height:60 }} /> : (
                intel?.fiiDii?.length ? (<>
                  <div style={{ fontSize:13, fontWeight:700, color: intel.fiiDii[0].fii_net > 0 ? '#16A34A' : '#DC2626', marginTop:6 }}>
                    {intel.fiiDii[0].fii_label || `FII ${intel.fiiDii[0].fii_net > 0 ? '+' : ''}${fmt.number(intel.fiiDii[0].fii_net)} Cr`}
                  </div>
                  <div style={{ fontSize:12, color: '#64748B', marginTop:3 }}>
                    {intel.fiiDii[0].dii_label || `DII ${intel.fiiDii[0].dii_net > 0 ? '+' : ''}${fmt.number(intel.fiiDii[0].dii_net)} Cr`}
                  </div>
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

          {/* Gainers / Losers — using validated data (losers guaranteed negative) */}
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:16, marginBottom:4 }}>
            {([
              { key: 'gainers' as const, label: 'Top Gainers', data: validatedGainers },
              { key: 'losers'  as const, label: 'Top Losers',  data: validatedLosers },
            ]).map(({ key, label, data }) => (
              <Card key={key}>
                <div style={{ padding:'12px 16px', borderBottom:'1px solid #F1F5F9', fontWeight:700, fontSize:13 }}>
                  {label}
                </div>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead>
                    <tr style={{ background:'#F8FAFC' }}>
                      <th style={{ padding:'6px 12px', textAlign:'left', fontSize:10, color:'#94A3B8', fontWeight:700 }}>SYMBOL</th>
                      <th style={{ padding:'6px 12px', textAlign:'right', fontSize:10, color:'#94A3B8', fontWeight:700 }}>LTP</th>
                      <th style={{ padding:'6px 12px', textAlign:'right', fontSize:10, color:'#94A3B8', fontWeight:700 }}>CHG%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.slice(0,5).map(m => (
                      <tr key={m.symbol} style={{ borderTop:'1px solid #F8FAFC' }}>
                        <td style={{ padding:'7px 12px', fontWeight:600, fontSize:12 }}>{m.symbol}</td>
                        <td style={{ padding:'7px 12px', textAlign:'right', fontSize:12, fontVariantNumeric:'tabular-nums' }}>{fmt.currency(m.ltp)}</td>
                        <td style={{ padding:'7px 12px', textAlign:'right', fontWeight:700, fontSize:12, color: m.change_percent >= 0 ? '#16A34A' : '#DC2626' }}>
                          {m.change_percent >= 0 ? '+' : ''}{m.change_percent.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                    {data.length === 0 && (
                      <tr><td colSpan={3} style={{ padding:16, textAlign:'center', color:'#94A3B8', fontSize:11 }}>
                        No {key === 'gainers' ? 'gaining' : 'declining'} stocks in current data
                      </td></tr>
                    )}
                  </tbody>
                </table>
              </Card>
            ))}
          </div>
        </section>

        {/* ── SECTION 2: RANKINGS ───────────────────────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <TrendingUp size={14} />
            <span>Top Rankings</span>
          </div>
          <Card>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr style={{ background:'#F8FAFC' }}>
                  {['#','SYMBOL','SCORE','LTP','CHANGE','SIGNAL','CONVICTION','CONF'].map(h => (
                    <th key={h} style={{ padding:'8px 12px', textAlign: h==='#'||h==='SYMBOL'?'left':'right', fontSize:10, color:'#94A3B8', fontWeight:700 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rankings.map((r, i) => (
                  <tr key={r.symbol} style={{ borderTop:'1px solid #F8FAFC' }}>
                    <td style={{ padding:'8px 12px', color:'#CBD5E1', fontSize:12 }}>{i+1}</td>
                    <td style={{ padding:'8px 12px' }}>
                      <div style={{ fontWeight:700, fontSize:13 }}>{r.symbol}</div>
                      <div style={{ fontSize:10, color:'#94A3B8' }}>{r.exchange}</div>
                    </td>
                    <td style={{ padding:'8px 12px', textAlign:'right', fontWeight:700, fontSize:12 }}>{r.score.toFixed(1)}</td>
                    <td style={{ padding:'8px 12px', textAlign:'right', fontSize:12, fontVariantNumeric:'tabular-nums' }}>{fmt.currency(r.ltp)}</td>
                    <td style={{ padding:'8px 12px', textAlign:'right', fontWeight:700, fontSize:12, color: r.pct_change >= 0 ? '#16A34A' : '#DC2626' }}>
                      {r.pct_change >= 0 ? '+' : ''}{r.pct_change.toFixed(2)}%
                    </td>
                    <td style={{ padding:'8px 12px', textAlign:'right' }}><SignalPill type={r.signal_type} /></td>
                    <td style={{ padding:'8px 12px', textAlign:'right' }}><ConvictionBadge band={r.conviction_band} /></td>
                    <td style={{ padding:'8px 12px', textAlign:'right' }}><ConfBar val={r.confidence_score ?? r.confidence} /></td>
                  </tr>
                ))}
                {!rankings.length && !loading && (
                  <tr><td colSpan={8} style={{ padding:24, textAlign:'center', color:'#94A3B8', fontSize:12 }}>
                    No ranked instruments. Run Admin → Data → Sync Rankings.
                  </td></tr>
                )}
              </tbody>
            </table>
          </Card>
        </section>

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
            <span style={{ fontSize: 10, color: '#94A3B8', fontWeight: 400, marginLeft: 8 }}>
              Signal ≠ permission · every opportunity must pass through the decision gate chain
            </span>
          </div>
          <div className={styles.grid3}>
            {opps.map(o => {
              const isBuy = o.direction === 'BUY';
              const accentColor = isBuy ? '#15803D' : '#DC2626';
              const bg = isBuy ? '#F0FDF4' : '#FFF1F2';
              return (
                <div key={o.tradingsymbol} className={styles.oppCard} style={{ borderLeftColor: accentColor }}>
                  <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:6 }}>
                    <div>
                      <div style={{ fontWeight:800, fontSize:16 }}>{o.tradingsymbol}</div>
                      <div style={{ fontSize:10, color:'#94A3B8' }}>{o.exchange}
                        {o.scenario_tag && <span style={{ marginLeft:5, color:'#3B82F6' }}>· {o.scenario_tag.replace(/_/g,' ')}</span>}
                      </div>
                    </div>
                    <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:3 }}>
                      <span style={{ background: isBuy?'#DCFCE7':'#FEE2E2', color: accentColor, fontWeight:800, fontSize:11, padding:'3px 10px', borderRadius:99 }}>
                        {o.direction}
                      </span>
                      {o.conviction_band && <ConvictionBadge band={o.conviction_band} />}
                    </div>
                  </div>

                  {/* Confidence bar */}
                  <div style={{ marginBottom:10 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'#64748B', marginBottom:3 }}>
                      <span>Confidence</span>
                      <strong style={{ color: o.confidence>=75?'#065F46':o.confidence>=60?'#1D4ED8':'#D97706' }}>
                        {o.confidence}%
                      </strong>
                    </div>
                    <div style={{ height:4, background:'#E2E8F0', borderRadius:99, overflow:'hidden' }}>
                      <div style={{ height:'100%', width:`${o.confidence}%`, background: o.confidence>=75?'#15803D':o.confidence>=60?'#1D4ED8':'#D97706', borderRadius:99 }} />
                    </div>
                  </div>

                  {/* Price levels */}
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6, marginBottom:8 }}>
                    {[['Entry', o.entry_price,'#1E3A5F'],['SL',o.stop_loss,'#DC2626'],['Target',o.target1,'#15803D']].map(([l,v,c]) => (
                      <div key={String(l)} style={{ background:'#F8FAFC', borderRadius:7, padding:'6px 8px', textAlign:'center' }}>
                        <div style={{ fontSize:9, color:'#94A3B8', fontWeight:700, marginBottom:2 }}>{l}</div>
                        <div style={{ fontSize:12, fontWeight:700, color: c as string }}>{v ? fmt.currency(v as number) : '—'}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ display:'flex', justifyContent:'space-between', fontSize:10, color:'#64748B' }}>
                    <span>Score: <strong style={{ color:'#1E3A5F' }}>{o.opportunity_score}</strong></span>
                    {o.risk_reward && <span>R:R <strong>{o.risk_reward}</strong></span>}
                  </div>
                </div>
              );
            })}
            {!opps.length && !loading && (
              <div style={{ gridColumn:'1/-1', textAlign:'center', padding:32, color:'#94A3B8' }}>
                No approved signals. Run Admin → Recompute Signals.
              </div>
            )}
          </div>
        </section>

        {/* ── SECTION: MANIPULATION DETECTION ───────────────── */}
        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <ShieldAlert size={14} />
            <span>Manipulation Detection</span>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <button className="btn btn--secondary btn--sm" onClick={runManipulationScan} disabled={mdScanning}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {mdScanning ? <RefreshCw size={13} className={styles.spin} /> : <Scan size={13} />}
              {mdScanning ? 'Scanning...' : 'Run Scan'}
            </button>
            {mdSummary && (
              <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
                <span>Alerts: <strong>{mdSummary.totalAlerts}</strong></span>
                {mdSummary.bySeverity?.critical > 0 && (
                  <span style={{ color: '#DC2626', fontWeight: 700 }}>Critical: {mdSummary.bySeverity.critical}</span>
                )}
                {mdSummary.bySeverity?.warning > 0 && (
                  <span style={{ color: '#D97706', fontWeight: 700 }}>Warning: {mdSummary.bySeverity.warning}</span>
                )}
              </div>
            )}
          </div>

          {mdAlerts.length > 0 ? (
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
                  {mdAlerts.slice(0, 10).map((a: any) => (
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
          ) : (
            <Card>
              <div style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>
                <ShieldAlert size={20} style={{ marginBottom: 6, opacity: 0.5 }} />
                <div>No manipulation alerts. Click "Run Scan" to analyze the universe.</div>
              </div>
            </Card>
          )}
        </section>

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
          {dataReady !== null && dataReady < dataTotal && (
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

          {dataReady !== null && dataReady >= dataTotal && dataTotal > 0 && (
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
                      {dataReady !== null && dataReady > 0
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
