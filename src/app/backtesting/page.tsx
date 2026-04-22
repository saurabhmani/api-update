'use client';
import { useEffect, useState, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card } from '@/components/ui';
import { fmt } from '@/lib/utils';
import {
  FlaskConical, Play, RefreshCw, Database, Download, AlertTriangle,
  CheckCircle, Activity, BarChart2, FileText, ChevronRight,
} from 'lucide-react';
import {
  ResponsiveContainer, AreaChart, Area, LineChart, Line,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ComposedChart,
} from 'recharts';

interface BacktestRunRow {
  run_id: string;
  name: string;
  status: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  signal_count: number;
  trade_count: number;
  summary_json: any;
  config_json: any;
}

interface SummaryData {
  totalSignalsGenerated: number;
  totalTradesTaken: number;
  totalWins: number;
  totalLosses: number;
  winRate: number;
  avgWinPct: number;
  avgLossPct: number;
  profitFactor: number;
  expectancyR: number;
  totalReturnPct: number;
  annualizedReturnPct: number;
  maxDrawdownPct: number;
  sharpeRatio: number;
  sortinoRatio: number;
  calmarRatio: number;
  avgBarsInTrade: number;
  target1HitRate: number;
  target2HitRate: number;
  target3HitRate: number;
  initialCapital: number;
  finalEquity: number;
}

export default function BacktestingPage() {
  const [runs, setRuns] = useState<BacktestRunRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  const [strategyBreak, setStrategyBreak] = useState<any[]>([]);
  const [regimeBreak, setRegimeBreak] = useState<any[]>([]);
  const [equityCurve, setEquityCurve] = useState<any[]>([]);
  const [calibration, setCalibration] = useState<any[]>([]);
  const [trades, setTrades] = useState<any[]>([]);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [tab, setTab] = useState<'overview' | 'trades' | 'calibration' | 'equity' | 'dexter' | 'audit'>('overview');
  const [dexterData, setDexterData] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Data seeding
  const [dataReady, setDataReady] = useState<number | null>(null);
  const [dataTotal, setDataTotal] = useState<number>(0);
  const [seeding, setSeeding] = useState(false);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/backtests', { cache: 'no-store' });
      const data = await res.json();
      const list = data.runs ?? [];
      setRuns(list);
      if (list.length > 0 && !selectedId) {
        const completed = list.find((r: BacktestRunRow) => r.status === 'completed');
        if (completed) loadDetail(completed.run_id);
      }
    } catch { /* ignore */ }
  }, [selectedId]);

  const loadDataAvailability = useCallback(async () => {
    try {
      const res = await fetch('/api/backtests/seed-data');
      const data = await res.json();
      setDataReady(data.readySymbols ?? 0);
      setDataTotal(data.totalSymbols ?? 0);
    } catch { /* ignore */ }
  }, []);

  const loadDetail = async (runId: string) => {
    setSelectedId(runId);
    setLoading(true);
    setError(null);
    try {
      const [analyticsRes, tradesRes, calibRes, auditRes, dexterRes] = await Promise.allSettled([
        fetch(`/api/backtests/${runId}/analytics`).then(r => r.json()),
        fetch(`/api/backtests/${runId}/trades`).then(r => r.json()),
        fetch(`/api/backtests/${runId}/calibration`).then(r => r.json()),
        fetch(`/api/backtests/${runId}/audit`).then(r => r.json()).catch(() => ({ logs: [] })),
        fetch(`/api/backtests/${runId}/dexter`).then(r => r.json()).catch(() => null),
      ]);
      if (analyticsRes.status === 'fulfilled') {
        // Coerce all numeric summary fields — DB JSON columns can return strings
        const raw = analyticsRes.value.summary;
        if (raw) {
          const numericKeys: (keyof SummaryData)[] = [
            'totalSignalsGenerated', 'totalTradesTaken', 'totalWins', 'totalLosses',
            'winRate', 'avgWinPct', 'avgLossPct', 'profitFactor', 'expectancyR',
            'totalReturnPct', 'annualizedReturnPct', 'maxDrawdownPct', 'sharpeRatio',
            'sortinoRatio', 'calmarRatio', 'avgBarsInTrade',
            'target1HitRate', 'target2HitRate', 'target3HitRate',
            'initialCapital', 'finalEquity',
          ];
          const normalized = { ...raw };
          for (const k of numericKeys) normalized[k] = Number(raw[k] ?? 0);
          setSummary(normalized);
        } else {
          setSummary(null);
        }
        setStrategyBreak(analyticsRes.value.strategyBreakdown ?? []);
        setRegimeBreak(analyticsRes.value.regimeBreakdown ?? []);
        setEquityCurve(analyticsRes.value.equityCurve ?? []);
      }
      if (tradesRes.status === 'fulfilled') setTrades(tradesRes.value.trades ?? []);
      if (calibRes.status === 'fulfilled') setCalibration(calibRes.value.buckets ?? []);
      if (auditRes.status === 'fulfilled') setAuditLogs(auditRes.value.logs ?? []);
      if (dexterRes.status === 'fulfilled' && dexterRes.value) setDexterData(dexterRes.value);
      else setDexterData(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  };

  const runNewBacktest = async () => {
    setRunning(true);
    setError(null);
    try {
      const res = await fetch('/api/backtests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: {} }),
      });
      const data = await res.json();
      if (!res.ok) { setError(data.error ?? 'Run failed'); return; }
      await loadRuns();
      if (data.runId) loadDetail(data.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setRunning(false);
    }
  };

  const seedData = async () => {
    setSeeding(true);
    try {
      await fetch('/api/backtests/seed-data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ range: '2y' }) });
      await loadDataAvailability();
    } catch { /* ignore */ }
    setSeeding(false);
  };

  useEffect(() => {
    loadRuns();
    loadDataAvailability();
    // Poll every 10s so completed backtest runs appear automatically
    const id = setInterval(() => {
      if (!document.hidden) loadRuns();
    }, 10_000);
    return () => clearInterval(id);
  }, [loadRuns, loadDataAvailability]);

  return (
    <AppShell title="Backtesting Engine">
      <div className="page">
        {/* Header */}
        <div className="page__header">
          <div>
            <h1><FlaskConical size={20} style={{ verticalAlign: -3, marginRight: 8 }} />Backtesting Engine</h1>
            <p>Run historical simulations against the live signal engine — full audit trail, calibration, and Dexter analytics.</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn--secondary btn--sm" onClick={() => loadRuns()} disabled={loading}>
              <RefreshCw size={13} className={loading ? 'spin' : ''} /> Refresh
            </button>
            <button className="btn btn--primary btn--sm" onClick={runNewBacktest} disabled={running || (dataReady !== null && dataReady < 1)}>
              {running ? <RefreshCw size={13} className="spin" /> : <Play size={13} />}
              {running ? ' Running...' : ' New Backtest'}
            </button>
          </div>
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
                Seed historical EOD candles to enable backtesting.
              </div>
            </div>
            <button className="btn btn--secondary btn--sm" onClick={seedData} disabled={seeding}>
              {seeding ? <RefreshCw size={12} className="spin" /> : <Download size={12} />}
              {seeding ? ' Seeding...' : ' Seed Data'}
            </button>
          </div>
        )}

        {error && (
          <div style={{ background: '#FEE2E2', color: '#DC2626', padding: '8px 14px', borderRadius: 8, marginBottom: 16, fontSize: 12, fontWeight: 600 }}>
            <AlertTriangle size={12} style={{ verticalAlign: -2, marginRight: 6 }} />{error}
          </div>
        )}

        {/* Run history sidebar + detail layout */}
        <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', gap: 16 }}>
          {/* Sidebar: Run list */}
          <Card title={`Run History (${runs.length})`}>
            <div style={{ maxHeight: 600, overflowY: 'auto' }}>
              {runs.length === 0 && (
                <div style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>
                  No backtest runs yet.
                </div>
              )}
              {runs.map(r => (
                <div
                  key={r.run_id}
                  onClick={() => loadDetail(r.run_id)}
                  style={{
                    padding: '10px 12px',
                    borderBottom: '1px solid #F1F5F9',
                    cursor: 'pointer',
                    background: selectedId === r.run_id ? '#EFF6FF' : 'transparent',
                    borderLeft: selectedId === r.run_id ? '3px solid #1D4ED8' : '3px solid transparent',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 700 }}>{r.name}</span>
                    <span style={{
                      fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 99,
                      background: r.status === 'completed' ? '#DCFCE7' : r.status === 'failed' ? '#FEE2E2' : '#FEF3C7',
                      color: r.status === 'completed' ? '#15803D' : r.status === 'failed' ? '#DC2626' : '#D97706',
                    }}>{r.status.toUpperCase()}</span>
                  </div>
                  <div style={{ fontSize: 10, color: '#94A3B8', marginTop: 2 }}>
                    {r.trade_count} trades · {r.signal_count} signals
                  </div>
                  <div style={{ fontSize: 10, color: '#CBD5E1' }}>
                    {new Date(r.started_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Detail panel */}
          <div>
            {loading && (
              <Card>
                <div style={{ padding: 60, textAlign: 'center', color: '#94A3B8' }}>
                  <RefreshCw size={24} className="spin" style={{ marginBottom: 8 }} />
                  <div>Loading backtest results...</div>
                </div>
              </Card>
            )}

            {!loading && !summary && !selectedId && (
              <Card>
                <div style={{ padding: 60, textAlign: 'center', color: '#94A3B8' }}>
                  <FlaskConical size={32} style={{ marginBottom: 8, opacity: 0.4 }} />
                  <div style={{ fontSize: 13 }}>Select a run from the sidebar or start a new backtest.</div>
                </div>
              </Card>
            )}

            {!loading && summary && (
              <>
                {/* Tabs */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 12, borderBottom: '1px solid #E2E8F0' }}>
                  {[
                    { key: 'overview', label: 'Overview', icon: BarChart2 },
                    { key: 'trades', label: `Trades (${trades.length})`, icon: Activity },
                    { key: 'calibration', label: `Calibration (${calibration.length})`, icon: CheckCircle },
                    { key: 'equity', label: 'Equity Curve', icon: BarChart2 },
                    { key: 'dexter', label: 'Dexter AI', icon: AlertTriangle },
                    { key: 'audit', label: `Audit (${auditLogs.length})`, icon: FileText },
                  ].map(t => {
                    const Icon = t.icon;
                    return (
                      <button
                        key={t.key}
                        onClick={() => setTab(t.key as any)}
                        style={{
                          padding: '8px 14px', border: 'none', background: 'transparent',
                          borderBottom: tab === t.key ? '2px solid #1D4ED8' : '2px solid transparent',
                          color: tab === t.key ? '#1D4ED8' : '#64748B',
                          fontWeight: tab === t.key ? 700 : 500, fontSize: 12, cursor: 'pointer',
                          display: 'flex', alignItems: 'center', gap: 5,
                        }}
                      >
                        <Icon size={12} /> {t.label}
                      </button>
                    );
                  })}
                </div>

                {/* Overview tab */}
                {tab === 'overview' && (
                  <>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
                      {[
                        { label: 'Total Return', value: `${summary.totalReturnPct >= 0 ? '+' : ''}${summary.totalReturnPct.toFixed(2)}%`, color: summary.totalReturnPct >= 0 ? '#15803D' : '#DC2626', sub: `Annual: ${summary.annualizedReturnPct?.toFixed(1) ?? '—'}%` },
                        { label: 'Win Rate', value: `${(summary.winRate * 100).toFixed(1)}%`, color: summary.winRate >= 0.5 ? '#15803D' : '#DC2626', sub: `${summary.totalWins}W / ${summary.totalLosses}L` },
                        { label: 'Profit Factor', value: summary.profitFactor.toFixed(2), color: summary.profitFactor >= 1.5 ? '#15803D' : summary.profitFactor >= 1 ? '#D97706' : '#DC2626', sub: `Expectancy: ${summary.expectancyR.toFixed(2)}R` },
                        { label: 'Max Drawdown', value: `${summary.maxDrawdownPct.toFixed(2)}%`, color: summary.maxDrawdownPct <= 10 ? '#15803D' : summary.maxDrawdownPct <= 20 ? '#D97706' : '#DC2626', sub: `Sharpe: ${summary.sharpeRatio.toFixed(2)}` },
                      ].map(s => (
                        <div key={s.label} style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8, padding: 14, textAlign: 'center' }}>
                          <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>{s.label}</div>
                          <div style={{ fontSize: 22, fontWeight: 800, color: s.color }}>{s.value}</div>
                          <div style={{ fontSize: 11, color: '#64748B', marginTop: 4 }}>{s.sub}</div>
                        </div>
                      ))}
                    </div>

                    <div style={{ display: 'flex', gap: 16, padding: '10px 16px', background: '#F8FAFC', borderRadius: 8, border: '1px solid #E2E8F0', fontSize: 12, marginBottom: 16 }}>
                      <span>Initial: <strong>{fmt.currency(summary.initialCapital)}</strong></span>
                      <span>Final: <strong style={{ color: summary.finalEquity >= summary.initialCapital ? '#15803D' : '#DC2626' }}>{fmt.currency(summary.finalEquity)}</strong></span>
                      <span>Sortino: <strong>{summary.sortinoRatio?.toFixed(2) ?? '—'}</strong></span>
                      <span>Calmar: <strong>{summary.calmarRatio?.toFixed(2) ?? '—'}</strong></span>
                      <span>T1 hit: <strong>{(summary.target1HitRate * 100).toFixed(0)}%</strong></span>
                      <span>T2 hit: <strong>{(summary.target2HitRate * 100).toFixed(0)}%</strong></span>
                    </div>

                    {strategyBreak.length > 0 && (
                      <Card title="Strategy Breakdown">
                        <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                          <thead>
                            <tr style={{ background: '#F8FAFC' }}>
                              {['STRATEGY', 'TRADES', 'WIN%', 'AVG R', 'PF', 'T1 HIT', 'MFE', 'MAE'].map(h => (
                                <th key={h} style={{ padding: '8px 12px', textAlign: h === 'STRATEGY' ? 'left' : 'right', fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{h}</th>
                              ))}
                            </tr>
                          </thead>
                          <tbody>
                            {strategyBreak.map((sb: any) => (
                              <tr key={sb.strategy} style={{ borderTop: '1px solid #F1F5F9' }}>
                                <td style={{ padding: '8px 12px', fontWeight: 700 }}>{(sb.strategy ?? '').replace(/_/g, ' ')}</td>
                                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{sb.totalTrades}</td>
                                <td style={{ padding: '8px 12px', textAlign: 'right', color: (sb.winRate ?? 0) >= 0.5 ? '#15803D' : '#DC2626', fontWeight: 700 }}>
                                  {((sb.winRate ?? 0) * 100).toFixed(0)}%
                                </td>
                                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{(sb.avgReturnR ?? 0).toFixed(2)}R</td>
                                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{(sb.profitFactor ?? 0).toFixed(2)}</td>
                                <td style={{ padding: '8px 12px', textAlign: 'right' }}>{((sb.target1HitRate ?? 0) * 100).toFixed(0)}%</td>
                                <td style={{ padding: '8px 12px', textAlign: 'right', color: '#15803D' }}>+{(sb.avgMfePct ?? 0).toFixed(2)}%</td>
                                <td style={{ padding: '8px 12px', textAlign: 'right', color: '#DC2626' }}>{(sb.avgMaePct ?? 0).toFixed(2)}%</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </Card>
                    )}
                  </>
                )}

                {/* Trades tab */}
                {tab === 'trades' && (
                  <Card>
                    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: '#F8FAFC' }}>
                          {['SYMBOL', 'STRATEGY', 'DIR', 'ENTRY', 'EXIT', 'P&L', 'R', 'OUTCOME'].map(h => (
                            <th key={h} style={{ padding: '8px 12px', textAlign: h === 'SYMBOL' || h === 'STRATEGY' || h === 'DIR' ? 'left' : 'right', fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {trades.slice(0, 100).map((t: any) => {
                          const pnl = Number(t.net_pnl ?? 0);
                          const retR = Number(t.return_r ?? 0);
                          return (
                            <tr key={t.trade_id} style={{ borderTop: '1px solid #F1F5F9' }}>
                              <td style={{ padding: '8px 12px', fontWeight: 700 }}>{t.symbol}</td>
                              <td style={{ padding: '8px 12px', fontSize: 11, color: '#64748B' }}>{(t.strategy ?? '').replace(/_/g, ' ')}</td>
                              <td style={{ padding: '8px 12px' }}>
                                <span style={{ background: t.direction === 'long' ? '#DCFCE7' : '#FEE2E2', color: t.direction === 'long' ? '#15803D' : '#DC2626', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 99 }}>
                                  {(t.direction ?? '').toUpperCase()}
                                </span>
                              </td>
                              <td style={{ padding: '8px 12px', textAlign: 'right' }}>{fmt.currency(Number(t.entry_price))}</td>
                              <td style={{ padding: '8px 12px', textAlign: 'right' }}>{t.exit_price ? fmt.currency(Number(t.exit_price)) : '—'}</td>
                              <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: pnl >= 0 ? '#15803D' : '#DC2626' }}>
                                {pnl >= 0 ? '+' : ''}{fmt.currency(pnl)}
                              </td>
                              <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 600, color: retR >= 0 ? '#15803D' : '#DC2626' }}>
                                {retR >= 0 ? '+' : ''}{retR.toFixed(2)}R
                              </td>
                              <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                                <span style={{ background: t.outcome === 'win' ? '#DCFCE7' : '#FEE2E2', color: t.outcome === 'win' ? '#15803D' : '#DC2626', fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 99 }}>
                                  {(t.outcome ?? '').toUpperCase()}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                        {trades.length === 0 && (
                          <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>No trades.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </Card>
                )}

                {/* Calibration tab */}
                {tab === 'calibration' && (
                  <Card title="Confidence Calibration">
                    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ background: '#F8FAFC' }}>
                          {['BUCKET', 'STRATEGY', 'REGIME', 'SAMPLE', 'EXPECTED', 'ACTUAL', 'STATE', 'MODIFIER'].map(h => (
                            <th key={h} style={{ padding: '8px 12px', textAlign: h === 'BUCKET' || h === 'STRATEGY' || h === 'REGIME' || h === 'STATE' ? 'left' : 'right', fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {calibration.map((c: any, i: number) => (
                          <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                            <td style={{ padding: '8px 12px', fontWeight: 700 }}>{c.bucket}</td>
                            <td style={{ padding: '8px 12px', fontSize: 11 }}>{c.strategy}</td>
                            <td style={{ padding: '8px 12px', fontSize: 11 }}>{c.regime}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>{c.sampleSize}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>{(Number(c.expectedHitRate) * 100).toFixed(0)}%</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700 }}>{(Number(c.actualHitRate) * 100).toFixed(0)}%</td>
                            <td style={{ padding: '8px 12px', fontSize: 11 }}>{c.calibrationState}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>{Number(c.confidenceModifierSuggestion).toFixed(1)}</td>
                          </tr>
                        ))}
                        {calibration.length === 0 && (
                          <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>No calibration data yet — needs more trades.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </Card>
                )}

                {/* Equity curve tab — charts + table */}
                {tab === 'equity' && (() => {
                  const chartData = equityCurve.map((p: any) => ({
                    date: typeof p.date === 'string' ? p.date.split('T')[0] : p.date,
                    equity: Number(p.equity),
                    cash: Number(p.cash),
                    drawdown: Math.abs(Number(p.drawdown_pct ?? p.drawdownPct ?? 0)),
                    dayPnl: Number(p.day_pnl ?? p.dayPnl ?? 0),
                    positions: Number(p.open_positions ?? p.openPositions ?? 0),
                  }));
                  const initialCap = summary?.initialCapital ?? chartData[0]?.equity ?? 0;

                  return (
                    <>
                      {/* Equity Curve Chart */}
                      <Card title="Equity Curve">
                        <div style={{ padding: 16 }}>
                          <ResponsiveContainer width="100%" height={300}>
                            <AreaChart data={chartData}>
                              <defs>
                                <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                                  <stop offset="5%" stopColor="#00C9FF" stopOpacity={0.3} />
                                  <stop offset="95%" stopColor="#00C9FF" stopOpacity={0} />
                                </linearGradient>
                              </defs>
                              <CartesianGrid strokeDasharray="3 3" stroke="#E1E8F0" />
                              <XAxis dataKey="date" fontSize={10} tick={{ fill: '#94A3B8' }} tickLine={false} />
                              <YAxis fontSize={10} tick={{ fill: '#94A3B8' }} tickLine={false} tickFormatter={(v) => `${(v / 100000).toFixed(1)}L`} />
                              <Tooltip
                                contentStyle={{ background: '#0B1F3A', border: 'none', borderRadius: 8, fontSize: 12, color: '#fff' }}
                                formatter={(v: number) => [fmt.currency(v), 'Equity']}
                              />
                              <ReferenceLine y={initialCap} stroke="#5A6A7E" strokeDasharray="5 5" label={{ value: 'Initial', fill: '#94A3B8', fontSize: 10 }} />
                              <Area type="monotone" dataKey="equity" stroke="#00C9FF" fill="url(#eqGrad)" strokeWidth={2} dot={false} />
                            </AreaChart>
                          </ResponsiveContainer>
                        </div>
                      </Card>

                      {/* Drawdown + Daily P&L Charts */}
                      <div style={{ display: 'grid', gap: 16, gridTemplateColumns: '1fr 1fr', marginTop: 16 }}>
                        <Card title="Drawdown">
                          <div style={{ padding: 16 }}>
                            <ResponsiveContainer width="100%" height={200}>
                              <AreaChart data={chartData}>
                                <defs>
                                  <linearGradient id="ddGrad" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#DC2626" stopOpacity={0.3} />
                                    <stop offset="95%" stopColor="#DC2626" stopOpacity={0} />
                                  </linearGradient>
                                </defs>
                                <CartesianGrid strokeDasharray="3 3" stroke="#E1E8F0" />
                                <XAxis dataKey="date" fontSize={9} tick={{ fill: '#94A3B8' }} tickLine={false} />
                                <YAxis fontSize={9} tick={{ fill: '#94A3B8' }} tickLine={false} tickFormatter={(v) => `-${v.toFixed(1)}%`} />
                                <Tooltip contentStyle={{ background: '#0B1F3A', border: 'none', borderRadius: 8, fontSize: 11, color: '#fff' }} formatter={(v: number) => [`-${v.toFixed(2)}%`, 'Drawdown']} />
                                <Area type="monotone" dataKey="drawdown" stroke="#DC2626" fill="url(#ddGrad)" strokeWidth={1.5} dot={false} />
                              </AreaChart>
                            </ResponsiveContainer>
                          </div>
                        </Card>

                        <Card title="Daily P&L">
                          <div style={{ padding: 16 }}>
                            <ResponsiveContainer width="100%" height={200}>
                              <BarChart data={chartData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#E1E8F0" />
                                <XAxis dataKey="date" fontSize={9} tick={{ fill: '#94A3B8' }} tickLine={false} />
                                <YAxis fontSize={9} tick={{ fill: '#94A3B8' }} tickLine={false} />
                                <Tooltip contentStyle={{ background: '#0B1F3A', border: 'none', borderRadius: 8, fontSize: 11, color: '#fff' }} formatter={(v: number) => [fmt.currency(v), 'P&L']} />
                                <ReferenceLine y={0} stroke="#5A6A7E" />
                                <Bar dataKey="dayPnl" fill="#00C9FF" radius={[2, 2, 0, 0]}>
                                  {chartData.map((entry, idx) => (
                                    <rect key={idx} fill={entry.dayPnl >= 0 ? '#059669' : '#DC2626'} />
                                  ))}
                                </Bar>
                              </BarChart>
                            </ResponsiveContainer>
                          </div>
                        </Card>
                      </div>

                      {/* Data Table */}
                      <Card title={`Data (${equityCurve.length} points)`} style={{ marginTop: 16 }}>
                        <div style={{ padding: 16, maxHeight: 300, overflowY: 'auto' }}>
                          <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                            <thead style={{ position: 'sticky', top: 0, background: '#F8FAFC' }}>
                              <tr>
                                {['DATE', 'EQUITY', 'CASH', 'POSITIONS', 'DRAWDOWN', 'DAY P&L'].map(h => (
                                  <th key={h} style={{ padding: '6px 10px', textAlign: h === 'DATE' ? 'left' : 'right', fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{h}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody>
                              {equityCurve.slice(-50).reverse().map((p: any, i: number) => (
                                <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                                  <td style={{ padding: '6px 10px' }}>{typeof p.date === 'string' ? p.date.split('T')[0] : p.date}</td>
                                  <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: 700 }}>{fmt.currency(Number(p.equity))}</td>
                                  <td style={{ padding: '6px 10px', textAlign: 'right' }}>{fmt.currency(Number(p.cash))}</td>
                                  <td style={{ padding: '6px 10px', textAlign: 'right' }}>{p.open_positions ?? p.openPositions ?? 0}</td>
                                  <td style={{ padding: '6px 10px', textAlign: 'right', color: '#DC2626' }}>{Number(p.drawdown_pct ?? p.drawdownPct ?? 0).toFixed(2)}%</td>
                                  <td style={{ padding: '6px 10px', textAlign: 'right', color: Number(p.day_pnl ?? p.dayPnl ?? 0) >= 0 ? '#15803D' : '#DC2626', fontWeight: 600 }}>
                                    {fmt.currency(Number(p.day_pnl ?? p.dayPnl ?? 0))}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </Card>
                    </>
                  );
                })()}

                {/* Dexter AI tab */}
                {tab === 'dexter' && (
                  <Card title="Dexter AI Intelligence">
                    {!dexterData ? (
                      <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>
                        No Dexter analysis available for this run.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                        {/* Verdict Banner */}
                        <div style={{
                          padding: '16px 20px', borderRadius: 8,
                          background: dexterData.verdict?.profitable ? '#F0FDF4' : '#FEF2F2',
                          border: `1px solid ${dexterData.verdict?.profitable ? '#BBF7D0' : '#FECACA'}`,
                        }}>
                          <div style={{ fontWeight: 700, fontSize: 14, color: dexterData.verdict?.profitable ? '#15803D' : '#DC2626', marginBottom: 4 }}>
                            {dexterData.verdict?.profitable ? 'Profitable System' : 'Unprofitable System'}
                            {dexterData.verdict?.edgeExists && ' — Edge Confirmed'}
                          </div>
                          <div style={{ fontSize: 12, color: '#374151' }}>{dexterData.verdict?.recommendation}</div>
                          <div style={{ fontSize: 11, color: '#64748B', marginTop: 4 }}>
                            Risk-Adjusted Quality: <b>{dexterData.verdict?.riskAdjustedQuality}</b>
                            {' | '}Confidence Calibrated: <b>{dexterData.verdict?.confidenceCalibrated ? 'Yes' : 'No'}</b>
                          </div>
                        </div>

                        {/* Strategy Insights */}
                        {dexterData.strategyInsights?.length > 0 && (
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 12, color: '#374151', marginBottom: 8 }}>Strategy Insights</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 10 }}>
                              {dexterData.strategyInsights.map((s: any, i: number) => (
                                <div key={i} style={{ padding: 12, borderRadius: 6, border: '1px solid #E2E8F0', fontSize: 11 }}>
                                  <div style={{ fontWeight: 700, marginBottom: 4, display: 'flex', justifyContent: 'space-between' }}>
                                    <span>{s.strategy?.replace(/_/g, ' ')}</span>
                                    <span style={{ color: s.verdict === 'strong' ? '#15803D' : s.verdict === 'avoid' ? '#DC2626' : '#92400E', fontWeight: 600, textTransform: 'uppercase', fontSize: 10 }}>{s.verdict}</span>
                                  </div>
                                  <div style={{ color: '#64748B' }}>
                                    WR: {((s.winRate ?? 0) * 100).toFixed(0)}% | Exp: {s.expectancyR?.toFixed(2)}R | PF: {s.profitFactor?.toFixed(1)} | Trades: {s.sampleSize}
                                  </div>
                                  <div style={{ color: '#475569', marginTop: 4 }}>{s.insight}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Calibration Warnings */}
                        {dexterData.calibrationWarnings?.length > 0 && (
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 12, color: '#374151', marginBottom: 8 }}>Calibration Warnings</div>
                            {dexterData.calibrationWarnings.map((w: any, i: number) => (
                              <div key={i} style={{
                                padding: '8px 12px', borderRadius: 6, fontSize: 11, marginBottom: 6,
                                background: w.severity === 'critical' ? '#FEF2F2' : w.severity === 'warning' ? '#FFFBEB' : '#F0FDF4',
                                border: `1px solid ${w.severity === 'critical' ? '#FECACA' : w.severity === 'warning' ? '#FDE68A' : '#BBF7D0'}`,
                                color: w.severity === 'critical' ? '#991B1B' : w.severity === 'warning' ? '#92400E' : '#166534',
                              }}>
                                <b>[{w.bucket}]</b> {w.message}
                                {w.suggestedModifier !== 0 && <span style={{ marginLeft: 8, fontWeight: 600 }}>Suggested: {w.suggestedModifier > 0 ? '+' : ''}{w.suggestedModifier}</span>}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Execution Quality */}
                        {dexterData.executionQuality && (
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 12, color: '#374151', marginBottom: 8 }}>Execution Quality</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, fontSize: 11 }}>
                              {[
                                { label: 'Edge Ratio', value: dexterData.executionQuality.edgeRatio?.toFixed(2) },
                                { label: 'T1 Hit Rate', value: `${((dexterData.executionQuality.target1HitRate ?? 0) * 100).toFixed(0)}%` },
                                { label: 'T2 Hit Rate', value: `${((dexterData.executionQuality.target2HitRate ?? 0) * 100).toFixed(0)}%` },
                                { label: 'Stop Hit Rate', value: `${((dexterData.executionQuality.stopHitRate ?? 0) * 100).toFixed(0)}%` },
                              ].map((m, i) => (
                                <div key={i} style={{ padding: 10, borderRadius: 6, border: '1px solid #E2E8F0', textAlign: 'center' }}>
                                  <div style={{ fontWeight: 700, fontSize: 16 }}>{m.value}</div>
                                  <div style={{ color: '#94A3B8', fontSize: 10 }}>{m.label}</div>
                                </div>
                              ))}
                            </div>
                            <div style={{ fontSize: 11, color: '#475569', marginTop: 8 }}>{dexterData.executionQuality.assessment}</div>
                          </div>
                        )}

                        {/* Regime Insights */}
                        {dexterData.regimeInsights?.length > 0 && (
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 12, color: '#374151', marginBottom: 8 }}>Regime Performance</div>
                            <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                              <thead>
                                <tr style={{ background: '#F8FAFC' }}>
                                  {['Regime', 'Verdict', 'Win Rate', 'Exp R', 'Trades', 'Top Strategy'].map(h => (
                                    <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {dexterData.regimeInsights.map((r: any, i: number) => (
                                  <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                                    <td style={{ padding: '6px 10px', fontWeight: 600 }}>{r.regime}</td>
                                    <td style={{ padding: '6px 10px', color: r.verdict === 'favorable' ? '#15803D' : r.verdict === 'unfavorable' ? '#DC2626' : '#92400E', fontWeight: 600, fontSize: 10, textTransform: 'uppercase' }}>{r.verdict}</td>
                                    <td style={{ padding: '6px 10px' }}>{((r.winRate ?? 0) * 100).toFixed(0)}%</td>
                                    <td style={{ padding: '6px 10px' }}>{r.expectancyR?.toFixed(2)}R</td>
                                    <td style={{ padding: '6px 10px' }}>{r.trades}</td>
                                    <td style={{ padding: '6px 10px', color: '#64748B' }}>{r.dominantStrategy?.replace(/_/g, ' ') ?? '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}

                        {/* Key Metrics */}
                        {dexterData.keyMetrics && (
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 12, color: '#374151', marginBottom: 8 }}>Key Metrics</div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, fontSize: 11 }}>
                              {Object.entries(dexterData.keyMetrics).map(([k, v]) => (
                                <div key={k} style={{ padding: 8, borderRadius: 6, border: '1px solid #E2E8F0', textAlign: 'center' }}>
                                  <div style={{ fontWeight: 700, fontSize: 14 }}>{typeof v === 'number' ? (v as number).toFixed(2) : v as string}</div>
                                  <div style={{ color: '#94A3B8', fontSize: 9, textTransform: 'uppercase' }}>{k.replace(/([A-Z])/g, ' $1').trim()}</div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </Card>
                )}

                {/* Audit tab */}
                {tab === 'audit' && (
                  <Card title="Audit Log">
                    <div style={{ maxHeight: 600, overflowY: 'auto' }}>
                      <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                        <thead style={{ position: 'sticky', top: 0, background: '#F8FAFC' }}>
                          <tr>
                            {['BAR', 'ACTION', 'SYMBOL', 'MESSAGE'].map(h => (
                              <th key={h} style={{ padding: '6px 10px', textAlign: 'left', fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {auditLogs.map((log: any, i: number) => (
                            <tr key={i} style={{ borderTop: '1px solid #F1F5F9' }}>
                              <td style={{ padding: '6px 10px', color: '#94A3B8' }}>{log.bar_index}</td>
                              <td style={{ padding: '6px 10px', fontWeight: 600, fontSize: 10 }}>{log.action}</td>
                              <td style={{ padding: '6px 10px', fontWeight: 700 }}>{log.symbol ?? '—'}</td>
                              <td style={{ padding: '6px 10px', color: '#64748B' }}>{log.message}</td>
                            </tr>
                          ))}
                          {auditLogs.length === 0 && (
                            <tr><td colSpan={4} style={{ padding: 24, textAlign: 'center', color: '#94A3B8', fontSize: 12 }}>No audit entries.</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
