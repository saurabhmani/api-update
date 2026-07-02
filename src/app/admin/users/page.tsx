'use client';
import { useCallback, useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty, Modal, Button, Input, AlertBanner } from '@/components/ui';
import { adminApi } from '@/lib/apiClient';
import { fmt } from '@/lib/utils';
import { Users, Plus, Pencil, Trash2 } from 'lucide-react';

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
const emptyEditForm = {
  name: '',
  email: '',
  role: 'user' as 'user' | 'admin',
  is_active: true,
  password: '',
  confirmPassword: '',
};

function validateEmailField(email: string): string | undefined {
  if (!email.trim()) return 'Email is required';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return 'Invalid email address';
  return undefined;
}

function validatePasswordFields(password: string, confirmPassword: string, required: boolean): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!password && !confirmPassword) {
    if (required) {
      errs.password = 'Password is required';
      errs.confirmPassword = 'Please confirm the password';
    }
    return errs;
  }
  if (!password) errs.password = 'Password is required';
  else if (password.length < 8) errs.password = 'Password must be at least 8 characters';
  else if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    errs.password = 'Password must contain at least one letter and one number';
  }
  if (!confirmPassword) errs.confirmPassword = 'Please confirm the password';
  else if (password !== confirmPassword) errs.confirmPassword = 'Passwords do not match';
  return errs;
}

function validateCreateForm(form: typeof emptyForm): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!form.name.trim()) errs.name = 'Name is required';
  const emailErr = validateEmailField(form.email);
  if (emailErr) errs.email = emailErr;
  return { ...errs, ...validatePasswordFields(form.password, form.confirmPassword, true) };
}

function validateEditForm(form: typeof emptyEditForm): Record<string, string> {
  const errs: Record<string, string> = {};
  if (!form.name.trim()) errs.name = 'Name is required';
  const emailErr = validateEmailField(form.email);
  if (emailErr) errs.email = emailErr;
  return { ...errs, ...validatePasswordFields(form.password, form.confirmPassword, false) };
}

export default function AdminUsersPage() {
  const [users,           setUsers]           = useState<AdminUser[]>([]);
  const [loading,         setLoading]         = useState(true);
  const [modalOpen,       setModalOpen]       = useState(false);
  const [editModalOpen,   setEditModalOpen]   = useState(false);
  const [editingUser,     setEditingUser]     = useState<AdminUser | null>(null);
  const [form,            setForm]            = useState(emptyForm);
  const [editForm,        setEditForm]        = useState(emptyEditForm);
  const [fieldErrors,     setFieldErrors]     = useState<Record<string, string>>({});
  const [editFieldErrors, setEditFieldErrors] = useState<Record<string, string>>({});
  const [formError,       setFormError]       = useState('');
  const [editFormError,   setEditFormError]   = useState('');
  const [saving,          setSaving]          = useState(false);
  const [editSaving,      setEditSaving]      = useState(false);
  const [deleteTarget,    setDeleteTarget]    = useState<AdminUser | null>(null);
  const [deleteSaving,    setDeleteSaving]    = useState(false);
  const [successMsg,      setSuccessMsg]      = useState('');
  const [pageError,       setPageError]       = useState('');

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

  const applyUserUpdate = (user: AdminUser) => {
    setUsers(prev => prev.map(u => u.id === user.id ? user : u));
  };

  const closeModal = () => {
    setModalOpen(false);
    setForm(emptyForm);
    setFieldErrors({});
    setFormError('');
  };

  const closeEditModal = () => {
    setEditModalOpen(false);
    setEditingUser(null);
    setEditForm(emptyEditForm);
    setEditFieldErrors({});
    setEditFormError('');
  };

  const openEditModal = (user: AdminUser) => {
    setEditingUser(user);
    setEditForm({
      name: user.name || '',
      email: user.email,
      role: user.role === 'admin' ? 'admin' : 'user',
      is_active: user.is_active,
      password: '',
      confirmPassword: '',
    });
    setEditFieldErrors({});
    setEditFormError('');
    setEditModalOpen(true);
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
      const err = e as { data?: { error?: string } };
      setFormError(err.data?.error || 'Failed to create user');
    } finally {
      setSaving(false);
    }
  };

  const saveEditUser = async () => {
    if (!editingUser) return;
    const errs = validateEditForm(editForm);
    setEditFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setEditSaving(true);
    setEditFormError('');
    try {
      const payload: Record<string, unknown> = {
        id: editingUser.id,
        name: editForm.name.trim(),
        email: editForm.email.trim(),
        role: editForm.role,
        is_active: editForm.is_active,
      };
      if (editForm.password) payload.password = editForm.password;

      const res = await adminApi.updateUser(payload) as { user: AdminUser };
      applyUserUpdate(res.user);
      closeEditModal();
      setSuccessMsg(`User ${res.user.email} updated successfully`);
      setPageError('');
    } catch (e: unknown) {
      const err = e as { data?: { error?: string } };
      setEditFormError(err.data?.error || 'Failed to update user');
    } finally {
      setEditSaving(false);
    }
  };

  const patchUser = async (id: number, patch: Partial<AdminUser>) => {
    try {
      const res = await adminApi.updateUser({ id, ...patch }) as { user: AdminUser };
      applyUserUpdate(res.user);
      setPageError('');
    } catch (e: unknown) {
      const err = e as { data?: { error?: string } };
      setSuccessMsg('');
      setPageError(err.data?.error || 'Failed to update user');
    }
  };

  const confirmDeleteUser = async () => {
    if (!deleteTarget) return;

    setDeleteSaving(true);
    try {
      const res = await adminApi.deleteUser(deleteTarget.id) as { email?: string };
      setUsers(prev => prev.filter(u => u.id !== deleteTarget.id));
      setSuccessMsg(`User ${res.email || deleteTarget.email} deleted successfully`);
      setPageError('');
      setDeleteTarget(null);
    } catch (e: unknown) {
      const err = e as { data?: { error?: string } };
      setPageError(err.data?.error || 'Failed to delete user');
    } finally {
      setDeleteSaving(false);
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

      <Modal
        open={editModalOpen}
        onClose={closeEditModal}
        title="Edit User"
        footer={
          <>
            <Button variant="secondary" onClick={closeEditModal}>Cancel</Button>
            <Button onClick={saveEditUser} loading={editSaving}>Save Changes</Button>
          </>
        }
      >
        {editFormError && <AlertBanner variant="error">{editFormError}</AlertBanner>}
        {editingUser && (
          <div style={{ fontSize: 12, color: '#64748B', marginBottom: 12 }}>
            <div>User ID: {editingUser.id}</div>
            <div>2FA: {editingUser.totp_enabled ? 'Enabled' : 'Off'}</div>
            <div>Last login: {fmt.datetime(editingUser.last_login_at)}</div>
          </div>
        )}
        <Input
          label="Name"
          placeholder="Jane Doe"
          value={editForm.name}
          error={editFieldErrors.name}
          onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
        />
        <Input
          label="Email"
          type="email"
          placeholder="user@example.com"
          value={editForm.email}
          error={editFieldErrors.email}
          onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))}
        />
        <div className="field">
          <label>Role</label>
          <select
            className="input"
            value={editForm.role}
            onChange={e => setEditForm(f => ({ ...f, role: e.target.value as 'user' | 'admin' }))}
          >
            <option value="user">User</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div className="field">
          <label>Status</label>
          <select
            className="input"
            value={editForm.is_active ? 'active' : 'disabled'}
            onChange={e => setEditForm(f => ({ ...f, is_active: e.target.value === 'active' }))}
          >
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>
        <Input
          label="New Password"
          type="password"
          passwordToggle
          placeholder="Leave blank to keep current password"
          value={editForm.password}
          error={editFieldErrors.password}
          hint="Optional — must contain at least one letter and one number"
          onChange={e => setEditForm(f => ({ ...f, password: e.target.value }))}
        />
        <Input
          label="Confirm New Password"
          type="password"
          passwordToggle
          placeholder="Re-enter new password"
          value={editForm.confirmPassword}
          error={editFieldErrors.confirmPassword}
          onChange={e => setEditForm(f => ({ ...f, confirmPassword: e.target.value }))}
        />
      </Modal>

      <Modal
        open={Boolean(deleteTarget)}
        onClose={() => { if (!deleteSaving) setDeleteTarget(null); }}
        title="Delete User"
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeleteTarget(null)} disabled={deleteSaving}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmDeleteUser} loading={deleteSaving}>
              Delete User
            </Button>
          </>
        }
      >
        {deleteTarget && (
          <>
            <AlertBanner variant="warning">
              This action permanently removes the user account and cannot be undone.
            </AlertBanner>
            <p style={{ fontSize: 14, color: '#334155', margin: '12px 0 0' }}>
              Are you sure you want to delete <strong>{deleteTarget.name || deleteTarget.email}</strong>
              {' '}({deleteTarget.email})?
            </p>
          </>
        )}
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
                          onChange={e => patchUser(u.id, { role: e.target.value })}
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
                        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
                          <button className="btn btn--sm btn--secondary" onClick={() => openEditModal(u)}>
                            <Pencil size={13} /> Edit
                          </button>
                          <button className="btn btn--sm btn--secondary" onClick={() => patchUser(u.id, { is_active: !u.is_active })}>
                            {u.is_active ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            className="btn btn--sm btn--danger"
                            onClick={() => setDeleteTarget(u)}
                          >
                            <Trash2 size={13} /> Delete
                          </button>
                        </div>
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
