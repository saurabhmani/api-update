'use client';
// ════════════════════════════════════════════════════════════════
//  /surveillance — Phase 3 Manipulation Surveillance Dashboard
//
//  One-screen operational view for the manipulation engine. Reads
//  /api/manipulation-engine/dashboard. Sections:
//   - Top suspicious symbols today
//   - Event-type histogram
//   - Sector concentration
//   - 20/60/120-day event density
//   - Watchlists (3)
//   - Recent penalty log
// ════════════════════════════════════════════════════════════════

import { useEffect, useState, useCallback } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card } from '@/components/ui';
import { ShieldAlert, RefreshCw, Activity, Layers, Eye } from 'lucide-react';

interface DashboardData {
  date: string;
  topSuspicious: Array<{ symbol: string; score: number; band: string; snapshotDate: string }>;
  eventDensity: {
    d20: Array<{ symbol: string; eventCount: number }>;
    d60: Array<{ symbol: string; eventCount: number }>;
    d120: Array<{ symbol: string; eventCount: number }>;
  };
  sectorConcentration: Array<{ sector: string; symbolCount: number; totalEvents: number; avgScore: number }>;
  eventTypes: Array<{ eventType: string; count: number }>;
  watchlists: Record<string, Array<{ symbol: string; scoreAtAdd: number; bandAtAdd: string; reason: string | null; coolingOffUntil: string | null }>>;
  recentPenalties: Array<{ signalId: string; snapshotId: number; confidencePenalty: number; rejectionFlag: boolean; reason: string }>;
}

const BAND_COLOR: Record<string, { bg: string; fg: string }> = {
  low:      { bg: '#F0FDF4', fg: '#15803D' },
  watch:    { bg: '#FEF9C3', fg: '#854D0E' },
  elevated: { bg: '#FEF3C7', fg: '#92400E' },
  high:     { bg: '#FEE2E2', fg: '#991B1B' },
  severe:   { bg: '#FEE2E2', fg: '#7F1D1D' },
};

export default function SurveillancePage() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [windowSize, setWindowSize] = useState<20 | 60 | 120>(20);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/manipulation-engine/dashboard?date=${date}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }, [date]);

  useEffect(() => { load(); }, [load]);

  const densityRows = data
    ? (windowSize === 20 ? data.eventDensity.d20
      : windowSize === 60 ? data.eventDensity.d60
      : data.eventDensity.d120)
    : [];

  return (
    <AppShell>
      <div style={{ padding: 24, maxWidth: 1400, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <ShieldAlert size={28} color="#7F1D1D" />
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 800, margin: 0, color: '#1E3A5F' }}>Manipulation Surveillance</h1>
              <div style={{ fontSize: 12, color: '#64748B' }}>Phase 3 — operational view</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
              style={{ padding: '6px 10px', border: '1px solid #E2E8F0', borderRadius: 6, fontSize: 13 }} />
            <button onClick={load} disabled={loading}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px',
                background: '#1E40AF', color: 'white', border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 600,
                cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1 }}>
              <RefreshCw size={14} /> {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
        </div>

        {error && (
          <Card style={{ padding: 12, marginBottom: 16, background: '#FEF2F2', border: '1px solid #FECACA', color: '#991B1B', fontSize: 13 }}>
            {error}
          </Card>
        )}

        {data && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>

            {/* Top suspicious */}
            <Card style={{ padding: 16 }}>
              <SectionHeader icon={<Activity size={16} />} title={`Top suspicious — ${data.date}`} />
              {data.topSuspicious.length === 0
                ? <div style={{ fontSize: 12, color: '#94A3B8', padding: 8 }}>No snapshots persisted for this date.</div>
                : <Table head={['Symbol', 'Score', 'Band']}
                    rows={data.topSuspicious.map((s) => [s.symbol, s.score.toString(), <BandPill key={s.symbol} band={s.band} />])} />}
            </Card>

            {/* Event types */}
            <Card style={{ padding: 16 }}>
              <SectionHeader icon={<Layers size={16} />} title="Event-type distribution (30d)" />
              {data.eventTypes.length === 0
                ? <div style={{ fontSize: 12, color: '#94A3B8', padding: 8 }}>No events recorded.</div>
                : data.eventTypes.slice(0, 12).map((e) => (
                  <div key={e.eventType} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', borderBottom: '1px solid #F1F5F9' }}>
                    <span style={{ fontSize: 12, color: '#475569' }}>{e.eventType}</span>
                    <span style={{ fontSize: 12, color: '#1E3A5F', fontWeight: 700 }}>{e.count}</span>
                  </div>
                ))}
            </Card>

            {/* Sector concentration */}
            <Card style={{ padding: 16 }}>
              <SectionHeader icon={<Layers size={16} />} title="Sector concentration (30d)" />
              {data.sectorConcentration.length === 0
                ? <div style={{ fontSize: 12, color: '#94A3B8', padding: 8 }}>No sector data.</div>
                : <Table head={['Sector', 'Symbols', 'Events', 'Avg score']}
                    rows={data.sectorConcentration.slice(0, 10).map((s) => [
                      s.sector, s.symbolCount.toString(), s.totalEvents.toString(), s.avgScore.toFixed(1),
                    ])} />}
            </Card>

            {/* Event density windows */}
            <Card style={{ padding: 16 }}>
              <SectionHeader icon={<Activity size={16} />} title="Event density by window" />
              <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                {[20, 60, 120].map((d) => (
                  <button key={d} onClick={() => setWindowSize(d as 20 | 60 | 120)}
                    style={{ padding: '4px 10px', fontSize: 11, fontWeight: 700,
                      background: windowSize === d ? '#1E40AF' : '#F1F5F9',
                      color: windowSize === d ? 'white' : '#475569',
                      border: 'none', borderRadius: 6, cursor: 'pointer' }}>
                    {d}d
                  </button>
                ))}
              </div>
              {densityRows.length === 0
                ? <div style={{ fontSize: 12, color: '#94A3B8', padding: 8 }}>No data.</div>
                : <Table head={['Symbol', 'Events']}
                    rows={densityRows.slice(0, 10).map((r) => [r.symbol, r.eventCount.toString()])} />}
            </Card>

            {/* Watchlists */}
            <Card style={{ padding: 16, gridColumn: '1 / span 2' }}>
              <SectionHeader icon={<Eye size={16} />} title="Active watchlists" />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
                {(['suspicious_symbols', 'high_risk_operator', 'event_cluster'] as const).map((wl) => (
                  <div key={wl}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: '#475569', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                      {wl.replace(/_/g, ' ')} ({(data.watchlists[wl] ?? []).length})
                    </div>
                    {(data.watchlists[wl] ?? []).length === 0
                      ? <div style={{ fontSize: 12, color: '#94A3B8' }}>—</div>
                      : (data.watchlists[wl] ?? []).slice(0, 8).map((e) => (
                        <div key={e.symbol} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, color: '#475569', borderBottom: '1px solid #F8FAFC' }}>
                          <span style={{ fontWeight: 600 }}>{e.symbol}</span>
                          <span>{Number(e.scoreAtAdd).toFixed(0)} {e.coolingOffUntil ? '· cooling' : ''}</span>
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            </Card>

            {/* Recent penalties */}
            <Card style={{ padding: 16, gridColumn: '1 / span 2' }}>
              <SectionHeader icon={<ShieldAlert size={16} />} title="Recent signal penalties" />
              {data.recentPenalties.length === 0
                ? <div style={{ fontSize: 12, color: '#94A3B8', padding: 8 }}>No penalties recorded.</div>
                : <Table head={['Signal id', 'Snapshot', 'Conf penalty', 'Rejected', 'Reason']}
                    rows={data.recentPenalties.slice(0, 12).map((p) => [
                      p.signalId, p.snapshotId.toString(),
                      p.confidencePenalty.toString(), p.rejectionFlag ? 'YES' : 'no',
                      p.reason,
                    ])} />}
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}

// ── Small inline UI helpers (kept here to avoid spreading new files) ──

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, color: '#1E3A5F' }}>
      {icon}
      <span style={{ fontSize: 13, fontWeight: 700 }}>{title}</span>
    </div>
  );
}

function BandPill({ band }: { band: string }) {
  const c = BAND_COLOR[band] ?? BAND_COLOR.low;
  return (
    <span style={{
      background: c.bg, color: c.fg, fontSize: 10, fontWeight: 700,
      padding: '2px 8px', borderRadius: 99, textTransform: 'uppercase', letterSpacing: 0.4,
    }}>
      {band}
    </span>
  );
}

function Table({ head, rows }: { head: string[]; rows: (string | React.ReactNode)[][] }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {head.map((h) => (
              <th key={h} style={{ textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid #E2E8F0', color: '#64748B', fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} style={{ padding: '6px 8px', borderBottom: '1px solid #F1F5F9', color: '#1E3A5F' }}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
