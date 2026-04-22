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
// ════════════════════════════════════════════════════════════════

import type { NewsAdapter, RawNewsItem } from '../types/newsEngine.types';

const SOCIAL_API_URL = process.env.SOCIAL_SIGNALS_API_URL ?? '';
const SOCIAL_API_KEY = process.env.SOCIAL_SIGNALS_API_KEY ?? '';

export const socialSignalsAdapter: NewsAdapter = {
  sourceId: 'social_signals',

  async fetch(query: string, limit = 15): Promise<RawNewsItem[]> {
    if (!SOCIAL_API_URL) return [];

    try {
      const headers: Record<string, string> = {
        'Accept': 'application/json',
      };
      if (SOCIAL_API_KEY) headers['Authorization'] = `Bearer ${SOCIAL_API_KEY}`;

      const res = await fetch(
        `${SOCIAL_API_URL}?q=${encodeURIComponent(query)}&limit=${limit}`,
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
