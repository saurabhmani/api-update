'use client';

import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { ChevronDown, Menu, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';

export interface MenuLink { label: string; href: string; }
export interface MenuGroup { title?: string; links: MenuLink[]; }
export interface MenuColumn { groups: MenuGroup[]; }
export interface MenuSection { title: string; columns: MenuColumn[]; width?: 'wide' | 'standard'; }
export interface Navigation { logo: MenuLink; contact: MenuLink; items: Array<MenuLink & { section?: MenuSection }>; }

export function MenuLinkItem({ link }: { link: MenuLink }) {
  return <Link href={link.href} className="group flex items-center text-sm font-medium text-white transition duration-200 hover:translate-x-1 hover:text-red-400 focus:outline-none focus-visible:text-red-400"><span>{link.label}</span><span aria-hidden="true" className="ml-2 opacity-0 transition group-hover:opacity-100">→</span></Link>;
}

export function MenuGroup({ group }: { group: MenuGroup }) {
  return <div className="space-y-3">{group.title && <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-400">{group.title}</h3>}<div className="space-y-2.5">{group.links.map(link => <MenuLinkItem key={link.href} link={link}/>)}</div></div>;
}

export function MenuColumn({ column }: { column: MenuColumn }) {
  return <div className="space-y-7">{column.groups.map((group, index) => <MenuGroup key={`${group.title ?? 'links'}-${index}`} group={group}/>)}</div>;
}

export function DropdownPanel({ section, id }: { section: MenuSection; id: string }) {
  const wide = section.width === 'wide';
  return <motion.div id={id} role="region" aria-label={section.title} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} transition={{ duration: 0.2, ease: 'easeOut' }} className={`absolute left-1/2 top-full z-50 mt-4 -translate-x-1/2 rounded-[20px] bg-[#1c1c1c] p-8 shadow-2xl ring-1 ring-white/10 ${wide ? 'w-[min(900px,calc(100vw-2rem))]' : 'w-[min(760px,calc(100vw-2rem))]'}`}><p className="mb-7 text-xs font-semibold uppercase tracking-widest text-gray-400">{section.title}</p><div className={`grid gap-8 ${wide ? 'grid-cols-1 lg:grid-cols-[7fr_3fr]' : 'grid-cols-1 md:grid-cols-2'}`}><div className={`grid gap-8 ${section.columns.length >= 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-1 sm:grid-cols-2'}`}>{section.columns.slice(0, wide ? -1 : undefined).map((column, index) => <MenuColumn key={index} column={column}/>)}</div>{wide && section.columns.at(-1) && <div className="border-t border-white/10 pt-7 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0"><MenuColumn column={section.columns.at(-1)!}/></div>}</div></motion.div>;
}

export function MegaMenu({ navigation }: { navigation: Navigation }) {
  const [openLabel, setOpenLabel] = useState<string | null>(null); const [mobileOpen, setMobileOpen] = useState(false); const panelId = useId();
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpenLabel(null); setMobileOpen(false); } }; document.addEventListener('keydown', close); return () => document.removeEventListener('keydown', close); }, []);
  return <header onMouseLeave={() => setOpenLabel(null)} className="relative z-40 w-full bg-black text-white"><div className="mx-auto flex h-20 max-w-7xl items-center justify-between px-5 lg:px-8"><Link href={navigation.logo.href} className="text-xl font-bold tracking-tight">{navigation.logo.label}</Link><nav aria-label="Primary navigation" className="hidden h-full items-center gap-7 lg:flex">{navigation.items.map(item => { const expanded = openLabel === item.label; const id = `${panelId}-${item.label}`; return <div key={item.href} className="relative h-full" onMouseEnter={() => item.section && setOpenLabel(item.label)}>{item.section ? <button aria-expanded={expanded} aria-controls={id} className={`flex h-full items-center gap-1 text-sm font-medium transition ${expanded ? 'border-b-2 border-red-400 text-red-400' : 'text-white hover:text-red-400'}`} onClick={() => setOpenLabel(expanded ? null : item.label)}>{item.label}<ChevronDown size={15}/></button> : <MenuLinkItem link={item}/>}<AnimatePresence>{expanded && item.section && <DropdownPanel id={id} section={item.section}/>}</AnimatePresence></div>; })}</nav><Link href={navigation.contact.href} className="hidden rounded-full bg-red-500 px-5 py-3 text-sm font-semibold transition hover:-translate-y-0.5 hover:bg-red-400 lg:inline-flex">{navigation.contact.label}</Link><button aria-label={mobileOpen ? 'Close navigation' : 'Open navigation'} aria-expanded={mobileOpen} className="rounded p-2 lg:hidden" onClick={() => setMobileOpen(!mobileOpen)}>{mobileOpen ? <X/> : <Menu/>}</button></div><AnimatePresence>{mobileOpen && <motion.nav initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: .2, ease: 'easeOut' }} className="border-t border-white/10 px-5 pb-6 lg:hidden" aria-label="Mobile navigation">{navigation.items.map(item => <div key={item.href} className="border-b border-white/10">{item.section ? <details><summary className="flex cursor-pointer list-none items-center justify-between py-5 text-sm font-medium">{item.label}<ChevronDown size={16}/></summary><div className="grid gap-7 pb-5">{item.section.columns.map((column, index) => <MenuColumn key={index} column={column}/>)}</div></details> : <Link className="block py-5 text-sm font-medium" href={item.href} onClick={() => setMobileOpen(false)}>{item.label}</Link>}</div>)}<Link className="mt-6 inline-flex rounded-full bg-red-500 px-5 py-3 text-sm font-semibold" href={navigation.contact.href}>{navigation.contact.label}</Link></motion.nav>}</AnimatePresence></header>;
}

// A semantic alias for consumers that prefer a conventional Navbar component name.
export const Navbar = MegaMenu;

export default MegaMenu;
