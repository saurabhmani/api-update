'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { NAV_LINKS } from '@/lib/data';
import styles from '@/styles/Nav.module.scss';

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen]         = useState(false);
  const pathname                = usePathname();

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', fn, { passive: true });
    return () => window.removeEventListener('scroll', fn);
  }, []);

  return (
    <>
      <nav
        className={styles.nav}
        style={{
          background:   scrolled ? 'rgba(3,7,18,0.92)' : 'transparent',
          borderBottom: scrolled ? '1px solid rgba(255,255,255,0.06)' : '1px solid transparent',
          backdropFilter: scrolled ? 'blur(20px)' : 'none',
        }}
      >
        <div className={styles.inner}>
          <Link href="/" className={styles.logoLink}>
            <span className={styles.logoName}>
              Quantorus<span className={styles.logoAccent}>365</span>
            </span>
            <span className={styles.logoTagline}>
              Intelligence Platform
            </span>
          </Link>

          <div className={styles.desktopLinks}>
            {NAV_LINKS.map(({ label, href }) => (
              <Link
                key={href}
                href={href}
                className={styles.desktopLink}
                style={{
                  color: pathname === href ? 'var(--text-primary)' : 'var(--gray-400)',
                }}
              >
                {label}
              </Link>
            ))}
          </div>

          <div className={styles.desktopCta}>
            <Link href="/gateway" className={`btn btn--outline ${styles.ctaButton}`}>
              Login
            </Link>
          </div>

          <button
            className={styles.hamburger}
            onClick={() => setOpen(o => !o)}
            aria-label="Toggle menu"
          >
            <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
              {open ? (
                <>
                  <line x1="3" y1="3" x2="19" y2="19" stroke="currentColor" strokeWidth="1.5"/>
                  <line x1="19" y1="3" x2="3" y2="19" stroke="currentColor" strokeWidth="1.5"/>
                </>
              ) : (
                <>
                  <line x1="3" y1="7" x2="19" y2="7" stroke="currentColor" strokeWidth="1.5"/>
                  <line x1="3" y1="11" x2="19" y2="11" stroke="currentColor" strokeWidth="1.5"/>
                  <line x1="3" y1="15" x2="19" y2="15" stroke="currentColor" strokeWidth="1.5"/>
                </>
              )}
            </svg>
          </button>
        </div>
      </nav>

      {open && (
        <div className={styles.mobileMenu}>
          {NAV_LINKS.map(({ label, href }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setOpen(false)}
              className={styles.mobileLink}
            >
              {label}
            </Link>
          ))}
          <Link
            href="/login"
            onClick={() => setOpen(false)}
            className={styles.mobileLogin}
          >
            Login
          </Link>
        </div>
      )}
    </>
  );
}
