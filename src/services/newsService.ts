/**
 * News Service
 * Fetches financial news from GNews, NewsData, and RSS fallback.
 */

import { cacheGet, cacheSet } from '@/lib/redis';

export interface NewsItem {
  id:           string;
  title:        string;
  description:  string | null;
  url:          string;
  source:       string;
  published_at: string;
  sentiment?:   'positive' | 'negative' | 'neutral';
  symbols?:     string[];
}

const GNEWS_KEY    = process.env.GNEWS_API_KEY;
const NEWSDATA_KEY = process.env.NEWSDATA_API_KEY;

// ── GNews ────────────────────────────────────────────────────────
async function fetchFromGNews(query: string, limit = 10): Promise<NewsItem[]> {
  if (!GNEWS_KEY) return [];
  try {
    const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(query)}&lang=en&country=in&max=${limit}&token=${GNEWS_KEY}`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.articles ?? []).map((a: any, i: number) => ({
      id:           `gnews-${i}-${Date.now()}`,
      title:        a.title,
      description:  a.description,
      url:          a.url,
      source:       a.source?.name ?? 'GNews',
      published_at: a.publishedAt,
    }));
  } catch { return []; }
}

// ── NewsData.io ───────────────────────────────────────────────────
async function fetchFromNewsData(query: string, limit = 10): Promise<NewsItem[]> {
  if (!NEWSDATA_KEY) return [];
  try {
    const url = `https://newsdata.io/api/1/news?apikey=${NEWSDATA_KEY}&q=${encodeURIComponent(query)}&language=en&country=in`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results ?? []).slice(0, limit).map((a: any, i: number) => ({
      id:           `newsdata-${i}-${Date.now()}`,
      title:        a.title,
      description:  a.description,
      url:          a.link,
      source:       a.source_id ?? 'NewsData',
      published_at: a.pubDate,
      sentiment:    a.sentiment as any,
    }));
  } catch { return []; }
}

// ── RSS fallback ──────────────────────────────────────────────────
async function fetchFromRss(limit = 10): Promise<NewsItem[]> {
  const feeds = [
    'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
    'https://www.moneycontrol.com/rss/marketreports.xml',
  ];
  const results: NewsItem[] = [];
  for (const url of feeds) {
    try {
      const res  = await fetch(url, { signal: AbortSignal.timeout(5000) });
      const text = await res.text();
      const items = text.match(/<item>([\s\S]*?)<\/item>/g) ?? [];
      items.slice(0, limit).forEach((item, i) => {
        const title = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)?.[1]
                   ?? item.match(/<title>(.*?)<\/title>/)?.[1] ?? '';
        const link  = item.match(/<link>(.*?)<\/link>/)?.[1] ?? '';
        const date  = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] ?? '';
        if (title) results.push({
          id: `rss-${i}-${Date.now()}`,
          title, description: null, url: link,
          source: url.includes('economictimes') ? 'Economic Times' : 'MoneyControl',
          published_at: date ? new Date(date).toISOString() : new Date().toISOString(),
        });
      });
    } catch {}
    if (results.length >= limit) break;
  }
  return results.slice(0, limit);
}

// ── Public API ────────────────────────────────────────────────────
export async function fetchNews(query = 'Indian stock market', limit = 10): Promise<NewsItem[]> {
  const cacheKey = `news:${query}:${limit}`;
  const cached   = await cacheGet<NewsItem[]>(cacheKey);
  if (cached?.length) return cached;

  let items = await fetchFromGNews(query, limit);
  if (!items.length) items = await fetchFromNewsData(query, limit);
  if (!items.length) items = await fetchFromRss(limit);

  if (items.length) await cacheSet(cacheKey, items, 900); // 15 min cache
  return items;
}

export async function fetchStockNews(symbol: string, limit = 10): Promise<NewsItem[]> {
  return fetchNews(`${symbol} NSE India stock`, limit);
}
