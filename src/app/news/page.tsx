'use client';
import { useEffect, useState } from 'react';
import AppShell from '@/components/layout/AppShell';
import { Card, Badge, Loading, Empty } from '@/components/ui';
import { newsApi } from '@/lib/apiClient';
import { fmt } from '@/lib/utils';
import { Newspaper, ExternalLink, Clock } from 'lucide-react';

interface Article {
  id:            string | number;
  title:         string;
  summary:       string;
  thumbnail?:    string | null;
  published_at:  string;
  category_name?: string;
  is_featured?:  boolean;
  is_rss?:       boolean;
  url?:          string;
  source?:       string;
  slug?:         string;
}

interface Category { id: number; name: string; }

export default function NewsPage() {
  const [articles,   setArticles]   = useState<Article[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [activeCat,  setActiveCat]  = useState<number | null>(null);
  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);

  async function load(catId: number | null = null) {
    setLoading(true);
    setError(null);
    try {
      const params = catId ? `category_id=${catId}` : '';
      const [nRes, cRes] = await Promise.all([
        newsApi.list(params),
        newsApi.categories(),
      ]) as any[];
      setArticles(nRes.news || []);
      setCategories(cRes.categories || []);
    } catch (e: any) {
      setError(e?.message || 'Failed to load news');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  const filter     = (id: number | null) => { setActiveCat(id); load(id); };
  const getHref    = (a: Article) => a.is_rss ? (a.url ?? '#') : `/news/${a.id}`;
  const isExternal = (a: Article) => !!a.is_rss;

  const withImage    = articles.filter(a => a.thumbnail);
  const withoutImage = articles.filter(a => !a.thumbnail);

  return (
    <AppShell title="News & Insights">
      <div className="page">
        <div className="page__header">
          <div>
            <h1>News &amp; Insights</h1>
            <p>Latest market updates from MoneyControl, Economic Times, LiveMint &amp; more</p>
          </div>
        </div>

        {/* Category filters */}
        {categories.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
            <button className={`btn btn--sm ${!activeCat ? 'btn--primary' : 'btn--secondary'}`} onClick={() => filter(null)}>All</button>
            {categories.map(c => (
              <button key={c.id} className={`btn btn--sm ${activeCat === c.id ? 'btn--primary' : 'btn--secondary'}`} onClick={() => filter(c.id)}>{c.name}</button>
            ))}
          </div>
        )}

        {loading ? (
          <Loading text="Fetching latest news…" />
        ) : error ? (
          <Empty icon={Newspaper} title="Could not load news" description={error} />
        ) : articles.length === 0 ? (
          <Empty icon={Newspaper} title="No news available" description="Unable to fetch news feeds. Please try again later." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>

            {/* ── Image cards ─────────────────────────────────────── */}
            {withImage.length > 0 && (
              <section>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: '#94A3B8', textTransform: 'uppercase', marginBottom: 14 }}>
                  Top Stories
                </div>
                <div style={{ display: 'grid', gap: 20, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                  {withImage.map(a => (
                    <a key={a.id} href={getHref(a)} target={isExternal(a) ? '_blank' : undefined} rel={isExternal(a) ? 'noopener noreferrer' : undefined} style={{ textDecoration: 'none', display: 'block' }}>
                      <Card className="card--hover" style={{ padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', height: '100%' } as any}>
                        <img
                          src={a.thumbnail!}
                          alt={a.title}
                          style={{ width: '100%', height: 180, objectFit: 'cover', display: 'block', flexShrink: 0 }}
                          onError={e => {
                            const img = e.target as HTMLImageElement;
                            img.style.display = 'none';
                          }}
                        />
                        <div style={{ padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', flex: 1 }}>
                          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 8 }}>
                            {a.is_featured && <Badge variant="orange">Featured</Badge>}
                            {a.category_name && <Badge>{a.category_name}</Badge>}
                            {a.source && <Badge variant="gray" style={{ fontSize: 10 }}>{a.source}</Badge>}
                          </div>
                          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#1E3A5F', lineHeight: 1.45, marginBottom: 8, flex: 1 }}>
                            {a.title}
                            {isExternal(a) && <ExternalLink size={10} style={{ marginLeft: 4, opacity: 0.4, verticalAlign: 'middle' }} />}
                          </h3>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#94A3B8' }}>
                            <Clock size={10} />
                            {fmt.date(a.published_at)}
                          </div>
                        </div>
                      </Card>
                    </a>
                  ))}
                </div>
              </section>
            )}

            {/* ── Text-only grid ───────────────────────────────────── */}
            {withoutImage.length > 0 && (
              <section>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: '#94A3B8', textTransform: 'uppercase', marginBottom: 14 }}>
                  Latest Updates
                </div>
                <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
                  {withoutImage.map(a => (
                    <a key={a.id} href={getHref(a)} target={isExternal(a) ? '_blank' : undefined} rel={isExternal(a) ? 'noopener noreferrer' : undefined} style={{ textDecoration: 'none', display: 'block' }}>
                      <Card className="card--hover" style={{ display: 'flex', flexDirection: 'column', gap: 6, height: '100%' } as any}>
                        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                          {a.source && <Badge variant="gray" style={{ fontSize: 10 }}>{a.source}</Badge>}
                          {a.category_name && <Badge>{a.category_name}</Badge>}
                          {a.is_featured && <Badge variant="orange">Featured</Badge>}
                        </div>
                        <h3 style={{ fontSize: 13, fontWeight: 600, color: '#1E3A5F', lineHeight: 1.45, flex: 1 }}>
                          {a.title}
                          {isExternal(a) && <ExternalLink size={10} style={{ marginLeft: 4, opacity: 0.4, verticalAlign: 'middle' }} />}
                        </h3>
                        {a.summary && (
                          <p style={{ fontSize: 11, color: '#64748B', lineHeight: 1.45 }}>
                            {fmt.truncate(a.summary, 90)}
                          </p>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#94A3B8', marginTop: 2 }}>
                          <Clock size={10} />
                          {fmt.date(a.published_at)}
                        </div>
                      </Card>
                    </a>
                  ))}
                </div>
              </section>
            )}

          </div>
        )}
      </div>
    </AppShell>
  );
}
