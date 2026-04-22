'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty } from '@/components/ui';
import { adminApi } from '@/lib/apiClient';
import { fmt } from '@/lib/utils';
import { ClipboardList } from 'lucide-react';

export default function AuditPage() {
  const [logs,    setLogs]    = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi.auditLogs(100).then((d: any) => setLogs(d.logs || [])).finally(() => setLoading(false));
  }, []);

  const badgeFor = (action: string) => {
    if (action?.includes('delete')) return 'red';
    if (action?.includes('create') || action?.includes('add')) return 'green';
    return 'gray';
  };

  return (
    <AppShell title="Admin — Audit Logs">
      <div className="page">
        <div className="page__header"><div><h1>Audit Logs</h1><p>All user and admin actions</p></div></div>
        <Card flush>
          {loading ? <Loading /> : logs.length === 0 ? (
            <Empty icon={ClipboardList} title="No audit logs yet" />
          ) : (
            <div style={{ overflowX:'auto' }}>
              <table className="table">
                <thead><tr><th>Time</th><th>User</th><th>Action</th><th>Resource</th><th>Details</th></tr></thead>
                <tbody>
                  {logs.map((l, i) => (
                    <tr key={l.id || i}>
                      <td style={{ fontSize:11, color:'#64748B', whiteSpace:'nowrap' }}>{fmt.datetime(l.created_at)}</td>
                      <td style={{ fontSize:13 }}>{l.user_email || '—'}</td>
                      <td><Badge variant={badgeFor(l.action) as any}>{l.action}</Badge></td>
                      <td style={{ fontSize:12, color:'#64748B' }}>{l.resource_type}{l.resource_id ? ` #${l.resource_id}` : ''}</td>
                      <td style={{ fontSize:11, color:'#94A3B8', maxWidth:200, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                        {l.metadata ? JSON.stringify(l.metadata).slice(0,60) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
