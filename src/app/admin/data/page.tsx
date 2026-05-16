'use client';
import { Suspense, useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, StatCard, Badge, Button, AlertBanner, Loading } from '@/components/ui';
import { adminApi } from '@/lib/apiClient';
import { fmt } from '@/lib/utils';
import { Database, RefreshCw, Users, FileText, Activity, CheckCircle, AlertTriangle } from 'lucide-react';
const SYNCS = ['rankings', 'signals', 'instruments-nse', 'instruments-bse', 'instruments-fo'];

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
      setMsg({ text: `✓ ${type} sync: ${d.message || 'OK'}`, ok: true });
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
            Run <strong>instruments-nse</strong> first to load the full equity instrument master
            (public CDN, no auth, takes 1–2 min). Then run <strong>rankings</strong> during
            market hours (9:15–15:30 IST) to populate the dashboard and signal engine.
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
            <StatCard label="Reports Generated" value={usage.reports_total ?? '—'}   icon={FileText} iconVariant="orange" />
            <StatCard label="API Calls Today"   value={usage.api_calls_today ?? '—'} icon={Database} iconVariant="blue"   />
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
