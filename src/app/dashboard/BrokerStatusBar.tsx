'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Database, Settings2, AlertTriangle } from 'lucide-react';
import styles from './dashboard.module.scss';

type SafeStatus = {
  connected: boolean;
  broker: string | null;
  status: string;
  displayName: string | null;
  accountId: string | null;
};

type LoadState = 'loading' | 'ready' | 'error';

export default function BrokerStatusBar() {
  const [status, setStatus] = useState<SafeStatus | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/brokers/status', { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('status_failed');
        return res.json() as Promise<SafeStatus>;
      })
      .then((data) => {
        if (cancelled) return;
        const status =
          data && typeof data === 'object' && 'data' in data && (data as { data?: SafeStatus }).data
            ? (data as { data: SafeStatus }).data
            : (data as SafeStatus);
        setStatus(status);
        setLoadState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        setLoadState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const label = loadState === 'loading'
    ? 'Data Source: Checking…'
    : loadState === 'error'
      ? 'Data Source: Status unavailable'
      : status?.connected
        ? `Data Source: ${status.displayName ?? status.broker ?? 'Broker'} — Connected`
        : 'Data Source: Not connected';

  return (
    <section className={styles.panel} aria-label="Data source status" aria-live="polite">
      <div className={styles.panelHead}>
        <div className={styles.panelTitle}>
          {loadState === 'error' ? <AlertTriangle size={14} /> : <Database size={14} />}
          <span>{label}</span>
        </div>
        <Link href="/data-source" className={styles.panelLink}>
          <Settings2 size={12} />
          Manage Data Source
        </Link>
      </div>
      {loadState === 'ready' && status?.connected && status.accountId && (
        <p className={styles.panelHelper}>
          Account {status.accountId}
          {status.status ? ` · ${status.status}` : ''}
        </p>
      )}
      {loadState === 'error' && (
        <p className={styles.panelHelper} role="status">
          Could not load broker status. Open Manage Data Source to reconnect if needed.
        </p>
      )}
    </section>
  );
}
