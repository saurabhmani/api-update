'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty } from '@/components/ui';
import { adminApi } from '@/lib/apiClient';
import { fmt } from '@/lib/utils';
import { Users } from 'lucide-react';

export default function AdminUsersPage() {
  const [users,   setUsers]   = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminApi.users().then((d: any) => setUsers(d.users || [])).finally(() => setLoading(false));
  }, []);

  const updateUser = async (id: number, patch: any) => {
    await adminApi.updateUser({ id, ...patch });
    setUsers(prev => prev.map(u => u.id === id ? { ...u, ...patch } : u));
  };

  return (
    <AppShell title="Admin — Users">
      <div className="page">
        <div className="page__header"><div><h1>User Management</h1><p>{users.length} users</p></div></div>
        <Card flush>
          {loading ? <Loading /> : users.length === 0 ? <Empty icon={Users} title="No users" /> : (
            <div style={{ overflowX:'auto' }}>
              <table className="table">
                <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>2FA</th><th>Last Login</th><th>Actions</th></tr></thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.id}>
                      <td><strong>{u.name || '—'}</strong></td>
                      <td style={{ fontSize:13, color:'#64748B' }}>{u.email}</td>
                      <td>
                        <select
                          value={u.role}
                          onChange={e => updateUser(u.id, { role: e.target.value })}
                          style={{ fontSize:12, border:'1px solid #E2E8F0', borderRadius:6, padding:'2px 8px', background:'#fff', cursor:'pointer' }}
                        >
                          <option value="user">User</option>
                          <option value="admin">Admin</option>
                        </select>
                      </td>
                      <td><Badge variant={u.is_active ? 'green' : 'red'}>{u.is_active ? 'Active' : 'Disabled'}</Badge></td>
                      <td><Badge variant={u.totp_enabled ? 'green' : 'gray'}>{u.totp_enabled ? 'Enabled' : 'Off'}</Badge></td>
                      <td style={{ fontSize:12, color:'#64748B' }}>{fmt.datetime(u.last_login_at)}</td>
                      <td>
                        <button className="btn btn--sm btn--secondary" onClick={() => updateUser(u.id, { is_active: !u.is_active })}>
                          {u.is_active ? 'Disable' : 'Enable'}
                        </button>
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
