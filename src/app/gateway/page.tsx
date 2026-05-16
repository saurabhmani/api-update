import Link from 'next/link';
import { ENGINES } from '@/lib/data';
import styles from '@/styles/Gateway.module.scss';
import Nav from '@/components/layout/Nav';
import Footer from '@/components/layout/Footer';

export const metadata = {
  title: 'Platform Access — Quantorus365',
  description: 'Select your Quantorus365 module destination.',
};

function LoginCard({ engine }: { engine: typeof ENGINES[0] }) {
  const isActive = engine.status === 'active';

  if (isActive) {
    return (
      <Link href={engine.href || '#'} className={styles.activeCard}>
        <Nav />
        <div className={styles.activeTopEdge} />

        <div className={styles.cardTopRow}>
          <span className={styles.activeCodename}>
            {engine.codename}
          </span>
          <span className="status-pill status-pill--active status-pill--dot">
            {engine.statusLabel}
          </span>
        </div>

        <h3 className={styles.activeName}>
          {engine.name}
        </h3>
        <p className={styles.activePurpose}>
          {engine.purpose}
        </p>

        <div className={styles.activeCta}>
          <span>Enter Module</span>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M2 7h10M8 3l4 4-4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>
      </Link>
    );
  }

  return (
    <div className={styles.devCard}>
      <div className={styles.cardTopRow}>
        <span className={styles.devCodename}>
          {engine.codename}
        </span>
        <span className="status-pill status-pill--dev">
          Under Development
        </span>
      </div>

      <h3 className={styles.devName}>
        {engine.name}
      </h3>
      <p className={styles.devPurpose}>
        {engine.purpose}
      </p>

      <div className={styles.devNote}>
        Access expanding — scheduled deployment
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <div className={styles.page}>
      <div aria-hidden="true" className={styles.pageGrid} />
      <div aria-hidden="true" className={styles.pageGlow} />

      <div className={`container ${styles.pageContainer}`}>
        <div className={styles.header}>
          <Link href="/" className={styles.logoLink}>
            Quantorus<span className={styles.logoAccent}>365</span>
          </Link>

          <div className={styles.divider} />

          <h1 className={styles.headerTitle}>
            Platform Access Gateway
          </h1>
          <p className={styles.headerSubtitle}>
            Select your destination module. Access is governed by module availability and authorised credentials.
          </p>
        </div>

        <div className={styles.cardsGrid}>
          {ENGINES.map(engine => (
            <LoginCard key={engine.id} engine={engine} />
          ))}
        </div>

        <div className={styles.noteBox}>
          <p className={styles.noteText}>
            Quantorus365 is a modular platform in active development. Module access expands as each engine completes its development phase. Authorised access to the Intelligence Engine is currently available. For access inquiries, contact us at{' '}
            <Link href="/contact" className={styles.noteLink}>
              the contact page
            </Link>.
          </p>
        </div>

        <div className={styles.backWrap}>
          <Link href="/" className={styles.backLink}>
            ← Return to site
          </Link>
        </div>
      </div>
      <Footer />
    </div>
  );
}
