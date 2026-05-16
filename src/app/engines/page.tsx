import Link from 'next/link';
import { ENGINES } from '@/lib/data';
import styles from '@/styles/Engines.module.scss';
import Nav from '@/components/layout/Nav';
import Footer from '@/components/layout/Footer';

export const metadata = {
  title: 'Intelligence Engines — Quantorus365',
  description: 'The modular engine architecture of Quantorus365. Five intelligence engines and one analytics workspace in a phased development programme.',
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="section-label">{children}</span>;
}

export default function EnginesPage() {
  const activeEngine = ENGINES.find(e => e.status === 'active')!;
  const devEngines   = ENGINES.filter(e => e.status !== 'active');

  return (
   <>
   <Nav />
    <div className={styles.page}>
      
      <section className={styles.hero}>
        <div aria-hidden="true" className={styles.heroGrid} />
        <div className={`container ${styles.heroContainer}`}>
          <SectionLabel>Engines</SectionLabel>
          <h1 className={styles.heroHeading}>
            Five intelligence engines. One analytics workspace. A phased development programme.
          </h1>
          <p className={styles.heroLede}>
            Each engine addresses a distinct domain of trading intelligence. One is currently active. The others are in structured development, expanding access as they reach production quality.
          </p>
        </div>
      </section>

      <section className={`section ${styles.activeSection}`}>
        <div className="container">
          <SectionLabel>Currently Available</SectionLabel>
          <div className={styles.activeCard}>
            <div className={styles.activeTopEdge} />

            <div className={styles.activeGrid}>
              <div>
                <div className={styles.activeHeader}>
                  <span className={styles.activeCodename}>
                    {activeEngine.codename}
                  </span>
                  <span className="status-pill status-pill--active status-pill--dot">
                    {activeEngine.statusLabel}
                  </span>
                </div>

                <h2 className={styles.activeName}>
                  {activeEngine.name}
                </h2>
                <p className={styles.activeDesc}>
                  {activeEngine.description}
                </p>
                <Link href="/login" className="btn btn--primary">
                  Access Engine
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                    <path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </Link>
              </div>

              <div>
                <div className={styles.activeCapLabel}>
                  Capabilities
                </div>
                {activeEngine.capabilities.map((cap, i) => (
                  <div key={i} className={styles.activeCapRow}>
                    <span className={styles.activeCapArrow}>→</span>
                    <span className={styles.activeCapText}>{cap}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <SectionLabel>Under Development</SectionLabel>
          <div className={styles.devIntro}>
            <h2>Modules in active development</h2>
            <p className={styles.devIntroPara}>
              Each engine below is being developed to the same architectural standards as the Intelligence Engine. Access expands as each module completes its development programme.
            </p>
          </div>

          <div className={styles.devList}>
            {devEngines.map((engine, i) => (
              <div key={engine.id} className={styles.devRow}>
                <div>
                  <span className={styles.devCodename}>
                    {engine.codename}
                  </span>
                  <span className="status-pill status-pill--dev">
                    Under Development
                  </span>
                </div>

                <div>
                  <h3 className={styles.devName}>
                    {engine.name}
                  </h3>
                  <p className={styles.devDesc}>{engine.description}</p>
                </div>

                <div>
                  <div className={styles.devCapLabel}>
                    Planned capabilities
                  </div>
                  {engine.capabilities.slice(0, 2).map((cap, j) => (
                    <div key={j} className={styles.devCapRow}>
                      <span className={styles.devCapBullet}>·</span>
                      <span className={styles.devCapText}>{cap}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={`section ${styles.ctaSection}`}>
        <div className={`container ${styles.ctaContainer}`}>
          <SectionLabel>Get Involved</SectionLabel>
          <h2 className={styles.ctaHeading}>Be among the first to evaluate new modules</h2>
          <p className={styles.ctaPara}>
            We are engaging with institutions and professional participants ahead of each module's release. If you have a specific requirement that aligns with our roadmap, we welcome structured conversations.
          </p>
          <div className={styles.ctaButtons}>
            <Link href="/contact#early-access" className="btn btn--primary">Express Interest</Link>
            <Link href="/vision" className="btn btn--outline">View Roadmap</Link>
          </div>
        </div>
      </section>
  
    </div>
        <Footer />
   </>
  );
}
