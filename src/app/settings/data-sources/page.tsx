'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Database,
  Link2,
  LogOut,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
} from 'lucide-react';
import styles from './data-sources.module.scss';

type BrokerKey = 'zerodha' | 'shoonya';

type ConnectionSummary = {
  broker: BrokerKey;
  status: string;
  connected: boolean;
  isActiveDataSource: boolean;
  displayName: string;
  accountId: string | null;
  expiresAt: string | null;
  updatedAt: string;
};

type SafeStatus = {
  connected: boolean;
  broker: BrokerKey | null;
  status: string;
  displayName: string | null;
  accountId: string | null;
  expiresAt: string | null;
  needsSelection?: boolean;
  activeDataSource?: BrokerKey | null;
  connections?: ConnectionSummary[];
};

export default function DataSourcesSettingsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<SafeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState<BrokerKey | null>(null);
  const [error, setError] = useState('');
  const needsSelection =
    searchParams.get('reason') === 'select_data_source' || status?.needsSelection === true;

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/brokers/status', { credentials: 'include' });
      if (res.status === 401) {
        router.replace('/login?from=/settings/data-sources');
        return;
      }
      if (!res.ok) throw new Error('Failed to load status');
      const body = await res.json();
      setStatus(body?.data && typeof body.data === 'object' ? body.data : body);
    } catch {
      setError('Unable to load data source status.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function setActive(broker: BrokerKey) {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/brokers/active', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ broker }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || 'Unable to switch data source');
      await load();
      router.replace('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to switch data source.');
      setBusy(false);
    }
  }

  async function handleDisconnect(broker: BrokerKey) {
    if (confirmDisconnect !== broker) {
      setConfirmDisconnect(broker);
      return;
    }

    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/brokers/${broker}/disconnect`, {
        method: 'POST',
        credentials: 'include',
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error('Disconnect failed');
      const redirectTo = typeof body.redirectTo === 'string' ? body.redirectTo : '/data-source';
      if (body.needsSelection) {
        await load();
        setBusy(false);
        setConfirmDisconnect(null);
        router.replace('/data-source?reason=select_data_source');
        return;
      }
      router.replace(redirectTo);
    } catch {
      setError('Unable to disconnect. Please try again.');
      setBusy(false);
      setConfirmDisconnect(null);
    }
  }

  function reconnect() {
    setBusy(true);
    window.location.href = '/data-source?reason=reconnect';
  }

  function connectAnother() {
    window.location.href = '/data-source';
  }

  const connections = status?.connections ?? [];
  const connected = connections.filter((c) => c.connected);

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <Link href="/dashboard" className={styles.back}>
            <ArrowLeft size={14} />
            Dashboard
          </Link>
          <h1 className={styles.title}>
            <Database size={18} />
            Data Sources
          </h1>
        </header>

        {error && (
          <div className={styles.alert} role="alert">
            <AlertTriangle size={14} />
            {error}
          </div>
        )}

        {needsSelection && (
          <div className={styles.alert} role="status">
            <AlertTriangle size={14} />
            Select which connected broker should be your active data source. We will not switch automatically.
          </div>
        )}

        <section className={styles.card}>
          {loading && <p className={styles.muted}>Loading connection status…</p>}

          {!loading && status && (
            <>
              <dl className={styles.details}>
                <div>
                  <dt>Active source</dt>
                  <dd>
                    {status.activeDataSource
                      ? (status.displayName ?? status.activeDataSource)
                      : needsSelection
                        ? 'Not selected'
                        : 'None'}
                  </dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>
                    {status.connected && status.activeDataSource
                      ? 'Connected'
                      : needsSelection
                        ? 'Selection required'
                        : status.status}
                  </dd>
                </div>
              </dl>

              {connections.length > 0 && (
                <ul className={styles.connList}>
                  {connections.map((c) => (
                    <li key={c.broker} className={styles.connRow}>
                      <div>
                        <strong>{c.displayName}</strong>
                        <span className={styles.muted}>
                          {c.connected ? 'Connected' : c.status}
                          {c.isActiveDataSource ? ' · Active data source' : ''}
                          {c.accountId ? ` · ${c.accountId}` : ''}
                        </span>
                      </div>
                      <div className={styles.actions}>
                        {c.connected && !c.isActiveDataSource && (
                          <button
                            type="button"
                            className={styles.btnPrimary}
                            onClick={() => void setActive(c.broker)}
                            disabled={busy}
                          >
                            <CheckCircle2 size={14} />
                            Use as active
                          </button>
                        )}
                        {c.connected && (
                          <button
                            type="button"
                            className={styles.btnDanger}
                            onClick={() => void handleDisconnect(c.broker)}
                            disabled={busy}
                          >
                            <LogOut size={14} />
                            {confirmDisconnect === c.broker ? 'Confirm disconnect' : 'Disconnect'}
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              {connections.length === 0 && (
                <p className={styles.muted}>No broker connections yet.</p>
              )}

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  onClick={reconnect}
                  disabled={busy}
                >
                  <RefreshCw size={14} />
                  Reconnect / add broker
                </button>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={connectAnother}
                  disabled={busy}
                >
                  <Link2 size={14} />
                  Connect another
                </button>
              </div>

              {confirmDisconnect && (
                <p className={styles.confirmHint}>
                  Click Confirm disconnect again to revoke stored credentials.
                  {connected.length > 1
                    ? ' Your other connected broker will stay linked, but you must choose the active data source explicitly.'
                    : ''}
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
