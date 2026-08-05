'use client';

import Link from 'next/link';
import { ArrowLeft, Database, CheckCircle2, Info } from 'lucide-react';
import styles from './data-sources.module.scss';

/**
 * Settings → Data Sources — IndianAPI-only. Broker connect UI retired.
 */
export default function DataSourcesSettingsPage() {
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

        <section className={styles.card}>
          <h2>
            <CheckCircle2 size={16} /> IndianAPI warehouse
          </h2>
          <p>
            Market data (quotes, daily candles, scan inputs) is ingested from
            IndianAPI into Redis and the database. You do not need to connect
            Zerodha or Shoonya for market data.
          </p>
        </section>

        <section className={styles.card}>
          <h2>
            <Info size={16} /> Retired broker connections
          </h2>
          <p>
            Zerodha Kite and Finvasia Shoonya OAuth are no longer available as
            market-data providers. Paper-trading endpoints under{' '}
            <code>/api/broker/*</code> remain separate and simulated.
          </p>
          <Link href="/data-source" className={styles.link}>
            View market-data details
          </Link>
        </section>
      </div>
    </div>
  );
}
