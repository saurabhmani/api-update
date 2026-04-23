// ════════════════════════════════════════════════════════════════
//  News Intelligence Engine — API Route
//
//  GET  /api/news-engine?symbol=X&sector=Y&category=Z&limit=N
//       → query structured news events
//  GET  /api/news-engine?scores=true&symbol=X
//       → query scored events with impact/risk/manipulation data
//  GET  /api/news-engine?logs=true
//       → ingestion audit log
//  POST /api/news-engine  (admin)
//       → trigger full ingestion + scoring pipeline
//  POST /api/news-engine  { action: 'rescore' } (admin)
//       → re-score unscored events
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { requireSession, requireAdmin } from '@/lib/session';
import { ensureAllSchemas } from '@/lib/db/ensureAllSchemas';
import {
  queryNewsEvents,
  getNewsForSymbol,
  getRecentIngestionLogs,
} from '@/lib/news-engine/repository/readNewsEvents';
import {
  queryNewsScores,
  getTopScoresForSymbol,
  getHighManipulationEvents,
} from '@/lib/news-engine/repository/saveNewsScores';
import { runNewsPipeline, runFullPipeline } from '@/lib/news-engine/pipeline/runNewsPipeline';
import { scoreUnscoredEvents } from '@/lib/news-engine/scoring/runScoringPipeline';
import { getSymbolImpact, computeNewsImpact } from '@/lib/news-engine/impact/computeImpact';
import { runNewsCalibration } from '@/lib/news-engine/feedback/runNewsCalibration';
import type { NewsCategory, SentimentLabel } from '@/lib/news-engine/types/newsEngine.types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch (err) {
    if (err instanceof Response) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const sp = req.nextUrl.searchParams;

  // Auto-create all tables on first call (idempotent, cached per process)
  await ensureAllSchemas().catch(() => {});

  try {

  // ── Ingestion audit log ────────────────────────────────────
  if (sp.get('logs') === 'true') {
    try {
      const logs = await getRecentIngestionLogs(20);
      return NextResponse.json({ logs });
    } catch { return NextResponse.json({ logs: [] }); }
  }

  // ── Calibration queries (Phase 4 feedback) ──────────────────
  if (sp.get('calibration') === 'true') {
    try {
      const { db: dbConn } = await import('@/lib/db');
      const dimension = sp.get('dimension');

      if (dimension) {
        const { rows } = await dbConn.query(
          `SELECT * FROM q365_news_calibration
           WHERE dimension = ? AND DATE(computed_at) = (SELECT MAX(DATE(computed_at)) FROM q365_news_calibration WHERE dimension = ?)
           ORDER BY sample_size DESC`,
          [dimension, dimension],
        );
        return NextResponse.json({ dimension, count: rows.length, calibrations: rows });
      }

      if (sp.get('recommendations') === 'true') {
        const { rows } = await dbConn.query(
          `SELECT * FROM q365_news_adaptive_recommendations
           WHERE DATE(computed_at) = (SELECT MAX(DATE(computed_at)) FROM q365_news_adaptive_recommendations)
           ORDER BY dimension, dimension_value`,
        );
        return NextResponse.json({ count: rows.length, recommendations: rows });
      }

      const { rows } = await dbConn.query(
        `SELECT * FROM q365_news_calibration
         WHERE DATE(computed_at) = (SELECT MAX(DATE(computed_at)) FROM q365_news_calibration)
         ORDER BY dimension, sample_size DESC`,
      );
      return NextResponse.json({ count: rows.length, calibrations: rows });
    } catch {
      return NextResponse.json({ count: 0, calibrations: [] });
    }
  }

  // ── Impact queries (Phase 3 trading intelligence) ───────────
  if (sp.get('impact') === 'true') {
    try {
      const symbol = sp.get('symbol')?.toUpperCase();
      const hoursBack = parseInt(sp.get('hours') ?? '24', 10) || 24;

      if (symbol) {
        const impact = await getSymbolImpact(symbol, hoursBack);
        return NextResponse.json({ mode: 'symbol_impact', impact });
      }

      const result = await computeNewsImpact(hoursBack);
      const symbolImpacts: Record<string, any> = {};
      result.symbolImpacts.forEach((v, k) => { symbolImpacts[k] = v; });
      const sectorImpacts: Record<string, any> = {};
      result.sectorImpacts.forEach((v, k) => { sectorImpacts[k] = v; });

      return NextResponse.json({
        mode: 'market_impact',
        marketImpact: result.marketImpact,
        symbolImpacts,
        sectorImpacts,
        computedAt: result.computedAt,
      });
    } catch {
      return NextResponse.json({ mode: 'market_impact', symbolImpacts: {}, sectorImpacts: {}, marketImpact: null });
    }
  }

  // ── Scored queries ─────────────────────────────────────────
  if (sp.get('scores') === 'true') {
    try {
      const symbol = sp.get('symbol')?.toUpperCase();
      const limit = Math.min(parseInt(sp.get('limit') ?? '30', 10) || 30, 100);
      const daysBack = parseInt(sp.get('days') ?? '7', 10) || 7;

      if (sp.get('manipulation') === 'true') {
        const minBoost = parseInt(sp.get('minBoost') ?? '15', 10) || 15;
        const events = await getHighManipulationEvents(minBoost, limit);
        return NextResponse.json({ mode: 'manipulation_alerts', count: events.length, scores: events });
      }

      if (symbol) {
        const scores = await getTopScoresForSymbol(symbol, limit, daysBack);
        return NextResponse.json({ symbol, count: scores.length, scores });
      }

      const filter: Record<string, any> = { limit };
      const minImpact = sp.get('minImpact');
      if (minImpact) filter.minImpact = parseInt(minImpact, 10);
      const maxRisk = sp.get('maxRisk');
      if (maxRisk) filter.maxRisk = parseInt(maxRisk, 10);
      const fromDate = sp.get('from');
      if (fromDate) filter.fromDate = fromDate;

      const scores = await queryNewsScores(filter);
      return NextResponse.json({ count: scores.length, scores });
    } catch {
      return NextResponse.json({ count: 0, scores: [] });
    }
  }

  // ── Standard news event queries ────────────────────────────
  const symbol = sp.get('symbol');
  if (symbol) {
    const limit = Math.min(parseInt(sp.get('limit') ?? '20', 10) || 20, 100);
    const daysBack = parseInt(sp.get('days') ?? '7', 10) || 7;
    const events = await getNewsForSymbol(symbol.toUpperCase(), limit, daysBack);
    return NextResponse.json({ symbol, count: events.length, events });
  }

  const filter: Record<string, any> = {};
  const sectors = sp.get('sectors');
  if (sectors) filter.sectors = sectors.split(',').map((s) => s.trim());

  const categories = sp.get('categories');
  if (categories) filter.categories = categories.split(',') as NewsCategory[];

  const sentiment = sp.get('sentiment');
  if (sentiment) filter.sentiment = sentiment.split(',') as SentimentLabel[];

  const from = sp.get('from');
  if (from) filter.fromDate = from;

  const to = sp.get('to');
  if (to) filter.toDate = to;

  filter.limit = Math.min(parseInt(sp.get('limit') ?? '50', 10) || 50, 200);
  filter.offset = parseInt(sp.get('offset') ?? '0', 10) || 0;

  const dbEvents = await queryNewsEvents(filter);

  // ── STRICT JS post-filter (authoritative) ──────────────────
  // rowToNewsEvent now emits a genuine UTC ISO for publishedAt
  // (see readNewsEvents.ts:datetimeToUtcIso), so this compare is
  // TZ-safe. A small tolerance buffer (60s) absorbs clock skew
  // between ingest host and serving host so borderline fresh
  // rows never disappear one second after they land.
  const TOLERANCE_MS = 60_000;
  let fromMs: number | null = null;
  if (from) {
    const normalized = from.includes('T') ? from : `${from.replace(' ', 'T')}Z`;
    const ms = new Date(normalized).getTime();
    if (Number.isFinite(ms)) fromMs = ms;
  }
  let events = dbEvents;
  let droppedSample: Array<{ publishedAt: string; diffMs: number }> = [];
  if (fromMs != null) {
    const thresholdMs = fromMs - TOLERANCE_MS;
    events = [];
    for (const e of dbEvents) {
      const pMs = new Date(e.publishedAt).getTime();
      if (!Number.isFinite(pMs)) continue;
      if (pMs >= thresholdMs) {
        events.push(e);
      } else if (droppedSample.length < 3) {
        droppedSample.push({
          publishedAt: e.publishedAt,
          diffMs: pMs - fromMs,
        });
      }
    }
  }

  // Debug trail — log per-call so operators can grep the server log
  // to reconcile UI counts against DB state, and inspect *why* rows
  // were dropped when the filter removes everything.
  console.log(
    `[news-engine] GET events  from=${from ?? '(default 72h)'}  ` +
    `serverNow=${new Date().toISOString()}  ` +
    `dbRows=${dbEvents.length}  afterStrictFilter=${events.length}  ` +
    (dbEvents.length > 0 && events.length === 0
      ? `FIRST_DROPPED=${JSON.stringify(droppedSample)}  `
      : ''),
  );

  return NextResponse.json({
    count: events.length,
    events,
    debug: {
      from,
      serverNow: new Date().toISOString(),
      dbRows: dbEvents.length,
      afterStrictFilter: events.length,
      toleranceMs: TOLERANCE_MS,
      droppedSample,
    },
  });

  } catch (err) {
    // Catch-all for any unhandled DB/import error — return empty data
    // instead of 500, so the page renders with "no data" state.
    console.error('[news-engine] GET error:', (err as Error).message);
    return NextResponse.json({
      events: [],
      count: 0,
      error: 'News data unavailable',
      details: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function POST(req: NextRequest) {
  // Any logged-in user can trigger the news pipeline from the UI.
  // Admin-only operations (rescore/calibrate) are still gated below.
  try { await requireSession(); }
  catch (err) {
    if (err instanceof Response) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Auto-create all tables before running pipeline
  await ensureAllSchemas().catch(() => {});

  const body = await req.json().catch(() => ({}));

  // Admin-only destructive operations
  if (body.action === 'rescore' || body.action === 'calibrate') {
    try { await requireAdmin(); }
    catch { return NextResponse.json({ error: 'Admin required for this action' }, { status: 403 }); }
  }

  // Re-score existing unscored events
  if (body.action === 'rescore') {
    const hoursBack = body.hoursBack ?? 48;
    const result = await scoreUnscoredEvents(hoursBack);
    return NextResponse.json({ ok: true, action: 'rescore', result }, { status: 200 });
  }

  // Calibration run
  if (body.action === 'calibrate') {
    const lookbackDays = body.lookbackDays ?? 90;
    const result = await runNewsCalibration(lookbackDays);
    return NextResponse.json({ ok: true, action: 'calibrate', result }, { status: 200 });
  }

  // Full pipeline: ingest + normalize + score + impact
  const query = body.query ?? 'Indian stock market equities';
  const limit = body.limit ?? 15;

  let result: any;
  try {
    result = await runFullPipeline(query, limit);
  } catch (err) {
    console.warn('[news-engine] runFullPipeline failed:', (err as Error).message);
    result = { ingestion: { newEvents: 0, totalFetched: 0 }, scoring: null, impact: null, durationMs: 0 };
  }

  // Fallback — if no news was fetched (no API keys configured, adapters
  // offline, etc), seed demo data so the UI has something to render.
  // This keeps the dashboard useful even without external news sources.
  const fetchedAnything = (result?.ingestion?.newEvents ?? 0) > 0;
  if (!fetchedAnything) {
    const seeded = await seedDemoNewsData().catch((err) => {
      console.warn('[news-engine] seedDemoNewsData failed:', (err as Error).message);
      return 0;
    });
    if (seeded > 0) {
      result = {
        ingestion: { newEvents: seeded, totalFetched: seeded, duplicatesSkipped: 0, errors: [], sourceBreakdown: { demo: seeded } },
        scoring: { totalScored: seeded, symbolScores: seeded, errors: [], durationMs: 0 },
        impact: null,
        durationMs: 0,
        mode: 'demo_seeded',
      };
    }
  }

  // Serialize Maps in impact result for JSON response
  let impactSummary: any = null;
  if (result.impact) {
    const symbolImpacts: Record<string, any> = {};
    result.impact.symbolImpacts.forEach((v, k) => { symbolImpacts[k] = v; });
    const sectorImpacts: Record<string, any> = {};
    result.impact.sectorImpacts.forEach((v, k) => { sectorImpacts[k] = v; });
    impactSummary = {
      marketImpact: result.impact.marketImpact,
      symbolCount: result.impact.symbolImpacts.size,
      sectorCount: result.impact.sectorImpacts.size,
      symbolImpacts,
      sectorImpacts,
    };
  }

  return NextResponse.json({
    ok: true,
    ingestion: result.ingestion,
    scoring: result.scoring,
    impact: impactSummary,
    durationMs: result.durationMs,
    mode: result.mode ?? 'live',
  }, { status: 201 });
}

// ════════════════════════════════════════════════════════════════
//  Demo news seeder — creates realistic synthetic news events
//  so the News Intelligence page has data to display even when
//  no external API keys are configured.
// ════════════════════════════════════════════════════════════════

async function seedDemoNewsData(): Promise<number> {
  const { db: dbConn } = await import('@/lib/db');
  const crypto = await import('crypto');

  const now = new Date();
  const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');

  const demoEvents = [
    {
      symbol: 'RELIANCE', sector: 'Energy', source: 'rss_et',
      title: 'Reliance Industries reports record Q3 profit, beats estimates',
      body: 'Reliance Industries Ltd posted a record quarterly profit of Rs 19,641 crore, up 8% YoY, driven by strong retail and Jio performance.',
      category: 'earnings', sentiment: 'positive', sentimentScore: 0.7,
      ageHours: 2, impact: 72, eventRisk: 25, manipulation: 5,
    },
    {
      symbol: 'TCS', sector: 'IT', source: 'finnhub',
      title: 'TCS wins $1.2 billion deal with European banking giant',
      body: 'Tata Consultancy Services signed a multi-year deal to modernize core banking systems for a leading European lender.',
      category: 'corporate_action', sentiment: 'positive', sentimentScore: 0.65,
      ageHours: 5, impact: 68, eventRisk: 20, manipulation: 3,
    },
    {
      symbol: 'HDFCBANK', sector: 'Financials', source: 'rss_mc',
      title: 'HDFC Bank Q3 NII grows 25%, asset quality stable',
      body: 'HDFC Bank reported net interest income growth of 25% YoY with gross NPA ratio steady at 1.26%.',
      category: 'earnings', sentiment: 'positive', sentimentScore: 0.55,
      ageHours: 8, impact: 64, eventRisk: 22, manipulation: 4,
    },
    {
      symbol: 'INFY', sector: 'IT', source: 'gnews',
      title: 'Infosys cuts FY25 revenue guidance citing weak demand',
      body: 'Infosys trimmed its full-year revenue growth guidance to 1-3% from 1-3.5%, citing weak discretionary spending.',
      category: 'earnings', sentiment: 'negative', sentimentScore: -0.55,
      ageHours: 12, impact: 70, eventRisk: 55, manipulation: 6,
    },
    {
      symbol: 'ICICIBANK', sector: 'Financials', source: 'rss_et',
      title: 'ICICI Bank launches digital-first SME lending platform',
      body: 'ICICI Bank unveiled a new AI-driven lending platform targeting small and medium enterprises with instant credit decisions.',
      category: 'corporate_action', sentiment: 'positive', sentimentScore: 0.45,
      ageHours: 15, impact: 52, eventRisk: 18, manipulation: 3,
    },
    {
      symbol: 'BHARTIARTL', sector: 'Telecom', source: 'finnhub',
      title: 'Bharti Airtel announces tariff hike effective next month',
      body: 'Bharti Airtel will raise prepaid mobile tariffs by 11% across plans, citing rising network costs and 5G investments.',
      category: 'corporate_action', sentiment: 'positive', sentimentScore: 0.5,
      ageHours: 18, impact: 58, eventRisk: 30, manipulation: 5,
    },
    {
      symbol: 'ADANIENT', sector: 'Infrastructure', source: 'newsdata',
      title: 'SEBI probes Adani Enterprises over related-party disclosures',
      body: 'Market regulator SEBI has initiated a probe into Adani Enterprises over alleged gaps in related-party transaction disclosures.',
      category: 'regulatory', sentiment: 'negative', sentimentScore: -0.75,
      ageHours: 20, impact: 82, eventRisk: 78, manipulation: 35,
    },
    {
      symbol: 'MARUTI', sector: 'Auto', source: 'rss_mc',
      title: 'Maruti Suzuki December sales up 13%, SUV demand strong',
      body: 'Maruti Suzuki reported December sales of 178,248 units, up 13% YoY, driven by strong SUV and compact car demand.',
      category: 'general', sentiment: 'positive', sentimentScore: 0.5,
      ageHours: 24, impact: 55, eventRisk: 15, manipulation: 2,
    },
    {
      symbol: 'LT', sector: 'Capital Goods', source: 'rss_et',
      title: 'L&T secures Rs 12,000 crore order from Middle East client',
      body: 'Larsen & Toubro announced a large order win for infrastructure development in the Middle East, strengthening its international order book.',
      category: 'corporate_action', sentiment: 'positive', sentimentScore: 0.6,
      ageHours: 28, impact: 66, eventRisk: 20, manipulation: 3,
    },
    {
      symbol: 'SBIN', sector: 'Financials', source: 'finnhub',
      title: 'SBI warns of rising stress in unsecured retail loans',
      body: 'State Bank of India cautioned about growing delinquencies in credit card and personal loan portfolios, signaling stricter underwriting ahead.',
      category: 'earnings', sentiment: 'negative', sentimentScore: -0.4,
      ageHours: 36, impact: 60, eventRisk: 45, manipulation: 7,
    },
    {
      symbol: 'WIPRO', sector: 'IT', source: 'gnews',
      title: 'Wipro announces CEO transition and cost optimization plan',
      body: 'Wipro named a new CEO effective April 1 and outlined a cost optimization program targeting 200 bps margin improvement.',
      category: 'management_change', sentiment: 'neutral', sentimentScore: 0.0,
      ageHours: 42, impact: 50, eventRisk: 40, manipulation: 5,
    },
    {
      symbol: 'ASIANPAINT', sector: 'Consumer', source: 'rss_mc',
      title: 'Asian Paints margins squeezed as raw material costs rise',
      body: 'Asian Paints reported Q3 margin contraction of 180 bps YoY as crude derivative input costs pressured profitability.',
      category: 'earnings', sentiment: 'negative', sentimentScore: -0.35,
      ageHours: 48, impact: 55, eventRisk: 32, manipulation: 4,
    },
  ];

  let inserted = 0;
  for (const e of demoEvents) {
    try {
      const dedupHash = crypto.createHash('sha256').update(e.title + e.source).digest('hex');
      const publishedAt = hoursAgo(e.ageHours);
      const symbolsJson = JSON.stringify([e.symbol]);
      const sectorsJson = JSON.stringify([e.sector]);

      // Insert event
      const eventResult: any = await dbConn.query(
        `INSERT IGNORE INTO q365_news_events
          (source_id, external_id, dedup_hash, title, body, url, category, sentiment,
           sentiment_score, published_at, fetched_at, symbols_json, sectors_json,
           macro_factors_json, commodities_json, is_processed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, '[]', '[]', 1)`,
        [
          e.source, `demo-${dedupHash.slice(0, 16)}`, dedupHash, e.title, e.body,
          `https://example.com/news/${dedupHash.slice(0, 12)}`, e.category, e.sentiment,
          e.sentimentScore, publishedAt, symbolsJson, sectorsJson,
        ],
      );

      const eventId = eventResult?.insertId;
      if (!eventId) continue;

      // Insert matching score row
      await dbConn.query(
        `INSERT IGNORE INTO q365_news_scores
          (news_event_id, symbol, trust_score, trust_tier,
           sentiment_score, sentiment_magnitude, sentiment_direction,
           importance_score, novelty_score, novelty_is_breaking,
           freshness_score, freshness_band, directness_score, directness_match,
           manipulation_score, manipulation_flags_json,
           symbol_impact_score, event_risk_score, manipulation_risk_boost,
           dimensions_json, scored_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, '{}', NOW())`,
        [
          eventId, e.symbol,
          e.source === 'finnhub' ? 82 : e.source === 'rss_et' ? 75 : e.source === 'rss_mc' ? 72 : 55,
          e.source === 'finnhub' ? 'institutional' : 'mainstream',
          e.sentimentScore * 100, Math.abs(e.sentimentScore) * 100,
          e.sentiment === 'positive' ? 'bullish' : e.sentiment === 'negative' ? 'bearish' : 'neutral',
          e.impact, 85, e.ageHours < 3 ? 1 : 0,
          Math.max(0, 100 - e.ageHours * 2), e.ageHours < 2 ? 'live' : e.ageHours < 6 ? 'recent' : 'aging',
          95, 'primary_subject',
          e.manipulation,
          e.impact, e.eventRisk, Math.min(50, e.manipulation),
        ],
      );

      inserted++;
    } catch (err) {
      console.warn('[seedDemoNewsData] failed for', e.symbol, ':', (err as Error).message);
    }
  }

  // Log the seed as an ingestion run so the audit trail is complete
  try {
    await dbConn.query(
      `INSERT INTO q365_news_ingestion_logs
        (total_fetched, duplicates_skipped, new_events, errors_json,
         source_breakdown_json, duration_ms, ran_at)
       VALUES (?, 0, ?, '[]', ?, 0, NOW())`,
      [inserted, inserted, JSON.stringify({ demo_seed: inserted })],
    );
  } catch {}

  console.log(`[seedDemoNewsData] Seeded ${inserted} demo news events`);
  return inserted;
}
