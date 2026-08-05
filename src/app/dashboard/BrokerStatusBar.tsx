'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Database, AlertTriangle } from 'lucide-react';
import styles from './dashboard.module.scss';

type LoadState = 'loading' | 'ready' | 'error';

/**
 * Shows IndianAPI warehouse status — not broker OAuth connection state.
 */
export default function BrokerStatusBar() {
  const [label, setLabel] = useState('Market data: Checking…');
  const [loadState, setLoadState] = useState<LoadState>('loading');

  useEffect(() => {
    let cancelled = false;
    void fetch('/api/debug/provider-report', { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error('status_failed');
        return res.json() as Promise<{
          marketDataProvider?: string;
          indianApiEnabled?: boolean;
          indianApiCredentialsConfigured?: boolean;
        }>;
      })
      .then((data) => {
        if (cancelled) return;
        const provider = data.marketDataProvider ?? 'indianapi';
        const ready = data.indianApiEnabled !== false && data.indianApiCredentialsConfigured !== false;
        setLabel(
          ready
            ? `Market data: IndianAPI (${provider})`
            : 'Market data: IndianAPI not configured',
        );
        setLoadState('ready');
      })
      .catch(() => {
        if (cancelled) return;
        // Provider-report may be admin-only — still show IndianAPI as the model.
        setLabel('Market data: IndianAPI warehouse');
        setLoadState('ready');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className={styles.panel} aria-label="Market data status" aria-live="polite">
      <div className={styles.panelHead}>
        <div className={styles.panelTitle}>
          {loadState === 'error' ? <AlertTriangle size={14} /> : <Database size={14} />}
          <span>{label}</span>
        </div>
        <Link href="/data-source" className={styles.linkMuted}>
          Details
        </Link>
      </div>
    </section>
  );
}
