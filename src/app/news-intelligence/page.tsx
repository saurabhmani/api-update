'use client';
import { useEffect, useState, useCallback, useRef } from 'react';
import { useEventStream } from '@/hooks/useEventStream';
import AppShell from '@/components/layout/AppShell';
import { Card, Loading } from '@/components/ui';
import { Newspaper, RefreshCw, TrendingUp, AlertTriangle, Zap, BarChart3, Shield } from 'lucide-react';
import s from './news.module.scss';

interface NewsEvent {
  id:          number;
  title:       string;
  category:    string;
  sentiment:   string;
  // API returns sourceId (camelCase); accept the snake_case form too
  // so older responses don't break this surface.
  sourceId?:   string;
  source_id?:  string;
  publishedAt: string;
  symbols?:    string[];   // extracted NSE symbols (from readNewsEvents.ts:33)
  sectors?:    string[];   // extracted sectors
}

// On-mount: if the freshest DB event is older than this threshold,
// kick the pipeline once to catch up. Normal ingestion is owned by
// the in-process scheduler (every 5 min server-side), so this only
// fires after a long absence — freshly opened tab, server restart,
// etc.
const AUTO_PIPELINE_STALE_MS = 10 * 60 * 1000; // 10 min

// Safe ISO formatter — returns "—" for anything that can't parse into
// a finite timestamp. Prevents the literal string "Invalid Date" from
// ever reaching the UI when a row's publishedAt slips through malformed.
function formatPublishedAt(raw: unknown): string {
  if (raw == null || raw === '') return '—';
  const t = new Date(String(raw)).getTime();
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleString();
}

// "5 min ago" / "2 h ago" — recomputed on every poll against the
// current clock so the label stays honest as time passes.
function formatRelative(raw: unknown, nowMs: number): string {
  if (raw == null || raw === '') return '';
  const t = new Date(String(raw)).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = Math.max(0, nowMs - t);
  if (diff < 60_000)         return 'just now';
  if (diff < 3_600_000)      return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000)     return `${Math.floor(diff / 3_600_000)} h ago`;
  return `${Math.floor(diff / 86_400_000)} d ago`;
}

// Freshness presets on the filter bar. `hours` is a float so we can
// express sub-hour windows cleanly (10 min = 1/6 h). The value is
// converted to an ISO `from=` timestamp on each fetch.
const WINDOW_OPTIONS: Array<{ key: string; label: string; hours: number }> = [
  { key: '10m', label: 'Last 10 min', hours: 10 / 60 },
  { key: '30m', label: 'Last 30 min', hours: 30 / 60 },
  { key: '1h',  label: 'Last 1h',     hours: 1 },
  { key: '6h',  label: 'Last 6h',     hours: 6 },
  { key: '24h', label: 'Last 24h',    hours: 24 },
  { key: '3d',  label: 'Last 3d',     hours: 72 },
];
// Default window opens at 24h per Phase-B spec — short windows like
// 10m can legitimately be empty even when news exists upstream, and
// landing on an empty view was confusing operators into thinking the
// pipeline had failed. 24h gives the dashboard a useful baseline.
const DEFAULT_WINDOW_KEY = '24h';
interface ScoreRow { symbol: string; trust_score: number; sentiment_score: number; importance_score: number; symbol_impact_score: number; event_risk_score: number; manipulation_risk_boost: number; }
interface ImpactRow { symbol: string; confidenceModifier: number; riskPenalty: number; aggregateImpact: number; netSentiment: string; eventCount: number; }

// Shape returned by /api/news-engine?action=summary. The three timestamp
// fields are *distinct on purpose* — UI refresh, pipeline run, and the
// freshest event in the DB answer three different operator questions.
type PipelineStatus = 'FRESH' | 'PARTIAL' | 'STALE' | 'NO_DATA';
interface NewsSummary {
  status:                PipelineStatus;
  configuredCount:       number;
  totalCount:            number;
  activeSources:         string[];
  notConfiguredSources:  string[];
  latestNewsPublishedAt: string | null;
  latestPipelineRunAt:   string | null;
}

export default function NewsIntelligencePage() {
  const [events, setEvents] = useState<NewsEvent[]>([]);
  const [impacts, setImpacts] = useState<Record<string, ImpactRow>>({});
  const [tab, setTab] = useState<'events' | 'impact'>('events');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [windowKey, setWindowKey] = useState(DEFAULT_WINDOW_KEY);
  const [lastAt, setLastAt] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // 1s wall clock so relative timestamps ("5 min ago") stay honest
  // without having to re-fetch. Cheap: one setState per second.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Timestamp of last successful poll — used for the LIVE "updated Xs
  // ago" badge. Stored as ms so a 1s clock can recompute the delta.
  const [lastFetchMs, setLastFetchMs] = useState<number | null>(null);
  // Pipeline summary (status, source counts, run / event timestamps).
  // Polled separately from /events so we can show pipeline state even
  // when no events fall inside the current freshness window.
  const [summary, setSummary] = useState<NewsSummary | null>(null);

  const load = useCallback(async (winKey: string = windowKey) => {
    setLoading(true);
    try {
      const win = WINDOW_OPTIONS.find(w => w.key === winKey) ?? WINDOW_OPTIONS[1];
      const winMs = win.hours * 3600_000;
      // The DB column is MySQL DATETIME and rows are written as UTC
      // `YYYY-MM-DD HH:MM:SS` (see saveNewsEvents.ts → toMysqlDateTime).
      // An ISO-Z string comparison against DATETIME is ambiguous in
      // MySQL — send the same UTC shape the DB stores.
      const thresholdMs = Date.now() - winMs;
      const d = new Date(thresholdMs);
      const pad = (n: number) => String(n).padStart(2, '0');
      const fromMysql =
        `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
        `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
      const qs = `limit=100&from=${encodeURIComponent(fromMysql)}`;
      const impactHours = Math.max(1, Math.ceil(win.hours));
      const [evRes, impRes, sumRes] = await Promise.allSettled([
        fetch(`/api/news-engine?${qs}`,                          { cache: 'no-store' }).then(r => r.ok ? r.json() : { events: [] }),
        fetch(`/api/news-engine?impact=true&hours=${impactHours}`, { cache: 'no-store' }).then(r => r.ok ? r.json() : { symbolImpacts: {} }),
        fetch(`/api/news-engine?action=summary`,                   { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
      ]);
      const evData  = evRes.status  === 'fulfilled' ? evRes.value  : { events: [] };
      const impData = impRes.status === 'fulfilled' ? impRes.value : { symbolImpacts: {} };
      const sumData = sumRes.status === 'fulfilled' ? sumRes.value : null;
      const fetched: NewsEvent[] = evData.events ?? [];
      if (sumData && typeof sumData === 'object' && 'status' in sumData) {
        setSummary(sumData as NewsSummary);
      }

      // ── CLIENT-SIDE STRICT FILTER (with 60s tolerance) ────────
      // rowToNewsEvent on the server now emits a genuine UTC ISO,
      // so this compare is TZ-safe. A 60s tolerance absorbs clock
      // skew so fresh rows landing right at the boundary don't
      // flicker in and out of view.
      const TOLERANCE_MS = 60_000;
      const floorMs = thresholdMs - TOLERANCE_MS;
      const droppedPreview: Array<{ title: string; publishedAt: string; diffMinutes: number }> = [];
      const strict = fetched.filter((e) => {
        const pMs = new Date(e.publishedAt).getTime();
        if (!Number.isFinite(pMs)) return false;
        if (pMs >= floorMs) return true;
        if (droppedPreview.length < 3) {
          droppedPreview.push({
            title: e.title,
            publishedAt: e.publishedAt,
            diffMinutes: Math.round((pMs - thresholdMs) / 60_000),
          });
        }
        return false;
      });

      // Debug trail — visible in the browser console so you can
      // reconcile the dashboard counts against the raw payload.
      // When the server returns rows but the client filters them
      // all out, the dropped sample surfaces the exact timestamps
      // so a timezone bug is diagnosable from the console alone.
      // eslint-disable-next-line no-console
      console.log(
        `[news-intelligence] window=${winKey}  fetched=${fetched.length}  ` +
        `afterStrictFilter=${strict.length}  ` +
        (fetched.length > 0 && strict.length === 0
          ? `ALL_FILTERED — droppedPreview=${JSON.stringify(droppedPreview)}  `
          : ''),
        `serverDebug=`, evData.debug,
      );

      setEvents(strict);
      setImpacts(impData.symbolImpacts ?? {});
      const nowDate = new Date();
      setLastFetchMs(nowDate.getTime());
      setLastAt(nowDate.toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true,
      }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[news-intelligence] load failed:', err);
    }
    setLoading(false);
  }, [windowKey]);

  const [pipelineMsg, setPipelineMsg] = useState<string | null>(null);

  const triggerPipeline = async () => {
    setRunning(true);
    setPipelineMsg(null);
    try {
      const res = await fetch('/api/news-engine', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        const newEvents = body?.ingestion?.newEvents ?? 0;
        const mode = body?.mode ?? 'live';
        if (newEvents > 0) {
          setPipelineMsg(mode === 'demo_seeded'
            ? `Loaded ${newEvents} demo events (no news API keys configured)`
            : `Pipeline fetched ${newEvents} new events`);
        } else {
          setPipelineMsg('Pipeline ran but found no new events. Add GNEWS_API_KEY or other news API keys to .env.local to enable live sources.');
        }
      } else if (res.status === 403) {
        setPipelineMsg('Permission denied — login as admin to run the pipeline.');
      } else {
        setPipelineMsg(`Pipeline error (HTTP ${res.status})`);
      }
      await load();
    } catch (err) {
      setPipelineMsg('Failed to reach the news pipeline endpoint.');
    }
    setRunning(false);
  };

  // Guard: a pipeline run can take several seconds. This ref blocks
  // overlapping runs — whether triggered by the on-mount stale check,
  // the hourly interval, or a fast double-click on the manual button.
  const pipelineInFlightRef = useRef(false);
  // Guard so the on-mount stale trigger only fires once per session
  // (without it, every 10s re-render would re-run the pipeline).
  const didInitialStaleTriggerRef = useRef(false);

  const runPipelineSilent = useCallback(async () => {
    if (pipelineInFlightRef.current) return;
    pipelineInFlightRef.current = true;
    try {
      await fetch('/api/news-engine', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      await load();
    } catch { /* best effort — manual "Run Pipeline" button still works */ }
    finally { pipelineInFlightRef.current = false; }
  }, [load]);

  // Re-fetch whenever the window changes (load itself is memoized on windowKey).
  useEffect(() => { load(); }, [load]);

  // On first DB read, if the newest row is older than the staleness
  // threshold, silently kick the pipeline so the page shows fresh
  // news on arrival without a manual button click.
  useEffect(() => {
    if (loading || didInitialStaleTriggerRef.current) return;
    if (events.length === 0) return;
    const latest = events[0]?.publishedAt;
    if (!latest) return;
    const ageMs = Date.now() - new Date(latest).getTime();
    if (!Number.isFinite(ageMs) || ageMs < AUTO_PIPELINE_STALE_MS) return;

    didInitialStaleTriggerRef.current = true;
    void runPipelineSilent();
  }, [loading, events, runPipelineSilent]);

  // NOTE: the client-side hourly pipeline trigger has been removed.
  // The in-process scheduler (src/lib/workers/bootInProc.ts) runs the
  // full news pipeline every 5 min on the server, so we no longer
  // need the tab to babysit ingestion. The 10-second DB poll below
  // is enough to pick up what the server writes.

  // Auto-refresh every 60 seconds
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 10_000);
    return () => clearInterval(id);
  }, [load]);

  // Refresh when news pipeline completes
  const { lastEvent } = useEventStream();
  useEffect(() => {
    if (lastEvent?.type === 'news:new') load();
  }, [lastEvent, load]);

  const impactEntries = Object.entries(impacts).sort(([, a], [, b]) => b.aggregateImpact - a.aggregateImpact);

  // "Symbols Impacted" — count ONLY symbols attached to events in the
  // currently-visible window. The `impactEntries` feed comes from a
  // separate 24 h query on q365_news_scores, so unioning with it
  // (previous logic) produced the "1 event, 20 symbols" inconsistency
  // the user reported. Scoped tight to what's on screen.
  const symbolsImpactedSet = new Set<string>();
  for (const e of events) {
    if (Array.isArray(e.symbols)) {
      for (const sym of e.symbols) {
        if (sym) symbolsImpactedSet.add(String(sym).toUpperCase());
      }
    }
  }
  const symbolsImpactedCount = symbolsImpactedSet.size;

  // Classifier emits 5 labels (strongly_positive, positive, neutral,
  // negative, strongly_negative) but the UI shows 3 buckets. Without
  // this collapse, the previous code `if (k in sentimentCounts)` was
  // literally checking `k === 'positive'` etc. and silently skipping
  // strongly_* rows — producing `positive = 0` whenever the classifier
  // had confidence to use the strong tier. Fold strong tiers back into
  // their base polarity so the bucket sum matches events.length.
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  events.forEach(e => {
    const raw = String(e.sentiment ?? '').toLowerCase();
    if (raw === 'positive' || raw === 'strongly_positive') sentimentCounts.positive++;
    else if (raw === 'negative' || raw === 'strongly_negative') sentimentCounts.negative++;
    else sentimentCounts.neutral++;
  });

  return (
    <AppShell>
      <div className={s.pageHeader}>
        <span className={s.pageTitle}>
          <Newspaper size={24} style={{ display:'inline', verticalAlign:'middle', marginRight:8 }} />
          News Intelligence
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* Pipeline status pill — derived from /api/news-engine?action=summary,
              NOT from the UI refresh time. Spec rule: never claim FRESH
              when only the UI re-rendered. */}
          {summary && (() => {
            const pal: Record<PipelineStatus, { bg: string; fg: string; bd: string; label: string }> = {
              FRESH:   { bg: '#ECFDF5', fg: '#166534', bd: '#BBF7D0', label: 'Pipeline FRESH' },
              PARTIAL: { bg: '#FFFBEB', fg: '#92400E', bd: '#FDE68A', label: 'Pipeline PARTIAL' },
              STALE:   { bg: '#FEF3C7', fg: '#B45309', bd: '#FDE68A', label: 'Pipeline STALE' },
              NO_DATA: { bg: '#F1F5F9', fg: '#475569', bd: '#CBD5E1', label: 'Pipeline NO DATA' },
            };
            const p = pal[summary.status];
            return (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 11, fontWeight: 700,
                padding: '3px 10px', borderRadius: 99,
                background: p.bg, color: p.fg, border: `1px solid ${p.bd}`,
              }} title={`Configured sources: ${summary.configuredCount}/${summary.totalCount}`}>
                {p.label}
              </span>
            );
          })()}
          {/* UI refresh chip — explicitly labelled so operators don't
              confuse it with pipeline freshness. */}
          {lastFetchMs != null && (() => {
            const ageMs = Math.max(0, nowMs - lastFetchMs);
            const label =
              ageMs < 2_000     ? 'just now'  :
              ageMs < 60_000    ? `${Math.floor(ageMs / 1000)}s ago` :
              ageMs < 3_600_000 ? `${Math.floor(ageMs / 60_000)}m ago` :
                                  `${Math.floor(ageMs / 3_600_000)}h ago`;
            return (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 11, fontWeight: 600,
                padding: '3px 10px', borderRadius: 99,
                background: '#F8FAFC', color: '#475569', border: '1px solid #E2E8F0',
              }} title="When the dashboard last re-fetched events from the API. Does NOT mean the pipeline ran.">
                UI refresh · {label}
              </span>
            );
          })()}
          {/* Last pipeline run — distinct from UI refresh. */}
          {summary?.latestPipelineRunAt && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 11, fontWeight: 600,
              padding: '3px 10px', borderRadius: 99,
              background: '#F8FAFC', color: '#475569', border: '1px solid #E2E8F0',
            }} title="Wall-clock timestamp of the most recent ingestion run logged in q365_news_ingestion_log.">
              Pipeline ran · {formatRelative(summary.latestPipelineRunAt, nowMs) || formatPublishedAt(summary.latestPipelineRunAt)}
            </span>
          )}
          {/* Latest news event — the freshest publishedAt in the DB. */}
          {summary?.latestNewsPublishedAt && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 11, fontWeight: 600,
              padding: '3px 10px', borderRadius: 99,
              background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE',
            }} title="Newest publishedAt across persisted news events. This is news-freshness, not UI-freshness.">
              Latest news · {formatRelative(summary.latestNewsPublishedAt, nowMs) || formatPublishedAt(summary.latestNewsPublishedAt)}
            </span>
          )}
          {summary && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 11, fontWeight: 600,
              padding: '3px 10px', borderRadius: 99,
              background: '#F8FAFC', color: '#475569', border: '1px solid #E2E8F0',
            }} title={`Configured: ${summary.configuredCount}/${summary.totalCount}. Not configured: ${summary.notConfiguredSources.join(', ') || '—'}`}>
              Sources · {summary.configuredCount}/{summary.totalCount}
            </span>
          )}
          <style jsx global>{`
            @keyframes ni-pulse {
              0%   { box-shadow: 0 0 0 0 rgba(22,163,74,0.55); }
              70%  { box-shadow: 0 0 0 8px rgba(22,163,74,0); }
              100% { box-shadow: 0 0 0 0 rgba(22,163,74,0); }
            }
          `}</style>
          <button className={s.refreshBtn} onClick={triggerPipeline} disabled={running}>
            <RefreshCw size={14} className={running ? s.spin : ''} /> {running ? 'Running Pipeline...' : 'Run Pipeline'}
          </button>
        </div>
      </div>

      {/* Freshness filter bar */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {WINDOW_OPTIONS.map(opt => (
          <button
            key={opt.key}
            onClick={() => setWindowKey(opt.key)}
            style={{
              padding: '4px 12px',
              fontSize: 11,
              fontWeight: 700,
              borderRadius: 99,
              cursor: 'pointer',
              border: `1px solid ${windowKey === opt.key ? '#1D4ED8' : '#E2E8F0'}`,
              background: windowKey === opt.key ? '#DBEAFE' : 'white',
              color: windowKey === opt.key ? '#1D4ED8' : '#475569',
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {pipelineMsg && (
        <div style={{
          padding: '10px 14px',
          marginBottom: 12,
          borderRadius: 6,
          fontSize: 12,
          background: pipelineMsg.includes('error') || pipelineMsg.includes('Permission') || pipelineMsg.includes('Failed')
            ? '#FEF2F2' : pipelineMsg.includes('demo')
            ? '#FFFBEB' : '#F0FDF4',
          border: `1px solid ${
            pipelineMsg.includes('error') || pipelineMsg.includes('Permission') || pipelineMsg.includes('Failed')
              ? '#FECACA' : pipelineMsg.includes('demo') ? '#FDE68A' : '#BBF7D0'
          }`,
          color: pipelineMsg.includes('error') || pipelineMsg.includes('Permission') || pipelineMsg.includes('Failed')
            ? '#991B1B' : pipelineMsg.includes('demo') ? '#92400E' : '#166534',
        }}>
          {pipelineMsg}
        </div>
      )}

      <div className={s.statsRow}>
        <div className={s.statBox}><div className={s.statLabel}>Events ({windowKey})</div><div className={s.statValue}>{events.length}</div></div>
        <div className={s.statBox}><div className={s.statLabel}>Symbols Impacted</div><div className={s.statValue}>{symbolsImpactedCount}</div></div>
        <div className={s.statBox}><div className={s.statLabel} style={{ color:'#059669' }}>Positive</div><div className={s.statValue} style={{ color:'#059669' }}>{sentimentCounts.positive}</div></div>
        <div className={s.statBox}><div className={s.statLabel}>Neutral</div><div className={s.statValue}>{sentimentCounts.neutral}</div></div>
        <div className={s.statBox}><div className={s.statLabel} style={{ color:'#DC2626' }}>Negative</div><div className={s.statValue} style={{ color:'#DC2626' }}>{sentimentCounts.negative}</div></div>
      </div>

      <div className={s.tabBar}>
        <div className={`${s.tab} ${tab === 'events' ? s.active : ''}`} onClick={() => setTab('events')}>Recent Events</div>
        <div className={`${s.tab} ${tab === 'impact' ? s.active : ''}`} onClick={() => setTab('impact')}>Symbol Impact</div>
      </div>

      {loading ? <Loading text="Loading news intelligence..." /> : tab === 'events' ? (
        <div>
          {events.length === 0 ? (
            <div className={s.empty} style={{ padding: 40, textAlign: 'center' }}>
              <Newspaper size={48} style={{ opacity: 0.3, marginBottom: 12 }} />
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6 }}>No news events yet</div>
              <div style={{ fontSize: 12, color: '#94A3B8', marginBottom: 16, maxWidth: 460, margin: '0 auto 16px' }}>
                Click <b>Run Pipeline</b> above to fetch news from configured sources. If no live news sources are set up, demo data will be loaded so you can explore the dashboard.
              </div>
              <button
                onClick={triggerPipeline}
                disabled={running}
                style={{
                  padding: '10px 20px', borderRadius: 6, border: 'none',
                  background: running ? '#94A3B8' : '#1D4ED8', color: 'white',
                  fontSize: 12, fontWeight: 700, cursor: running ? 'not-allowed' : 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 8,
                }}
              >
                <RefreshCw size={14} className={running ? s.spin : ''} />
                {running ? 'Loading...' : 'Load News Now'}
              </button>
            </div>
          ) : events.map(e => {
            // Collapse 5 classifier labels → 3 UI buckets for styling.
            // `base` drives color/CSS; `display` keeps the strong-tier
            // text so operators still see "STRONGLY POSITIVE" / etc.
            const raw = String(e.sentiment ?? '').toLowerCase();
            const base = raw === 'positive' || raw === 'strongly_positive' ? 'positive'
                       : raw === 'negative' || raw === 'strongly_negative' ? 'negative'
                       : 'neutral';
            const borderColor = base === 'positive' ? '#059669'
                              : base === 'negative' ? '#DC2626' : undefined;
            const syms = Array.isArray(e.symbols) ? e.symbols : [];
            return (
              <div key={e.id} className={`${s.eventCard} ${s[base] ?? s.neutral}`}>
                <div className={s.eventTitle}>{e.title}</div>
                <div className={s.eventMeta}>
                  <span className={s.metaChip}>{e.category}</span>
                  <span className={s.metaChip} style={{ borderColor }}>
                    {raw.replace('_', ' ')}
                  </span>
                  {syms.length > 0 && syms.slice(0, 6).map(sym => (
                    <span
                      key={sym}
                      className={s.metaChip}
                      style={{ borderColor: '#1D4ED8', color: '#1D4ED8', fontWeight: 700 }}
                    >
                      {sym}
                    </span>
                  ))}
                  {syms.length > 6 && (
                    <span className={s.metaChip} style={{ color: '#5A6A7E' }}>
                      +{syms.length - 6}
                    </span>
                  )}
                  <span>{e.sourceId ?? e.source_id ?? '—'}</span>
                  <span style={{ color: '#475569', fontWeight: 600 }}>
                    {formatRelative(e.publishedAt, nowMs) || formatPublishedAt(e.publishedAt)}
                  </span>
                  <span style={{ color: '#94A3B8', fontSize: 10 }}>
                    {formatPublishedAt(e.publishedAt)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div>
          {impactEntries.length === 0 ? (
            <div className={s.empty}><BarChart3 size={48} /><span>No impact data available</span></div>
          ) : impactEntries.map(([sym, imp]) => {
            const barColor = imp.netSentiment === 'bullish' ? '#059669' : imp.netSentiment === 'bearish' ? '#DC2626' : '#0E7490';
            return (
              <div key={sym} className={s.impactRow}>
                <span className={s.impactSymbol}>{sym}</span>
                <span style={{ fontSize:11, color: barColor, fontWeight:700, width:60 }}>{imp.netSentiment}</span>
                <div className={s.impactBar}><div className={s.impactFill} style={{ width:`${Math.min(100, imp.aggregateImpact)}%`, background:barColor }} /></div>
                <span className={s.impactScore} style={{ color:barColor }}>{imp.aggregateImpact}</span>
                <span style={{ fontSize:11, color:'#5A6A7E', width:60, textAlign:'right' }}>{imp.eventCount} events</span>
              </div>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
