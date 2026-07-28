import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { Reveal } from './Reveal';
export function PageHero({ eyebrow, title, body }: { eyebrow: string; title: string; body: string }) { return <section className="q-page-hero"><div className="q-container"><p className="q-eyebrow">{eyebrow}</p><h1>{title}</h1><p>{body}</p></div></section>; }
export function CTA() { return <section className="q-section alt"><div className="q-container q-scheme"><p className="q-eyebrow">Start here</p><h2>Bring the hard problem into focus.</h2><p>We’ll start with the context, constraints, and progress that matters to your team.</p><Link className="q-talk" href="/contact">Start a conversation <ArrowUpRight size={16}/></Link></div></section>; }
export function Section({ children, className = '' }: { children: React.ReactNode; className?: string }) { return <section className={`q-section ${className}`}><div className="q-container"><Reveal>{children}</Reveal></div></section>; }
