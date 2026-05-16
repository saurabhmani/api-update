// ════════════════════════════════════════════════════════════════
//  Finnhub Adapter — news-engine ingestion
//
//  Purpose: market and company news.
//  Use for: company-level financial news where symbol mapping is
//           available — Finnhub pre-tags each article with related
//           symbols via the `related` field, which downstream
//           entity-linking consumes directly.
//
//  Two entry points:
//    • finnhubAdapter.fetch(query, limit)
//        Broadcast call from the orchestrator — pulls category=general
//        market news. The `query` arg is unused because Finnhub's
//        category endpoint has no free-text search; relevance is
//        driven entirely by Finnhub's editorial pipeline.
//    • fetchFinnhubCompanyNews(symbol, daysBack, limit)
//        Targeted company news for a specific symbol over a date
//        window. Call this directly when you already have a symbol
//        in hand (e.g. signal enrichment, per-symbol drill-down).
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem } from '../types/newsEngine.types';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'finnhubAdapter' });

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

export const finnhubAdapter: NewsAdapter = {
  sourceId: 'finnhub',

  async fetch(_query: string, limit = 20): Promise<RawNewsItem[]> {
    if (!FINNHUB_KEY) return [];

    try {
      // Finnhub general news endpoint — category=general covers market-wide
      // headlines and is the only category-style endpoint that returns
      // pre-tagged `related` symbols suitable for entity-linking. The
      // free-text `query` is intentionally ignored: per-symbol lookup
      // should go through fetchFinnhubCompanyNews() below.
      const url = `https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];

      const data: any[] = await res.json();
      const now = new Date().toISOString();

      return data
        .slice(0, limit)
        .map((a): RawNewsItem | null => {
          const title = (a.headline ?? '').trim();
          if (!title) return null;
          return {
            sourceId:    'finnhub',
            externalId:  String(a.id ?? `finnhub-${a.datetime}-${Date.now()}`),
            title,
            body:        (a.summary ?? '').trim() || null,
            url:         a.url ?? '',
            publishedAt: a.datetime
              ? new Date(a.datetime * 1000).toISOString()
              : now,
            fetchedAt:   now,
            rawMeta: {
              category: a.category,
              source:   a.source,
              image:    a.image,
              related:  a.related,  // comma-separated symbols from Finnhub
            },
          };
        })
        .filter((item): item is RawNewsItem => item !== null);
    } catch (err) {
      log.warn('Fetch failed', { error: (err as Error).message });
      return [];
    }
  },
};

/**
 * Fetch company-specific news for a given symbol.
 * Uses the Finnhub company news endpoint with date range.
 */
export async function fetchFinnhubCompanyNews(
  symbol: string,
  daysBack = 7,
  limit = 10,
): Promise<RawNewsItem[]> {
  if (!FINNHUB_KEY) return [];

  try {
    const to = new Date();
    const from = new Date(to.getTime() - daysBack * 86_400_000);
    const fmt = (d: Date) => d.toISOString().slice(0, 10);

    const url = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(symbol)}&from=${fmt(from)}&to=${fmt(to)}&token=${FINNHUB_KEY}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];

    const data: any[] = await res.json();
    const now = new Date().toISOString();

    return data
      .slice(0, limit)
      .map((a): RawNewsItem | null => {
        const title = (a.headline ?? '').trim();
        if (!title) return null;
        return {
          sourceId:    'finnhub',
          externalId:  String(a.id ?? `finnhub-co-${a.datetime}-${Date.now()}`),
          title,
          body:        (a.summary ?? '').trim() || null,
          url:         a.url ?? '',
          publishedAt: a.datetime
            ? new Date(a.datetime * 1000).toISOString()
            : now,
          fetchedAt:   now,
          rawMeta: {
            category: a.category,
            source:   a.source,
            related:  symbol,
          },
        };
      })
      .filter((item): item is RawNewsItem => item !== null);
  } catch (err) {
    log.warn('Company news fetch failed', { symbol, error: (err as Error).message });
    return [];
  }
}
