import { NextRequest, NextResponse } from 'next/server';
import { requireSession, requireAdmin } from '@/lib/session';
import { db } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/redis';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

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

    const published_at = pubDate ? new Date(pubDate).toISOString() : new Date().toISOString();

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

// ── GET ───────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try { await requireSession(); } catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const catId    = searchParams.get('category_id');
  const featured = searchParams.get('featured');
  const limit    = Math.min(parseInt(searchParams.get('limit') || '40'), 100);

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
