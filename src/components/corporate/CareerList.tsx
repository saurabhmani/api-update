'use client';
import { useState } from 'react';
import { ChevronDown, ArrowUpRight } from 'lucide-react';
import { brand, jobs } from '@/content/corporate';

type Job = (typeof jobs)[number];
export default function CareerList({ opportunities = jobs }: { opportunities?: readonly Job[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!opportunities.length) return <div className="q-empty"><h2>There are no open positions right now.</h2><p className="q-body">We welcome thoughtful introductions at <a className="q-link" href={`mailto:${brand.contactEmail}`}>{brand.contactEmail}</a>.</p></div>;
  return <div className="q-service-list">{opportunities.map((job, index) => <article className="q-job" key={job.slug}><button aria-expanded={open === job.slug} onClick={() => setOpen(open === job.slug ? null : job.slug)}><span>{String(index + 1).padStart(2, '0')}</span><div><h2>{job.title}</h2><p>{job.type}</p></div><ChevronDown aria-hidden="true" className={open === job.slug ? 'open' : ''}/></button>{open === job.slug && <div className="q-job-detail"><p className="q-body">{job.summary}</p><h3>What you’ll bring</h3><ul>{job.requirements.map(requirement => <li key={requirement}>{requirement}</li>)}</ul><a className="q-talk" href={`mailto:${brand.contactEmail}?subject=${encodeURIComponent(`Application: ${job.title}`)}`}>Apply by email <ArrowUpRight size={16}/></a></div>}</article>)}</div>;
}
