import Link from 'next/link';
import { INSIGHTS } from '@/lib/data';
import styles from '@/styles/Insights.module.scss';

export const metadata = {
  title: 'Insights — Quantorus365',
  description: 'Platform thinking and market intelligence from the Quantorus365 team.',
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <span className="section-label">{children}</span>;
}

const CATEGORIES = ['All', 'Signal Architecture', 'Risk Systems', 'Market Intelligence', 'Decision Workflows', 'Platform Thinking'];

const ALL_INSIGHTS = [
  ...INSIGHTS,
  {
    category: 'Platform Thinking',
    title:    'What modular architecture actually means for a trading intelligence platform',
    excerpt:  'Modularity is not simply a technical property. In a multi-engine intelligence platform, it determines how capabilities compose, how quality gates interact, and how the system behaves when one module has better data than another.',
    readTime: '7 min read',
    date:     'November 2024',
    slug:     'modular-architecture',
  },
  {
    category: 'Risk Systems',
    title:    'Building risk as a gatekeeper: the eleven-gate architecture',
    excerpt:  'Risk as a display metric and risk as a gatekeeper are architecturally different things. One is computed after a signal is formed. The other determines whether a signal is permitted to form at all.',
    readTime: '10 min read',
    date:     'October 2024',
    slug:     'risk-as-gatekeeper',
  },
];

export default function InsightsPage() {
  return (
    <>
      <section className={styles.hero}>
        <div aria-hidden="true" className={styles.heroGrid} />
        <div className={`container ${styles.heroContainer}`}>
          <SectionLabel>Insights</SectionLabel>
          <h1 className={styles.heroHeading}>
            Platform thinking and market intelligence
          </h1>
          <p className={styles.heroLede}>
            Perspectives on signal architecture, risk systems, decision workflows, and the building of Quantorus365.
          </p>
        </div>
      </section>

      <section className={styles.categoriesSection}>
        <div className="container">
          <div className={styles.categoriesBar}>
            {CATEGORIES.map((cat, i) => (
              <button
                key={cat}
                className={styles.categoryButton}
                style={{
                  borderBottom: i === 0 ? '2px solid var(--gold)' : '2px solid transparent',
                  color: i === 0 ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontWeight: i === 0 ? 500 : 400,
                }}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <Link href={`/insights/${ALL_INSIGHTS[0].slug}`} className={styles.featuredLink}>
            <div>
              <span className={styles.featuredCategory}>
                {ALL_INSIGHTS[0].category}
              </span>
              <h2 className={styles.featuredTitle}>
                {ALL_INSIGHTS[0].title}
              </h2>
              <p className={styles.featuredExcerpt}>
                {ALL_INSIGHTS[0].excerpt}
              </p>
              <div className={styles.featuredMeta}>
                <span>{ALL_INSIGHTS[0].date}</span>
                <span>·</span>
                <span>{ALL_INSIGHTS[0].readTime}</span>
              </div>
            </div>
            <div className={styles.featuredImage}>
              <div className={styles.featuredImageInner}>
                <div className={styles.featuredImageIcon}>✦</div>
                <div className={styles.featuredImageLabel}>
                  {ALL_INSIGHTS[0].category.toUpperCase()}
                </div>
              </div>
            </div>
          </Link>

          <div className={styles.grid}>
            {ALL_INSIGHTS.slice(1).map(insight => (
              <Link key={insight.slug} href={`/insights/${insight.slug}`} className={styles.gridCard}>
                <span className={styles.gridCategory}>
                  {insight.category}
                </span>
                <h4 className={styles.gridTitle}>
                  {insight.title}
                </h4>
                <p className={styles.gridExcerpt}>
                  {insight.excerpt.slice(0, 120)}...
                </p>
                <div className={styles.gridMeta}>
                  <span>{insight.date}</span>
                  <span>·</span>
                  <span>{insight.readTime}</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
