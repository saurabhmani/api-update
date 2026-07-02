'use client';
import { useCallback, useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty, Modal, Button, Input, AlertBanner } from '@/components/ui';
import { adminApi } from '@/lib/apiClient';
import { fmt } from '@/lib/utils';
import { Users, Plus } from 'lucide-react';

interface AdminUser {
  id: number;
  email: string;
  name: string | null;
  role: string;
  is_active: boolean;
  totp_enabled: boolean;
  last_login_at: string | null;
}

const emptyForm = { name: '', email: '', password: '', confirmPassword: '', role: 'user' as 'user' | 'admin' };

function validateCreateForm(form: typeof emptyForm): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!form.name.trim()) errs.name = 'Name is required';
  if (!form.email.trim()) errs.email = 'Email is required';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) errs.email = 'Invalid email address';
  if (!form.password) errs.password = 'Password is required';
  else if (form.password.length < 8) errs.password = 'Password must be at least 8 characters';
  else if (!/[A-Za-z]/.test(form.password) || !/[0-9]/.test(form.password)) {
    errs.password = 'Password must contain at least one letter and one number';
  }
  if (!form.confirmPassword) errs.confirmPassword = 'Please confirm the password';
  else if (form.password !== form.confirmPassword) errs.confirmPassword = 'Passwords do not match';
  return errs;
}

export default function AdminUsersPage() {
  const [users,        setUsers]        = useState<AdminUser[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [modalOpen,    setModalOpen]    = useState(false);
  const [form,         setForm]         = useState(emptyForm);
  const [fieldErrors,  setFieldErrors]  = useState<Record<string, string>>({});
  const [formError,    setFormError]    = useState('');
  const [saving,       setSaving]       = useState(false);
  const [successMsg,   setSuccessMsg]   = useState('');
  const [pageError,    setPageError]    = useState('');

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const d = await adminApi.users() as { users?: AdminUser[] };
      setUsers(d.users || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);

  const closeModal = () => {
    setModalOpen(false);
    setForm(emptyForm);
    setFieldErrors({});
    setFormError('');
  };

  const createUser = async () => {
    const errs = validateCreateForm(form);
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setSaving(true);
    setFormError('');
    try {
      const res = await adminApi.createUser({
        name: form.name.trim(),
        email: form.email.trim(),
        password: form.password,
        role: form.role,
      }) as { user: AdminUser };
      setUsers(prev => [res.user, ...prev]);
      closeModal();
      setSuccessMsg(`User ${res.user.email} created successfully`);
      setPageError('');
    } catch (e: unknown) {
      const err = e as { data?: { error?: string }; status?: number };
      const msg = err.data?.error || 'Failed to create user';
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  };

  const updateUser = async (id: number, patch: Partial<AdminUser>) => {
    try {
      await adminApi.updateUser({ id, ...patch });
      setUsers(prev => prev.map(u => u.id === id ? { ...u, ...patch } : u));
    } catch (e: unknown) {
      const err = e as { data?: { error?: string } };
      setSuccessMsg('');
      setPageError(err.data?.error || 'Failed to update user');
    }
  };

  return (
    <AppShell title="Admin — Users">
      <Modal
        open={modalOpen}
        onClose={closeModal}
        title="Add User"
        footer={
          <>
            <Button variant="secondary" onClick={closeModal}>Cancel</Button>
            <Button onClick={createUser} loading={saving}>Create User</Button>
          </>
        }
      >
        {formError && <AlertBanner variant="error">{formError}</AlertBanner>}
        <Input
          label="Name"
          placeholder="Jane Doe"
          value={form.name}
          error={fieldErrors.name}
          onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
        />
        <Input
          label="Email"
          type="email"
          placeholder="user@example.com"
          value={form.email}
          error={fieldErrors.email}
          onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
        />
        <Input
          label="Password"
          type="password"
          passwordToggle
          placeholder="Min. 8 characters"
          value={form.password}
          error={fieldErrors.password}
          hint="Must contain at least one letter and one number"
          onChange={e => setForm(f => ({ ...f, password: e.target.value }))}
        />
        <Input
          label="Confirm Password"
          type="password"
          passwordToggle
          placeholder="Re-enter password"
          value={form.confirmPassword}
          error={fieldErrors.confirmPassword}
          onChange={e => setForm(f => ({ ...f, confirmPassword: e.target.value }))}
        />
        <div className="field">
          <label>Role</label>
          <select
            className="input"
            value={form.role}
            onChange={e => setForm(f => ({ ...f, role: e.target.value as 'user' | 'admin' }))}
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
      </Modal>

      <div className="page">
        <div className="page__header">
          <div><h1>User Management</h1><p>{users.length} users</p></div>
          <Button onClick={() => setModalOpen(true)}><Plus size={14} /> Add User</Button>
        </div>

        {pageError && (
          <AlertBanner variant="error" style={{ marginBottom: 16 }}>
            {pageError}
            <button
              onClick={() => setPageError('')}
              style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
            >
              Dismiss
            </button>
          </AlertBanner>
        )}

        {successMsg && (
          <AlertBanner variant="success" style={{ marginBottom: 16 }}>
            {successMsg}
            <button
              onClick={() => setSuccessMsg('')}
              style={{ marginLeft: 12, background: 'none', border: 'none', cursor: 'pointer', fontWeight: 600 }}
            >
              Dismiss
            </button>
          </AlertBanner>
        )}

        <Card flush>
          {loading ? <Loading /> : users.length === 0 ? (
            <Empty
              icon={Users}
              title="No users"
              action={<Button onClick={() => setModalOpen(true)}><Plus size={14} /> Add User</Button>}
            />
          ) : (
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
