'use client';

import Link from 'next/link';
import { Database, ArrowRight, CheckCircle2, Info } from 'lucide-react';
import styles from './data-source.module.scss';

/**
 * Market data is IndianAPI-only. Broker OAuth (Zerodha/Shoonya) has been
 * removed from the market-data path. This page explains the current model.
 */
export default function DataSourcePage() {
  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <header className={styles.header}>
          <div className={styles.brand}>
            <span className={styles.brandDot} aria-hidden />
            <span className={styles.brandName}>
              Quantorus<span className={styles.brandAccent}>365</span>
            </span>
          </div>
          <Link href="/dashboard" className={styles.logoutBtn}>
            Dashboard <ArrowRight size={14} />
          </Link>
        </header>

        <div style={{ padding: '1.5rem', display: 'grid', gap: '1rem' }}>
          <div>
            <h1 style={{ margin: '0 0 0.35rem', fontSize: '1.35rem', color: '#0B1F3A', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Database size={22} /> Market data
            </h1>
            <p style={{ margin: 0, color: '#64748b', fontSize: '0.9rem' }}>
              IndianAPI warehouse — sole upstream
            </p>
          </div>

          <section aria-labelledby="indianapi-status" style={{ border: '1px solid #e2e8f0', borderRadius: 14, padding: '1.1rem' }}>
            <h2 id="indianapi-status" style={{ margin: '0 0 0.5rem', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <CheckCircle2 size={18} /> IndianAPI
            </h2>
            <p style={{ margin: '0 0 0.75rem', color: '#475569', fontSize: '0.9rem', lineHeight: 1.45 }}>
              Quotes, daily candles, and scan inputs are ingested from IndianAPI into
              Redis and the database. The product reads that warehouse — it does not
              call IndianAPI from the browser or from signal evaluation.
            </p>
            <ul style={{ margin: 0, paddingLeft: '1.1rem', color: '#475569', fontSize: '0.88rem', lineHeight: 1.5 }}>
              <li>Live broker WebSockets (Kite / Shoonya) are not used for market data.</li>
              <li>Paper trading under <code>/api/broker/*</code> remains separate and simulated.</li>
              <li>Connect flows for Zerodha and Shoonya are removed (HTTP 404).</li>
            </ul>
          </section>

          <section aria-labelledby="retired" style={{ border: '1px solid #e2e8f0', borderRadius: 14, padding: '1.1rem' }}>
            <h2 id="retired" style={{ margin: '0 0 0.5rem', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Info size={18} /> Retired broker connections
            </h2>
            <p style={{ margin: 0, color: '#475569', fontSize: '0.9rem', lineHeight: 1.45 }}>
              Zerodha Kite Connect and Finvasia Shoonya OAuth are no longer available
              as market-data sources. If you previously connected a broker, that
              connection is ignored for quotes and candles.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
