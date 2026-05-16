// ════════════════════════════════════════════════════════════════
//  GNews Adapter — news-engine ingestion
//
//  Purpose: broad business/news search.
//  Use for: "stock market India", "NSE", "BSE", "earnings",
//           "merger", "SEBI".
//
//  When the orchestrator calls with the default broadcast query,
//  the adapter substitutes an OR-joined business/markets clause so
//  GNews surfaces a wider slice of Indian market news instead of
//  literal-matching the sentinel string. Explicit queries
//  (e.g. "RELIANCE Q2 results") are passed through verbatim.
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem } from '../types/newsEngine.types';
import { DEFAULT_NEWS_QUERY } from './ingestAll';

const GNEWS_KEY = process.env.GNEWS_API_KEY;

// GNews v4 supports OR / quoted-phrase syntax inside the `q` param —
// this clause matches the user's stated coverage targets (markets,
// exchanges, regulator, corporate-action verbs).
const BROAD_BUSINESS_QUERY =
  '"stock market" OR NSE OR BSE OR SEBI OR earnings OR merger';

export const gnewsAdapter: NewsAdapter = {
  sourceId: 'gnews',

  async fetch(query: string, limit = 10): Promise<RawNewsItem[]> {
    if (!GNEWS_KEY) return [];

    const effectiveQuery =
      !query || query === DEFAULT_NEWS_QUERY ? BROAD_BUSINESS_QUERY : query;

    try {
      const url =
        `https://gnews.io/api/v4/search` +
        `?q=${encodeURIComponent(effectiveQuery)}` +
        `&lang=en&country=in&max=${limit}` +
        `&token=${GNEWS_KEY}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];

      const data = await res.json();
      const now = new Date().toISOString();

      return (data.articles ?? [])
        .slice(0, limit)
        .map((a: any, i: number): RawNewsItem | null => {
          const title = (a.title ?? '').trim();
          if (!title) return null;
          return {
            sourceId:    'gnews',
            externalId:  `gnews-${a.publishedAt || i}-${Date.now()}`,
            title,
            body:        (a.description ?? '').trim() || null,
            url:         a.url ?? '',
            publishedAt: a.publishedAt ?? now,
            fetchedAt:   now,
            rawMeta: {
              sourceName: a.source?.name,
              sourceUrl:  a.source?.url,
              image:      a.image,
              query:      effectiveQuery,
            },
          };
        })
        .filter((item: RawNewsItem | null): item is RawNewsItem => item !== null);
    } catch (err) {
      console.warn('[gnewsAdapter] fetch failed:', (err as Error).message);
      return [];
    }
  },
};
