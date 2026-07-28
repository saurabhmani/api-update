'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight, ChevronDown, Menu, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { brand, industries, navItems, services, technologies } from '@/content/corporate';

const menuItems = {
  'What we do': services.slice(0, 6).map((x) => ({ label: x.name, href: `/services/${x.slug}` })),
  Industries: industries.map((x) => ({ label: x.name, href: `/industries/${x.slug}` })),
  Technologies: technologies.map((x) => ({ label: x.name, href: `/technologies/${x.slug}` })),
  Insights: [
    { label: 'Latest insights', href: '/insights' },
    { label: 'Case studies', href: '/case-studies' },
  ],
} as const;

export default function SiteShell({ children }: { children: React.ReactNode }) {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [mobile, setMobile] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const path = usePathname();
  const headerRef = useRef<HTMLElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const drawerId = useId();

  useEffect(() => {
    setMobile(false);
    setOpenMenu(null);
    setExpanded(null);
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobile(false);
        setOpenMenu(null);
      }
    };
    const onOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (headerRef.current?.contains(target)) return;
      if (drawerRef.current?.contains(target)) return;
      setOpenMenu(null);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onOutside);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onOutside);
    };
  }, []);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = mobile ? 'hidden' : '';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [mobile]);

  useEffect(() => {
    if (!mobile || !drawerRef.current) return;
    const drawer = drawerRef.current;
    const focusable = () =>
      Array.from(drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'));
    focusable()[0]?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusable();
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [mobile]);

  const isActive = (href: string) =>
    href === '/' ? path === href : path === href || path.startsWith(`${href}/`);
  const close = () => {
    setMobile(false);
    setOpenMenu(null);
    setExpanded(null);
  };

  return (
    <div className={`q-site${mobile ? ' q-nav-open' : ''}`}>
      <a className="q-skip" href="#main">
        Skip to content
      </a>

      <header ref={headerRef} className="q-header">
        <div className="q-header-bar">
          <Link href="/" className="q-logo" aria-label="Quantorus home" onClick={close}>
            <i />
            Quantorus
          </Link>

          <nav aria-label="Primary navigation" className="q-desktop-nav">
            {navItems.map((item) => {
              const children = menuItems[item.label as keyof typeof menuItems];
              const active = isActive(item.href);
              return (
                <div className="q-nav-item" key={item.href}>
                  {children ? (
                    <>
                      <button
                        className={active ? 'active' : ''}
                        aria-expanded={openMenu === item.label}
                        aria-haspopup="true"
                        onClick={() => setOpenMenu(openMenu === item.label ? null : item.label)}
                      >
                        {item.label}
                        <ChevronDown size={14} />
                      </button>
                      {openMenu === item.label && (
                        <div className="q-mega" role="menu">
                          <Link className="q-mega-all" href={item.href} onClick={close}>
                            Explore {item.label}
                            <ArrowUpRight size={15} />
                          </Link>
                          <div>
                            {children.map((child) => (
                              <Link role="menuitem" key={child.href} href={child.href} onClick={close}>
                                {child.label}
                                <ArrowUpRight size={13} />
                              </Link>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <Link className={active ? 'active' : ''} href={item.href}>
                      {item.label}
                    </Link>
                  )}
                </div>
              );
            })}
          </nav>

          <Link className="q-talk q-talk-desktop" href="/contact">
            Talk to our experts <ArrowUpRight size={15} />
          </Link>

          <button
            type="button"
            className="q-menu"
            aria-label={mobile ? 'Close menu' : 'Open menu'}
            aria-expanded={mobile}
            aria-controls={drawerId}
            onClick={() => setMobile((v) => !v)}
          >
            {mobile ? <X size={22} /> : <Menu size={22} />}
          </button>
        </div>
      </header>

      {/* Drawer is a sibling of the header bar so overflow/sticky cannot clip it */}
      <div
        id={drawerId}
        ref={drawerRef}
        className={`q-drawer${mobile ? ' is-open' : ''}`}
        hidden={!mobile}
        aria-hidden={!mobile}
        aria-label="Mobile navigation"
      >
        <nav className="q-drawer-nav">
          {navItems.map((item) => {
            const children = menuItems[item.label as keyof typeof menuItems];
            return (
              <div className="q-mobile-item" key={item.href}>
                {children ? (
                  <>
                    <button
                      type="button"
                      aria-expanded={expanded === item.label}
                      onClick={() => setExpanded(expanded === item.label ? null : item.label)}
                    >
                      {item.label}
                      <ChevronDown size={17} />
                    </button>
                    {expanded === item.label && (
                      <div>
                        <Link href={item.href} onClick={close}>
                          Explore {item.label}
                        </Link>
                        {children.map((child) => (
                          <Link key={child.href} href={child.href} onClick={close}>
                            {child.label}
                          </Link>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <Link
                    href={item.href}
                    className={isActive(item.href) ? 'active' : ''}
                    onClick={close}
                  >
                    {item.label}
                  </Link>
                )}
              </div>
            );
          })}
        </nav>
        <Link className="q-talk q-drawer-cta" href="/contact" onClick={close}>
          Talk to our experts <ArrowUpRight size={15} />
        </Link>
      </div>

      <main id="main">{children}</main>

      <footer className="q-footer">
        <div>
          <Link href="/" className="q-logo">
            <i />
            Quantorus
          </Link>
          <p>Technology, strategy, and delivery for meaningful business progress.</p>
          <a className="q-footer-mail" href={`mailto:${brand.contactEmail}`}>
            {brand.contactEmail}
          </a>
        </div>
        <div className="q-footer-links">
          <div>
            <b>Explore</b>
            <Link href="/services">Services</Link>
            <Link href="/industries">Industries</Link>
            <Link href="/technologies">Technologies</Link>
            <Link href="/case-studies">Case studies</Link>
          </div>
          <div>
            <b>Company</b>
            <Link href="/about">About</Link>
            <Link href="/insights">Insights</Link>
            <Link href="/careers">Careers</Link>
            <Link href="/contact">Contact</Link>
          </div>
          <div>
            <b>Legal</b>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
          </div>
        </div>
        <div className="q-footer-bottom">
          <span>© {new Date().getFullYear()} Quantorus. All rights reserved.</span>
          <span>LinkedIn and X channels coming soon.</span>
        </div>
      </footer>
    </div>
  );
}
