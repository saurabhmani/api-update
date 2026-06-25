'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { FileText, RefreshCw, Shield } from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { Badge, Button, Card, Empty, Loading, AlertBanner } from '@/components/ui';
import { fmt } from '@/lib/utils';
import styles from './audit.module.scss';

export default function AuditLogsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [data, setData] = useState<any>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/audit?all=true&limit=100').then((r) => r.json());
      if (!res.ok) throw new Error(res.error);
      setData(res);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <AppShell title="Audit Logs">
      <div className="page">
        <div className="page__header">
          <h1><FileText size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />Audit Logs</h1>
          <p>Security events, compliance actions, and platform audit trail.</p>
        </div>
        <div style={{ marginBottom: 12 }}>
          <Link href="/settings/security" style={{ fontSize: '0.85rem', color: '#64748B' }}>← Security Settings</Link>
        </div>
        {error && <AlertBanner variant="error">{error}</AlertBanner>}
        <Button variant="secondary" size="sm" onClick={load} loading={loading} style={{ marginBottom: 16 }}>
          <RefreshCw size={14} /> Refresh
        </Button>
        {loading ? <Loading /> : !data ? <Empty icon={FileText} title="No logs" /> : (
          <>
            <Card title="Security Audit" compact>
              <table className={styles.table}>
                <thead><tr><th>Time</th><th>Event</th><th>Action</th><th>Actor</th><th>Resource</th></tr></thead>
                <tbody>
                  {(data.securityAudit ?? []).slice(0, 50).map((e: any) => (
                    <tr key={`s-${e.id}`}>
                      <td>{fmt.datetime(e.createdAt)}</td>
                      <td><Badge variant="gray">{e.eventType}</Badge></td>
                      <td><strong>{e.action}</strong></td>
                      <td>{e.actorEmail ?? e.userId ?? '—'}</td>
                      <td>{e.resource ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Platform Audit Logs" compact>
              <table className={styles.table}>
                <thead><tr><th>Time</th><th>Action</th><th>Type</th><th>User</th></tr></thead>
                <tbody>
                  {(data.auditLogs ?? []).slice(0, 50).map((e: any) => (
                    <tr key={`a-${e.id}`}>
                      <td>{fmt.datetime(e.createdAt)}</td>
                      <td><strong>{e.action}</strong></td>
                      <td>{e.resourceType ?? '—'}</td>
                      <td>{e.userId ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <Card title="Consent Logs" compact>
              <table className={styles.table}>
                <thead><tr><th>Time</th><th>Type</th><th>Version</th><th>User</th></tr></thead>
                <tbody>
                  {(data.consentLogs ?? []).map((c: any) => (
                    <tr key={c.id}>
                      <td>{fmt.datetime(c.createdAt)}</td>
                      <td>{c.consentType}</td>
                      <td>{c.version}</td>
                      <td>{c.userId}</td>
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
