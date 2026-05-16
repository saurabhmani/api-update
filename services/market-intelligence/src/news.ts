// ════════════════════════════════════════════════════════════════
//  News ingestion + dedup
//
//  Dedup key: sha256(`${symbol}|${ISO-day}|${normalizedTitle}`)
//
//  The same headline frequently gets republished by multiple
//  sources within the same day; we collapse those to ONE item.
//  Day bucket (not minute) is deliberate — a story re-run 6 hours
//  later with a new angle is usually the SAME event for signal-
//  engine purposes.
//
//  Source: IndianAPI /news (via MarketDataProvider.getCorporateIntel
//  which already hits /news as part of the intel payload). Falls
//  back to an empty list on error — callers treat absence as "no
//  news" rather than a fatal error.
// ════════════════════════════════════════════════════════════════

import crypto from 'node:crypto';
import MarketDataProvider from '@/providers/MarketDataProvider';
import { logger } from '@/lib/logger';

const log = logger.child({ service: 'market-intelligence', component: 'news' });

export interface NewsItem {
  dedup_key: string;
  symbol: string | null;
  title: string;
  summary?: string;
  source?: string;
  url?: string;
  published_at: string;    // ISO 8601
  categories: string[];
}

function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function dedupKey(symbol: string | null, publishedAt: string | number | Date, title: string): string {
  const day = new Date(publishedAt).toISOString().slice(0, 10);
  const base = `${(symbol ?? 'MARKET').toUpperCase()}|${day}|${normalizeTitle(title)}`;
  return crypto.createHash('sha256').update(base).digest('hex');
}

export function dedupNews(items: NewsItem[]): NewsItem[] {
  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const it of items) {
    if (seen.has(it.dedup_key)) continue;
    seen.add(it.dedup_key);
    out.push(it);
  }
  return out;
}

// ── Fetch ───────────────────────────────────────────────────────────
//
// MarketDataProvider.getCorporateIntel returns the /stock payload
// which, in the public IndianAPI shape, carries a `news` array. We
// lift + normalize it. If the adapter evolves to expose a direct
// getNews method, swap the body here without the caller noticing.

interface RawIntelWithNews {
  news?: Array<{
    title?: string; summary?: string; source?: string; url?: string;
    published_at?: string; categories?: string[];
  }>;
}

export async function fetchNewsForSymbol(symbol: string): Promise<NewsItem[]> {
  try {
    // getCorporateIntel is already typed to CorporateIntel, but the
    // underlying RawStock passthrough keeps extra fields. Cast loose
    // here to read the news array when present.
    const resp = await MarketDataProvider.getCorporateIntel(symbol);
    const raw = resp.data as unknown as RawIntelWithNews;
    const items = (raw.news ?? [])
      .filter(n => typeof n.title === 'string' && n.title.length > 0)
      .map((n): NewsItem => {
        const publishedAt = n.published_at ?? new Date().toISOString();
        return {
          dedup_key: dedupKey(symbol, publishedAt, n.title!),
          symbol: symbol.toUpperCase(),
          title: n.title!,
          summary: n.summary,
          source: n.source,
          url: n.url,
          published_at: publishedAt,
          categories: n.categories ?? [],
        };
      });
    return dedupNews(items);
  } catch (err) {
    log.warn('fetchNewsForSymbol failed', {
      symbol,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
