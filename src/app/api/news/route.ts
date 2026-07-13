import { NextRequest, NextResponse } from 'next/server';
import { requireSession, requireAdmin } from '@/lib/session';
import { db } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/redis';
import { getCompanyNews } from '@/providers/MarketDataProvider';
import { fetchNews, fetchStockNews } from '@/services/newsService';
import { getNewsForSymbol } from '@/lib/news-engine/repository/readNewsEvents';
import { resolveInstrumentProfile } from '@/services/marketQuote';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

/** UI shape used by MarketDetail / StockDetail news tabs. */
interface StockNewsItem {
  id:            string | number;
  title:         string;
  summary?:      string | null;
  url:           string;
  published_at:  string;
  source:        string;
  category_name?: string;
  thumbnail?:    string | null;
  sentiment?:    string | null;
  symbol?:       string;
}

// ── RSS feeds ─────────────────────────────────────────────────────
const RSS_FEEDS = [
  { url: 'https://www.moneycontrol.com/rss/latestnews.xml',                     source: 'MoneyControl',       category: 'Markets' },
  { url: 'https://economictimes.indiatimes.com/markets/rss.cms',                source: 'Economic Times',      category: 'Markets' },
  { url: 'https://economictimes.indiatimes.com/news/economy/rss.cms',           source: 'Economic Times',      category: 'Economy' },
  { url: 'https://www.livemint.com/rss/markets',                                source: 'LiveMint',            category: 'Markets' },
  { url: 'https://www.business-standard.com/rss/markets-106.rss',               source: 'Business Standard',  category: 'Markets' },
];

interface RssItem {
  id:           string;
  title:        string;
  summary:      string;
  url:          string;
  published_at: string;
  source:       string;
  category_name:string;
  thumbnail:    string | null;
  is_featured:  boolean;
  is_rss:       boolean;
}

function extractTag(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*>(?:<\\!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'));
  return (m?.[1] ?? '').trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function extractAttr(xml: string, tag: string, attr: string): string {
  const m = xml.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i'));
  return m?.[1] ?? '';
}

// Safe ISO parser. Returns null when the input is missing or
// unparseable — caller decides whether to skip the article or use
// a fallback. The previous code called `.toISOString()` directly,
// which throws `RangeError: Invalid time value` on malformed RSS
// dates (some Indian feeds emit non-RFC2822 strings like
// "Jan 1, 2024 12:00" or a trailing BOM), killing the whole parse
// batch and leaving "Invalid Date" strings in downstream consumers
// that tried to catch and stringify the error.
function safeIsoDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  // Sanity window: reject dates > 2 days in the future and older
  // than 10 years — those are almost always parse artefacts
  // (year=0001, year=9999, etc.) rather than real news.
  const now = Date.now();
  if (ms > now + 2 * 24 * 3600 * 1000) return null;
  if (ms < now - 10 * 365 * 24 * 3600 * 1000) return null;
  return d.toISOString();
}

function parseRss(xml: string, source: string, category: string): RssItem[] {
  const items: RssItem[] = [];
  const itemMatches = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];

  for (const block of itemMatches) {
    const title = extractTag(block, 'title');
    const link  = extractTag(block, 'link') || extractAttr(block, 'link', 'href');
    const desc  = extractTag(block, 'description');
    const pubDate = extractTag(block, 'pubDate') || extractTag(block, 'dc:date') || extractTag(block, 'published');
    const enclosureUrl = extractAttr(block, 'enclosure', 'url');
    const mediaUrl     = extractAttr(block, 'media:content', 'url') || extractAttr(block, 'media:thumbnail', 'url');

    if (!title || !link) continue;

    // Strip HTML from description
    const summary = desc.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 300);

    // Skip articles with no meaningful content AND no valid date —
    // those are feed noise (empty `<item>` shells or malformed XML).
    // A real article is allowed to have an empty summary as long as
    // title + link + a parseable date are present.
    const parsedDate = safeIsoDate(pubDate);
    if (!parsedDate && !summary) continue;
    const published_at = parsedDate ?? new Date().toISOString();

    items.push({
      id:           Buffer.from(link).toString('base64').slice(0, 32),
      title:        title.slice(0, 200),
      summary,
      url:          link,
      published_at,
      source,
      category_name: category,
      thumbnail:    enclosureUrl || mediaUrl || null,
      is_featured:  false,
      is_rss:       true,
    });
  }
  return items;
}

async function fetchRssFeed(feed: typeof RSS_FEEDS[0]): Promise<RssItem[]> {
  try {
    const res = await fetch(feed.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept':     'application/rss+xml, application/xml, text/xml, */*',
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    return parseRss(xml, feed.source, feed.category);
  } catch {
    return [];
  }
}

async function fetchAllRssNews(limit = 40): Promise<RssItem[]> {
  const cacheKey = 'rss:news:all';
  const cached = await cacheGet<RssItem[]>(cacheKey);
  if (cached) return cached;

  const results = await Promise.allSettled(RSS_FEEDS.map(fetchRssFeed));
  const all: RssItem[] = [];
  for (const r of results) {
    if (r.status === 'fulfilled') all.push(...r.value);
  }

  // Sort by date desc, deduplicate by title similarity
  all.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());
  const seen = new Set<string>();
  const deduped = all.filter(item => {
    const key = item.title.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const news = deduped.slice(0, limit);
  if (news.length > 0) await cacheSet(cacheKey, news, 300); // 5-min cache
  return news;
}

function matchesSymbol(text: string, symbol: string, companyName?: string | null): boolean {
  const hay = text.toLowerCase();
  const sym = symbol.toLowerCase();
  if (hay.includes(sym)) return true;
  // Common spaced form: INDUSIND BK / IndusInd Bank style tokens for longer symbols
  if (sym.length >= 5 && hay.includes(sym.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())) return true;
  if (companyName) {
    const name = companyName.toLowerCase().trim();
    if (name.length >= 4 && hay.includes(name)) return true;
    // First significant word of company name (e.g. "IndusInd" from "IndusInd Bank Ltd")
    const first = name.split(/\s+/)[0];
    if (first.length >= 5 && hay.includes(first)) return true;
  }
  return false;
}

async function resolveCompanyName(symbol: string): Promise<string | null> {
  const profile = await resolveInstrumentProfile(symbol);
  if (profile.name && profile.name.toUpperCase() !== symbol.toUpperCase()) {
    return profile.name;
  }
  try {
    const { rows } = await db.query<{ name?: string }>(
      `SELECT name FROM instruments WHERE tradingsymbol = ? LIMIT 1`,
      [symbol],
    );
    return rows[0]?.name ? String(rows[0].name) : null;
  } catch {
    return null;
  }
}

function symbolNewsCacheKey(symbol: string): string {
  return `news:symbol-bundle:${symbol.toUpperCase()}`;
}

function dedupeNews(items: StockNewsItem[]): StockNewsItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.title.toLowerCase().slice(0, 60);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Symbol-specific news for stock / market detail pages.
 * Priority: news-engine DB → IndianAPI company news → GNews/NewsData → filtered RSS.
 */
async function fetchSymbolNews(
  symbol: string,
  limit: number,
  companyHint?: string | null,
): Promise<{
  news: StockNewsItem[];
  sources: Record<string, number>;
}> {
  const sym = symbol.toUpperCase();
  const companyName = (companyHint && companyHint.trim()) || (await resolveCompanyName(sym));
  const sources = { engine: 0, indianapi: 0, external: 0, rss: 0 };
  const merged: StockNewsItem[] = [];

  // 1) News-engine DB (already entity-linked to this symbol)
  try {
    const events = await getNewsForSymbol(sym, limit, 14);
    sources.engine = events.length;
    for (const e of events) {
      merged.push({
        id:           e.id ?? e.externalId,
        title:        e.title,
        summary:      e.body,
        url:          e.url || '#',
        published_at: e.publishedAt,
        source:       e.sourceId,
        category_name: e.category,
        sentiment:    e.sentiment ?? null,
        symbol:       sym,
      });
    }
  } catch { /* schema may be empty */ }

  // 2) IndianAPI /company_news
  if (merged.length < limit) {
    try {
      const res = await getCompanyNews(sym);
      const items = res.data ?? [];
      sources.indianapi = items.length;
      for (const n of items) {
        const title = String(n.headline ?? '').trim();
        if (!title) continue;
        const published = typeof n.publishedAt === 'number'
          ? new Date(n.publishedAt).toISOString()
          : new Date().toISOString();
        merged.push({
          id:           `ia-${Buffer.from(`${title}:${n.url ?? ''}`).toString('base64').slice(0, 24)}`,
          title,
          summary:      n.summary ?? null,
          url:          n.url || '#',
          published_at: published,
          source:       n.source ?? 'IndianAPI',
          symbol:       sym,
        });
      }
    } catch { /* quota / upstream unavailable */ }
  }

  // 3) External search (GNews / NewsData) with symbol + company query
  if (merged.length < limit) {
    try {
      const query = companyName
        ? `${sym} OR "${companyName}" stock India NSE`
        : `${sym} NSE India stock`;
      const items = companyName
        ? await fetchNews(query, limit)
        : await fetchStockNews(sym, limit);
      sources.external = items.length;
      for (const n of items) {
        const blob = `${n.title} ${n.description ?? ''}`;
        if (!matchesSymbol(blob, sym, companyName)) continue;
        merged.push({
          id:           n.id,
          title:        n.title,
          summary:      n.description,
          url:          n.url || '#',
          published_at: n.published_at,
          source:       n.source,
          sentiment:    n.sentiment ?? null,
          symbol:       sym,
        });
      }
    } catch { /* keys may be missing */ }
  }

  // 4) Last resort: market RSS filtered to symbol / company name
  if (merged.length < limit) {
    try {
      const rss = await fetchAllRssNews(80);
      const filtered = rss.filter((r) =>
        matchesSymbol(`${r.title} ${r.summary}`, sym, companyName),
      );
      sources.rss = filtered.length;
      for (const r of filtered) {
        merged.push({
          id:            r.id,
          title:         r.title,
          summary:       r.summary,
          url:           r.url,
          published_at:  r.published_at,
          source:        r.source,
          category_name: r.category_name,
          thumbnail:     r.thumbnail,
          symbol:        sym,
        });
      }
    } catch { /* silent */ }
  }

  const news = dedupeNews(merged)
    .sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime())
    .slice(0, limit);

  return { news, sources };
}

// ── GET ───────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try { await requireSession(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const catId    = searchParams.get('category_id');
  const featured = searchParams.get('featured');
  const limit    = Math.min(parseInt(searchParams.get('limit') || '40'), 100);
  // Stock/market detail pages pass symbol via `symbol` or `q`
  const rawSymbol = (searchParams.get('symbol') || searchParams.get('q') || '').trim();
  const symbol = rawSymbol
    ? (rawSymbol.includes('|') ? rawSymbol.split('|')[1] : rawSymbol).toUpperCase().replace(/[^A-Z0-9]/g, '')
    : '';
  const companyHint = searchParams.get('company');

  if (symbol) {
    const cacheKey = `news:symbol:${symbol}:${limit}`;
    const cached = await cacheGet<{ news: StockNewsItem[]; sources: Record<string, number> }>(cacheKey);
    if (cached?.news?.length) {
      return NextResponse.json({
        news: cached.news,
        symbol,
        count: cached.news.length,
        sources: cached.sources,
        from_cache: true,
      });
    }

    const { news, sources } = await fetchSymbolNews(symbol, limit, companyHint);
    if (news.length > 0) {
      await cacheSet(cacheKey, { news, sources }, 6 * 3600);
      await cacheSet(symbolNewsCacheKey(symbol), { news, sources }, 7 * 24 * 3600);
    } else {
      const stale = await cacheGet<{ news: StockNewsItem[]; sources: Record<string, number> }>(
        symbolNewsCacheKey(symbol),
      );
      if (stale?.news?.length) {
        return NextResponse.json({
          news: stale.news,
          symbol,
          count: stale.news.length,
          sources: stale.sources,
          from_cache: true,
          stale: true,
        });
      }
    }
    return NextResponse.json({
      news,
      symbol,
      count: news.length,
      sources,
      from_cache: false,
    });
  }

  // Try DB articles first
  let dbArticles: any[] = [];
  try {
    let query = `
      SELECT n.id, n.title, n.slug, n.summary, n.thumbnail,
             n.is_published, n.is_featured, n.published_at,
             nc.name AS category_name
      FROM news n
      LEFT JOIN news_categories nc ON nc.id = n.category_id
      WHERE n.is_published = TRUE
    `;
    const params: any[] = [];
    if (catId)            { params.push(catId); query += ` AND n.category_id = ?`; }
    if (featured === 'true') query += ` AND n.is_featured = TRUE`;
    params.push(limit);
    query += ` ORDER BY n.published_at DESC LIMIT ?`;
    const { rows } = await db.query(query, params);
    dbArticles = rows as any[];
  } catch {
    // Table may not exist yet — proceed to RSS fallback
  }

  // Fetch RSS news
  let rssArticles: RssItem[] = [];
  try {
    const allRss = await fetchAllRssNews(limit);
    // Filter by category name if requested
    rssArticles = catId ? [] : allRss; // RSS has no category_id filtering
  } catch { /* silent */ }

  // Merge: DB articles first (admin-published), then RSS
  const dbIds = new Set(dbArticles.map((a: any) => String(a.id)));
  const merged = [
    ...dbArticles,
    ...rssArticles.filter(r => !dbIds.has(r.id)),
  ].slice(0, limit);

  return NextResponse.json({ news: merged, rss_count: rssArticles.length, db_count: dbArticles.length });
}

// ── POST ──────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try { await requireAdmin(); } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }
  const body = await req.json();
  const { title, content, summary, thumbnail, category_id, is_published, is_featured } = body;
  if (!title) return NextResponse.json({ error: 'title required' }, { status: 400 });
  const slug         = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 200);
  const published_at = is_published ? new Date().toISOString() : null;
  const { rows } = await db.query(
    `INSERT INTO news (title, slug, content, summary, thumbnail, category_id, is_published, is_featured, published_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [title, slug, content, summary, thumbnail, category_id || null, !!is_published, !!is_featured, published_at]
  );
  return NextResponse.json({ article: rows[0] }, { status: 201 });
}

// ── PATCH ─────────────────────────────────────────────────────────
export async function PATCH(req: NextRequest) {
  try { await requireAdmin(); } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }
  const body = await req.json();
  const { id, title, content, summary, thumbnail, category_id, is_published, is_featured } = body;
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  const published_at = is_published ? new Date().toISOString() : null;
  await db.query(
    `UPDATE news SET title=?, content=?, summary=?, thumbnail=?, category_id=?,
     is_published=?, is_featured=?, published_at=?, updated_at=NOW() WHERE id=?`,
    [title, content, summary, thumbnail, category_id || null, !!is_published, !!is_featured, published_at, id]
  );
  return NextResponse.json({ success: true });
}

// ── DELETE ────────────────────────────────────────────────────────
export async function DELETE(req: NextRequest) {
  try { await requireAdmin(); } catch { return NextResponse.json({ error: 'Forbidden' }, { status: 403 }); }
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
  await db.query(`DELETE FROM news WHERE id=?`, [id]);
  return NextResponse.json({ success: true });
}
