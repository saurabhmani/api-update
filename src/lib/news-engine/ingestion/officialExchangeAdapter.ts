// ════════════════════════════════════════════════════════════════
//  Official Exchange / Corporate Filings Adapter
//
//  Ingests from:
//    - BSE/NSE corporate announcements (RSS or JSON API)
//    - Corporate filings and disclosures
//
//  Source class: official
//  Higher default credibility than media/social sources.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import type { NewsAdapter, RawNewsItem } from '../types/newsEngine.types';

const log = logger.child({ component: 'officialExchangeAdapter' });

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const BSE_API_BASE =
  'https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w';
const NSE_API_BASE =
  'https://www.nseindia.com/api/corporate-announcements?index=equities';
const NSE_ROOT = 'https://www.nseindia.com';

const LEGACY_BSE_RSS_RE = /bseindia\.com\/xml-data\/corpfiling/i;
const LEGACY_NSE_RSS_RE = /nsearchives\.nseindia\.com\/corporate\/ann_listing/i;

type ExchangeFeed = 'bse' | 'nse';

function getConfiguredFeeds(): Array<{ exchange: ExchangeFeed; url: string }> {
  const feeds: Array<{ exchange: ExchangeFeed; url: string }> = [];
  const bseUrl = process.env.BSE_ANNOUNCEMENTS_RSS?.trim();
  const nseUrl = process.env.NSE_ANNOUNCEMENTS_RSS?.trim();
  if (bseUrl) feeds.push({ exchange: 'bse', url: bseUrl });
  if (nseUrl) feeds.push({ exchange: 'nse', url: nseUrl });
  return feeds;
}

function resolveFeedUrl(exchange: ExchangeFeed, configuredUrl: string): string {
  if (exchange === 'bse') {
    if (LEGACY_BSE_RSS_RE.test(configuredUrl) || configuredUrl.includes('CorpListing.xml')) {
      return buildBseApiUrl();
    }
    if (configuredUrl.includes('api.bseindia.com')) {
      return configuredUrl.includes('?') ? configuredUrl : buildBseApiUrl(configuredUrl);
    }
    return configuredUrl;
  }

  if (
    LEGACY_NSE_RSS_RE.test(configuredUrl) ||
    (configuredUrl.includes('nsearchives.nseindia.com') && configuredUrl.endsWith('.xml'))
  ) {
    return NSE_API_BASE;
  }
  if (configuredUrl.includes('nseindia.com/api/corporate-announcements')) {
    return configuredUrl;
  }
  return configuredUrl;
}

function toBseDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function buildBseApiUrl(base = BSE_API_BASE): string {
  const today = toBseDateKey(new Date());
  const params = new URLSearchParams({
    pageno:       '1',
    strCat:       '-1',
    strPrevDate:  today,
    strScrip:     '',
    strSearch:    'P',
    strToDate:    today,
    strType:      'C',
    subcategory:  '',
  });
  return `${base.split('?')[0]}?${params.toString()}`;
}

function buildCookieHeader(setCookieHeaders: string[]): string {
  return setCookieHeaders
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

async function warmupNseSession(timeoutMs = 8_000): Promise<string | null> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(NSE_ROOT, {
      method:  'GET',
      headers: {
        'User-Agent':      BROWSER_UA,
        'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'X-Quantorus':     'news-ingest/1',
      },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const raw =
      typeof (res.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie === 'function'
        ? (res.headers as Headers & { getSetCookie: () => string[] }).getSetCookie()
        : res.headers.get('set-cookie')
            ? [res.headers.get('set-cookie') as string]
            : [];
    if (!raw.length) return null;
    return buildCookieHeader(raw);
  } catch (err) {
    log.warn('NSE session warmup failed', { error: (err as Error).message });
    return null;
  }
}

async function fetchExchangeFeed(
  exchange: ExchangeFeed,
  configuredUrl: string,
): Promise<{ text: string; resolvedUrl: string } | null> {
  const resolvedUrl = resolveFeedUrl(exchange, configuredUrl);
  const headers: Record<string, string> = {
    'User-Agent': BROWSER_UA,
    'Accept':     'application/json,application/xml,text/xml,text/plain,*/*',
  };

  if (exchange === 'bse') {
    headers.Referer = 'https://www.bseindia.com/corporates/ann.html';
  } else {
    headers.Referer = 'https://www.nseindia.com/companies-listing/corporate-filings-announcements';
    const cookie = await warmupNseSession();
    if (cookie) headers.Cookie = cookie;
  }

  const res = await fetch(resolvedUrl, {
    headers,
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) {
    log.warn('Exchange feed HTTP error', {
      exchange,
      status: res.status,
      url: resolvedUrl,
    });
    return null;
  }

  const text = await res.text();
  if (!text.trim()) {
    log.warn('Exchange feed returned empty body', { exchange, url: resolvedUrl });
    return null;
  }

  return { text, resolvedUrl };
}

function extractCdata(raw: string): string {
  const m = raw.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  return (m ? m[1] : raw).trim();
}

function extractTag(xml: string, tag: string): string | null {
  const match = xml.match(
    new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'),
  );
  return match?.[1] ? extractCdata(match[1]) : null;
}

function parseRssItems(xml: string, fetchedAt: string, limit: number): RawNewsItem[] {
  const items: RawNewsItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  let idx = 0;

  while ((match = itemRegex.exec(xml)) !== null && idx < limit) {
    const content = match[1];
    const title = extractTag(content, 'title');
    const link = extractTag(content, 'link');
    const pubDate = extractTag(content, 'pubDate');
    const description = extractTag(content, 'description');

    if (!title) continue;

    items.push({
      sourceId:    'official_exchange',
      externalId:  `exchange-rss-${Buffer.from(link || title).toString('base64').slice(0, 40)}`,
      title:       title.trim(),
      body:        description?.trim() || null,
      url:         link ?? '',
      publishedAt: safeIsoDate(pubDate, fetchedAt),
      fetchedAt,
      rawMeta:     { source: 'exchange_rss', feedFormat: 'rss' },
    });
    idx++;
  }

  return items;
}

function parseNseAnnouncements(json: unknown, fetchedAt: string, limit: number): RawNewsItem[] {
  if (!Array.isArray(json)) return [];

  return json.slice(0, limit).flatMap((item, idx) => {
    const title = String(item.attchmntText ?? item.desc ?? item.sm_name ?? '').trim();
    if (!title) return [];

    const symbol = String(item.symbol ?? '').trim();
    const url = String(item.attchmntFile ?? '').trim();
    const publishedAt = safeIsoDate(item.sort_date ?? item.an_dt ?? item.exchdisstime, fetchedAt);

    return [{
      sourceId:    'official_exchange' as const,
      externalId:  `nse-${item.seq_id ?? item.dt ?? idx}`,
      title,
      body:        String(item.desc ?? '').trim() || null,
      url,
      publishedAt,
      fetchedAt,
      rawMeta:     {
        source:     'nse_api',
        feedFormat: 'json',
        symbol,
        company:    item.sm_name ?? null,
      },
    }];
  });
}

function parseBseAnnouncements(json: unknown, fetchedAt: string, limit: number): RawNewsItem[] {
  const table = (json as { Table?: unknown[] })?.Table;
  if (!Array.isArray(table)) return [];

  return table.slice(0, limit).flatMap((item, idx) => {
    const row = item as Record<string, unknown>;
    const title = String(row.NEWSSUB ?? row.HEADLINE ?? '').trim();
    if (!title) return [];

    const publishedAt = safeIsoDate(row.DissemDT ?? row.NEWS_DT ?? row.DT_TM, fetchedAt);
    const scripCode = String(row.SCRIP_CD ?? '').trim();

    return [{
      sourceId:    'official_exchange' as const,
      externalId:  `bse-${row.NEWSID ?? row.XML_NAME ?? idx}`,
      title,
      body:        String(row.HEADLINE ?? row.MORE ?? '').trim() || null,
      url:         String(row.NSURL ?? '').trim(),
      publishedAt,
      fetchedAt,
      rawMeta:     {
        source:     'bse_api',
        feedFormat: 'json',
        scripCode,
        company:    row.SLONGNAME ?? null,
        category:   row.CATEGORYNAME ?? null,
      },
    }];
  });
}

function parseFeedResponse(
  exchange: ExchangeFeed,
  text: string,
  fetchedAt: string,
  limit: number,
): RawNewsItem[] {
  const trimmed = text.trim();

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const json = JSON.parse(trimmed) as unknown;
      if (exchange === 'bse') return parseBseAnnouncements(json, fetchedAt, limit);
      if (Array.isArray(json)) return parseNseAnnouncements(json, fetchedAt, limit);
      if (exchange === 'nse' && Array.isArray((json as { data?: unknown[] }).data)) {
        return parseNseAnnouncements((json as { data: unknown[] }).data, fetchedAt, limit);
      }
    } catch (err) {
      log.error('Exchange feed JSON parse failed', {
        exchange,
        error: (err as Error).message,
      });
      return [];
    }
  }

  if (/<rss|<feed|<item/i.test(trimmed)) {
    return parseRssItems(trimmed, fetchedAt, limit);
  }

  log.warn('Exchange feed format not recognized', {
    exchange,
    preview: trimmed.slice(0, 120),
  });
  return [];
}

function safeIsoDate(raw: unknown, fallback: string): string {
  if (!raw) return fallback;
  const d = new Date(String(raw));
  return Number.isFinite(d.getTime()) ? d.toISOString() : fallback;
}

/** Test/validation helper — parse a fetched exchange payload in-process. */
export function parseExchangeFeedText(
  exchange: ExchangeFeed,
  text: string,
  limit = 15,
): RawNewsItem[] {
  return parseFeedResponse(exchange, text, new Date().toISOString(), limit);
}

/**
 * Official exchange announcements adapter.
 * Fetches corporate announcements from BSE/NSE RSS or JSON APIs.
 */
export const officialExchangeAdapter: NewsAdapter = {
  sourceId: 'official_exchange',

  async fetch(_query: string, limit = 15): Promise<RawNewsItem[]> {
    const feeds = getConfiguredFeeds();
    if (!feeds.length) return [];

    const items: RawNewsItem[] = [];
    const fetchedAt = new Date().toISOString();
    const perFeedLimit = Math.max(1, Math.ceil(limit / feeds.length));

    for (const feed of feeds) {
      try {
        const response = await fetchExchangeFeed(feed.exchange, feed.url);
        if (!response) continue;

        const parsed = parseFeedResponse(
          feed.exchange,
          response.text,
          fetchedAt,
          perFeedLimit,
        );

        if (!parsed.length) {
          log.warn('Exchange feed parsed zero items', {
            exchange: feed.exchange,
            url: response.resolvedUrl,
          });
        } else {
          log.info('Exchange feed ingested', {
            exchange: feed.exchange,
            count: parsed.length,
            url: response.resolvedUrl,
          });
        }

        items.push(...parsed);
      } catch (err) {
        log.warn('Exchange feed fetch failed', {
          exchange: feed.exchange,
          error: (err as Error).message,
        });
      }
    }

    return items.slice(0, limit);
  },
};

/**
 * Corporate filings adapter.
 * Fetches from a configured corporate filings/disclosures endpoint.
 *
 * Premium integration — disabled until CORPORATE_FILINGS_API_URL is set.
 * Onboarding: docs/PREMIUM_NEWS_FEEDS.md
 * TODO(provider): add CORPORATE_FILINGS_API_KEY / vendor auth when the
 * chosen filings vendor requires it.
 */
export const corporateFilingsAdapter: NewsAdapter = {
  sourceId: 'corporate_filings',

  async fetch(query: string, limit = 15): Promise<RawNewsItem[]> {
    const filingsUrl = process.env.CORPORATE_FILINGS_API_URL?.trim();
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
    } catch (err) {
      log.warn('Corporate filings fetch failed', { error: (err as Error).message });
      return [];
    }
  },
};
