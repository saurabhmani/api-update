// ════════════════════════════════════════════════════════════════
//  NewsData.io Adapter — news-engine ingestion
//
//  Fetches from NewsData.io API v1. Returns RawNewsItem[] for
//  downstream normalization.
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem } from '../types/newsEngine.types';

const NEWSDATA_KEY = process.env.NEWSDATA_API_KEY;

export const newsDataAdapter: NewsAdapter = {
  sourceId: 'newsdata',

  async fetch(query: string, limit = 10): Promise<RawNewsItem[]> {
    if (!NEWSDATA_KEY) return [];

    try {
      const url = `https://newsdata.io/api/1/news?apikey=${NEWSDATA_KEY}&q=${encodeURIComponent(query)}&language=en&country=in&category=business`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];

      const data = await res.json();
      const now = new Date().toISOString();

      return (data.results ?? []).slice(0, limit).map((a: any, i: number) => ({
        sourceId:    'newsdata' as const,
        externalId:  a.article_id ?? `newsdata-${i}-${Date.now()}`,
        title:       (a.title ?? '').trim(),
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
        },
      }));
    } catch (err) {
      console.warn('[newsDataAdapter] fetch failed:', (err as Error).message);
      return [];
    }
  },
};
