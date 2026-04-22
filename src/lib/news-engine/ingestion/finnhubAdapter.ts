// ════════════════════════════════════════════════════════════════
//  Finnhub Adapter — news-engine ingestion
//
//  Fetches market news and company news from Finnhub.io.
//  Provides high-quality financial news with pre-tagged symbols.
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem } from '../types/newsEngine.types';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'finnhubAdapter' });

const FINNHUB_KEY = process.env.FINNHUB_API_KEY;

export const finnhubAdapter: NewsAdapter = {
  sourceId: 'finnhub',

  async fetch(query: string, limit = 20): Promise<RawNewsItem[]> {
    if (!FINNHUB_KEY) return [];

    try {
      // Finnhub general news endpoint — category=general covers market-wide
      const url = `https://finnhub.io/api/v1/news?category=general&token=${FINNHUB_KEY}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return [];

      const data: any[] = await res.json();
      const now = new Date().toISOString();

      return data.slice(0, limit).map((a) => ({
        sourceId:    'finnhub' as const,
        externalId:  String(a.id ?? `finnhub-${a.datetime}-${Date.now()}`),
        title:       (a.headline ?? '').trim(),
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
      }));
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

    return data.slice(0, limit).map((a) => ({
      sourceId:    'finnhub' as const,
      externalId:  String(a.id ?? `finnhub-co-${a.datetime}-${Date.now()}`),
      title:       (a.headline ?? '').trim(),
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
    }));
  } catch (err) {
    console.warn(`[finnhubAdapter] company news for ${symbol} failed:`, (err as Error).message);
    return [];
  }
}
