'use client';
import { Suspense, useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, StatCard, Badge, Button, AlertBanner, Loading } from '@/components/ui';
import { adminApi } from '@/lib/apiClient';
import { fmt } from '@/lib/utils';
import { Database, RefreshCw, Users, FileText, Activity, CheckCircle, AlertTriangle } from 'lucide-react';
const SYNCS = [
  'securities-master',
  'securities-candles',
  'nse1000-universe',
  'rankings',
  'signals',
  'instruments-nse',
  'instruments-bse',
  'instruments-fo',
];

function AdminDataContent() {
  const [usage,     setUsage]     = useState<any>(null);
  const [syncing,   setSyncing]   = useState<string | null>(null);
  const [msg,       setMsg]       = useState<{ text: string; ok: boolean } | null>(null);
  const [srcStatus, setSrcStatus] = useState<any>(null);

  useEffect(() => {
    adminApi.usage().then(setUsage).catch(() => {});
    fetch('/api/market-intelligence')
      .then(r => r.json())
      .then(d => setSrcStatus({ ok: true, source: d.meta?.dataSource, asOf: d.meta?.asOf }))
      .catch(() => setSrcStatus({ ok: false }));
  }, []);

  const triggerSync = async (type: string) => {
    setSyncing(type); setMsg(null);
    try {
      const d = await adminApi.syncData(type) as any;
      const extra =
        type === 'rankings' && d.db_count != null
          ? ` (${d.db_count} rows in DB)`
          : type === 'nse1000-universe' && d.apply?.totalActive != null
            ? ` (${d.apply.totalActive}/${d.targetSize ?? 1000} active universe)`
            : type === 'securities-master' && d.total != null
              ? ` (${d.total} EQ rows)`
              : '';
      setMsg({ text: `✓ ${type} sync: ${d.message || 'OK'}${extra}`, ok: true });
      adminApi.usage().then(setUsage).catch(() => {});
    } catch (e: any) {
      setMsg({ text: `✗ Failed: ${e.data?.error || e.message}`, ok: false });
    } finally { setSyncing(null); }
  };

  return (
    <AppShell title="Admin — Data Management">
      <div className="page">
        <div className="page__header">
          <div>
            <h1>Data Management</h1>
            <p>Data source health, sync jobs, and platform stats</p>
          </div>
        </div>

        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            {srcStatus?.ok
              ? <CheckCircle size={20} color="#16A34A" />
              : <AlertTriangle size={20} color="#D97706" />}
            <h3 style={{ fontWeight: 700 }}>Data Sources</h3>
            <Badge variant={srcStatus?.ok ? 'green' : 'red'}>
              {srcStatus?.ok ? `Live — ${srcStatus.source ?? 'yahoo'}` : 'Checking…'} // @deprecated marker
            </Badge>
          </div>
          <p style={{ fontSize: 13, color: '#64748B', marginBottom: 4 }}>
            <strong>Source:</strong> Yahoo Finance (~15-min delayed, no auth) // @deprecated marker
          </p>
          <p style={{ fontSize: 13, color: '#64748B', marginBottom: 4 }}>
            <strong>Mode:</strong> Signal-only — no broker dependency
          </p>
          {srcStatus?.asOf && (
            <p style={{ fontSize: 12, color: '#94A3B8', marginTop: 8 }}>
              Last data: {fmt.datetime(srcStatus.asOf)}
            </p>
          )}
        </Card>

        <Card style={{ marginBottom: 20 }}>
          <h3 style={{ fontWeight: 700, marginBottom: 4 }}>Data Sync Jobs</h3>
          <p style={{ fontSize: 13, color: '#64748B', marginBottom: 16 }}>
            NSE1000 uses <strong>EQUITY_L.csv</strong> as the securities master,
            filters <strong>SERIES=EQ</strong>, backfills candle history, then ranks
            the top 1000 by traded value, volume consistency, and candle completeness.
            Weekly rebuild is scheduled automatically; these buttons run it manually.
          </p>
          {msg && <AlertBanner variant={msg.ok ? 'success' : 'error'}>{msg.text}</AlertBanner>}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 12 }}>
            {SYNCS.map(t => (
              <Button key={t} variant="secondary" loading={syncing === t} onClick={() => triggerSync(t)}>
                <RefreshCw size={13} /> {t}
              </Button>
            ))}
          </div>
        </Card>

        {usage && (
          <div className="grid-stats">
            <StatCard label="Total Users"       value={usage.total_users ?? '—'}     icon={Users}    iconVariant="blue"   />
            <StatCard label="Active Sessions"   value={usage.active_today ?? '—'}    icon={Activity} iconVariant="green"  />
            <StatCard label="Rankings Rows"     value={usage.total_rankings ?? '—'}  icon={Database} iconVariant="green"  />
            <StatCard label="Universe Active"   value={usage.total_universe ?? '—'}   icon={Database} iconVariant="orange" />
            <StatCard label="Securities EQ"     value={usage.total_securities_eq ?? '—'} icon={FileText} iconVariant="blue" />
            <StatCard label="Instruments"       value={usage.total_instruments ?? '—'} icon={Database} iconVariant="blue" />
          </div>
        )}
      </div>
    </AppShell>
  );
}

export default function AdminDataPage() {
  return (
    <Suspense fallback={<AppShell title="Admin — Data Management"><div className="page"><Loading /></div></AppShell>}>
      <AdminDataContent />
    </Suspense>
  );
}
