'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Menu, X, ArrowUpRight } from 'lucide-react';
import { useState } from 'react';
import { brand, navItems } from '@/content/corporate';

export default function SiteShell({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false); const path = usePathname();
  return <div className="q-site"><a className="q-skip" href="#main">Skip to content</a><header className="q-header"><Link href="/" className="q-logo" aria-label="Quantorus home"><i />Quantorus</Link><nav aria-label="Primary navigation">{navItems.map(n => <Link key={n.href} className={path === n.href ? 'active' : ''} href={n.href}>{n.label}</Link>)}</nav><Link className="q-talk q-talk-desktop" href="/contact">Let’s talk <ArrowUpRight size={15}/></Link><button className="q-menu" aria-label="Toggle menu" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <X/> : <Menu/>}</button>{open && <div className="q-drawer">{navItems.map(n => <Link key={n.href} href={n.href} onClick={() => setOpen(false)}>{n.label}</Link>)}<Link className="q-talk" href="/contact" onClick={() => setOpen(false)}>Let’s talk <ArrowUpRight size={15}/></Link></div>}</header><main id="main">{children}</main><footer className="q-footer"><div><Link href="/" className="q-logo"><i />Quantorus</Link><p>Clarity for the decisions that move organizations forward.</p></div><div className="q-footer-links">{navItems.map(n => <Link key={n.href} href={n.href}>{n.label}</Link>)}<Link href="/privacy">Privacy</Link></div><div className="q-footer-bottom"><span>© {new Date().getFullYear()} Quantorus. All rights reserved.</span><a href={`mailto:${brand.contactEmail}`}>{brand.contactEmail}</a></div></footer></div>;
}
