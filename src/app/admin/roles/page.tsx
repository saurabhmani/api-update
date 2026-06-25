'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Shield, RefreshCw, Users } from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { adminApi } from '@/lib/apiClient';
import { Badge, Button, Card, Empty, Loading, AlertBanner } from '@/components/ui';
import styles from '../audit-logs/audit.module.scss';

export default function RoleManagementPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rbac, setRbac] = useState<any>(null);
  const [users, setUsers] = useState<any[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rbacRes, usersRes] = await Promise.all([
        fetch('/api/security/rbac').then((r) => r.json()),
        adminApi.users(),
      ]);
      if (!rbacRes.ok) throw new Error(rbacRes.error);
      setRbac(rbacRes);
      setUsers((usersRes as { users?: any[] }).users ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const updateRole = async (userId: number, role: string) => {
    await adminApi.updateUser({ id: userId, role });
    await load();
  };

  return (
    <AppShell title="Role Management">
      <div className="page">
        <div className="page__header">
          <h1><Shield size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />Role Management</h1>
          <p>RBAC — roles, permissions, and user assignments.</p>
        </div>
        <Link href="/settings/security" style={{ fontSize: '0.85rem', color: '#64748B' }}>← Security Settings</Link>
        {error && <AlertBanner variant="error">{error}</AlertBanner>}
        <Button variant="secondary" size="sm" onClick={load} loading={loading} style={{ margin: '16px 0' }}>
          <RefreshCw size={14} /> Refresh
        </Button>
        {loading ? <Loading /> : !rbac ? <Empty icon={Shield} title="No RBAC data" /> : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
              <Card title="Roles" compact>
                {(rbac.roles ?? []).map((r: any) => (
                  <div key={r.id} style={{ padding: '8px 0', borderBottom: '1px solid #E2E8F0' }}>
                    <strong>{r.name}</strong>
                    <div style={{ fontSize: '0.8rem', color: '#64748B' }}>{r.description}</div>
                    <div style={{ marginTop: 6 }}>
                      {(rbac.matrix?.[r.name] ?? []).map((p: string) => (
                        <Badge key={p} variant="gray" style={{ marginRight: 4, marginBottom: 4 }}>{p}</Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </Card>
              <Card title="Permissions" compact>
                {(rbac.permissions ?? []).map((p: any) => (
                  <div key={p.id} style={{ fontSize: '0.85rem', padding: '4px 0' }}>
                    <code>{p.code}</code> — <span style={{ color: '#64748B' }}>{p.description}</span>
                  </div>
                ))}
              </Card>
            </div>
            <Card title="User Role Assignments" action={<Users size={16} />} flush>
              <table className={styles.table}>
                <thead><tr><th>User</th><th>Email</th><th>Role</th><th>Status</th></tr></thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id}>
                      <td><strong>{u.name ?? '—'}</strong></td>
                      <td>{u.email}</td>
                      <td>
                        <select value={u.role} onChange={(e) => updateRole(u.id, e.target.value)}
                          style={{ fontSize: 12, border: '1px solid #E2E8F0', borderRadius: 6, padding: '2px 8px' }}>
                          {(rbac.roles ?? []).map((r: any) => (
                            <option key={r.name} value={r.name}>{r.name}</option>
                          ))}
                        </select>
                      </td>
                      <td><Badge variant={u.is_active ? 'green' : 'red'}>{u.is_active ? 'Active' : 'Disabled'}</Badge></td>
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
