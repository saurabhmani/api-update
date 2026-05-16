import Link from 'next/link';
import styles from '@/styles/Footer.module.scss';

const FOOTER_LINKS = {
  Platform: [
    { label: 'Overview',      href: '/platform' },
    { label: 'Engines',       href: '/engines' },
    { label: 'Intelligence Engine', href: '/engines#intelligence' },
    { label: 'Architecture',  href: '/platform#architecture' },
    { label: 'Roadmap',       href: '/vision#roadmap' },
  ],
  Company: [
    { label: 'About',         href: '/about' },
    { label: 'Vision',        href: '/vision' },
    { label: 'Insights',      href: '/insights' },
    { label: 'Contact',       href: '/contact' },
  ],
  Access: [
    { label: 'Platform Login',     href: '/login' },
    { label: 'Early Access',       href: '/contact#early-access' },
    { label: 'Partnership Inquiry',href: '/contact#partnership' },
    { label: 'Strategic Discussion',href: '/contact#strategic' },
  ],
};

export default function Footer() {
  return (
    <footer className={styles.footer}>
      <div className="container">
        <div className={styles.topRow}>
          <div>
            <Link href="/" className={styles.brandLink}>
              <span className={styles.brandName}>
                Quantorus<span className={styles.brandAccent}>365</span>
              </span>
            </Link>
            <p className={styles.brandTagline}>
              Institutional trading intelligence. Being built with precision, discipline, and a clear product philosophy.
            </p>
            <div className={styles.statusWrap}>
              <span className="status-pill status-pill--active status-pill--dot">
                Platform in Development
              </span>
            </div>
          </div>

          {Object.entries(FOOTER_LINKS).map(([groupLabel, links]) => (
            <div key={groupLabel}>
              <p className={styles.groupLabel}>{groupLabel}</p>
              <div className={styles.linkList}>
                {links.map(({ label, href }) => (
                  <Link key={href} href={href} className={styles.link}>
                    {label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className={styles.bottomRow}>
          <p className={styles.copyright}>
            © {new Date().getFullYear()} Quantorus365. All rights reserved.
          </p>
          <p className={styles.disclaimer}>
            Quantorus365 is an intelligence platform in active development. All content on this site is for informational purposes only and does not constitute financial advice or investment recommendations.
          </p>
        </div>
      </div>
    </footer>
  );
}
