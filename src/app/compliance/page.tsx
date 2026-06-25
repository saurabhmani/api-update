'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Scale, RefreshCw, CheckCircle, AlertTriangle, FileText } from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { Badge, Button, Card, Loading, AlertBanner } from '@/components/ui';
import styles from '../settings/security/security.module.scss';

const CONSENT_LABELS: Record<string, string> = {
  terms_of_service: 'Terms of Service',
  privacy_policy: 'Privacy Policy',
  trading_disclaimer: 'Trading Disclaimer',
  live_trading_risk: 'Live Trading Risk',
  data_processing: 'Data Processing',
  marketing: 'Marketing',
};

export default function ComplianceCenterPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState<any>(null);
  const [events, setEvents] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [comp, ev] = await Promise.all([
        fetch('/api/security/compliance').then((r) => r.json()),
        fetch('/api/security/events?limit=30').then((r) => r.json()),
      ]);
      if (!comp.ok) throw new Error(comp.error);
      setData(comp);
      setEvents(ev.events ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const accept = async (type: string) => {
    await fetch('/api/security/compliance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consentType: type }),
    });
    await load();
  };

  return (
    <AppShell title="Compliance Center">
      <div className="page">
        <div className="page__header">
          <h1><Scale size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />Compliance Center</h1>
          <p>Consent tracking, trading disclaimers, retention policies, and security events.</p>
        </div>
        <Link href="/settings/security" style={{ fontSize: '0.85rem', color: '#64748B' }}>← Security Settings</Link>
        {error && <AlertBanner variant="error">{error}</AlertBanner>}
        <Button variant="secondary" size="sm" onClick={load} loading={loading} style={{ margin: '16px 0' }}>
          <RefreshCw size={14} /> Refresh
        </Button>
        {loading ? <Loading /> : data && (
          <>
            <Card title="Trading Disclaimers" compact>
              <div className={styles.disclaimer}>{data.disclaimers?.standard}</div>
              <div className={styles.disclaimer} style={{ background: '#FEF2F2', borderColor: '#FCA5A5', color: '#991B1B' }}>
                {data.disclaimers?.liveTrading}
              </div>
            </Card>
            <Card title="Consent Status" action={<FileText size={16} />}>
              {(data.required?.pending ?? []).map((c: string) => (
                <div key={c} style={{ display: 'flex', justifyContent: 'space-between', padding: '10px 0', borderBottom: '1px solid #E2E8F0' }}>
                  <span><AlertTriangle size={14} style={{ color: '#D97706', marginRight: 6 }} />{CONSENT_LABELS[c] ?? c}</span>
                  <Button size="sm" onClick={() => accept(c)}>Accept</Button>
                </div>
              ))}
              {(data.required?.accepted ?? []).map((c: string) => (
                <div key={c} style={{ padding: '10px 0', color: '#16A34A' }}>
                  <CheckCircle size={14} style={{ marginRight: 6 }} />{CONSENT_LABELS[c] ?? c}
                </div>
              ))}
            </Card>
            <Card title="Data Retention Policies" compact>
              <table className={styles.table}>
                <thead><tr><th>Category</th><th>Days</th><th>Description</th></tr></thead>
                <tbody>
                  {(data.retentionPolicies ?? []).map((p: any) => (
                    <tr key={p.dataCategory}><td><strong>{p.dataCategory}</strong></td><td>{p.retentionDays}</td><td style={{ fontSize: '0.8rem', color: '#64748B' }}>{p.description}</td></tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Recent Security Events" compact>
              <table className={styles.table}>
                <thead><tr><th>Time</th><th>Type</th><th>Action</th><th>Severity</th></tr></thead>
                <tbody>
                  {events.slice(0, 20).map((e: any) => (
                    <tr key={e.id}>
                      <td>{new Date(e.createdAt).toLocaleString()}</td>
                      <td>{e.eventType}</td>
                      <td>{e.action}</td>
                      <td><Badge variant={e.severity === 'critical' ? 'red' : e.severity === 'warning' ? 'orange' : 'gray'}>{e.severity}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
