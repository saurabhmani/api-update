// ════════════════════════════════════════════════════════════════
//  Official Exchange / Corporate Filings Adapter
//
//  Ingests from:
//    - BSE/NSE corporate announcements (via RSS/API)
//    - Corporate filings and disclosures
//
//  Source class: official
//  Higher default credibility than media/social sources.
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem } from '../types/newsEngine.types';

const BSE_RSS_URL = process.env.BSE_ANNOUNCEMENTS_RSS ?? '';
const NSE_RSS_URL = process.env.NSE_ANNOUNCEMENTS_RSS ?? '';

/**
 * Official exchange announcements adapter.
 * Fetches corporate announcements from BSE/NSE RSS feeds.
 */
export const officialExchangeAdapter: NewsAdapter = {
  sourceId: 'official_exchange',

  async fetch(query: string, limit = 15): Promise<RawNewsItem[]> {
    if (!BSE_RSS_URL && !NSE_RSS_URL) return [];

    const items: RawNewsItem[] = [];
    const now = new Date().toISOString();

    for (const feedUrl of [BSE_RSS_URL, NSE_RSS_URL].filter(Boolean)) {
      try {
        const res = await fetch(feedUrl, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) continue;
        const text = await res.text();
        items.push(...parseRssItems(text, now, limit));
      } catch {
        // Non-blocking: skip this feed
      }
    }

    return items.slice(0, limit);
  },
};

/**
 * Corporate filings adapter.
 * Fetches from a configured corporate filings/disclosures endpoint.
 */
export const corporateFilingsAdapter: NewsAdapter = {
  sourceId: 'corporate_filings',

  async fetch(query: string, limit = 15): Promise<RawNewsItem[]> {
    const filingsUrl = process.env.CORPORATE_FILINGS_API_URL;
    if (!filingsUrl) return [];

    try {
      const res = await fetch(
        `${filingsUrl}?q=${encodeURIComponent(query)}&limit=${limit}`,
        { signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) return [];

      const data = await res.json();
      const now = new Date().toISOString();

      return (data.filings ?? data.items ?? []).slice(0, limit).map((item: any, i: number) => ({
        sourceId:    'corporate_filings' as const,
        externalId:  item.id ?? `filing-${Date.now()}-${i}`,
        title:       (item.title ?? item.subject ?? '').trim(),
        body:        (item.description ?? item.body ?? '').trim() || null,
        url:         item.url ?? item.link ?? '',
        publishedAt: item.publishedAt ?? item.date ?? now,
        fetchedAt:   now,
        rawMeta:     { filingType: item.filingType, symbol: item.symbol },
      }));
    } catch {
      return [];
    }
  },
};

// ── RSS parsing helper ──────────────────────────────────────────

function parseRssItems(xml: string, fetchedAt: string, limit: number): RawNewsItem[] {
  const items: RawNewsItem[] = [];
  // Simple regex-based RSS item extraction
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  let idx = 0;

  while ((match = itemRegex.exec(xml)) !== null && idx < limit) {
    const content = match[1];
    const title = extractTag(content, 'title');
    const link = extractTag(content, 'link');
    const pubDate = extractTag(content, 'pubDate');
    const description = extractTag(content, 'description');

    if (title) {
      items.push({
        sourceId:    'official_exchange',
        externalId:  `exchange-${idx}-${Date.now()}`,
        title:       title.trim(),
        body:        description?.trim() || null,
        url:         link ?? '',
        publishedAt: pubDate ? new Date(pubDate).toISOString() : fetchedAt,
        fetchedAt,
        rawMeta:     { source: 'exchange_rss' },
      });
      idx++;
    }
  }
  return items;
}

function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?(.*?)(?:\\]\\]>)?<\\/${tag}>`, 's'));
  return match?.[1]?.trim() ?? null;
}
