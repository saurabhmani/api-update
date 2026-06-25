'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  Shield, Key, Monitor, FileText, Bell, RefreshCw, CheckCircle, AlertTriangle,
} from 'lucide-react';
import AppShell from '@/components/layout/AppShell';
import { Badge, Button, Card, Empty, Input, Loading, AlertBanner } from '@/components/ui';
import { fmt } from '@/lib/utils';
import styles from './security.module.scss';

type Tab = 'overview' | 'mfa' | 'sessions' | 'compliance' | 'audit';

const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Security Overview' },
  { id: 'mfa', label: 'MFA' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'compliance', label: 'Compliance' },
  { id: 'audit', label: 'Audit Log' },
];

const CONSENT_LABELS: Record<string, string> = {
  terms_of_service: 'Terms of Service',
  privacy_policy: 'Privacy Policy',
  trading_disclaimer: 'Trading Disclaimer',
  live_trading_risk: 'Live Trading Risk',
  data_processing: 'Data Processing',
  marketing: 'Marketing Communications',
};

export default function SecuritySettingsPage() {
  const [tab, setTab] = useState<Tab>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [mfa, setMfa] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [compliance, setCompliance] = useState<any>(null);
  const [audit, setAudit] = useState<any[]>([]);
  const [mfaSetup, setMfaSetup] = useState<any>(null);
  const [totpToken, setTotpToken] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [st, mf, ses, comp, aud] = await Promise.all([
        fetch('/api/security/status').then((r) => r.json()),
        fetch('/api/auth/mfa').then((r) => r.json()),
        fetch('/api/security/sessions').then((r) => r.json()),
        fetch('/api/security/compliance').then((r) => r.json()),
        fetch('/api/security/audit').then((r) => r.json()),
      ]);
      if (!st.ok) throw new Error(st.error);
      setStatus(st);
      setMfa(mf);
      setSessions(ses.sessions ?? []);
      setCompliance(comp);
      setAudit(aud.entries ?? []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setupMfa = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/auth/mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'setup' }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setMfaSetup(data);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'MFA setup failed');
    } finally {
      setSaving(false);
    }
  };

  const confirmMfa = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/auth/mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'confirm', token: totpToken }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      setMfaSetup(null);
      setTotpToken('');
      await load();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Invalid token');
    } finally {
      setSaving(false);
    }
  };

  const revokeSession = async (sessionId: number) => {
    await fetch('/api/security/sessions', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    await load();
  };

  const acceptConsent = async (consentType: string) => {
    await fetch('/api/security/compliance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ consentType }),
    });
    await load();
  };

  const s = status?.status;

  return (
    <AppShell title="Security">
      <div className="page">
        <div className="page__header">
          <h1><Shield size={22} style={{ verticalAlign: 'middle', marginRight: 8 }} />Security & Compliance</h1>
          <p>RBAC, MFA, sessions, consent tracking, and audit logs.</p>
        </div>

        <div style={{ marginBottom: 12 }}>
          <Link href="/settings" style={{ fontSize: '0.85rem', color: '#64748B' }}>← Back to Settings</Link>
        </div>

        {error && <AlertBanner variant="error">{error}</AlertBanner>}

        <div style={{ marginBottom: 16 }}>
          <Button variant="secondary" size="sm" onClick={load} loading={loading}>
            <RefreshCw size={14} /> Refresh
          </Button>
        </div>

        <Card title="Quick Links" style={{ marginBottom: 20 } as any}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <Link href="/admin/audit-logs" className="btn btn--secondary btn--sm">Audit Logs</Link>
            <Link href="/admin/roles" className="btn btn--secondary btn--sm">Role Management</Link>
            <Link href="/compliance" className="btn btn--secondary btn--sm">Compliance Center</Link>
          </div>
        </Card>

        <nav className={styles.tabs}>
          {TABS.map((t) => (
            <button key={t.id} type="button" className={tab === t.id ? styles.tabActive : styles.tab} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>

        {loading ? <Loading /> : (
          <>
            {tab === 'overview' && s && (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 20 }}>
                  <div className={styles.stat}><small>Role</small><strong>{s.role}</strong></div>
                  <div className={styles.stat}><small>MFA</small><strong className={s.mfaEnabled ? styles.ok : styles.warn}>{s.mfaEnabled ? 'Enabled' : 'Disabled'}</strong></div>
                  <div className={styles.stat}><small>Active Sessions</small><strong>{s.activeSessions}</strong></div>
                  <div className={styles.stat}><small>Consents Pending</small><strong className={s.consentsPending?.length ? styles.warn : styles.ok}>{s.consentsPending?.length ?? 0}</strong></div>
                </div>
                <Card title="Permissions (RBAC)" compact>
                  {(s.permissions ?? []).map((p: string) => (
                    <span key={p} className={styles.permission}>{p}</span>
                  ))}
                </Card>
              </>
            )}

            {tab === 'mfa' && (
              <Card title="Multi-Factor Authentication" action={<Key size={16} />}>
                <p style={{ marginBottom: 16, color: '#64748B', fontSize: '0.9rem' }}>
                  TOTP-based 2FA adds an extra layer of security. Secrets are encrypted at rest with AES-256-GCM.
                </p>
                <Badge variant={mfa?.mfaEnabled ? 'green' : 'orange'}>
                  {mfa?.mfaEnabled ? 'MFA Active' : 'MFA Not Enabled'}
                </Badge>
                {!mfa?.mfaEnabled && !mfaSetup && (
                  <div style={{ marginTop: 16 }}>
                    <Button onClick={setupMfa} loading={saving}>Enable MFA</Button>
                  </div>
                )}
                {mfaSetup && (
                  <div style={{ marginTop: 16 }}>
                    <p style={{ fontSize: '0.85rem' }}>Scan this secret in your authenticator app:</p>
                    <code style={{ display: 'block', padding: 12, background: '#F1F5F9', borderRadius: 6, margin: '8px 0', wordBreak: 'break-all' }}>{mfaSetup.secret}</code>
                    <Input label="Enter 6-digit code" value={totpToken} onChange={(e) => setTotpToken(e.target.value)} maxLength={6} />
                    <Button onClick={confirmMfa} loading={saving} style={{ marginTop: 8 }}>Confirm MFA</Button>
                  </div>
                )}
              </Card>
            )}

            {tab === 'sessions' && (
              <Card title="Session Management" action={<Monitor size={16} />}>
                {sessions.length === 0 ? <Empty icon={Monitor} title="No active sessions" /> : (
                  <table className={styles.table}>
                    <thead><tr><th>Device</th><th>IP</th><th>Created</th><th>Expires</th><th></th></tr></thead>
                    <tbody>
                      {sessions.map((ses: any) => (
                        <tr key={ses.id}>
                          <td>{ses.device ?? 'Unknown'}{ses.isCurrent && <Badge variant="green" style={{ marginLeft: 6 }}>Current</Badge>}</td>
                          <td>{ses.ipAddress ?? '—'}</td>
                          <td>{fmt.datetime(ses.createdAt)}</td>
                          <td>{fmt.datetime(ses.expiresAt)}</td>
                          <td>
                            {!ses.isCurrent && (
                              <Button size="sm" variant="secondary" onClick={() => revokeSession(ses.id)}>Revoke</Button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            )}

            {tab === 'compliance' && compliance && (
              <>
                <Card title="Trading Disclaimers" compact>
                  <div className={styles.disclaimer}>{compliance.disclaimers?.standard}</div>
                  <div className={styles.disclaimer} style={{ background: '#FEF2F2', borderColor: '#FCA5A5', color: '#991B1B' }}>
                    {compliance.disclaimers?.liveTrading}
                  </div>
                </Card>
                <Card title="User Consent" action={<FileText size={16} />}>
                  {(compliance.required?.pending ?? []).map((c: string) => (
                    <div key={c} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #E2E8F0' }}>
                      <span><AlertTriangle size={14} style={{ color: '#D97706', marginRight: 6 }} />{CONSENT_LABELS[c] ?? c}</span>
                      <Button size="sm" onClick={() => acceptConsent(c)}>Accept</Button>
                    </div>
                  ))}
                  {(compliance.required?.accepted ?? []).map((c: string) => (
                    <div key={c} style={{ display: 'flex', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #E2E8F0', color: '#16A34A' }}>
                      <CheckCircle size={14} style={{ marginRight: 6 }} />{CONSENT_LABELS[c] ?? c} — Accepted
                    </div>
                  ))}
                </Card>
                <Card title="Data Retention Policies" compact>
                  <table className={styles.table}>
                    <thead><tr><th>Category</th><th>Retention</th><th>Description</th></tr></thead>
                    <tbody>
                      {(compliance.retentionPolicies ?? []).map((p: any) => (
                        <tr key={p.dataCategory}>
                          <td><strong>{p.dataCategory}</strong></td>
                          <td>{p.retentionDays} days</td>
                          <td style={{ fontSize: '0.8rem', color: '#64748B' }}>{p.description}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </>
            )}

            {tab === 'audit' && (
              <Card title="Security Audit Log" action={<Bell size={16} />}>
                {audit.length === 0 ? <Empty icon={Bell} title="No audit entries" /> : (
                  <table className={styles.table}>
                    <thead><tr><th>Time</th><th>Event</th><th>Action</th><th>Resource</th></tr></thead>
                    <tbody>
                      {audit.map((e: any) => (
                        <tr key={e.id}>
                          <td>{fmt.datetime(e.createdAt)}</td>
                          <td>{e.eventType}</td>
                          <td><strong>{e.action}</strong></td>
                          <td>{e.resource ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            )}
          </>
        )}
      </div>
    </AppShell>
  );
}
