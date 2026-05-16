'use client';
// ════════════════════════════════════════════════════════════════
//  Manipulation Watch — Phase A surveillance dashboard.
//
//  Tabs: Overview | Action Required | Patterns | Symbol Risk |
//        Historical | Scan Runs | Health.
//
//  Read-only when freshness is anything other than FRESH. Stale data
//  is shown for reference but cannot hard-reject signals — that policy
//  is enforced server-side (see recommendedActionFor in
//  src/app/api/manipulation/route.ts) and surfaced here as a banner.
// ════════════════════════════════════════════════════════════════

import { useEffect, useState, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card } from '@/components/ui';
import {
  ShieldAlert, Scan, RefreshCw, AlertTriangle, CheckCircle,
  TrendingUp, TrendingDown, Clock, Activity, Layers, Target,
  History,
} from 'lucide-react';

// ── Wire shapes (mirror /api/manipulation responses) ────────────────

type FreshnessStatus = 'FRESH' | 'STALE' | 'NO_DATA' | 'PARTIAL';
type RiskBand        = 'LOW' | 'WATCH' | 'ELEVATED' | 'HIGH' | 'SEVERE' | 'UNKNOWN';
type RecommendedAction =
  | 'NO_IMPACT' | 'WARNING_ONLY' | 'PENALIZE' | 'RISK_RESTRICT' | 'BLOCK_APPROVAL';

interface FreshnessEnvelope {
  latestEventDate:   string | null;
  latestCandleDate:  string | null;
  latestScanAt:      string | null;
  latestTradingDate: string | null;
  isStale:           boolean;
  daysLag:           number | null;
  status:            FreshnessStatus;
  reason:            string;
}

interface AlertRow {
  alertId?:    string;
  alert_id?:   string;
  symbol:      string;
  type:        string;
  severity:    string;
  score:       number;
  status:      string;
  headline:    string;
  description: string;
  evidence?:   unknown;
  detectedAt?: string;
  detected_at?: string;
}

interface SummaryData {
  totalAlerts:           number;
  byType:                Record<string, number>;
  bySeverity:            Record<string, number>;
  topAlerts:             AlertRow[];
  recentTrend:           'increasing' | 'stable' | 'decreasing';
  freshness:             FreshnessEnvelope;
  signalEngineImpactMode: 'ACTIVE' | 'WARNING_ONLY';
}

interface PatternRow {
  pattern:         string;
  label:           string;
  alertCount:      number;
  criticalCount:   number;
  avgScore:        number;
  latestEventDate: string | null;
  topSymbols:      string[];
  freshnessStatus: FreshnessStatus;
}

interface SymbolRiskRow {
  symbol:                string;
  manipulationScore:     number;
  riskBand:              RiskBand;
  alertCount:            number;
  patternCount:          number;
  latestEventDate:       string | null;
  latestScanAt:          string | null;
  freshnessStatus:       FreshnessStatus;
  dominantPatterns:      string[];
  recommendedAction:     RecommendedAction;
  canAffectSignalEngine: boolean;
}

interface ScanRunRow {
  scanDate:        string;
  symbolsScanned:  number;
  eventsGenerated: number;
  avgScore:        number;
  severeCount:     number;
}

interface HealthEnvelope {
  freshness:              FreshnessEnvelope;
  signalEngineImpactMode: 'ACTIVE' | 'WARNING_ONLY';
  hardRejectionEnabled:   boolean;
  staleWarningOnlyMode:   boolean;
  totals: {
    symbolsScanned30d:     number;
    eventsGenerated30d:    number;
    snapshotsPersisted30d: number;
  };
  explanation: string;
}

// ── Safe JSON read (same pattern as the backtesting page) ───────────
class ManipulationApiError extends Error {
  route:   string;
  status:  number;
  snippet: string;
  constructor(opts: { route: string; status: number; snippet: string; message: string }) {
    super(opts.message);
    this.name    = 'ManipulationApiError';
    this.route   = opts.route;
    this.status  = opts.status;
    this.snippet = opts.snippet;
  }
}

async function readJsonOrThrow(res: Response, route: string) {
  const ct  = res.headers.get('content-type') ?? '';
  const txt = await res.text();
  if (!ct.includes('application/json')) {
    throw new ManipulationApiError({
      route, status: res.status, snippet: txt.slice(0, 220),
      message: `Expected JSON from ${route}; got ${ct || 'unknown'} (HTTP ${res.status}).`,
    });
  }
  try { return JSON.parse(txt); }
  catch {
    throw new ManipulationApiError({
      route, status: res.status, snippet: txt.slice(0, 220),
      message: `Invalid JSON from ${route} (HTTP ${res.status}).`,
    });
  }
}

// ── Tab keys ────────────────────────────────────────────────────────
type TabKey =
  | 'overview' | 'action' | 'patterns' | 'symbols'
  | 'historical' | 'runs' | 'health';

const TABS: { key: TabKey; label: string; icon: any }[] = [
  { key: 'overview',   label: 'Overview',        icon: ShieldAlert },
  { key: 'action',     label: 'Action Required', icon: AlertTriangle },
  { key: 'patterns',   label: 'Patterns',        icon: Layers },
  { key: 'symbols',    label: 'Symbol Risk',     icon: Target },
  { key: 'historical', label: 'Historical',      icon: History },
  { key: 'runs',       label: 'Scan Runs',       icon: Activity },
  { key: 'health',     label: 'Health',          icon: CheckCircle },
];

// ── Freshness banner ────────────────────────────────────────────────
function FreshnessBanner({ freshness }: { freshness: FreshnessEnvelope | null }) {
  if (!freshness) return null;
  if (freshness.status === 'FRESH') return null;

  const palette =
    freshness.status === 'STALE'    ? { bg: '#FEF3C7', border: '#FDE68A', color: '#92400E' } :
    freshness.status === 'NO_DATA'  ? { bg: '#F1F5F9', border: '#CBD5E1', color: '#475569' } :
                                      { bg: '#FFFBEB', border: '#FDE68A', color: '#92400E' };

  const headline =
    freshness.status === 'STALE'    ? 'Manipulation data is STALE — historical alerts shown for reference only.' :
    freshness.status === 'NO_DATA'  ? 'No manipulation data — surface is empty until the next scan.' :
                                      'Manipulation data is PARTIAL — symbol-level view may be incomplete.';

  return (
    <div style={{
      background: palette.bg, border: `1px solid ${palette.border}`,
      borderRadius: 8, padding: '12px 16px', marginBottom: 14,
      color: palette.color, fontSize: 12, lineHeight: 1.55,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 800, fontSize: 13 }}>
        <AlertTriangle size={14} /> {headline}
      </div>
      <div style={{ marginTop: 4 }}>
        <strong>Latest event:</strong> {freshness.latestEventDate ?? '—'} ·{' '}
        <strong>Latest candle:</strong> {freshness.latestCandleDate ?? '—'} ·{' '}
        <strong>Latest scan:</strong> {freshness.latestScanAt ? new Date(freshness.latestScanAt).toLocaleString('en-IN') : '—'}
        {freshness.daysLag != null && <> · <strong>Lag:</strong> {freshness.daysLag}d</>}
      </div>
      <div style={{ marginTop: 4, fontStyle: 'italic' }}>
        {freshness.reason} Hard rejection is disabled until a fresh scan runs — Signal Engine sees warnings only.
      </div>
    </div>
  );
}

// ── Reusable bits ───────────────────────────────────────────────────
const FRESHNESS_PALETTE: Record<FreshnessStatus, { bg: string; color: string }> = {
  FRESH:   { bg: '#DCFCE7', color: '#15803D' },
  STALE:   { bg: '#FEF3C7', color: '#92400E' },
  NO_DATA: { bg: '#F1F5F9', color: '#475569' },
  PARTIAL: { bg: '#FFFBEB', color: '#B45309' },
};

const RISK_PALETTE: Record<RiskBand, { bg: string; color: string }> = {
  SEVERE:   { bg: '#FEE2E2', color: '#7F1D1D' },
  HIGH:     { bg: '#FEE2E2', color: '#B91C1C' },
  ELEVATED: { bg: '#FEF3C7', color: '#92400E' },
  WATCH:    { bg: '#FEF3C7', color: '#B45309' },
  LOW:      { bg: '#DCFCE7', color: '#15803D' },
  UNKNOWN:  { bg: '#F1F5F9', color: '#475569' },
};

function Chip({ children, palette }: { children: React.ReactNode; palette: { bg: string; color: string } }) {
  return (
    <span style={{
      background: palette.bg, color: palette.color,
      padding: '2px 8px', borderRadius: 99, fontWeight: 700, fontSize: 10,
      letterSpacing: 0.4, whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function Pagination({
  page, totalPages, hasNext, hasPrevious, pageSize, onPage, onPageSize,
}: {
  page: number; totalPages: number; hasNext: boolean; hasPrevious: boolean;
  pageSize: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 4px', fontSize: 12 }}>
      <button className="btn btn--secondary btn--sm" disabled={!hasPrevious} onClick={() => onPage(page - 1)}>Prev</button>
      <span>Page <strong>{page}</strong> of <strong>{Math.max(1, totalPages)}</strong></span>
      <button className="btn btn--secondary btn--sm" disabled={!hasNext} onClick={() => onPage(page + 1)}>Next</button>
      <div style={{ flex: 1 }} />
      <span>Page size:</span>
      <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}
        style={{ padding: '4px 8px', borderRadius: 6, border: '1px solid #E2E8F0', fontSize: 12 }}>
        <option value={25}>25</option>
        <option value={50}>50</option>
        <option value={100}>100</option>
      </select>
    </div>
  );
}

// ── Page ────────────────────────────────────────────────────────────
export default function ManipulationPage() {
  const [tab,       setTab]       = useState<TabKey>('overview');
  const [summary,   setSummary]   = useState<SummaryData | null>(null);
  const [alerts,    setAlerts]    = useState<AlertRow[]>([]);
  const [alertsMeta, setAlertsMeta] = useState({
    total: 0, page: 1, pageSize: 25, totalPages: 1, hasNext: false, hasPrevious: false,
  });
  const [patterns,  setPatterns]  = useState<PatternRow[]>([]);
  const [symbols,   setSymbols]   = useState<SymbolRiskRow[]>([]);
  const [symbolsMeta, setSymbolsMeta] = useState({
    total: 0, page: 1, pageSize: 25, totalPages: 1, hasNext: false, hasPrevious: false,
  });
  const [runs,      setRuns]      = useState<ScanRunRow[]>([]);
  const [health,    setHealth]    = useState<HealthEnvelope | null>(null);
  const [loading,   setLoading]   = useState(false);
  const [scanning,  setScanning]  = useState(false);
  const [error,     setError]     = useState<string | null>(null);

  // ── EOD ingestion + daily scan trigger state ────────────────────
  // These two flows are new (free-source NSE bhavcopy + composed
  // ingest-then-scan). They live alongside the existing "Run Full
  // Scan" button so the operator can refresh the candle warehouse
  // without re-running the scanner, or run both in sequence.
  const [eodRunning,        setEodRunning]        = useState(false);
  const [dailyScanRunning,  setDailyScanRunning]  = useState(false);
  const [pipelineResult,    setPipelineResult]    = useState<{
    kind:    'eod' | 'daily-scan';
    ok:      boolean;
    message: string;
    details: Array<{ label: string; value: string }>;
  } | null>(null);

  // Per-tab filters
  const [filterType,           setFilterType]           = useState<string>('all');
  const [filterSeverity,       setFilterSeverity]       = useState<string>('all');
  const [includeAcknowledged,  setIncludeAcknowledged]  = useState(false);
  const [symbolBand,           setSymbolBand]           = useState<string>('all');
  const [alertsPage,           setAlertsPage]           = useState(1);
  const [alertsPageSize,       setAlertsPageSize]       = useState(25);
  const [symbolsPage,          setSymbolsPage]          = useState(1);
  const [symbolsPageSize,      setSymbolsPageSize]      = useState(25);

  const formatErr = (err: unknown) => {
    if (err instanceof ManipulationApiError) {
      return `Manipulation API error — ${err.route} (HTTP ${err.status}). ${err.snippet}`;
    }
    return err instanceof Error ? err.message : 'Unknown error';
  };

  const loadSummary = useCallback(async () => {
    try {
      const url = '/api/manipulation?action=summary';
      const res = await fetch(url, { cache: 'no-store' });
      setSummary(await readJsonOrThrow(res, url));
    } catch (err) {
      setError(formatErr(err));
    }
  }, []);

  const loadAlerts = useCallback(async (opts: { actionRequired?: boolean; historical?: boolean }) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        action: 'alerts',
        page: String(alertsPage),
        pageSize: String(alertsPageSize),
      });
      if (filterType !== 'all')     params.set('type',     filterType);
      if (filterSeverity !== 'all') params.set('severity', filterSeverity);
      if (opts.actionRequired)      params.set('actionRequired', '1');
      if (opts.historical || includeAcknowledged) params.set('includeAcknowledged', '1');
      const url = `/api/manipulation?${params}`;
      const res = await fetch(url, { cache: 'no-store' });
      const data = await readJsonOrThrow(res, url);
      setAlerts(data.alerts ?? []);
      setAlertsMeta({
        total:       Number(data.total ?? 0),
        page:        Number(data.page ?? 1),
        pageSize:    Number(data.pageSize ?? alertsPageSize),
        totalPages:  Number(data.totalPages ?? 1),
        hasNext:     Boolean(data.hasNext),
        hasPrevious: Boolean(data.hasPrevious),
      });
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setLoading(false);
    }
  }, [alertsPage, alertsPageSize, filterType, filterSeverity, includeAcknowledged]);

  const loadPatterns = useCallback(async () => {
    setLoading(true);
    try {
      const url = '/api/manipulation?action=patterns';
      const res = await fetch(url, { cache: 'no-store' });
      const data = await readJsonOrThrow(res, url);
      setPatterns(data.patterns ?? []);
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSymbols = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        action: 'symbols',
        page: String(symbolsPage),
        pageSize: String(symbolsPageSize),
      });
      if (symbolBand !== 'all') params.set('riskBand', symbolBand);
      const url = `/api/manipulation?${params}`;
      const res = await fetch(url, { cache: 'no-store' });
      const data = await readJsonOrThrow(res, url);
      setSymbols(data.symbols ?? []);
      setSymbolsMeta({
        total:       Number(data.total ?? 0),
        page:        Number(data.page ?? 1),
        pageSize:    Number(data.pageSize ?? symbolsPageSize),
        totalPages:  Number(data.totalPages ?? 1),
        hasNext:     Boolean(data.hasNext),
        hasPrevious: Boolean(data.hasPrevious),
      });
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setLoading(false);
    }
  }, [symbolsPage, symbolsPageSize, symbolBand]);

  const loadRuns = useCallback(async () => {
    setLoading(true);
    try {
      const url = '/api/manipulation?action=runs';
      const res = await fetch(url, { cache: 'no-store' });
      const data = await readJsonOrThrow(res, url);
      setRuns(data.runs ?? []);
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHealth = useCallback(async () => {
    setLoading(true);
    try {
      const url = '/api/manipulation?action=health';
      const res = await fetch(url, { cache: 'no-store' });
      setHealth(await readJsonOrThrow(res, url));
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const runScan = async () => {
    setScanning(true);
    setError(null);
    try {
      const res = await fetch('/api/manipulation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await readJsonOrThrow(res, '/api/manipulation');
      if (!res.ok) {
        setError(data.error ?? `Scan failed (HTTP ${res.status})`);
        return;
      }
      await loadSummary();
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setScanning(false);
    }
  };

  // ── Run EOD ingestion only (free NSE bhavcopy → candles upsert) ─
  const runEodIngestion = async () => {
    setEodRunning(true);
    setError(null);
    setPipelineResult(null);
    try {
      const res = await fetch('/api/manipulation/eod-ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await readJsonOrThrow(res, '/api/manipulation/eod-ingest');
      if (!res.ok) {
        setError(data.error ?? `EOD ingest failed (HTTP ${res.status})`);
        setPipelineResult({
          kind:    'eod',
          ok:      false,
          message: data.error ?? `EOD ingest failed (HTTP ${res.status})`,
          details: [],
        });
        return;
      }
      const totalInserted = (data.sources ?? []).reduce(
        (n: number, s: any) => n + Number(s.inserted ?? 0), 0);
      const totalUpdated = (data.sources ?? []).reduce(
        (n: number, s: any) => n + Number(s.updated ?? 0), 0);
      setPipelineResult({
        kind:    'eod',
        ok:      Boolean(data.ok),
        message: data.ok
                   ? `EOD ingestion complete. ${totalInserted + totalUpdated} candle rows written (${totalInserted} inserted, ${totalUpdated} updated).`
                   : `EOD ingestion did not advance the candle warehouse. ${(data.warnings ?? []).join(' ')}`,
        details: [
          { label: 'Trade date',          value: String(data.tradeDate ?? '—') },
          { label: 'Latest candle date',  value: String(data.latestCandleDate ?? '—') },
          ...(data.sources ?? []).map((s: any) => ({
            label: s.source,
            value: `${s.status} · fetched=${s.fetched ?? 0} ins=${s.inserted ?? 0} upd=${s.updated ?? 0}` +
                   (s.error ? ` · ${s.error}` : ''),
          })),
        ],
      });
      await loadSummary();
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setEodRunning(false);
    }
  };

  // ── Run composed daily pipeline (ingestion → manipulation scan) ──
  const runDailyScan = async () => {
    setDailyScanRunning(true);
    setError(null);
    setPipelineResult(null);
    try {
      const res = await fetch('/api/manipulation/daily-scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await readJsonOrThrow(res, '/api/manipulation/daily-scan');
      if (!res.ok) {
        setError(data.error ?? `Daily scan failed (HTTP ${res.status})`);
        setPipelineResult({
          kind:    'daily-scan',
          ok:      false,
          message: data.error ?? `Daily scan failed (HTTP ${res.status})`,
          details: [],
        });
        return;
      }
      setPipelineResult({
        kind:    'daily-scan',
        ok:      Boolean(data.ok),
        message: String(data.reason ?? (data.ok
                  ? 'Daily manipulation pipeline complete.'
                  : 'Daily manipulation scan failed. Signal Engine remains warning-only.')),
        details: [
          { label: 'Candles advanced',     value: data.candlesAdvanced ? 'yes' : 'no' },
          { label: 'Candle date (before)', value: String(data.candleDateBefore ?? '—') },
          { label: 'Candle date (after)',  value: String(data.candleDateAfter ?? '—') },
          { label: 'Latest event date',    value: String(data.latestEventDate ?? '—') },
          { label: 'Scanned symbols',      value: String(data.scan?.scanned ?? 0) },
          { label: 'Snapshots persisted',  value: String(data.scan?.snapshotsPersisted ?? 0) },
          { label: 'Penalties written',    value: String(data.scan?.penaltiesWritten ?? 0) },
        ],
      });
      await loadSummary();
      if (tab === 'health') await loadHealth();
    } catch (err) {
      setError(formatErr(err));
    } finally {
      setDailyScanRunning(false);
    }
  };

  const updateStatus = async (alertId: string, status: string) => {
    try {
      await fetch('/api/manipulation', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ alertId, status }),
      });
      // Reload current view
      if (tab === 'action')        await loadAlerts({ actionRequired: true });
      else if (tab === 'historical') await loadAlerts({ historical: true });
    } catch { /* ignore */ }
  };

  // Initial load + auto-refresh of overview. Patterns are preloaded so
  // the "Action Required" pattern dropdown has options on first paint.
  useEffect(() => { loadSummary(); loadPatterns(); }, [loadSummary, loadPatterns]);

  // Per-tab loaders
  useEffect(() => {
    setError(null);
    if (tab === 'action')        loadAlerts({ actionRequired: true });
    else if (tab === 'patterns') loadPatterns();
    else if (tab === 'symbols')  loadSymbols();
    else if (tab === 'historical') loadAlerts({ historical: true });
    else if (tab === 'runs')     loadRuns();
    else if (tab === 'health')   loadHealth();
  }, [tab, loadAlerts, loadPatterns, loadSymbols, loadRuns, loadHealth]);

  // Refresh on summary state every 30s for the overview tab only
  useEffect(() => {
    if (tab !== 'overview') return;
    const id = setInterval(() => { if (!document.hidden) loadSummary(); }, 30_000);
    return () => clearInterval(id);
  }, [tab, loadSummary]);

  const freshness = summary?.freshness ?? null;
  const TrendIcon = summary?.recentTrend === 'increasing' ? TrendingUp : summary?.recentTrend === 'decreasing' ? TrendingDown : CheckCircle;
  const trendColor = summary?.recentTrend === 'increasing' ? '#DC2626' : summary?.recentTrend === 'decreasing' ? '#15803D' : '#64748B';

  return (
    <AppShell title="Manipulation Watch">
      <div className="page">
        <div className="page__header">
          <div>
            <h1><ShieldAlert size={20} style={{ verticalAlign: -3, marginRight: 8 }} />Manipulation Watch</h1>
            <p>Surveillance surface: pattern grouping, symbol risk, freshness-aware Signal Engine integration.</p>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button
              className="btn btn--secondary btn--sm"
              onClick={runEodIngestion}
              disabled={eodRunning || dailyScanRunning}
              title="Pull NSE bhavcopy and upsert into the candles warehouse."
            >
              {eodRunning ? <RefreshCw size={13} className="spin" /> : <Layers size={13} />}
              {eodRunning ? ' Ingesting…' : ' Run EOD Ingestion'}
            </button>
            <button
              className="btn btn--secondary btn--sm"
              onClick={runDailyScan}
              disabled={dailyScanRunning || eodRunning}
              title="Pull EOD candles, then run the manipulation scanner against the refreshed data."
            >
              {dailyScanRunning ? <RefreshCw size={13} className="spin" /> : <Activity size={13} />}
              {dailyScanRunning ? ' Running…' : ' Run Daily Manipulation Scan'}
            </button>
            <button className="btn btn--primary btn--sm" onClick={runScan} disabled={scanning}>
              {scanning ? <RefreshCw size={13} className="spin" /> : <Scan size={13} />}
              {scanning ? ' Scanning...' : ' Run Full Scan'}
            </button>
          </div>
        </div>

        <FreshnessBanner freshness={freshness} />

        {pipelineResult && (
          <div style={{
            background:    pipelineResult.ok ? '#ECFDF5' : '#FEF2F2',
            border:        `1px solid ${pipelineResult.ok ? '#A7F3D0' : '#FCA5A5'}`,
            color:         pipelineResult.ok ? '#065F46' : '#7F1D1D',
            padding:       '10px 14px',
            borderRadius:  8,
            marginBottom:  14,
            fontSize:      12,
            lineHeight:    1.55,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
              <div style={{ fontWeight: 800 }}>
                {pipelineResult.ok ? <CheckCircle size={13} style={{ verticalAlign: -2, marginRight: 6 }} /> : <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />}
                {pipelineResult.kind === 'eod' ? 'EOD ingestion' : 'Daily manipulation scan'} — {pipelineResult.ok ? 'OK' : 'attention'}
              </div>
              <button
                onClick={() => setPipelineResult(null)}
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 14, padding: 2 }}
                aria-label="Dismiss"
              >×</button>
            </div>
            <div style={{ marginTop: 4 }}>{pipelineResult.message}</div>
            {pipelineResult.details.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '4px 16px', marginTop: 8 }}>
                {pipelineResult.details.map((d, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6 }}>
                    <span style={{ opacity: 0.75 }}>{d.label}:</span>
                    <span style={{ fontWeight: 600, wordBreak: 'break-all' }}>{d.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{
            background: '#FEE2E2', border: '1px solid #FCA5A5', color: '#7F1D1D',
            padding: '10px 14px', borderRadius: 8, marginBottom: 14, fontSize: 12, lineHeight: 1.5,
          }}>
            <div style={{ fontWeight: 800, marginBottom: 4 }}>
              <AlertTriangle size={13} style={{ verticalAlign: -2, marginRight: 6 }} />Manipulation API error
            </div>
            <div style={{ wordBreak: 'break-word' }}>{error}</div>
          </div>
        )}

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 4, marginBottom: 14, borderBottom: '1px solid #E2E8F0', flexWrap: 'wrap' }}>
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                style={{
                  padding: '8px 14px', border: 'none', background: 'transparent',
                  borderBottom: active ? '2px solid #1D4ED8' : '2px solid transparent',
                  color: active ? '#1D4ED8' : '#64748B',
                  fontWeight: active ? 700 : 500, fontSize: 12, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 5,
                }}
              >
                <Icon size={12} /> {t.label}
              </button>
            );
          })}
        </div>

        {/* OVERVIEW */}
        {tab === 'overview' && summary && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
              <div style={{ background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8, padding: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#94A3B8', textTransform: 'uppercase' }}>Total Alerts (30d)</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: '#1E293B', marginTop: 4 }}>{summary.totalAlerts}</div>
                <div style={{ fontSize: 11, color: trendColor, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <TrendIcon size={11} /> Trend: {summary.recentTrend}
                </div>
              </div>
              <div style={{ background: '#FEE2E2', border: '1px solid #DC262633', borderRadius: 8, padding: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#DC2626', textTransform: 'uppercase' }}>Critical</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: '#DC2626', marginTop: 4 }}>{summary.bySeverity?.critical ?? 0}</div>
                <div style={{ fontSize: 11, color: '#7F1D1D', marginTop: 4 }}>Immediate review needed</div>
              </div>
              <div style={{ background: '#FEF3C7', border: '1px solid #D9770633', borderRadius: 8, padding: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#D97706', textTransform: 'uppercase' }}>Warning</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: '#D97706', marginTop: 4 }}>{summary.bySeverity?.warning ?? 0}</div>
                <div style={{ fontSize: 11, color: '#92400E', marginTop: 4 }}>Suspicious activity</div>
              </div>
              <div style={{ background: '#F0FDF4', border: '1px solid #16A34A33', borderRadius: 8, padding: 14 }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#15803D', textTransform: 'uppercase' }}>Info</div>
                <div style={{ fontSize: 26, fontWeight: 800, color: '#15803D', marginTop: 4 }}>{summary.bySeverity?.info ?? 0}</div>
                <div style={{ fontSize: 11, color: '#065F46', marginTop: 4 }}>Notable patterns</div>
              </div>
            </div>

            <Card title="Freshness">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, padding: 12, fontSize: 12 }}>
                <div><Clock size={12} style={{ verticalAlign: -2, marginRight: 6 }} />
                  <strong>Status:</strong>{' '}
                  <Chip palette={FRESHNESS_PALETTE[summary.freshness.status]}>{summary.freshness.status}</Chip>
                </div>
                <div><strong>Signal Engine impact mode:</strong>{' '}
                  <Chip palette={summary.signalEngineImpactMode === 'ACTIVE'
                    ? { bg: '#DCFCE7', color: '#15803D' } : { bg: '#FEF3C7', color: '#92400E' }}>
                    {summary.signalEngineImpactMode}
                  </Chip>
                </div>
                <div><strong>Latest event:</strong> {summary.freshness.latestEventDate ?? '—'}</div>
                <div><strong>Latest candle:</strong> {summary.freshness.latestCandleDate ?? '—'}</div>
                <div><strong>Latest scan:</strong> {summary.freshness.latestScanAt ? new Date(summary.freshness.latestScanAt).toLocaleString('en-IN') : '—'}</div>
                <div><strong>Lag:</strong> {summary.freshness.daysLag ?? '—'} day(s)</div>
              </div>
              <div style={{ padding: '4px 12px 12px 12px', fontSize: 11.5, color: '#475569', lineHeight: 1.55 }}>
                {summary.freshness.reason}
              </div>
            </Card>

            {Object.keys(summary.byType ?? {}).length > 0 && (
              <Card title="Top Patterns (30d)" style={{ marginTop: 14 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 12 }}>
                  {Object.entries(summary.byType)
                    .sort((a, b) => b[1] - a[1]).slice(0, 12)
                    .map(([type, count]) => (
                      <span key={type} style={{ background: '#F1F5F9', padding: '6px 12px', borderRadius: 99, fontSize: 12 }}>
                        <strong>{type.replace(/_/g, ' ')}:</strong> {count}
                      </span>
                    ))}
                </div>
              </Card>
            )}
          </>
        )}

        {/* ACTION REQUIRED / HISTORICAL share the alert-table renderer */}
        {(tab === 'action' || tab === 'historical') && (
          <>
            {tab === 'action' && (
              <div style={{ display: 'flex', gap: 12, marginBottom: 10, alignItems: 'center' }}>
                <select value={filterType} onChange={(e) => { setFilterType(e.target.value); setAlertsPage(1); }}
                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #E2E8F0', fontSize: 12 }}>
                  <option value="all">All patterns</option>
                  {patterns.map((p) => <option key={p.pattern} value={p.pattern}>{p.label}</option>)}
                </select>
                <select value={filterSeverity} onChange={(e) => { setFilterSeverity(e.target.value); setAlertsPage(1); }}
                  style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #E2E8F0', fontSize: 12 }}>
                  <option value="all">All severities</option>
                  <option value="critical">Critical</option>
                  <option value="warning">Warning</option>
                  <option value="info">Info</option>
                </select>
                <label style={{ fontSize: 12, color: '#475569', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input type="checkbox" checked={includeAcknowledged}
                    onChange={(e) => setIncludeAcknowledged(e.target.checked)} />
                  Include acknowledged
                </label>
              </div>
            )}
            <Card title={tab === 'action' ? `Action Required (${alertsMeta.total})` : `Historical Alerts (${alertsMeta.total})`}>
              <AlertsTable
                loading={loading}
                alerts={alerts}
                freshness={freshness}
                onAck={(id) => updateStatus(id, 'acknowledged')}
                onDismiss={(id) => updateStatus(id, 'dismissed')}
                readOnly={tab === 'historical' || freshness?.status !== 'FRESH'}
              />
              <Pagination
                page={alertsMeta.page} totalPages={alertsMeta.totalPages}
                hasNext={alertsMeta.hasNext} hasPrevious={alertsMeta.hasPrevious}
                pageSize={alertsPageSize}
                onPage={setAlertsPage}
                onPageSize={(n) => { setAlertsPageSize(n); setAlertsPage(1); }}
              />
            </Card>
          </>
        )}

        {/* PATTERNS */}
        {tab === 'patterns' && (
          <Card title={`Pattern Groups (${patterns.length})`}>
            {loading ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}><RefreshCw size={20} className="spin" /></div>
            ) : patterns.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No patterns recorded yet.</div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12, padding: 12 }}>
                {patterns.map((p) => (
                  <div key={p.pattern} style={{
                    background: '#fff', border: '1px solid #E2E8F0', borderRadius: 8, padding: 12,
                    display: 'flex', flexDirection: 'column', gap: 6,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                      <strong style={{ fontSize: 13, color: '#0F172A' }}>{p.label}</strong>
                      <Chip palette={FRESHNESS_PALETTE[p.freshnessStatus]}>{p.freshnessStatus}</Chip>
                    </div>
                    <div style={{ fontSize: 11.5, color: '#475569' }}>
                      <strong>{p.alertCount}</strong> alerts · <strong style={{ color: '#DC2626' }}>{p.criticalCount}</strong> critical
                    </div>
                    <div style={{ fontSize: 11.5, color: '#475569' }}>
                      Avg score: <strong>{p.avgScore.toFixed(1)}</strong> · Latest: <strong>{p.latestEventDate ?? '—'}</strong>
                    </div>
                    {p.topSymbols.length > 0 && (
                      <div style={{ fontSize: 11, color: '#64748B' }}>
                        Top: {p.topSymbols.join(', ')}
                      </div>
                    )}
                    <button
                      className="btn btn--secondary btn--sm"
                      style={{ marginTop: 6, alignSelf: 'flex-start' }}
                      onClick={() => { setFilterType(p.pattern); setFilterSeverity('all'); setAlertsPage(1); setTab('action'); }}
                    >View Details →</button>
                  </div>
                ))}
              </div>
            )}
          </Card>
        )}

        {/* SYMBOL RISK */}
        {tab === 'symbols' && (
          <>
            <div style={{ display: 'flex', gap: 12, marginBottom: 10, alignItems: 'center' }}>
              <select value={symbolBand} onChange={(e) => { setSymbolBand(e.target.value); setSymbolsPage(1); }}
                style={{ padding: '6px 10px', borderRadius: 6, border: '1px solid #E2E8F0', fontSize: 12 }}>
                <option value="all">All bands</option>
                <option value="SEVERE">Severe</option>
                <option value="HIGH">High</option>
                <option value="ELEVATED">Elevated</option>
                <option value="WATCH">Watch</option>
                <option value="LOW">Low</option>
              </select>
            </div>
            <Card title={`Symbol Risk (${symbolsMeta.total})`}>
              {loading ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}><RefreshCw size={20} className="spin" /></div>
              ) : symbols.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No symbols at this band.</div>
              ) : (
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#F8FAFC' }}>
                      {['SYMBOL', 'BAND', 'SCORE', 'ALERTS', 'PATTERNS', 'LATEST', 'FRESHNESS', 'ACTION', 'AFFECTS ENGINE'].map((h) => (
                        <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {symbols.map((s) => (
                      <tr key={s.symbol} style={{ borderTop: '1px solid #F1F5F9' }}>
                        <td style={{ padding: '8px 12px', fontWeight: 700 }}>{s.symbol}</td>
                        <td style={{ padding: '8px 12px' }}>
                          <Chip palette={RISK_PALETTE[s.riskBand]}>{s.riskBand}</Chip>
                        </td>
                        <td style={{ padding: '8px 12px', fontWeight: 700 }}>{s.manipulationScore.toFixed(1)}</td>
                        <td style={{ padding: '8px 12px' }}>{s.alertCount}</td>
                        <td style={{ padding: '8px 12px', fontSize: 11, color: '#64748B', maxWidth: 200 }}>
                          {s.dominantPatterns.map((p) => p.replace(/_/g, ' ')).join(', ') || '—'}
                        </td>
                        <td style={{ padding: '8px 12px', fontSize: 11 }}>{s.latestEventDate ?? '—'}</td>
                        <td style={{ padding: '8px 12px' }}>
                          <Chip palette={FRESHNESS_PALETTE[s.freshnessStatus]}>{s.freshnessStatus}</Chip>
                        </td>
                        <td style={{ padding: '8px 12px', fontSize: 11, fontWeight: 700 }}>
                          {s.recommendedAction.replace(/_/g, ' ')}
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          {s.canAffectSignalEngine
                            ? <span style={{ color: '#DC2626', fontWeight: 700, fontSize: 11 }}>YES</span>
                            : <span style={{ color: '#64748B', fontWeight: 500, fontSize: 11 }}>no</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <Pagination
                page={symbolsMeta.page} totalPages={symbolsMeta.totalPages}
                hasNext={symbolsMeta.hasNext} hasPrevious={symbolsMeta.hasPrevious}
                pageSize={symbolsPageSize}
                onPage={setSymbolsPage}
                onPageSize={(n) => { setSymbolsPageSize(n); setSymbolsPage(1); }}
              />
            </Card>
          </>
        )}

        {/* SCAN RUNS */}
        {tab === 'runs' && (
          <Card title={`Scan Runs (${runs.length})`}>
            {loading ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}><RefreshCw size={20} className="spin" /></div>
            ) : runs.length === 0 ? (
              <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8', fontSize: 13 }}>No scan runs recorded.</div>
            ) : (
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#F8FAFC' }}>
                    {['SCAN DATE', 'SYMBOLS', 'EVENTS', 'AVG SCORE', 'SEVERE'].map((h) => (
                      <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.scanDate} style={{ borderTop: '1px solid #F1F5F9' }}>
                      <td style={{ padding: '8px 12px', fontWeight: 700 }}>{r.scanDate}</td>
                      <td style={{ padding: '8px 12px' }}>{r.symbolsScanned}</td>
                      <td style={{ padding: '8px 12px' }}>{r.eventsGenerated}</td>
                      <td style={{ padding: '8px 12px' }}>{r.avgScore.toFixed(1)}</td>
                      <td style={{ padding: '8px 12px', color: r.severeCount > 0 ? '#DC2626' : '#475569', fontWeight: r.severeCount > 0 ? 700 : 500 }}>
                        {r.severeCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        )}

        {/* HEALTH */}
        {tab === 'health' && health && (
          <Card title="Manipulation Engine Health">
            <div style={{ padding: 14, fontSize: 13, color: '#0F172A', lineHeight: 1.6 }}>
              {health.explanation}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, padding: 12, fontSize: 12 }}>
              <div><strong>Freshness:</strong>{' '}
                <Chip palette={FRESHNESS_PALETTE[health.freshness.status]}>{health.freshness.status}</Chip>
              </div>
              <div><strong>Signal Engine mode:</strong>{' '}
                <Chip palette={health.signalEngineImpactMode === 'ACTIVE'
                  ? { bg: '#DCFCE7', color: '#15803D' }
                  : { bg: '#FEF3C7', color: '#92400E' }}>
                  {health.signalEngineImpactMode}
                </Chip>
              </div>
              <div><strong>Hard rejection:</strong> {health.hardRejectionEnabled ? 'Enabled' : 'Disabled (stale data)'}</div>
              <div><strong>Latest event:</strong> {health.freshness.latestEventDate ?? '—'}</div>
              <div><strong>Latest scan:</strong> {health.freshness.latestScanAt ? new Date(health.freshness.latestScanAt).toLocaleString('en-IN') : '—'}</div>
              <div><strong>Latest candle:</strong> {health.freshness.latestCandleDate ?? '—'}</div>
              <div><strong>Symbols scanned (30d):</strong> {health.totals.symbolsScanned30d}</div>
              <div><strong>Events generated (30d):</strong> {health.totals.eventsGenerated30d}</div>
              <div><strong>Snapshots persisted (30d):</strong> {health.totals.snapshotsPersisted30d}</div>
            </div>
          </Card>
        )}
      </div>
    </AppShell>
  );
}

// ── Alerts table renderer (used by Action Required + Historical) ────
function AlertsTable({
  loading, alerts, freshness, onAck, onDismiss, readOnly,
}: {
  loading: boolean;
  alerts: AlertRow[];
  freshness: FreshnessEnvelope | null;
  onAck: (id: string) => void;
  onDismiss: (id: string) => void;
  readOnly: boolean;
}) {
  if (loading) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}>
        <RefreshCw size={20} className="spin" />
        <div style={{ fontSize: 12, marginTop: 6 }}>Loading...</div>
      </div>
    );
  }
  if (alerts.length === 0) {
    return (
      <div style={{ padding: 40, textAlign: 'center', color: '#94A3B8' }}>
        <ShieldAlert size={32} style={{ opacity: 0.4, marginBottom: 8 }} />
        <div style={{ fontSize: 13 }}>No alerts in this view.</div>
      </div>
    );
  }
  return (
    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
      <thead>
        <tr style={{ background: '#F8FAFC' }}>
          {['SYMBOL', 'PATTERN', 'SEVERITY', 'SCORE', 'STATUS', 'DETECTED', 'FRESHNESS', 'ACTIONS'].map((h) => (
            <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: '#94A3B8', fontWeight: 700 }}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {alerts.map((a) => {
          const alertId = a.alertId ?? a.alert_id ?? '';
          const detected = a.detectedAt ?? a.detected_at ?? null;
          // Each row is tagged with the global freshness state so an
          // operator never confuses an April event for a live alert.
          const rowFreshness: FreshnessStatus = freshness?.status ?? 'NO_DATA';
          return (
            <tr key={alertId} style={{ borderTop: '1px solid #F1F5F9' }}>
              <td style={{ padding: '8px 12px', fontWeight: 700 }}>{a.symbol}</td>
              <td style={{ padding: '8px 12px', fontSize: 11 }}>{(a.type ?? '').replace(/_/g, ' ')}</td>
              <td style={{ padding: '8px 12px' }}>
                <span style={{
                  background: a.severity === 'critical' ? '#FEE2E2' : a.severity === 'warning' ? '#FEF3C7' : '#F1F5F9',
                  color: a.severity === 'critical' ? '#DC2626' : a.severity === 'warning' ? '#D97706' : '#64748B',
                  fontWeight: 700, fontSize: 10, padding: '2px 8px', borderRadius: 99,
                }}>
                  {(a.severity ?? '').toUpperCase()}
                </span>
              </td>
              <td style={{ padding: '8px 12px', fontWeight: 700, color: a.score >= 70 ? '#DC2626' : a.score >= 45 ? '#D97706' : '#64748B' }}>
                {a.score}
              </td>
              <td style={{ padding: '8px 12px', fontSize: 11, color: '#64748B' }}>{a.status}</td>
              <td style={{ padding: '8px 12px', fontSize: 11, color: '#94A3B8' }}>
                {detected ? new Date(detected).toLocaleDateString('en-IN') : '—'}
              </td>
              <td style={{ padding: '8px 12px' }}>
                <Chip palette={FRESHNESS_PALETTE[rowFreshness]}>{rowFreshness}</Chip>
              </td>
              <td style={{ padding: '8px 12px' }}>
                {!readOnly && a.status === 'new' && (
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button onClick={() => onAck(alertId)}
                      style={{ background: '#DBEAFE', color: '#1D4ED8', border: 'none', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                      ACK
                    </button>
                    <button onClick={() => onDismiss(alertId)}
                      style={{ background: '#F1F5F9', color: '#64748B', border: 'none', padding: '2px 8px', borderRadius: 4, fontSize: 10, fontWeight: 700, cursor: 'pointer' }}>
                      DISMISS
                    </button>
                  </div>
                )}
                {readOnly && (
                  <span style={{ fontSize: 10, color: '#94A3B8', fontStyle: 'italic' }}>read-only</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
