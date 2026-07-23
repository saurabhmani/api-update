'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ArrowLeft,
  Database,
  Link2,
  LogOut,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import styles from './data-sources.module.scss';

type SafeStatus = {
  connected: boolean;
  broker: 'zerodha' | 'shoonya' | null;
  status: string;
  displayName: string | null;
  accountId: string | null;
  expiresAt: string | null;
};

export default function DataSourcesSettingsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<SafeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [error, setError] = useState('');

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
      setStatus(await res.json());
    } catch {
      setError('Unable to load data source status.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDisconnect() {
    if (!status?.broker) return;
    if (!confirmDisconnect) {
      setConfirmDisconnect(true);
      return;
    }

    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/brokers/${status.broker}/disconnect`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error('Disconnect failed');
      router.replace('/data-source');
    } catch {
      setError('Unable to disconnect. Please try again.');
      setBusy(false);
      setConfirmDisconnect(false);
    }
  }

  function reconnect() {
    setBusy(true);
    window.location.href = '/data-source?reason=reconnect';
  }

  function changeBroker() {
    if (!window.confirm('Change data source? You will disconnect the current broker and choose a new one.')) {
      return;
    }
    void (async () => {
      if (status?.broker) {
        setBusy(true);
        try {
          await fetch(`/api/brokers/${status.broker}/disconnect`, {
            method: 'POST',
            credentials: 'include',
          });
        } catch {
          // still navigate
        }
      }
      window.location.href = '/data-source';
    })();
  }

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

        <section className={styles.card}>
          {loading && <p className={styles.muted}>Loading connection status…</p>}

          {!loading && status && (
            <>
              <dl className={styles.details}>
                <div>
                  <dt>Broker</dt>
                  <dd>{status.displayName ?? status.broker ?? 'None'}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{status.connected ? 'Connected' : status.status}</dd>
                </div>
                {status.accountId && (
                  <div>
                    <dt>Account</dt>
                    <dd>{status.accountId}</dd>
                  </div>
                )}
                {status.expiresAt && (
                  <div>
                    <dt>Expires</dt>
                    <dd>{new Date(status.expiresAt).toLocaleString()}</dd>
                  </div>
                )}
              </dl>

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  onClick={reconnect}
                  disabled={busy}
                >
                  <RefreshCw size={14} />
                  Reconnect
                </button>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={changeBroker}
                  disabled={busy}
                >
                  <Link2 size={14} />
                  Change broker
                </button>
                {status.connected && (
                  <button
                    type="button"
                    className={styles.btnDanger}
                    onClick={handleDisconnect}
                    disabled={busy}
                  >
                    <LogOut size={14} />
                    {confirmDisconnect ? 'Confirm disconnect' : 'Disconnect'}
                  </button>
                )}
              </div>

              {confirmDisconnect && (
                <p className={styles.confirmHint}>
                  Click Confirm disconnect again to revoke stored credentials and return to data source login.
                </p>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
