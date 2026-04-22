'use client';
import { useEffect, useState, useCallback } from 'react';
import { useEventStream } from '@/hooks/useEventStream';
import AppShell from '@/components/layout/AppShell';
import { Card, Loading } from '@/components/ui';
import { Newspaper, RefreshCw, TrendingUp, AlertTriangle, Zap, BarChart3, Shield } from 'lucide-react';
import s from './news.module.scss';

interface NewsEvent { id: number; title: string; category: string; sentiment: string; source_id: string; publishedAt: string; }
interface ScoreRow { symbol: string; trust_score: number; sentiment_score: number; importance_score: number; symbol_impact_score: number; event_risk_score: number; manipulation_risk_boost: number; }
interface ImpactRow { symbol: string; confidenceModifier: number; riskPenalty: number; aggregateImpact: number; netSentiment: string; eventCount: number; }

export default function NewsIntelligencePage() {
  const [events, setEvents] = useState<NewsEvent[]>([]);
  const [impacts, setImpacts] = useState<Record<string, ImpactRow>>({});
  const [tab, setTab] = useState<'events' | 'impact'>('events');
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [evRes, impRes] = await Promise.allSettled([
        fetch('/api/news-engine?limit=50&days=3', { cache: 'no-store' }).then(r => r.ok ? r.json() : { events: [] }),
        fetch('/api/news-engine?impact=true', { cache: 'no-store' }).then(r => r.ok ? r.json() : { symbolImpacts: {} }),
      ]);
      const evData = evRes.status === 'fulfilled' ? evRes.value : { events: [] };
      const impData = impRes.status === 'fulfilled' ? impRes.value : { symbolImpacts: {} };
      setEvents(evData.events ?? []);
      setImpacts(impData.symbolImpacts ?? {});
    } catch { /* empty */ }
    setLoading(false);
  }, []);

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

  useEffect(() => { load(); }, [load]);

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
  const sentimentCounts = { positive: 0, neutral: 0, negative: 0 };
  events.forEach(e => { const k = e.sentiment as keyof typeof sentimentCounts; if (k in sentimentCounts) sentimentCounts[k]++; });

  return (
    <AppShell>
      <div className={s.pageHeader}>
        <span className={s.pageTitle}><Newspaper size={24} style={{ display:'inline', verticalAlign:'middle', marginRight:8 }} />News Intelligence</span>
        <button className={s.refreshBtn} onClick={triggerPipeline} disabled={running}>
          <RefreshCw size={14} className={running ? s.spin : ''} /> {running ? 'Running Pipeline...' : 'Run Pipeline'}
        </button>
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
        <div className={s.statBox}><div className={s.statLabel}>Events (3d)</div><div className={s.statValue}>{events.length}</div></div>
        <div className={s.statBox}><div className={s.statLabel}>Symbols Impacted</div><div className={s.statValue}>{impactEntries.length}</div></div>
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
          ) : events.map(e => (
            <div key={e.id} className={`${s.eventCard} ${s[e.sentiment] ?? s.neutral}`}>
              <div className={s.eventTitle}>{e.title}</div>
              <div className={s.eventMeta}>
                <span className={s.metaChip}>{e.category}</span>
                <span className={s.metaChip} style={{ borderColor: e.sentiment === 'positive' ? '#059669' : e.sentiment === 'negative' ? '#DC2626' : undefined }}>
                  {e.sentiment}
                </span>
                <span>{e.source_id}</span>
                <span>{new Date(e.publishedAt).toLocaleString()}</span>
              </div>
            </div>
          ))}
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
