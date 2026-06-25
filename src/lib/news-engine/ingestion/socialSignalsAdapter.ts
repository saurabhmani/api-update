// ════════════════════════════════════════════════════════════════
//  Social Signals Adapter
//
//  Ingests from:
//    - Curated social/newswire-like sentiment sources
//    - Monitored social signal aggregation endpoints
//
//  Source class: social
//  Social sources have lower default credibility and raise
//  manipulation scrutiny when not confirmed by official sources.
//
//  RULE: Social signals are treated with higher manipulation
//  sensitivity. The scoring layer automatically increases
//  manipulation suspicion for social-origin events.
//
//  Premium integration — disabled until SOCIAL_SIGNALS_API_URL is set.
//  Onboarding: docs/PREMIUM_NEWS_FEEDS.md
//  TODO(provider): add vendor-specific auth, rate limits, and platform
//  filters once a social signal vendor is selected.
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem } from '../types/newsEngine.types';

export const socialSignalsAdapter: NewsAdapter = {
  sourceId: 'social_signals',

  async fetch(query: string, limit = 15): Promise<RawNewsItem[]> {
    const socialUrl = process.env.SOCIAL_SIGNALS_API_URL?.trim();
    if (!socialUrl) return [];

    const socialApiKey = process.env.SOCIAL_SIGNALS_API_KEY?.trim() ?? '';

    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };
      if (socialApiKey) headers['Authorization'] = `Bearer ${socialApiKey}`;

      const res = await fetch(
        `${socialUrl}?q=${encodeURIComponent(query)}&limit=${limit}`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) return [];

      const data = await res.json();
      const now = new Date().toISOString();

      return (data.signals ?? data.posts ?? data.items ?? []).slice(0, limit).map((item: any, i: number) => ({
        sourceId:    'social_signals' as const,
        externalId:  item.id ?? `social-${Date.now()}-${i}`,
        title:       (item.title ?? item.text ?? item.content ?? '').trim().slice(0, 500),
        body:        (item.body ?? item.description ?? '').trim() || null,
        url:         item.url ?? item.link ?? '',
        publishedAt: item.publishedAt ?? item.postedAt ?? item.date ?? now,
        fetchedAt:   now,
        rawMeta: {
          source:     'social',
          platform:   item.platform ?? item.source ?? 'unknown',
          engagement: item.engagement ?? item.likes ?? 0,
          reposts:    item.reposts ?? item.shares ?? 0,
          author:     item.author ?? item.user,
          verified:   item.verified ?? false,
        },
      }));
    } catch {
      return [];
    }
  },
};
