'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowUpRight, ChevronDown, Instagram, Linkedin, Menu, X, Youtube } from 'lucide-react';
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

const whatWeDoMenu = {
  capabilities: [
    {
      title: 'iRun',
      links: [
        { label: 'Application Management Services', href: '/services/managed-services' },
        { label: 'Cognitive Infrastructure Services', href: '/services/cloud-services' },
        { label: 'Cybersecurity', href: '/services/cybersecurity' },
      ],
    },
    {
      title: 'iTransform',
      links: [
        { label: 'AI-led Engineering', href: '/services/artificial-intelligence' },
        { label: 'Data and Analytics', href: '/services/data-analytics' },
        { label: 'Enterprise Applications', href: '/services/enterprise-applications' },
        { label: 'Interactive', href: '/services/digital-product-engineering' },
        { label: 'Industry.NXT', href: '/services/technology-strategy' },
      ],
    },
    {
      title: 'Business AI',
      links: [{ label: 'BlueVerse', href: '/services/ai-data-automation' }],
    },
  ],
} as const;

const whatWeDoLinks: { label: string; href: string }[] = [
  ...whatWeDoMenu.capabilities.flatMap<{ label: string; href: string }>((group) => group.links),
];

const getMenuChildren = (label: string) =>
  label === 'What we do'
    ? whatWeDoLinks
    : menuItems[label as keyof typeof menuItems];

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
              const children = getMenuChildren(item.label);
              const active = isActive(item.href);
              return (
                <div
                  className="q-nav-item"
                  key={item.href}
                  onMouseEnter={() => children && setOpenMenu(item.label)}
                  onMouseLeave={() => setOpenMenu(null)}
                >
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
                      {openMenu === item.label && (item.label === 'What we do' ? (
                        <div className="q-mega q-what-mega" role="menu" aria-label="What we do">
                          <div className="q-what-capabilities">
                            <p className="q-mega-heading">Capabilities</p>
                            <div className="q-what-groups">
                              {whatWeDoMenu.capabilities.map((group) => (
                                <section className="q-what-group" key={group.title}>
                                  <p>{group.title}</p>
                                  {group.links.map((link) => (
                                    <Link role="menuitem" key={link.label} href={link.href} onClick={close}>{link.label}</Link>
                                  ))}
                                </section>
                              ))}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div
                          className={`q-mega q-list-mega q-list-mega--${item.label.toLowerCase().replace(/\s+/g, '-')} q-list-mega--${Math.min(children.length, 3)}`}
                          role="menu"
                          aria-label={item.label}
                        >
                          <p className="q-mega-heading">{item.label}</p>
                          <div className="q-list-mega-links">
                            {children.map((child) => (
                              <Link role="menuitem" key={child.href} href={child.href} onClick={close}>
                                {child.label}
                              </Link>
                            ))}
                          </div>
                        </div>
                      ))}
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
            const children = getMenuChildren(item.label);
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
        <div className="q-footer-panel">
          <div className="q-footer-top">
            <h2>It&apos;s time to make<br />meaningful progress.</h2>
            <div className="q-footer-links">
              <div>
                <b>Explore</b>
                <Link href="/services">What we do</Link>
                <Link href="/industries">Industries</Link>
                <Link href="/technologies">Technologies</Link>
                <Link href="/resources">Case studies</Link>
              </div>
              <div>
                <b>Company</b>
                <Link href="/about">About us</Link>
                <Link href="/insights">Insights</Link>
                <Link href="/careers">Careers</Link>
                <Link href="/contact">Contact</Link>
              </div>
              <div>
                <b>Connect</b>
                <a href={`mailto:${brand.contactEmail}`}>{brand.contactEmail}</a>
                <Link href="/contact">Start a conversation</Link>
              </div>
            </div>
          </div>
          <div className="q-footer-brand-row">
            <Link href="/" className="q-footer-wordmark" aria-label="Quantorus home">
              <i /> Quantorus
            </Link>
            <div className="q-footer-socials" aria-label="Social channels">
              <span title="LinkedIn coming soon"><Linkedin size={15} aria-hidden="true" /></span>
              <span title="YouTube coming soon"><Youtube size={16} aria-hidden="true" /></span>
              <span className="q-social-x" title="X coming soon" aria-hidden="true">X</span>
              <span title="Instagram coming soon"><Instagram size={15} aria-hidden="true" /></span>
            </div>
          </div>
          <div className="q-footer-bottom">
            <span>© {new Date().getFullYear()} Quantorus. All rights reserved.</span>
            <Link href="/privacy">Privacy</Link>
            <Link href="/terms">Terms</Link>
            <Link href="/contact">Accessibility</Link>
            <a href={`mailto:${brand.contactEmail}`}>Contact</a>
          </div>
        </div>
      </footer>
    </div>
  );
}
