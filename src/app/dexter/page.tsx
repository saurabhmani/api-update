'use client';
import { useEffect, useState, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Loading } from '@/components/ui';
import { Brain, RefreshCw, Shield, AlertTriangle, TrendingUp, Target, Zap, ChevronDown, ChevronUp, Wifi } from 'lucide-react';
import { useEventStream } from '@/hooks/useEventStream';
import s from './dexter.module.scss';

interface DexterIntel {
  symbol: string;
  verdict: string;
  conviction: 'high' | 'moderate' | 'low' | 'avoid';
  explanation: {
    setupReason: string;
    newsImpact: string;
    cautionReason: string | null;
    riskHighlights: string[];
    invalidators: string[];
  };
  modifiers: Record<string, number>;
  calibration: { strategyWinRate: number | null; strategyFit: string; confidenceCalibration: string; feedbackNote: string | null; };
  guidance: string[];
}

const CONV_LABELS: Record<string, string> = { high: 'High Conviction', moderate: 'Moderate', low: 'Low', avoid: 'Avoid' };
const CONV_ICONS: Record<string, typeof Zap> = { high: TrendingUp, moderate: Target, low: AlertTriangle, avoid: Shield };

function ModValue({ v }: { v: number }) {
  const color = v > 0 ? '#059669' : v < 0 ? '#DC2626' : '#5A6A7E';
  return <span className={s.modValue} style={{ color }}>{v > 0 ? `+${v}` : v}</span>;
}

function SignalCard({ d }: { d: DexterIntel }) {
  const [open, setOpen] = useState(false);
  const Icon = CONV_ICONS[d.conviction] ?? Target;
  const modEntries = Object.entries(d.modifiers).filter(([k]) => k !== 'totalAdjustment');

  return (
    <div className={`${s.signalCard} ${s[d.conviction]}`}>
      <div className={s.cardHeader}>
        <span className={s.symbol}>{d.symbol}</span>
        <span className={s.convictionBadge}><Icon size={12} /> {CONV_LABELS[d.conviction]}</span>
      </div>

      <p className={s.verdict}>{d.verdict}</p>

      {d.explanation.newsImpact && d.explanation.newsImpact !== 'No significant news activity for this symbol.' && (
        <div className={s.section}>
          <div className={s.sectionTitle}>News Impact</div>
          <div className={s.newsImpact}>{d.explanation.newsImpact}</div>
        </div>
      )}

      {d.explanation.cautionReason && (
        <div className={s.section}>
          <div className={s.sectionTitle}>Caution</div>
          <div className={s.cautionBox}>{d.explanation.cautionReason}</div>
        </div>
      )}

      <button onClick={() => setOpen(!open)} style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, color:'#0E7490', fontWeight:700, background:'none', border:'none', cursor:'pointer', marginTop:8 }}>
        {open ? 'Less' : 'More Details'} {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {open && (
        <>
          {d.explanation.riskHighlights.length > 0 && (
            <div className={s.section} style={{ marginTop: 12 }}>
              <div className={s.sectionTitle}>Risk Highlights</div>
              <ul className={s.riskList}>{d.explanation.riskHighlights.map((r, i) => <li key={i}>{r}</li>)}</ul>
            </div>
          )}

          {d.guidance.length > 0 && (
            <div className={s.section}>
              <div className={s.sectionTitle}>Guidance</div>
              <ul className={s.guidanceList}>{d.guidance.map((g, i) => <li key={i}>{g}</li>)}</ul>
            </div>
          )}

          <div className={s.section}>
            <div className={s.sectionTitle}>Modifier Breakdown (total: {d.modifiers.totalAdjustment > 0 ? '+' : ''}{d.modifiers.totalAdjustment})</div>
            <div className={s.modGrid}>
              {modEntries.map(([k, v]) => (
                <div key={k} className={s.modItem}>
                  <span className={s.modLabel}>{k.replace(/([A-Z])/g, ' $1').trim()}</span>
                  <ModValue v={v} />
                </div>
              ))}
            </div>
          </div>

          {d.calibration.feedbackNote && (
            <div className={s.calibNote}>{d.calibration.feedbackNote}</div>
          )}
        </>
      )}
    </div>
  );
}

export default function DexterPage() {
  const [data, setData] = useState<DexterIntel[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>('all');

  // Auto-refresh when new signals arrive via SSE
  const { lastEvent, connected } = useEventStream();
  useEffect(() => {
    if (lastEvent?.type === 'dexter:update' || lastEvent?.type === 'signal:new') {
      load(false);
    }
  }, [lastEvent]);

  const load = useCallback(async (spinner = true) => {
    if (spinner) setLoading(true);
    try {
      const convParam = filter !== 'all' ? `&conviction=${filter}` : '';
      const res = await fetch(`/api/signal-engine/dexter?days=7${convParam}`, { cache: 'no-store' });
      const json = await res.json();
      setData(json.intelligence ?? []);
    } catch { setData([]); }
    if (spinner) setLoading(false);
  }, [filter]);

  useEffect(() => { load(); }, [filter, load]);

  // Auto-refresh every 30 seconds as a polling fallback
  // (SSE events may not cross process boundaries on the server)
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) load(false);
    }, 10_000);
    return () => clearInterval(id);
  }, [load]);

  const counts = { high: 0, moderate: 0, low: 0, avoid: 0 };
  data.forEach(d => { if (d.conviction in counts) counts[d.conviction as keyof typeof counts]++; });

  return (
    <AppShell>
      <div className={s.pageHeader}>
        <span className={s.pageTitle}><Brain size={24} style={{ display:'inline', verticalAlign:'middle', marginRight:8 }} />Dexter AI Intelligence</span>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          {connected && <span style={{ display:'inline-flex', alignItems:'center', gap:4, fontSize:11, color:'#059669', fontWeight:600 }}><Wifi size={12} /> LIVE</span>}
          <button className={s.refreshBtn} onClick={() => load()} disabled={loading}>
            <RefreshCw size={14} className={loading ? s.spin : ''} /> Refresh
          </button>
        </div>
      </div>

      <div className={s.statsRow}>
        <div className={s.statBox}><div className={s.statLabel}>Total Signals</div><div className={s.statValue}>{data.length}</div></div>
        <div className={s.statBox}><div className={s.statLabel} style={{ color:'#059669' }}>High Conviction</div><div className={s.statValue} style={{ color:'#059669' }}>{counts.high}</div></div>
        <div className={s.statBox}><div className={s.statLabel} style={{ color:'#2563EB' }}>Moderate</div><div className={s.statValue} style={{ color:'#2563EB' }}>{counts.moderate}</div></div>
        <div className={s.statBox}><div className={s.statLabel} style={{ color:'#DC2626' }}>Avoid</div><div className={s.statValue} style={{ color:'#DC2626' }}>{counts.avoid}</div></div>
      </div>

      <div className={s.filterBar}>
        {['all', 'high', 'moderate', 'low', 'avoid'].map(f => (
          <button key={f} className={`${s.filterBtn} ${filter === f ? s.active : ''}`} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : CONV_LABELS[f]}
          </button>
        ))}
      </div>

      {loading ? <Loading text="Loading Dexter intelligence..." /> : data.length === 0 ? (
        <div className={s.empty}><Brain size={48} /><span>No signals in the selected timeframe</span></div>
      ) : (
        <div className={s.grid}>{data.map((d, i) => <SignalCard key={i} d={d} />)}</div>
      )}
    </AppShell>
  );
}
