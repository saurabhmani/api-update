import Link from 'next/link';
import styles from '@/styles/About.module.scss';

export const metadata = {
  title: 'About — Quantorus365',
  description: 'What Quantorus365 is, what we believe, and the principles behind the platform.',
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="section-label">{children}</span>;
}

const BELIEFS = [
  {
    title: 'Decision quality is the product',
    body: 'Not signal volume. Not alert frequency. Not data breadth. The single measure of value in a trading intelligence platform is the quality of the decisions it enables. Everything else is noise.',
  },
  {
    title: 'Rejection is as important as approval',
    body: 'A system that never says no is not an intelligence system. It is a data feed with formatting. The discipline to reject — quickly, clearly, and with structured reasoning — is what separates intelligence from information.',
  },
  {
    title: 'Risk should govern, not inform',
    body: 'In most tooling, risk is computed after a signal is formed and then displayed alongside it. We build risk as a gatekeeper that determines whether a signal is permitted to exist at all.',
  },
  {
    title: 'Portfolio context cannot be optional',
    body: 'Any signal that does not account for what is already in the portfolio is incomplete. Sector overexposure, strategy concentration, and correlation clustering are structural risks that an intelligence system must address, not leave to the user to notice.',
  },
  {
    title: 'Explainability is not a feature — it is a requirement',
    body: 'A professional cannot act on a black-box signal and maintain a defensible process. Every output of Quantorus365 must surface its reasoning: which factors contributed, which gates were passed or failed, and why.',
  },
  {
    title: 'Phased quality beats rushed completeness',
    body: 'We would rather have one fully production-grade module than five modules that are partially functional. The platform grows in phases, and each phase is built to last.',
  },
];

export default function AboutPage() {
  return (
    <>
      <section className={styles.hero}>
        <div aria-hidden="true" className={styles.heroGrid} />
        <div className={`container ${styles.heroContainer}`}>
          <SectionLabel>About</SectionLabel>
          <h1 className={styles.heroHeading}>
            We are building the intelligence infrastructure that serious market decisions require
          </h1>
          <p className={styles.heroLede}>
            Quantorus365 exists because the tools available to professional and advanced market participants are, structurally, insufficient. They are fragmented, shallow, and designed for volume rather than quality.
          </p>
        </div>
      </section>

      <section className={`section ${styles.whySection}`}>
        <div className="container">
          <div className={styles.whyGrid}>
            <div>
              <SectionLabel>Why This Exists</SectionLabel>
              <h2 className={styles.whyHeading}>The gap we are addressing</h2>
            </div>
            <div>
              <p className={styles.whyPara}>
                The dominant market intelligence tools available today were designed for retail participation — for simplicity, for volume, for engagement. They optimise for metrics that have nothing to do with decision quality.
              </p>
              <p className={styles.whyPara}>
                Institutional decision systems work differently. They filter aggressively. They contextualise every signal within the existing portfolio. They decompose confidence into independent components. They make risk a structural constraint, not a label.
              </p>
              <p className={styles.whyParaLast}>
                These capabilities are not technically inaccessible to non-institutional participants. They have simply never been built for them. Quantorus365 is being built to close that gap.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <SectionLabel>What We Believe</SectionLabel>
          <h2 className={styles.beliefsHeading}>
            The principles behind every product decision
          </h2>
          <div className={styles.beliefsGrid}>
            {BELIEFS.map(({ title, body }, i) => (
              <div key={title} className={styles.belief}>
                <div className={styles.beliefNum}>
                  {String(i + 1).padStart(2, '0')}
                </div>
                <h4 className={styles.beliefTitle}>
                  {title}
                </h4>
                <p className={styles.beliefBody}>{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={`section ${styles.platformSection}`}>
        <div className="container">
          <div className={styles.platformInner}>
            <SectionLabel>The Platform</SectionLabel>
            <h2 className={styles.platformHeading}>
              Quantorus365 is being built
            </h2>
            <p className={styles.platformPara}>
              The platform is in active development. The Intelligence Engine — the core decision module — is production-ready. Further modules follow a structured, phased programme. We are transparent about what is available, what is under development, and what is on the roadmap.
            </p>
            <p className={styles.platformParaLast}>
              We do not claim to be complete. We claim to be building correctly. The distinction matters enormously to us.
            </p>
            <div className={styles.platformCtas}>
              <Link href="/platform" className="btn btn--primary">Platform Overview</Link>
              <Link href="/contact" className="btn btn--outline">Get in Touch</Link>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
