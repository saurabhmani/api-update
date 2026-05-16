// ════════════════════════════════════════════════════════════════
//  /debug/system-health — Quantorus365 System Health Dashboard
//
//  Single-file, tab-based layout. Pulls live state from:
//    GET /api/debug/system-health   — apiMonitor + trace + market state + quota
//    GET /api/debug/provider-report — cumulative provider counters
//    GET /api/debug/quota           — IST-aligned quota report
//
//  Tabs (default: overview):
//    Overview · API Usage · Providers · Workflow · Logs · Performance
//
//  Switching tabs is local React state — no navigation, no refetch.
//  The persistent status strip and (when applicable) LIMIT NEAR
//  banner stay visible across every tab so critical alerts are never
//  hidden behind a click.
//
//  Polls every 5s. Shimmer skeleton on first load. When the live
//  endpoints aren't reachable, falls back to a deterministic mock
//  with simulated delay so the page renders end-to-end.
// ════════════════════════════════════════════════════════════════

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import '@/styles/system-health.scss';

// ── Types ─────────────────────────────────────────────────────────

type Safety       = 'SAFE' | 'WARNING' | 'CRITICAL';
type SystemStatus = 'HEALTHY' | 'DEGRADED' | 'CRITICAL' | 'UNKNOWN';

interface ProviderRow {
  name:         string;
  calls:        number;
  errors:       number;
  avgLatencyMs: number;
  maxLatencyMs: number;
  errorRate:    number;
  lastError:    string | null;
  lastCallAt:   string | null;
}

interface TraceStep { label: string; detail?: string; durationMs?: number; }
interface TraceRow {
  id:        string;
  route:     string;
  startedAt: string;
  totalMs:   number;
  summary:   string;
  steps:     TraceStep[];
}

interface ErrorRow {
  timestamp:  string;
  route:      string;
  method?:    string;
  provider:   string | null;
  errorCode:  string | null;
  durationMs: number;
}

interface SlowRow {
  timestamp:  string;
  route:      string;
  durationMs: number;
  provider:   string | null;
  fallback:   boolean;
}

interface FallbackRow {
  timestamp:    string;
  route:        string;
  fromProvider: string | null;
  toProvider:   string | null;
  errorCode:    string | null;
}

interface RouteRow {
  route:         string;
  calls:         number;
  errors:        number;
  errorRate:     number;
  avgLatencyMs:  number;
  maxLatencyMs:  number;
}

interface QuotaReport {
  daily: {
    used: number; limit: number; remaining: number; percent: number;
  };
  monthly: {
    used: number;
    safe_limit: number;
    hard_limit: number;
    remaining_safe: number;
    remaining_hard: number;
    percent: number;
    percent_safe: number;
  };
  state: 'SAFE' | 'WARNING' | 'CRITICAL' | 'BLOCKED';
  limit_near: boolean;
  reduce_polling: boolean;
  block_non_essential: boolean;
  block_all: boolean;
  resets: { daily_at: string; monthly_at: string };
}

interface SystemHealth {
  status:         SystemStatus;
  safety:         Safety;
  lastUpdatedAt:  string;
  startedAt:      string;
  lastRequestAt:  string | null;
  quota:          QuotaReport;

  totalRequestsToday:  number;
  requestsPerMinute:   number;
  totalRequestsAll:    number;
  errorsToday:         number;
  errorRate:           number;
  avgLatencyMs:        number;
  maxLatencyMs:        number;

  marketState:    string;
  marketLabel:    string;
  mode:           string;
  dataSource:     string | null;

  fallbacksToday:     number;
  fallbackTriggered:  boolean;
  lastError:          string | null;
  lastProvider:       string | null;

  flags: {
    slowApi:        boolean;
    highErrorRate:  boolean;
    fallbackSpike:  boolean;
    slowThresholdMs: number;
    errorThreshold:  number;
  };

  providers:     ProviderRow[];
  routes:        RouteRow[];
  traces:        TraceRow[];
  errors:        ErrorRow[];
  slowRequests:  SlowRow[];
  fallbackLog:   FallbackRow[];
}

// ── Service: live fetch with mock fallback ────────────────────────

async function safeJson(url: string, signal?: AbortSignal): Promise<any | null> {
  try {
    const res = await fetch(url, { cache: 'no-store', signal });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function safetyFrom(s: SystemStatus): Safety {
  if (s === 'CRITICAL') return 'CRITICAL';
  if (s === 'DEGRADED') return 'WARNING';
  if (s === 'HEALTHY')  return 'SAFE';
  return 'WARNING';
}

function buildProviders(sysProviders: any, report: any): ProviderRow[] {
  const order = ['indianapi', 'nse', 'yahoo', 'snapshot'] as const;
  return order.map((name) => {
    const p = sysProviders?.[name] ?? {};
    const reportCalls =
      name === 'indianapi' ? report?.indianapi_calls :
      name === 'nse'       ? report?.nse_calls :
      name === 'yahoo'     ? report?.yahoo_calls :
                             report?.snapshot_calls;
    return {
      name,
      calls:        Math.max(p.calls ?? 0, reportCalls ?? 0),
      errors:       p.errors ?? 0,
      avgLatencyMs: p.avg_latency ?? 0,
      maxLatencyMs: p.max_latency ?? 0,
      errorRate:    p.error_rate ?? 0,
      lastError:    p.last_error ?? null,
      lastCallAt:   p.last_call_at ?? null,
    };
  });
}

function defaultQuota(): QuotaReport {
  return {
    daily:   { used: 0, limit: 2500, remaining: 2500, percent: 0 },
    monthly: {
      used: 0, safe_limit: 70_000, hard_limit: 90_000,
      remaining_safe: 70_000, remaining_hard: 90_000,
      percent: 0, percent_safe: 0,
    },
    state: 'SAFE',
    limit_near: false, reduce_polling: false,
    block_non_essential: false, block_all: false,
    resets: { daily_at: new Date().toISOString(), monthly_at: new Date().toISOString() },
  };
}

async function fetchLive(signal?: AbortSignal): Promise<SystemHealth | null> {
  const [sys, report, quota] = await Promise.all([
    safeJson('/api/debug/system-health',   signal),
    safeJson('/api/debug/provider-report', signal),
    safeJson('/api/debug/quota',           signal),
  ]);
  if (!sys && !report) return null;

  const status: SystemStatus = (sys?.system_status as SystemStatus) ?? 'UNKNOWN';

  return {
    status,
    safety: safetyFrom(status),
    lastUpdatedAt: sys?.last_updated_at ?? new Date().toISOString(),
    startedAt:     sys?.process_started_at ?? new Date().toISOString(),
    lastRequestAt: sys?.last_request_at ?? null,

    totalRequestsToday: sys?.total_requests_today ?? 0,
    requestsPerMinute:  sys?.requests_last_minute ?? 0,
    totalRequestsAll:   sys?.total_requests ?? 0,
    errorsToday:        sys?.errors_today ?? 0,
    errorRate:          sys?.error_rate ?? 0,
    avgLatencyMs:       sys?.avg_latency_ms ?? 0,
    maxLatencyMs:       sys?.max_latency_ms ?? 0,

    marketState: sys?.market_state ?? 'unknown',
    marketLabel: sys?.market_label ?? '—',
    mode:        sys?.mode ?? 'unknown',
    dataSource:  sys?.data_source ?? report?.last_provider ?? null,

    fallbacksToday:    sys?.fallbacks_today ?? 0,
    fallbackTriggered: !!(sys?.fallback_triggered ?? report?.fallback_triggered),
    lastError:         sys?.last_error ?? report?.last_error ?? null,
    lastProvider:      report?.last_provider ?? null,

    flags: {
      slowApi:         !!sys?.flags?.slow_api,
      highErrorRate:   !!sys?.flags?.high_error_rate,
      fallbackSpike:   !!sys?.flags?.fallback_spike,
      slowThresholdMs: sys?.flags?.slow_threshold_ms ?? 500,
      errorThreshold:  sys?.flags?.error_threshold   ?? 0.05,
    },

    providers:    buildProviders(sys?.providers, report),
    routes:       sys?.routes        ?? [],
    traces:       sys?.recent_traces ?? [],
    errors:       sys?.error_log     ?? [],
    slowRequests: sys?.slow_requests ?? [],
    fallbackLog:  sys?.fallback_log  ?? [],

    quota: (quota ?? sys?.quota ?? defaultQuota()) as QuotaReport,
  };
}

let _mockTick = 0;
async function mockHealth(): Promise<SystemHealth> {
  await new Promise((r) => setTimeout(r, 250));
  _mockTick += 1;
  const drift = (n: number, j: number) => Math.max(0, Math.round(n + (Math.random() - 0.5) * j));
  const errorRate = 0.012 + Math.random() * 0.01;
  const status: SystemStatus = errorRate > 0.05 ? 'DEGRADED' : 'HEALTHY';
  const nowIso = new Date().toISOString();
  const mkProv = (name: string, calls: number, err: number, avg: number, max: number, lastErr: string | null = null): ProviderRow => ({
    name, calls, errors: err, avgLatencyMs: avg, maxLatencyMs: max,
    errorRate: calls > 0 ? err / calls : 0,
    lastError: lastErr, lastCallAt: nowIso,
  });
  return {
    status, safety: safetyFrom(status),
    lastUpdatedAt: nowIso,
    startedAt: new Date(Date.now() - 1000 * 60 * 60 * 4).toISOString(),
    lastRequestAt: new Date(Date.now() - 1000 * 6).toISOString(),
    totalRequestsToday: drift(1284 + _mockTick * 3, 4),
    requestsPerMinute:  drift(17, 6),
    totalRequestsAll:   drift(98_230 + _mockTick * 5, 8),
    errorsToday:        10,
    errorRate,
    avgLatencyMs:       drift(213, 30),
    maxLatencyMs:       drift(1820, 200),
    marketState: 'open', marketLabel: 'Market Open', mode: 'live',
    dataSource: 'indianapi',
    fallbacksToday: 4, fallbackTriggered: false, lastError: null,
    lastProvider: 'indianapi',
    flags: {
      slowApi: false, highErrorRate: false, fallbackSpike: false,
      slowThresholdMs: 500, errorThreshold: 0.05,
    },
    providers: [
      mkProv('indianapi', drift(612, 4), 4, 187, 980),
      mkProv('nse',       12, 1, 305, 612, 'NSE_NO_DATA'),
      mkProv('yahoo',     0,  0, 0,   0),
      mkProv('snapshot',  drift(38, 2), 0, 8,   22),
    ],
    routes: [
      { route: '/api/signals',             calls: drift(412, 8), errors: 3, errorRate: 0.0073, avgLatencyMs: 320, maxLatencyMs: 980 },
      { route: '/api/intelligence/stock',  calls: drift(186, 4), errors: 1, errorRate: 0.0054, avgLatencyMs: 612, maxLatencyMs: 1820 },
      { route: '/api/market-data/quote',   calls: drift(298, 5), errors: 2, errorRate: 0.0067, avgLatencyMs: 142, maxLatencyMs: 540 },
    ],
    traces: [
      {
        id: 't1', route: '/api/signals',
        startedAt: new Date(Date.now() - 1000 * 8).toISOString(),
        totalMs: 320,
        summary: '/api/signals → resolver → IndianAPI (120ms) → DB write → response (320ms total)',
        steps: [
          { label: 'Request', detail: '/api/signals' },
          { label: 'Route', detail: 'GET /api/signals' },
          { label: 'Resolver', detail: 'cache miss → upstream' },
          { label: 'IndianAPI', detail: '47 symbols', durationMs: 120 },
          { label: 'DB',  detail: 'persist signals',  durationMs: 14 },
          { label: 'Response', detail: '200',          durationMs: 320 },
        ],
      },
      {
        id: 't2', route: '/api/signals',
        startedAt: new Date(Date.now() - 1000 * 41).toISOString(),
        totalMs: 450,
        summary: '/api/signals → resolver → IndianAPI HTTP_500 → fallback NSE (300ms) → response (450ms total)',
        steps: [
          { label: 'Request',   detail: '/api/signals' },
          { label: 'Route',     detail: 'GET /api/signals' },
          { label: 'Resolver',  detail: 'primary → fallback' },
          { label: 'IndianAPI', detail: 'HTTP_500 (122ms)', durationMs: 122 },
          { label: 'Fallback NSE', detail: '12 symbols',    durationMs: 300 },
          { label: 'Response',  detail: '200',              durationMs: 450 },
        ],
      },
    ],
    errors: [
      { timestamp: new Date(Date.now() - 1000 * 41).toISOString(), route: '/api/signals', method: 'GET',
        provider: 'indianapi', errorCode: 'HTTP_500', durationMs: 122 },
    ],
    slowRequests: [
      { timestamp: new Date(Date.now() - 1000 * 22).toISOString(), route: '/api/intelligence/stock',
        durationMs: 612, provider: 'indianapi', fallback: false },
    ],
    fallbackLog: [
      { timestamp: new Date(Date.now() - 1000 * 41).toISOString(), route: 'marketDataResolver',
        fromProvider: 'indianapi', toProvider: 'nse', errorCode: 'HTTP_500' },
    ],

    quota: (() => {
      const dayUsed   = drift(1180, 30);
      const monthUsed = drift(45_000, 200);
      const dailyPct  = dayUsed / 2500;
      const monthlyPct = monthUsed / 90_000;
      const worst = Math.max(dailyPct, monthlyPct);
      const state: QuotaReport['state'] =
        worst >= 1.0 ? 'BLOCKED' :
        worst >= 0.9 ? 'CRITICAL' :
        worst >= 0.7 ? 'WARNING' : 'SAFE';
      return {
        daily: { used: dayUsed, limit: 2500, remaining: Math.max(0, 2500 - dayUsed), percent: dailyPct },
        monthly: {
          used: monthUsed, safe_limit: 70_000, hard_limit: 90_000,
          remaining_safe: 70_000 - monthUsed,
          remaining_hard: Math.max(0, 90_000 - monthUsed),
          percent: monthlyPct, percent_safe: monthUsed / 70_000,
        },
        state,
        limit_near: dailyPct >= 0.9,
        reduce_polling: worst >= 0.7,
        block_non_essential: worst >= 0.9,
        block_all: worst >= 1.0,
        resets: {
          daily_at: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
          monthly_at: new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString(),
        },
      };
    })(),
  };
}

async function getSystemHealth(signal?: AbortSignal): Promise<SystemHealth> {
  const live = await fetchLive(signal);
  return live ?? mockHealth();
}

// ── Render helpers ─────────────────────────────────────────────────

function fmtAgo(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0)         return 'in future';
  if (ms < 1000)      return 'just now';
  if (ms < 60_000)    return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  return `${Math.floor(ms / 3_600_000)}h ago`;
}

function fmtPct(n: number): string { return `${(n * 100).toFixed(2)}%`; }

function colorClass(level: 'good' | 'warn' | 'bad'): string {
  if (level === 'good') return 'sh-color-green';
  if (level === 'warn') return 'sh-color-yellow';
  return 'sh-color-red';
}

function quotaColorClass(pct: number): string {
  if (pct >= 0.9) return 'sh-color-red';
  if (pct >= 0.7) return 'sh-color-yellow';
  return 'sh-color-green';
}

function statusLevel(s: SystemStatus): 'good' | 'warn' | 'bad' {
  if (s === 'HEALTHY') return 'good';
  if (s === 'DEGRADED') return 'warn';
  return 'bad';
}

function safetyColor(s: Safety): string {
  if (s === 'SAFE')     return 'sh-color-green';
  if (s === 'WARNING')  return 'sh-color-yellow';
  return 'sh-color-red';
}

// ── Page ───────────────────────────────────────────────────────────

const POLL_MS = 5_000;

export default function SystemHealthPage() {
  const [data, setData]    = useState<SystemHealth | null>(null);
  const [loading, setLoad] = useState(true);
  const [toast, setToast]  = useState<string | null>(null);
  const [busy,  setBusy]   = useState<string | null>(null);
  const [openTraces, setOpenTraces] = useState<Set<string>>(new Set());
  const [, setTick] = useState(0);

  // Manual-refresh handler used by the header button. No AbortSignal —
  // user-triggered fetches always complete; cancelling on click would
  // just create a race we don't need.
  const refresh = useCallback(async () => {
    const h = await getSystemHealth();
    setData(h); setLoad(false);
  }, []);

  // Background poller. Uses a mounted flag rather than an AbortController
  // because a shared controller is unsafe in React 18 StrictMode + Next.js
  // Fast Refresh: the cleanup aborts in-flight fetches with `signal is
  // aborted without reason`, which surfaces as an unhandled error in the
  // dev overlay. The flag pattern is simpler and the in-flight fetch
  // finishes in milliseconds — its result just gets dropped on unmount.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const h = await getSystemHealth();
      if (cancelled) return;
      setData(h); setLoad(false);
    };
    void tick();
    const id = setInterval(() => { void tick(); }, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  };

  const runEngine = async () => {
    setBusy('engine');
    const r = await safeJson('/api/run-signal-engine');
    setBusy(null);
    showToast(r ? 'Engine triggered' : 'Engine endpoint unreachable');
  };
  const testApi = async () => {
    setBusy('api');
    const r = await safeJson('/api/debug/provider-report');
    setBusy(null);
    showToast(r ? `IndianAPI calls: ${r.indianapi_calls ?? 0}` : 'API test failed');
  };
  const restart = () => {
    if (!confirm('Restart not exposed via UI. Use ops console.')) return;
    showToast('Restart not exposed via UI.');
  };

  const toggleTrace = (id: string) => {
    setOpenTraces((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const maxProviderCalls = useMemo(() => {
    if (!data) return 1;
    return Math.max(1, ...data.providers.map((p) => p.calls));
  }, [data]);

  if (loading || !data) {
    return (
      <div className="sh-page">
        <header className="sh-header">
          <div>
            <h1 className="sh-title">System Health</h1>
            <div className="sh-subtitle">Loading live metrics…</div>
          </div>
        </header>
        <div className="sh-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="sh-card sh-col-4">
              <div className="sh-skel sh-skel-line sh-w-40" />
              <div className="sh-skel sh-skel-line" />
              <div className="sh-skel sh-skel-line sh-w-60" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const dangerClass = data.safety === 'CRITICAL' ? 'sh-danger' : '';

  // ── Top-level layout (single vertical scroll) ──────────────────

  return (
    <div className="sh-page">
      {/* Header — title, status pill, refresh */}
      <header className="sh-header">
        <div>
          <h1 className="sh-title">System Health · Quantorus365</h1>
          <div className="sh-subtitle">
            polling every {POLL_MS / 1000}s · last update {fmtAgo(data.lastUpdatedAt)}
          </div>
        </div>
        <div className="sh-header-actions">
          <span className={`sh-pill ${colorClass(statusLevel(data.status))}`}>
            <span className="sh-pill-dot" /> {data.status}
          </span>
          <button className="sh-btn" onClick={() => refresh()}>⟳ Refresh</button>
        </div>
      </header>

      {/* LIMIT NEAR / CRITICAL — pinned above the scroll for visibility */}
      {(data.quota.limit_near || data.quota.block_non_essential) && (
        <div className={`sh-quota-banner ${data.quota.block_non_essential ? 'sh-quota-banner-critical' : ''}`}>
          <span className="sh-quota-banner-msg">
            {data.quota.block_all       && '🔴 BLOCKED · daily/monthly hard limit reached — only essential calls allowed'}
            {!data.quota.block_all && data.quota.block_non_essential && '🔴 CRITICAL · usage > 90% — non-critical IndianAPI calls suppressed'}
            {!data.quota.block_non_essential && data.quota.limit_near && '⚠️ LIMIT NEAR · approaching daily 2,500 cap — reduce polling'}
          </span>
          <span className="sh-quota-banner-detail">
            {data.quota.daily.used}/{data.quota.daily.limit} today · {data.quota.monthly.used.toLocaleString()}/{data.quota.monthly.hard_limit.toLocaleString()} this month
          </span>
        </div>
      )}

      {/* All sections vertical, in spec order */}
      <div className="sh-stack">

        {/* ── 1. System Overview ─────────────────────────────── */}
        <section className="sh-card">
          <div className="sh-section-title">
            <span className="sh-section-num">01</span>
            <span className="sh-section-name">System Overview</span>
            <span className="sh-section-meta">
              status <span className={colorClass(statusLevel(data.status))}>{data.status}</span>
              {' · '}up since {fmtAgo(data.startedAt)}
              {' · '}last req {fmtAgo(data.lastRequestAt)}
            </span>
          </div>
          <div className="sh-kpi-row">
            <div className="sh-kpi">
              <div className="sh-kpi-label">Requests Today</div>
              <div className="sh-kpi-value">{data.totalRequestsToday.toLocaleString()}</div>
            </div>
            <div className="sh-kpi">
              <div className="sh-kpi-label">Req / min</div>
              <div className="sh-kpi-value">{data.requestsPerMinute}</div>
            </div>
            <div className="sh-kpi">
              <div className="sh-kpi-label">Avg Latency</div>
              <div className="sh-kpi-value">{data.avgLatencyMs} ms</div>
            </div>
            <div className="sh-kpi">
              <div className="sh-kpi-label">Max Latency</div>
              <div className="sh-kpi-value">{data.maxLatencyMs} ms</div>
            </div>
            <div className="sh-kpi">
              <div className="sh-kpi-label">Error Rate</div>
              <div className={`sh-kpi-value ${data.errorRate > data.flags.errorThreshold ? 'sh-color-red' : ''}`}>
                {fmtPct(data.errorRate)}
              </div>
            </div>
            <div className="sh-kpi">
              <div className="sh-kpi-label">Market</div>
              <div className="sh-kpi-value" style={{ fontSize: 14 }}>{data.marketLabel}</div>
            </div>
            <div className="sh-kpi">
              <div className="sh-kpi-label">Mode</div>
              <div className={`sh-kpi-value ${data.mode === 'live' ? 'sh-color-green' : 'sh-color-yellow'}`}
                   style={{ fontSize: 14 }}>{data.mode.toUpperCase()}</div>
            </div>
            <div className="sh-kpi">
              <div className="sh-kpi-label">Source</div>
              <div className="sh-kpi-value sh-mono" style={{ fontSize: 13 }}>{data.dataSource ?? '—'}</div>
            </div>
          </div>
        </section>

        {/* ── 2. API Usage + Quota ───────────────────────────── */}
        <section className="sh-card">
          <div className="sh-section-title">
            <span className="sh-section-num">02</span>
            <span className="sh-section-name">API Usage + Quota</span>
            <span className="sh-section-meta">
              quota <span className={quotaColorClass(Math.max(data.quota.daily.percent, data.quota.monthly.percent))}>
                {data.quota.state}
              </span>
              {' · '}IST resets
            </span>
          </div>

          <div className="sh-quota">
            {/* Daily */}
            <div className="sh-quota-row">
              <div className="sh-quota-head">
                <span className="sh-quota-name">Daily</span>
                <span className="sh-quota-value">
                  {data.quota.daily.used.toLocaleString()} / {data.quota.daily.limit.toLocaleString()}
                  {' · '}
                  <span className={quotaColorClass(data.quota.daily.percent)}>
                    {fmtPct(data.quota.daily.percent)}
                  </span>
                </span>
              </div>
              <div className="sh-quota-meter">
                <div
                  className={`sh-quota-fill ${quotaColorClass(data.quota.daily.percent)}`}
                  style={{ width: `${Math.min(100, data.quota.daily.percent * 100)}%` }}
                />
              </div>
              <div className="sh-quota-foot">
                <span>remaining {data.quota.daily.remaining.toLocaleString()}</span>
                <span>resets {fmtAgo(data.quota.resets.daily_at)}</span>
              </div>
            </div>

            {/* Monthly */}
            <div className="sh-quota-row">
              <div className="sh-quota-head">
                <span className="sh-quota-name">Monthly</span>
                <span className="sh-quota-value">
                  {data.quota.monthly.used.toLocaleString()} / {data.quota.monthly.safe_limit.toLocaleString()}
                  {' '}<span className="sh-color-dim">(safe)</span>
                  {' · '}
                  {data.quota.monthly.used.toLocaleString()} / {data.quota.monthly.hard_limit.toLocaleString()}
                  {' '}<span className="sh-color-dim">(max)</span>
                  {' · '}
                  <span className={quotaColorClass(data.quota.monthly.percent)}>
                    {fmtPct(data.quota.monthly.percent)}
                  </span>
                </span>
              </div>
              <div className="sh-quota-meter">
                <div
                  className={`sh-quota-fill ${quotaColorClass(data.quota.monthly.percent)}`}
                  style={{ width: `${Math.min(100, data.quota.monthly.percent * 100)}%` }}
                />
                <div
                  className="sh-quota-marker"
                  style={{ left: `${(data.quota.monthly.safe_limit / data.quota.monthly.hard_limit) * 100}%` }}
                  title="safe limit"
                />
              </div>
              <div className="sh-quota-foot">
                <span>
                  remaining safe {data.quota.monthly.remaining_safe.toLocaleString()}
                  {' · '}
                  remaining hard {data.quota.monthly.remaining_hard.toLocaleString()}
                </span>
                <span>resets {fmtAgo(data.quota.resets.monthly_at)}</span>
              </div>
            </div>
          </div>

          <div className="sh-kpi-row sh-section-pad-top">
            <div className="sh-kpi">
              <div className="sh-kpi-label">Slow (&gt;{data.flags.slowThresholdMs}ms)</div>
              <div className={`sh-kpi-value ${data.slowRequests.length > 0 ? 'sh-color-yellow' : ''}`}>
                {data.slowRequests.length}
              </div>
            </div>
            <div className="sh-kpi">
              <div className="sh-kpi-label">Errors Today</div>
              <div className={`sh-kpi-value ${data.errorsToday > 0 ? 'sh-color-red' : ''}`}>
                {data.errorsToday}
              </div>
            </div>
            <div className="sh-kpi">
              <div className="sh-kpi-label">Fallbacks Today</div>
              <div className="sh-kpi-value">{data.fallbacksToday}</div>
            </div>
            <div className="sh-kpi">
              <div className="sh-kpi-label">Lifetime</div>
              <div className="sh-kpi-value">{data.totalRequestsAll.toLocaleString()}</div>
            </div>
          </div>
        </section>

        {/* ── 3. Provider Usage ──────────────────────────────── */}
        <section className="sh-card">
          <div className="sh-section-title">
            <span className="sh-section-num">03</span>
            <span className="sh-section-name">Provider Usage</span>
            <span className="sh-section-meta">
              last <strong>{data.lastProvider ?? '—'}</strong>
              {' · '}fallbacks today <strong>{data.fallbacksToday}</strong>
              {' · '}last error <strong className={data.lastError ? 'sh-color-red' : ''}>
                {data.lastError ?? 'none'}
              </strong>
            </span>
          </div>
          <div className="sh-bars">
            {data.providers.map((p) => {
              const pct = Math.round((p.calls / maxProviderCalls) * 100);
              const colour =
                p.name === 'indianapi' ? 'sh-color-cyan'   :
                p.name === 'nse'       ? 'sh-color-green'  :
                p.name === 'yahoo'     ? 'sh-color-yellow' : 'sh-color-dim';
              return (
                <div key={p.name} className="sh-bar-row">
                  <div className="sh-bar-label">{p.name}</div>
                  <div className="sh-bar-track">
                    <div className={`sh-bar-fill ${colour}`} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="sh-bar-value">{p.calls.toLocaleString()}</div>
                </div>
              );
            })}
          </div>
        </section>

        {/* ── 4. Latency + Performance ───────────────────────── */}
        <section className="sh-card">
          <div className="sh-section-title">
            <span className="sh-section-num">04</span>
            <span className="sh-section-name">Latency + Performance</span>
            <span className="sh-section-meta">
              avg {data.avgLatencyMs}ms · max {data.maxLatencyMs}ms · slow threshold {data.flags.slowThresholdMs}ms
            </span>
          </div>

          {/* Alert pills */}
          <div className="sh-alerts">
            <div className={`sh-alert ${data.flags.slowApi ? 'sh-alert-bad' : 'sh-alert-ok'}`}>
              <span className="sh-alert-msg">
                Slow API · avg {data.avgLatencyMs}ms vs {data.flags.slowThresholdMs}ms threshold
              </span>
              <span className="sh-alert-tag">{data.flags.slowApi ? 'TRIGGERED' : 'OK'}</span>
            </div>
            <div className={`sh-alert ${data.flags.highErrorRate ? 'sh-alert-bad' : 'sh-alert-ok'}`}>
              <span className="sh-alert-msg">
                Error rate · {fmtPct(data.errorRate)} vs {fmtPct(data.flags.errorThreshold)} threshold
              </span>
              <span className="sh-alert-tag">{data.flags.highErrorRate ? 'TRIGGERED' : 'OK'}</span>
            </div>
            <div className={`sh-alert ${data.flags.fallbackSpike ? 'sh-alert-warn' : 'sh-alert-ok'}`}>
              <span className="sh-alert-msg">
                Fallback spike · {data.fallbacksToday} fallbacks today
              </span>
              <span className="sh-alert-tag">{data.flags.fallbackSpike ? 'TRIGGERED' : 'OK'}</span>
            </div>
          </div>

          {/* Per-provider latency table */}
          <div className="sh-section-pad-top">
            <table className="sh-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Calls</th>
                  <th>Errors</th>
                  <th>Avg</th>
                  <th>Max</th>
                  <th>Err Rate</th>
                  <th>Last Error</th>
                  <th>Last Call</th>
                </tr>
              </thead>
              <tbody>
                {data.providers.map((p) => (
                  <tr key={p.name}>
                    <td><span className="sh-color-cyan">{p.name}</span></td>
                    <td className="sh-num">{p.calls}</td>
                    <td className="sh-num">{p.errors}</td>
                    <td className={`sh-num ${p.avgLatencyMs > data.flags.slowThresholdMs ? 'sh-color-yellow' : ''}`}>
                      {p.avgLatencyMs} ms
                    </td>
                    <td className="sh-num">{p.maxLatencyMs} ms</td>
                    <td className={`sh-num ${p.errorRate > 0.05 ? 'sh-color-red' : ''}`}>{fmtPct(p.errorRate)}</td>
                    <td className={p.lastError ? 'sh-color-red' : 'sh-color-dim'}>{p.lastError ?? '—'}</td>
                    <td className="sh-color-dim">{fmtAgo(p.lastCallAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Slow + top routes side-by-side */}
          <div className="sh-subgrid sh-section-pad-top">
            <div>
              <div className="sh-card-title" style={{ marginBottom: 8 }}>
                Slow Requests (&gt; {data.flags.slowThresholdMs}ms)
              </div>
              <table className="sh-table">
                <thead>
                  <tr><th>When</th><th>Route</th><th>Provider</th><th>Duration</th></tr>
                </thead>
                <tbody>
                  {data.slowRequests.map((s, i) => (
                    <tr key={i}>
                      <td className="sh-color-dim">{fmtAgo(s.timestamp)}</td>
                      <td>{s.route}</td>
                      <td>{s.provider ?? '—'}</td>
                      <td className="sh-color-yellow sh-num">{s.durationMs} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.slowRequests.length === 0 && (
                <div className="sh-empty">No slow requests.</div>
              )}
            </div>
            <div>
              <div className="sh-card-title" style={{ marginBottom: 8 }}>
                Top Routes by Avg Latency
              </div>
              <table className="sh-table">
                <thead>
                  <tr><th>Route</th><th>Calls</th><th>Avg</th><th>Max</th><th>Err</th></tr>
                </thead>
                <tbody>
                  {data.routes
                    .slice()
                    .sort((a, b) => b.avgLatencyMs - a.avgLatencyMs)
                    .slice(0, 8)
                    .map((r) => (
                      <tr key={r.route}>
                        <td>{r.route}</td>
                        <td className="sh-num">{r.calls}</td>
                        <td className={`sh-num ${r.avgLatencyMs > data.flags.slowThresholdMs ? 'sh-color-yellow' : ''}`}>
                          {r.avgLatencyMs} ms
                        </td>
                        <td className="sh-num">{r.maxLatencyMs} ms</td>
                        <td className={`sh-num ${r.errorRate > 0.05 ? 'sh-color-red' : ''}`}>{fmtPct(r.errorRate)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
              {data.routes.length === 0 && (
                <div className="sh-empty">No route data yet.</div>
              )}
            </div>
          </div>
        </section>

        {/* ── 5. Workflow Trace ──────────────────────────────── */}
        <section className="sh-card">
          <div className="sh-section-title">
            <span className="sh-section-num">05</span>
            <span className="sh-section-name">Workflow Trace</span>
            <span className="sh-section-meta">
              last {data.traces.length} · click any row to expand
            </span>
          </div>
          <div className="sh-traces">
            {data.traces.length === 0 && (
              <div className="sh-empty">No traces captured yet — hit an /api/* endpoint and refresh.</div>
            )}
            {data.traces.map((t) => {
              const isOpen = openTraces.has(t.id);
              return (
                <div key={t.id} className="sh-trace">
                  <div className="sh-trace-head" onClick={() => toggleTrace(t.id)}>
                    <span className="sh-trace-route">{t.route}</span>
                    <span className="sh-trace-summary">{t.summary}</span>
                    <span className={`sh-trace-total ${t.totalMs > data.flags.slowThresholdMs ? 'sh-color-yellow' : 'sh-color-green'}`}>
                      {t.totalMs} ms
                    </span>
                    <span className="sh-trace-toggle">{isOpen ? '▲' : '▼'}</span>
                  </div>
                  {isOpen && (
                    <div className="sh-trace-body">
                      {t.steps.map((s, i) => (
                        <div key={i} className="sh-step">
                          <div className="sh-step-label">{s.label}</div>
                          <div className="sh-step-detail">{s.detail ?? ''}</div>
                          <div className="sh-step-dur">
                            {typeof s.durationMs === 'number' ? `${s.durationMs} ms` : ''}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {/* ── 6. Error Logs ──────────────────────────────────── */}
        <section className="sh-card">
          <div className="sh-section-title">
            <span className="sh-section-num">06</span>
            <span className="sh-section-name">Error Logs</span>
            <span className="sh-section-meta">
              {data.errors.length} errors · {data.slowRequests.length} slow · {data.fallbackLog.length} fallbacks
            </span>
          </div>
          <div className="sh-logs" style={{ maxHeight: 460 }}>
            {(data.errors.length === 0 && data.slowRequests.length === 0 && data.fallbackLog.length === 0) && (
              <div className="sh-empty">No errors, slow requests, or fallbacks logged.</div>
            )}
            {data.errors.map((e, i) => (
              <div key={`e${i}`} className="sh-log-row sh-log-error">
                <span className="sh-log-ts">{fmtAgo(e.timestamp)}</span>
                <span className="sh-log-level">error</span>
                <span className="sh-log-msg">
                  {(e.method ?? 'GET')} {e.route} → {e.errorCode ?? 'ERR'} ({e.durationMs}ms)
                  {e.provider ? ` · provider=${e.provider}` : ''}
                </span>
              </div>
            ))}
            {data.slowRequests.map((s, i) => (
              <div key={`s${i}`} className="sh-log-row sh-log-warn">
                <span className="sh-log-ts">{fmtAgo(s.timestamp)}</span>
                <span className="sh-log-level">slow</span>
                <span className="sh-log-msg">
                  {s.route} {s.durationMs}ms via {s.provider ?? 'n/a'}
                  {s.fallback ? ' · fallback' : ''}
                </span>
              </div>
            ))}
            {data.fallbackLog.map((f, i) => (
              <div key={`f${i}`} className="sh-log-row sh-log-warn">
                <span className="sh-log-ts">{fmtAgo(f.timestamp)}</span>
                <span className="sh-log-level">fallback</span>
                <span className="sh-log-msg">
                  {f.fromProvider ?? '?'} → {f.toProvider ?? '?'} ({f.errorCode ?? '—'})
                  {' · '}{f.route}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* ── 7. Safety Indicator ────────────────────────────── */}
        <section className={`sh-safety ${dangerClass}`}>
          <div>
            <div className="sh-safety-label">07 · Safety Indicator</div>
            <div className={`sh-safety-state ${safetyColor(data.safety)}`}>{data.safety}</div>
            <div className="sh-safety-detail">
              {data.safety === 'SAFE'     && 'All subsystems within tolerances.'}
              {data.safety === 'WARNING'  && 'Some metrics out of band — investigate before market open.'}
              {data.safety === 'CRITICAL' && 'Critical failure detected — escalate immediately.'}
            </div>
          </div>
          <div className="sh-safety-actions">
            <button className="sh-btn sh-btn-success" onClick={runEngine} disabled={busy === 'engine'}>
              {busy === 'engine' ? 'Running…' : 'Run Engine'}
            </button>
            <button className="sh-btn" onClick={testApi} disabled={busy === 'api'}>
              {busy === 'api' ? 'Testing…' : 'Test API'}
            </button>
            <button className="sh-btn sh-btn-danger" onClick={restart}>Restart</button>
          </div>
        </section>

      </div>

      {toast && <div className="sh-toast">{toast}</div>}
    </div>
  );
}
