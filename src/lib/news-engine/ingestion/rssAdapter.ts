// ════════════════════════════════════════════════════════════════
//  RSS Adapter — news-engine ingestion
//
//  Fetches from Economic Times + MoneyControl RSS feeds.
//  Lightweight fallback when API keys are unavailable.
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem, NewsSourceId } from '../types/newsEngine.types';

interface RssFeedConfig {
  url: string;
  sourceId: NewsSourceId;
  sourceName: string;
}

const RSS_FEEDS: RssFeedConfig[] = [
  {
    url: 'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
    sourceId: 'rss_et',
    sourceName: 'Economic Times',
  },
  {
    url: 'https://www.moneycontrol.com/rss/marketreports.xml',
    sourceId: 'rss_mc',
    sourceName: 'MoneyControl',
  },
];

function extractCdata(raw: string): string {
  const m = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return m ? m[1].trim() : raw.trim();
}

function parseRssItems(xml: string, feed: RssFeedConfig, limit: number): RawNewsItem[] {
  const items = xml.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
  const now = new Date().toISOString();
  const results: RawNewsItem[] = [];

  for (const item of items.slice(0, limit)) {
    const titleRaw = item.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? '';
    const title = extractCdata(titleRaw);
    if (!title) continue;

    const link = item.match(/<link>([\s\S]*?)<\/link>/)?.[1]?.trim() ?? '';
    const descRaw = item.match(/<description>([\s\S]*?)<\/description>/)?.[1] ?? '';
    const pubDate = item.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1]?.trim() ?? '';

    results.push({
      sourceId:    feed.sourceId,
      externalId:  `${feed.sourceId}-${Buffer.from(title).toString('base64').slice(0, 40)}`,
      title,
      body:        extractCdata(descRaw) || null,
      url:         link,
      publishedAt: pubDate ? new Date(pubDate).toISOString() : now,
      fetchedAt:   now,
      rawMeta:     { sourceName: feed.sourceName },
    });
  }

  return results;
}

function createRssAdapter(feed: RssFeedConfig): NewsAdapter {
  return {
    sourceId: feed.sourceId,

    async fetch(_query: string, limit = 15): Promise<RawNewsItem[]> {
      try {
        const res = await fetch(feed.url, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) return [];
        const xml = await res.text();
        return parseRssItems(xml, feed, limit);
      } catch (err) {
        console.warn(`[rssAdapter:${feed.sourceId}] fetch failed:`, (err as Error).message);
        return [];
      }
    },
  };
}

export const rssEtAdapter: NewsAdapter = createRssAdapter(RSS_FEEDS[0]);
export const rssMcAdapter: NewsAdapter = createRssAdapter(RSS_FEEDS[1]);
