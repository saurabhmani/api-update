'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { insights } from '@/content/corporate';

export default function InsightList() {
  const [query, setQuery] = useState(''); const [category, setCategory] = useState('All');
  const categories = ['All', ...new Set(insights.map(article => article.category))];
  const list = useMemo(() => insights.filter(article => (category === 'All' || article.category === category) && `${article.title} ${article.excerpt}`.toLowerCase().includes(query.toLowerCase())), [category, query]);
  return <><div className="q-resource-toolbar"><input aria-label="Search insights" placeholder="Search insights" value={query} onChange={event => setQuery(event.target.value)}/><select aria-label="Filter insights by category" value={category} onChange={event => setCategory(event.target.value)}>{categories.map(item => <option key={item}>{item}</option>)}</select></div><div className="q-card-grid">{list.map(article => <article className="q-card" key={article.slug}><div><p className="q-eyebrow">{article.category} · {article.readTime}</p><h3>{article.title}</h3><p>{article.excerpt}</p><small>{article.date}</small></div><Link className="q-link" href={`/insights/${article.slug}`}>Read insight <ArrowUpRight size={16}/></Link></article>)}</div>{!list.length && <div className="q-empty">No insights match that search. Try another term or category.</div>}</>;
}
