// ════════════════════════════════════════════════════════════════
//  Macro + News + Event Risk Context — Phase 4
// ════════════════════════════════════════════════════════════════

import type { MacroContext, NewsContext, EventRiskSnapshot, EventTag, MarketTone, RiskMode } from '../types/phase4.types';
import type { EnhancedMarketRegime } from '../types/signalEngine.types';

// ── Macro Context from Regime ───────────────────────────────

export function buildMacroContext(regime: EnhancedMarketRegime, sectorLeadership: string[] = []): MacroContext {
  const toneMap: Record<string, MarketTone> = {
    'Strong Bullish': 'strongly_constructive',
    'Bullish': 'constructive',
    'Sideways': 'neutral',
    'Weak': 'cautious',
    'Bearish': 'hostile',
    'High Volatility Risk': 'cautious',
  };

  const riskMap: Record<string, RiskMode> = {
    'Strong Bullish': 'risk_on',
    'Bullish': 'moderate_risk_on',
    'Sideways': 'neutral',
    'Weak': 'risk_off',
    'Bearish': 'risk_off',
    'High Volatility Risk': 'risk_off',
  };

  return {
    marketTone: toneMap[regime.label] || 'neutral',
    riskMode: riskMap[regime.label] || 'neutral',
    volatilityState: regime.volatilityRegime,
    sectorLeadership,
    macroEventProximity: 'none',
  };
}

// ── Default News Context (fallback when no news available) ──

export function defaultNewsContext(): NewsContext {
  return {
    bias: 'neutral',
    strength: 0,
    freshnessHours: 999,
    sourceConfidence: 0,
    eventTags: [],
    headline: null,
  };
}

// ── Live News Context (from RSS feeds via internal API) ─────

const BULLISH_KEYWORDS = ['rally', 'surge', 'soar', 'jump', 'gain', 'upgrade', 'bullish', 'record high', 'outperform', 'breakout', 'strong buy', 'beat estimate'];
const BEARISH_KEYWORDS = ['crash', 'plunge', 'drop', 'fall', 'downgrade', 'bearish', 'sell-off', 'selloff', 'warning', 'cut', 'miss estimate', 'default', 'fraud', 'scam'];
const EVENT_KEYWORDS: Record<string, EventTag> = {
  'earnings': 'earnings_within_3_days',
  'results': 'earnings_within_3_days',
  'quarterly': 'earnings_within_3_days',
  'rbi': 'policy_decision_today',
  'fed': 'policy_decision_today',
  'rate decision': 'policy_decision_today',
  'gdp': 'macro_data_release_today',
  'inflation': 'macro_data_release_today',
  'cpi': 'macro_data_release_today',
  'sebi': 'regulatory_decision',
  'dividend': 'corporate_action',
  'split': 'corporate_action',
  'buyback': 'corporate_action',
  'ceo': 'management_event',
  'resignation': 'management_event',
};

/**
 * Build NewsContext from actual news articles (legacy fallback path).
 * Pass an array of recent headlines/titles fetched from /api/news or RSS.
 *
 * NOTE: This is the legacy keyword-based fallback. When the news-engine
 * impact layer is active, buildSignalNewsContext() in signalIntegration.ts
 * produces the enriched context instead.
 *
 * All values normalized to 0-1 contract.
 */
export function buildNewsContext(articles: Array<{ title: string; published_at?: string; source?: string }>): NewsContext {
  if (!articles.length) return defaultNewsContext();

  let bullishCount = 0;
  let bearishCount = 0;
  const detectedTags: EventTag[] = [];
  const latestHeadline = articles[0]?.title ?? null;

  for (const article of articles) {
    const lower = (article.title ?? '').toLowerCase();
    for (const kw of BULLISH_KEYWORDS) { if (lower.includes(kw)) bullishCount++; }
    for (const kw of BEARISH_KEYWORDS) { if (lower.includes(kw)) bearishCount++; }
    for (const [kw, tag] of Object.entries(EVENT_KEYWORDS)) {
      if (lower.includes(kw) && !detectedTags.includes(tag)) detectedTags.push(tag);
    }
  }

  const total = bullishCount + bearishCount;
  const bias: NewsContext['bias'] = total === 0 ? 'neutral' : bullishCount > bearishCount * 1.5 ? 'positive' : bearishCount > bullishCount * 1.5 ? 'negative' : 'neutral';
  // Normalize to 0-1 (was 0-100 before)
  const strength = Math.min(1, total * 0.1);

  // Freshness from latest article
  let freshnessHours = 999;
  if (articles[0]?.published_at) {
    const diff = Date.now() - new Date(articles[0].published_at).getTime();
    freshnessHours = Math.round(diff / (1000 * 60 * 60));
  }

  // Normalize sourceConfidence to 0-1 (was 30/50/70 before)
  const sourceConfidence = articles.length >= 5 ? 0.7 : articles.length >= 2 ? 0.5 : 0.3;

  return {
    bias,
    strength,
    freshnessHours,
    sourceConfidence,
    eventTags: detectedTags,
    headline: latestHeadline,
  };
}

/**
 * Fetch real news context by calling the internal API.
 * Falls back to defaultNewsContext() on failure.
 *
 * When a symbol is provided, uses the news-engine impact layer
 * for scored, entity-linked intelligence (returns full enriched
 * NewsContext with symbolImpactScore, eventRiskScore, etc.).
 * Otherwise falls back to the legacy DB query.
 *
 * Returns the same enriched NewsContext shape regardless of path.
 * All values follow the 0-1 contract.
 */
export async function fetchLiveNewsContext(symbol?: string): Promise<NewsContext> {
  // ── Enriched path: use scored news intelligence ─────────────
  if (symbol) {
    try {
      const { enrichSignalWithNews } = await import('@/lib/news-engine/impact/signalIntegration');
      const result = await enrichSignalWithNews(symbol, 50, 50);
      // enrichSignalWithNews now returns the full enriched NewsContext
      // with symbolImpactScore, eventRiskScore, etc. — no stripping.
      return result.newsContext;
    } catch {
      // Fall through to legacy path
    }
  }

  // ── Legacy path: raw DB query ──────────────────────────────
  try {
    const { db } = await import('@/lib/db');

    // Try news-engine table first, then fall back to legacy `news` table
    let rows: any[] = [];
    try {
      const result = await db.query(
        `SELECT title, published_at FROM q365_news_events
         WHERE published_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
         ORDER BY published_at DESC LIMIT 20`,
      );
      rows = result.rows;
    } catch {
      const result = await db.query(
        `SELECT title, published_at FROM news
         WHERE is_published = TRUE AND published_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)
         ORDER BY published_at DESC LIMIT 20`,
      );
      rows = result.rows;
    }

    if (rows.length > 0) {
      return buildNewsContext(rows as any[]);
    }

    return defaultNewsContext();
  } catch {
    return defaultNewsContext();
  }
}

// ── Event Risk from Context ─────────────────────────────────

export function computeEventRisk(
  eventTags: EventTag[] = [],
  newsStrength = 0,
): EventRiskSnapshot {
  if (eventTags.length === 0 || (eventTags.length === 1 && eventTags[0] === 'none')) {
    return { eventRiskScore: 5, eventRiskBand: 'low', eventRiskPenalty: 0, eventTags: ['none'], comment: 'No significant events detected' };
  }

  let score = 10;
  const comments: string[] = [];

  for (const tag of eventTags) {
    switch (tag) {
      case 'earnings_within_3_days': score += 25; comments.push('Earnings approaching'); break;
      case 'policy_decision_today': score += 30; comments.push('Policy decision today'); break;
      case 'macro_data_release_today': score += 20; comments.push('Macro data release'); break;
      case 'regulatory_decision': score += 20; comments.push('Regulatory event'); break;
      case 'corporate_action': score += 15; comments.push('Corporate action'); break;
      case 'management_event': score += 12; comments.push('Management event'); break;
      case 'sudden_news_spike': score += 18; comments.push('News spike'); break;
    }
  }

  score = Math.min(100, score);
  const band = score > 60 ? 'high' as const : score > 40 ? 'elevated' as const : score > 20 ? 'moderate' as const : 'low' as const;
  const penalty = Math.min(10, Math.round(score / 10));

  return { eventRiskScore: score, eventRiskBand: band, eventRiskPenalty: penalty, eventTags, comment: comments.join('; ') || 'Minor event context' };
}
