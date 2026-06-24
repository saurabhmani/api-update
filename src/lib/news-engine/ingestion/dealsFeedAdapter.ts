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
//
//  Premium integration — disabled until DEALS_FEED_API_URL is set.
//  Onboarding: docs/PREMIUM_NEWS_FEEDS.md
//  TODO(provider): add vendor-specific auth, pagination, and POST bodies
//  once a deals data vendor is selected.
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem } from '../types/newsEngine.types';

export const dealsFeedAdapter: NewsAdapter = {
  sourceId: 'deals_feed',

  async fetch(query: string, limit = 15): Promise<RawNewsItem[]> {
    const dealsUrl = process.env.DEALS_FEED_API_URL?.trim();
    if (!dealsUrl) return [];

    const dealsApiKey = process.env.DEALS_FEED_API_KEY?.trim() ?? '';

    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };
      if (dealsApiKey) headers['Authorization'] = `Bearer ${dealsApiKey}`;

      const res = await fetch(
        `${dealsUrl}?q=${encodeURIComponent(query)}&limit=${limit}`,
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
