// ════════════════════════════════════════════════════════════════
//  GNews Adapter — news-engine ingestion
//
//  Fetches from GNews API v4. Returns RawNewsItem[] for
//  downstream normalization.
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem } from '../types/newsEngine.types';

const GNEWS_KEY = process.env.GNEWS_API_KEY;

export const gnewsAdapter: NewsAdapter = {
  sourceId: 'gnews',

  async fetch(query: string, limit = 10): Promise<RawNewsItem[]> {
    if (!GNEWS_KEY) return [];

    try {
      const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&country=in&max=${limit}&token=${GNEWS_KEY}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];

      const data = await res.json();
      const now = new Date().toISOString();

      return (data.articles ?? []).map((a: any, i: number) => ({
        sourceId:    'gnews' as const,
        externalId:  `gnews-${a.publishedAt || i}-${Date.now()}`,
        title:       (a.title ?? '').trim(),
        body:        (a.description ?? '').trim() || null,
        url:         a.url ?? '',
        publishedAt: a.publishedAt ?? now,
        fetchedAt:   now,
        rawMeta: {
          sourceName: a.source?.name,
          sourceUrl:  a.source?.url,
          image:      a.image,
        },
      }));
    } catch (err) {
      console.warn('[gnewsAdapter] fetch failed:', (err as Error).message);
      return [];
    }
  },
};
