// ════════════════════════════════════════════════════════════════
//  NewsData.io Adapter — news-engine ingestion
//
//  Purpose: India/global category-based news.
//  Use for: business top headlines, company-specific keywords.
//
//  Default broadcast call → category=business&country=in with no
//  free-text query, so NewsData returns the freshest top business
//  headlines from Indian outlets. When the caller supplies an
//  explicit query (e.g. company name, sector keyword), we forward
//  it via `q=` and keep category=business so we stay inside the
//  intended slice.
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem } from '../types/newsEngine.types';
import { DEFAULT_NEWS_QUERY } from './ingestAll';

const NEWSDATA_KEY = process.env.NEWSDATA_API_KEY;

export const newsDataAdapter: NewsAdapter = {
  sourceId: 'newsdata',

  async fetch(query: string, limit = 10): Promise<RawNewsItem[]> {
    if (!NEWSDATA_KEY) return [];

    const useExplicitQuery = !!query && query !== DEFAULT_NEWS_QUERY;
    const qParam = useExplicitQuery
      ? `&q=${encodeURIComponent(query)}`
      : '';

    try {
      const url =
        `https://newsdata.io/api/1/news` +
        `?apikey=${NEWSDATA_KEY}` +
        `&language=en&country=in&category=business` +
        qParam;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];

      const data = await res.json();
      const now = new Date().toISOString();

      return (data.results ?? [])
        .slice(0, limit)
        .map((a: any, i: number): RawNewsItem | null => {
          const title = (a.title ?? '').trim();
          if (!title) return null;
          return {
            sourceId:    'newsdata',
            externalId:  a.article_id ?? `newsdata-${i}-${Date.now()}`,
            title,
            body:        (a.description ?? '').trim() || null,
            url:         a.link ?? '',
            publishedAt: a.pubDate ?? now,
            fetchedAt:   now,
            rawMeta: {
              sourceId:   a.source_id,
              keywords:   a.keywords,
              creator:    a.creator,
              sentiment:  a.sentiment,
              categories: a.category,
              query:      useExplicitQuery ? query : null,
            },
          };
        })
        .filter((item: RawNewsItem | null): item is RawNewsItem => item !== null);
    } catch (err) {
      console.warn('[newsDataAdapter] fetch failed:', (err as Error).message);
      return [];
    }
  },
};
