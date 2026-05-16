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
  progress_percent?: number | null;
  current_step?:     string | null;
  error?:            string | null;
}

// Backtest run statuses surfaced by the API (UPPERCASE) — kept aligned
// with normalizeStatus() in src/lib/backtesting/runner/backtestQueue.ts.
type ApiRunStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

function normalizeApiStatus(raw: string | null | undefined): ApiRunStatus {
  const v = String(raw ?? '').toLowerCase();
  if (v === 'queued')                        return 'QUEUED';
  if (v === 'running')                       return 'RUNNING';
  if (v === 'failed')                        return 'FAILED';
  if (v === 'cancelled' || v === 'canceled') return 'CANCELLED';
  if (v === 'completed' || v === 'success' || v === 'partial_success') return 'COMPLETED';
  return 'QUEUED';
}

function statusChipColors(status: ApiRunStatus): { bg: string; color: string } {
  switch (status) {
    case 'COMPLETED': return { bg: '#DCFCE7', color: '#15803D' };
    case 'RUNNING':   return { bg: '#DBEAFE', color: '#1D4ED8' };
    case 'QUEUED':    return { bg: '#FEF3C7', color: '#92400E' };
    case 'FAILED':    return { bg: '#FEE2E2', color: '#DC2626' };
    case 'CANCELLED': return { bg: '#F1F5F9', color: '#64748B' };
  }
}

// ── Safe JSON parsing for backtesting API calls ─────────────────────
// Every backtesting endpoint is contractually JSON. If we ever receive
// HTML (Next.js 404/500, proxy timeout page, auth redirect), surface it
// as a structured error instead of throwing "Unexpected token '<'".
class BacktestApiError extends Error {
  route:       string;
  status:      number;
  contentType: string;
  snippet:     string;
  constructor(opts: { route: string; status: number; contentType: string; snippet: string; message: string }) {
    super(opts.message);
    this.name        = 'BacktestApiError';
    this.route       = opts.route;
    this.status      = opts.status;
    this.contentType = opts.contentType;
    this.snippet     = opts.snippet;
  }
}

async function readJsonOrThrow(res: Response, routeHint?: string) {
  const route       = routeHint ?? res.url;
  const contentType = res.headers.get('content-type') ?? '';
  const text        = await res.text();
  const snippet     = text.slice(0, 220);

  if (!contentType.includes('application/json')) {
    throw new BacktestApiError({
      route, status: res.status, contentType, snippet,
      message: `Expected JSON but received ${contentType || 'unknown content-type'} from ${route}. ` +
               `Status: ${res.status}. Response: ${snippet}`,
    });
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new BacktestApiError({
      route, status: res.status, contentType, snippet,
      message: `Invalid JSON from ${route}. Status: ${res.status}. Response: ${snippet}`,
    });
  }
}

function formatBacktestApiError(err: unknown): string {
  if (err instanceof BacktestApiError) {
    return `Backtesting API returned a non-JSON response. ` +
           `Route: ${err.route} · Status: ${err.status} · Content-Type: ${err.contentType || 'unknown'}. ` +
           `Response: ${err.snippet}`;
  }
  if (err instanceof Error) return err.message;
  return 'Unknown backtesting error';
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

  // ── Queue / polling state ────────────────────────────────────────
  // The selected run's queue lifecycle. Set when POST /api/backtests
  // returns QUEUED and refreshed by the polling loop. `null` means
  // the selected run is an existing COMPLETED row loaded historically.
  const [runStatus,       setRunStatus]       = useState<ApiRunStatus | null>(null);
  const [runProgress,     setRunProgress]     = useState<number>(0);
  const [runCurrentStep,  setRunCurrentStep]  = useState<string | null>(null);
  const [runErrorMessage, setRunErrorMessage] = useState<string | null>(null);
  // Tracks how many consecutive polls have observed status=QUEUED so the
  // UI can warn the user when the worker doesn't appear to be running.
  const [queuedPolls,     setQueuedPolls]     = useState<number>(0);
  // Toast / banner shown after a successful queue.
  const [toast,           setToast]           = useState<string | null>(null);

  const loadRuns = useCallback(async () => {
    try {
      const res = await fetch('/api/backtests', { cache: 'no-store' });
      const data = await readJsonOrThrow(res, '/api/backtests');
      const list = data.runs ?? [];
      setRuns(list);
      if (list.length > 0 && !selectedId) {
        const completed = list.find((r: BacktestRunRow) => r.status === 'completed');
        if (completed) loadDetail(completed.run_id);
      }
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('[Backtesting UI] loadRuns failed', err);
      }
      setError(formatBacktestApiError(err));
    }
  }, [selectedId]);

  const loadDataAvailability = useCallback(async () => {
    try {
      const res = await fetch('/api/backtests/seed-data');
      const data = await readJsonOrThrow(res, '/api/backtests/seed-data');
      setDataReady(data.readySymbols ?? 0);
      setDataTotal(data.totalSymbols ?? 0);
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('[Backtesting UI] loadDataAvailability failed', err);
      }
      setError(formatBacktestApiError(err));
    }
  }, []);

  const loadDetail = async (runId: string) => {
    setSelectedId(runId);
    setLoading(true);
    setError(null);
    const fetchJson = (route: string) =>
      fetch(route).then(r => readJsonOrThrow(r, route));
    try {
      const [analyticsRes, tradesRes, calibRes, auditRes, dexterRes] = await Promise.allSettled([
        fetchJson(`/api/backtests/${runId}/analytics`),
        fetchJson(`/api/backtests/${runId}/trades`),
        fetchJson(`/api/backtests/${runId}/calibration`),
        fetchJson(`/api/backtests/${runId}/audit`).catch(() => ({ logs: [] })),
        fetchJson(`/api/backtests/${runId}/dexter`).catch(() => null),
      ]);

      // Surface any non-JSON / 5xx failures so the user sees a clear cause
      // instead of an empty panel. Audit & dexter are tolerated (best-effort).
      const failures: string[] = [];
      if (analyticsRes.status === 'rejected') failures.push(formatBacktestApiError(analyticsRes.reason));
      if (tradesRes.status    === 'rejected') failures.push(formatBacktestApiError(tradesRes.reason));
      if (calibRes.status     === 'rejected') failures.push(formatBacktestApiError(calibRes.reason));
      if (failures.length > 0) setError(failures.join(' | '));
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
    setToast(null);
    try {
      const res = await fetch('/api/backtests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: {} }),
      });
      // POST /api/backtests is asynchronous by default — see the queue
      // implementation in src/lib/backtesting/runner/backtestQueue.ts.
      // Response shape: { ok, runId, status: 'QUEUED', mode: 'queued' }.
      // The legacy synchronous path is still reachable via
      // BACKTEST_SYNC_MODE=true; in that case mode='sync' and the
      // status is already 'completed' or 'failed'.
      const data = await readJsonOrThrow(res, '/api/backtests');
      if (!res.ok && res.status !== 202) {
        setError(data.error ?? `Run failed (HTTP ${res.status})`);
        return;
      }
      const runId = data.runId as string;
      const status = normalizeApiStatus(data.status);

      // Optimistic sidebar insert so the queued run appears immediately
      // without waiting for the next loadRuns() poll.
      setRuns((prev) => {
        if (prev.some((r) => r.run_id === runId)) return prev;
        const optimistic: BacktestRunRow = {
          run_id:        runId,
          name:          'New Backtest',
          status:        status.toLowerCase(),
          started_at:    new Date().toISOString(),
          completed_at:  null,
          duration_ms:   null,
          signal_count:  0,
          trade_count:   0,
          summary_json:  null,
          config_json:   null,
          progress_percent: 0,
          current_step:     'Queued',
        };
        return [optimistic, ...prev];
      });
      setSelectedId(runId);
      setRunStatus(status);
      setRunProgress(0);
      setRunCurrentStep(status === 'COMPLETED' ? 'Completed' : 'Queued');
      setRunErrorMessage(null);
      setQueuedPolls(0);
      setToast(data.mode === 'sync'
        ? 'Backtest completed (sync mode).'
        : 'Backtest queued successfully — waiting for worker.');

      // Sync-mode short-circuit: jump straight to loadDetail because the
      // run is already terminal by the time the response lands.
      if (data.mode === 'sync' && status === 'COMPLETED') {
        await loadDetail(runId);
      } else {
        // Refresh sidebar in the background so the optimistic row is
        // replaced with the real DB row on the next list query.
        void loadRuns();
      }
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('[Backtesting UI] runNewBacktest failed', err);
      }
      setError(formatBacktestApiError(err));
    } finally {
      setRunning(false);
    }
  };

  const seedData = async () => {
    setSeeding(true);
    setError(null);
    try {
      const res = await fetch('/api/backtests/seed-data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ range: '2y' }),
      });
      const data = await readJsonOrThrow(res, '/api/backtests/seed-data');
      if (!res.ok) setError(data.error ?? `Seed failed (HTTP ${res.status})`);
      await loadDataAvailability();
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.error('[Backtesting UI] seedData failed', err);
      }
      setError(formatBacktestApiError(err));
    }
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

  // Selected-run polling. Fires every 4s while the selected run is
  // QUEUED or RUNNING and stops the moment it reaches a terminal state.
  // On COMPLETED we also trigger a single loadDetail() to populate the
  // analytics/trades/calibration panels.
  useEffect(() => {
    if (!selectedId) return;
    if (runStatus !== 'QUEUED' && runStatus !== 'RUNNING') return;

    let cancelled = false;
    const pollOnce = async () => {
      try {
        const url = `/api/backtests/${selectedId}`;
        const res = await fetch(url, { cache: 'no-store' });
        const data = await readJsonOrThrow(res, url);
        if (cancelled) return;
        const run = data?.run ?? {};
        const next = normalizeApiStatus(run.status);
        setRunStatus(next);
        setRunProgress(Number(run.progressPercent ?? 0));
        setRunCurrentStep(run.currentStep ?? null);
        setRunErrorMessage(run.errorMessage ?? null);
        // Mirror the queue-side fields onto the sidebar row so the
        // status badge / progress chip stay in sync.
        setRuns((prev) => prev.map((r) =>
          r.run_id === selectedId
            ? {
                ...r,
                status:           String(run.rawStatus ?? next.toLowerCase()),
                progress_percent: Number(run.progressPercent ?? 0),
                current_step:     run.currentStep ?? null,
                error:            run.errorMessage ?? null,
                completed_at:     run.completedAt ?? r.completed_at,
              }
            : r,
        ));
        if (next === 'QUEUED') setQueuedPolls((n) => n + 1);
        else                   setQueuedPolls(0);

        if (next === 'COMPLETED') {
          await loadDetail(selectedId);
        }
      } catch (err) {
        if (!cancelled) {
          if (process.env.NODE_ENV !== 'production') {
            console.error('[Backtesting UI] poll failed', err);
          }
          setError(formatBacktestApiError(err));
        }
      }
    };

    void pollOnce();
    const id = setInterval(() => {
      if (!document.hidden) void pollOnce();
    }, 4_000);
    return () => { cancelled = true; clearInterval(id); };
    // loadDetail is stable enough for this poller; including it would
    // restart the interval every time it identity-changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, runStatus]);

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
          <div style={{ background: '#FEE2E2', color: '#7F1D1D', padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 12, lineHeight: 1.5, border: '1px solid #FCA5A5' }}>
            <div style={{ fontWeight: 800, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={13} /> Backtesting API Error
            </div>
            <div style={{ fontWeight: 500, wordBreak: 'break-word' }}>{error}</div>
            <div style={{ marginTop: 4, fontSize: 11, color: '#991B1B' }}>
              Please check server logs for the failing route.
            </div>
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
              {runs.map(r => {
                const rowStatus = normalizeApiStatus(r.status);
                const chip = statusChipColors(rowStatus);
                const handleClick = () => {
                  setSelectedId(r.run_id);
                  setError(null);
                  if (rowStatus === 'COMPLETED') {
                    setRunStatus(null);
                    setRunProgress(0);
                    setRunCurrentStep(null);
                    setRunErrorMessage(null);
                    setQueuedPolls(0);
                    loadDetail(r.run_id);
                  } else {
                    // Queued / running / failed / cancelled — don't try
                    // to load analytics (they will be empty/404). The
                    // polling effect picks it up via runStatus.
                    setRunStatus(rowStatus);
                    setRunProgress(Number(r.progress_percent ?? 0));
                    setRunCurrentStep(r.current_step ?? null);
                    setRunErrorMessage(r.error ?? null);
                    setQueuedPolls(0);
                    // Clear any stale detail-panel state from a previous selection.
                    setSummary(null);
                    setTrades([]);
                    setCalibration([]);
                    setEquityCurve([]);
                    setAuditLogs([]);
                    setDexterData(null);
                  }
                };
                return (
                  <div
                    key={r.run_id}
                    onClick={handleClick}
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
                        background: chip.bg, color: chip.color,
                      }}>{rowStatus}</span>
                    </div>
                    <div style={{ fontSize: 10, color: '#94A3B8', marginTop: 2 }}>
                      {r.trade_count} trades · {r.signal_count} signals
                    </div>
                    {(rowStatus === 'QUEUED' || rowStatus === 'RUNNING') && (
                      <div style={{ fontSize: 10, color: '#1D4ED8', marginTop: 2 }}>
                        {r.current_step ?? rowStatus} · {Number(r.progress_percent ?? 0)}%
                      </div>
                    )}
                    <div style={{ fontSize: 10, color: '#CBD5E1' }}>
                      {new Date(r.started_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Detail panel */}
          <div>
            {toast && (
              <div style={{
                background: '#DBEAFE', color: '#1E40AF', padding: '8px 14px',
                borderRadius: 8, marginBottom: 12, fontSize: 12, fontWeight: 600,
                border: '1px solid #BFDBFE',
              }}>
                {toast}
              </div>
            )}

            {/* Queue lifecycle state — shown whenever the selected run
                is not yet COMPLETED. Replaces the empty analytics panel
                that historical loadDetail used to render. */}
            {selectedId && runStatus && runStatus !== 'COMPLETED' && (
              <Card style={{ marginBottom: 12 }}>
                <div style={{ padding: '18px 20px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    {runStatus === 'RUNNING'
                      ? <RefreshCw size={18} className="spin" color="#1D4ED8" />
                      : runStatus === 'FAILED'
                        ? <AlertTriangle size={18} color="#DC2626" />
                        : runStatus === 'CANCELLED'
                          ? <AlertTriangle size={18} color="#64748B" />
                          : <RefreshCw size={18} className="spin" color="#D97706" />}
                    <span style={{
                      fontSize: 11, fontWeight: 800, letterSpacing: 0.6,
                      padding: '2px 8px', borderRadius: 99,
                      background: statusChipColors(runStatus).bg,
                      color: statusChipColors(runStatus).color,
                    }}>{runStatus}</span>
                    <span style={{ fontSize: 13, fontWeight: 700, color: '#0F172A' }}>
                      {runStatus === 'QUEUED'    && 'Backtest is queued and waiting for worker.'}
                      {runStatus === 'RUNNING'   && 'Backtest is running…'}
                      {runStatus === 'FAILED'    && 'Backtest failed.'}
                      {runStatus === 'CANCELLED' && 'Backtest cancelled.'}
                    </span>
                  </div>
                  {(runStatus === 'QUEUED' || runStatus === 'RUNNING') && (
                    <>
                      <div style={{ fontSize: 12, color: '#475569', marginBottom: 6 }}>
                        {runCurrentStep ?? runStatus} — <strong>{runProgress}%</strong>
                      </div>
                      <div style={{
                        background: '#F1F5F9', borderRadius: 99, height: 6, overflow: 'hidden',
                      }}>
                        <div style={{
                          width: `${Math.max(2, runProgress)}%`,
                          background: runStatus === 'RUNNING' ? '#1D4ED8' : '#D97706',
                          height: '100%',
                          transition: 'width 400ms ease',
                        }} />
                      </div>
                    </>
                  )}
                  {runStatus === 'QUEUED' && queuedPolls >= 8 && (
                    <div style={{ marginTop: 10, fontSize: 11, color: '#92400E' }}>
                      Backtest is still queued. Worker may not be running — try POST <code>/api/backtests/process-queue</code> or restart the scheduler.
                    </div>
                  )}
                  {runStatus === 'FAILED' && runErrorMessage && (
                    <div style={{ marginTop: 8, padding: '8px 12px', background: '#FEE2E2', borderRadius: 6, fontSize: 11, color: '#7F1D1D', wordBreak: 'break-word' }}>
                      <strong>Error:</strong> {runErrorMessage}
                    </div>
                  )}
                </div>
              </Card>
            )}

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
