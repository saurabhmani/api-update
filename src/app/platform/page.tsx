import Link from 'next/link';
import styles from '@/styles/Platform.module.scss';

export const metadata = {
  title: 'Platform — Quantorus365',
  description: 'The Quantorus365 platform architecture. Modular, engine-led intelligence for professional market participants.',
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="section-label">{children}</span>;
}

const ARCHITECTURE_LAYERS = [
  { layer: 'Data Layer',         desc: 'Real-time NSE/BSE market data, candle history, options chain, FII/DII flows. Structured via Redis hot cache and MySQL warehouse.', icon: '◈' },
  { layer: 'Intelligence Layer', desc: 'Feature engineering, factor scoring, scenario detection, market stance computation. The reasoning core of every decision.', icon: '◎' },
  { layer: 'Decision Layer',     desc: '11-gate rejection engine. Signal only emitted when all gates pass. Portfolio fit, confidence model, and risk scoring at every output.', icon: '◉' },
  { layer: 'Interface Layer',    desc: 'Dashboard, watchlist intelligence, trade setups, signals, and analytics. Every surface exposes reasoning, not just output.', icon: '◐' },
];

const PRINCIPLES = [
  { title: 'Modularity by design', body: 'Every capability is a discrete engine. Engines can be developed, tested, and deployed independently. No module carries hidden dependencies on another.' },
  { title: 'Single source of truth', body: 'All operational thresholds — confidence minimums, R:R floors, exposure caps — live in a centralised configuration system. No business logic is hardcoded.' },
  { title: 'Explainability at output', body: 'Every signal exposes its nine confidence components, its rejection code if blocked, its factor scores, and the market scenario it was generated in.' },
  { title: 'Risk as architecture', body: 'Risk is not a number appended to a signal. It is a gatekeeper embedded in the decision chain. No signal reaches a user without passing all risk conditions.' },
  { title: 'Portfolio context always present', body: 'No signal is assessed in isolation. Every decision is informed by current sector exposure, strategy concentration, drawdown state, and correlation.' },
  { title: 'Incremental production quality', body: 'Each module is developed to full production quality before the next begins. There are no placeholder features presented as functional.' },
];

export default function PlatformPage() {
  return (
    <>
      <section className={styles.hero}>
        <div aria-hidden="true" className={styles.heroGrid} />
        <div className={`container ${styles.heroContainer}`}>
          <SectionLabel>Platform</SectionLabel>
          <h1 className={styles.heroHeading}>
            A modular intelligence platform built for serious decisions
          </h1>
          <p className={styles.heroLede}>
            Quantorus365 is designed from first principles as a multi-engine intelligence system. Each engine addresses a distinct domain. Together, they form a coherent decision architecture.
          </p>
        </div>
      </section>

      <section id="architecture" className={`section ${styles.archSection}`}>
        <div className="container">
          <SectionLabel>Architecture</SectionLabel>
          <div className={styles.archIntro}>
            <h2>The four-layer decision stack</h2>
            <p className={styles.archIntroPara}>
              Quantorus365 organises every capability into four distinct layers. Each layer has a clear purpose and a defined interface to the layers adjacent to it.
            </p>
          </div>

          <div className={styles.archList}>
            {ARCHITECTURE_LAYERS.map(({ layer, desc, icon }, i) => (
              <div key={layer} className={styles.archItem}>
                <span className={styles.archIndex}>
                  0{i + 1}
                </span>
                <div className={styles.archLabelWrap}>
                  <span className={styles.archIcon}>{icon}</span>
                  <span className={styles.archLabel}>{layer}</span>
                </div>
                <p className={styles.archDesc}>{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className={styles.engineGrid}>
            <div>
              <SectionLabel>Current Module</SectionLabel>
              <h2 className={styles.engineHeading}>Intelligence Engine</h2>
              <p className={styles.enginePara}>
                The first module to reach production state. The Intelligence Engine processes real-time NSE/BSE market data through a structured decision chain — from raw data ingestion to a fully reasoned, portfolio-aware signal or a structured rejection.
              </p>
              <p className={styles.engineParaLast}>
                Nothing reaches the user that hasn't passed through eleven independent quality gates, a nine-component confidence model, and full portfolio fit evaluation.
              </p>
              <Link href="/login" className="btn btn--primary">
                Access Intelligence Engine
              </Link>
            </div>

            <div className={styles.capList}>
              {[
                'Feature engineering across 36 market dimensions',
                'Eight-factor scoring with regime-adjusted composite',
                'Ten strategy patterns with scenario-based gating',
                'Eleven-gate hard rejection engine',
                'Nine-component confidence decomposition',
                'Real portfolio fit scoring using live position data',
                'Rolling correlation computed from historical candles',
                'Market stance: Aggressive → Capital Preservation',
                'Scenario detection from multi-timeframe market inputs',
              ].map((item, i) => (
                <div key={i} className={styles.capItem}>
                  <span className={styles.capCheck}>✓</span>
                  <span className={styles.capText}>{item}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className={`section ${styles.principlesSection}`}>
        <div className="container">
          <SectionLabel>Design Principles</SectionLabel>
          <h2 className={styles.principlesHeading}>
            The principles that govern every engineering decision
          </h2>
          <div className={styles.principlesGrid}>
            {PRINCIPLES.map(({ title, body }) => (
              <div key={title}>
                <div className={styles.principleDivider} />
                <h4 className={styles.principleTitle}>
                  {title}
                </h4>
                <p className={styles.principleBody}>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className={styles.ctaGrid}>
            <div>
              <h2 className={styles.ctaHeading}>Explore the full engine architecture</h2>
              <p className={styles.ctaPara}>
                Each module in Quantorus365 is designed with the same architectural discipline as the Intelligence Engine. See the full engine map and their development status.
              </p>
              <div className={styles.ctaButtons}>
                <Link href="/engines" className="btn btn--primary">View All Engines</Link>
                <Link href="/contact" className="btn btn--outline">Get Early Access</Link>
              </div>
            </div>
            <div className={styles.statusPanel}>
              <div className={styles.statusPanelLabel}>
                Development Status
              </div>
              {[
                { label: 'Intelligence Engine',         status: 'Active Module' },
                { label: 'Risk Intelligence Engine',    status: 'Under Development' },
                { label: 'Macro Intelligence Engine',   status: 'Under Development' },
                { label: 'Derivatives Intelligence',    status: 'Under Development' },
                { label: 'Alpha Construction Engine',   status: 'Under Development' },
                { label: 'Analytics Workspace',         status: 'Under Development' },
              ].map(({ label, status }) => (
                <div key={label} className={styles.statusRow}>
                  <span className={styles.statusRowLabel}>{label}</span>
                  <span className={`status-pill ${status === 'Active Module' ? 'status-pill--active status-pill--dot' : 'status-pill--dev'}`}>
                    {status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
