// ════════════════════════════════════════════════════════════════
//  Deals Feed Adapter
//
//  Ingests from:
//    - Mergers & acquisitions feeds
//    - Fundraising / strategic stake purchases
//    - Major contracts and partnerships
//
//  Source class: deals
//  Deal events often have high impact on symbol prices.
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem } from '../types/newsEngine.types';

const DEALS_API_URL = process.env.DEALS_FEED_API_URL ?? '';
const DEALS_API_KEY = process.env.DEALS_FEED_API_KEY ?? '';

export const dealsFeedAdapter: NewsAdapter = {
  sourceId: 'deals_feed',

  async fetch(query: string, limit = 15): Promise<RawNewsItem[]> {
    if (!DEALS_API_URL) return [];

    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };
      if (DEALS_API_KEY) headers['Authorization'] = `Bearer ${DEALS_API_KEY}`;

      const res = await fetch(
        `${DEALS_API_URL}?q=${encodeURIComponent(query)}&limit=${limit}`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) return [];

      const data = await res.json();
      const now = new Date().toISOString();

      return (data.deals ?? data.items ?? []).slice(0, limit).map((deal: any, i: number) => ({
        sourceId:    'deals_feed' as const,
        externalId:  deal.id ?? `deal-${Date.now()}-${i}`,
        title:       buildDealTitle(deal),
        body:        (deal.description ?? deal.summary ?? '').trim() || null,
        url:         deal.url ?? deal.link ?? '',
        publishedAt: deal.announcedAt ?? deal.publishedAt ?? deal.date ?? now,
        fetchedAt:   now,
        rawMeta: {
          dealType:   deal.dealType ?? deal.type,
          dealValue:  deal.value ?? deal.amount,
          acquirer:   deal.acquirer ?? deal.buyer,
          target:     deal.target ?? deal.company,
          symbol:     deal.symbol,
        },
      }));
    } catch {
      return [];
    }
  },
};

function buildDealTitle(deal: any): string {
  const title = deal.title ?? deal.headline;
  if (title) return title.trim();

  // Construct a title from structured fields
  const dealType = deal.dealType ?? deal.type ?? 'Deal';
  const target = deal.target ?? deal.company ?? 'Unknown';
  const acquirer = deal.acquirer ?? deal.buyer;
  if (acquirer) {
    return `${dealType}: ${acquirer} and ${target}`;
  }
  return `${dealType}: ${target}`;
}
