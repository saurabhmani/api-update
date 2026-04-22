// ════════════════════════════════════════════════════════════════
//  News Normalization Layer
//
//  Transforms RawNewsItem → NewsEvent:
//  - Generates deterministic dedup hash
//  - Classifies category from title/body keywords
//  - Computes rule-based sentiment score
//  - Ensures all fields are structured before downstream use
// ════════════════════════════════════════════════════════════════

import { createHash } from 'crypto';
import type {
  RawNewsItem,
  NewsEvent,
  NewsCategory,
  SentimentLabel,
} from '../types/newsEngine.types';
import { resolveEntities } from '../entity-linking/entityResolver';

// ── Dedup Hash ───────────────────────────────────────────────────

function computeDedupHash(item: RawNewsItem): string {
  const normalized = (item.title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const payload = `${item.sourceId}|${normalized}`;
  return createHash('sha256').update(payload).digest('hex');
}

// ── Category Classification ──────────────────────────────────────

const CATEGORY_RULES: Array<{ pattern: RegExp; category: NewsCategory }> = [
  { pattern: /\b(earnings|quarterly results?|Q[1-4]\s*(FY)?|profit|revenue|net income|EPS|PAT)\b/i, category: 'earnings' },
  { pattern: /\b(merg|acqui|takeover|buyout|deal\s+value|stake\s+sale)\b/i, category: 'merger_acquisition' },
  { pattern: /\b(SEBI|regulator|compliance|penalty|ban|fine|show.?cause)\b/i, category: 'regulatory' },
  { pattern: /\b(RBI|repo\s+rate|CRR|SLR|monetary\s+policy|inflation|GDP|fiscal|budget|tax\s+reform)\b/i, category: 'macro_policy' },
  { pattern: /\b(crude|gold|silver|copper|aluminium|steel|commodity|Brent|WTI|natural\s+gas)\b/i, category: 'commodity' },
  { pattern: /\b(sector.*rotat|sector.*rally|Nifty\s+(IT|Bank|Pharma|Auto|Metal|Realty|FMCG)|sectoral)\b/i, category: 'sector_move' },
  { pattern: /\b(CEO|MD|chairman|appoint|resign|management\s+change|board\s+reshuffle)\b/i, category: 'management_change' },
  { pattern: /\b(insider|promoter|bulk\s+deal|block\s+deal|stake\s+increase|stake\s+decrease)\b/i, category: 'insider_trade' },
  { pattern: /\b(rating|upgrade|downgrade|CRISIL|ICRA|CARE|Moody|Fitch|S&P)\b/i, category: 'credit_rating' },
  { pattern: /\b(IPO|listing|grey\s+market|GMP|public\s+offer|FPO)\b/i, category: 'ipo_listing' },
  { pattern: /\b(Fed|ECB|Powell|Yellen|tariff|geopolitical|China|US\s+market|Wall\s+Street|Dow|Nasdaq|S&P\s+500)\b/i, category: 'global_cue' },
  { pattern: /\b(dividend|split|buyback|bonus|rights\s+issue|record\s+date)\b/i, category: 'corporate_action' },
];

function classifyCategory(title: string, body: string | null): NewsCategory {
  const text = `${title} ${body ?? ''}`;
  for (const rule of CATEGORY_RULES) {
    if (rule.pattern.test(text)) return rule.category;
  }
  return 'general';
}

// ── Sentiment Scoring ────────────────────────────────────────────
// Rule-based sentiment until an ML model is integrated.
// Score range: -1.0 (strongly negative) to +1.0 (strongly positive).

const POSITIVE_WORDS = new Set([
  'surge', 'rally', 'jump', 'gain', 'rise', 'bull', 'bullish', 'upbeat',
  'outperform', 'upgrade', 'beat', 'record', 'high', 'boom', 'optimistic',
  'growth', 'profit', 'dividend', 'buyback', 'strong', 'recovery', 'breakout',
  'positive', 'expansion', 'approve', 'exceed', 'robust', 'momentum',
]);

const NEGATIVE_WORDS = new Set([
  'crash', 'plunge', 'drop', 'fall', 'decline', 'bear', 'bearish', 'slump',
  'loss', 'downgrade', 'miss', 'low', 'bust', 'pessimistic', 'weak',
  'default', 'penalty', 'fraud', 'scam', 'ban', 'warning', 'risk',
  'correction', 'sell-off', 'selloff', 'negative', 'contraction', 'reject',
  'debt', 'concern', 'fear', 'recession', 'crisis', 'fail',
]);

function scoreSentiment(title: string, body: string | null): { label: SentimentLabel; score: number } {
  const text = `${title} ${body ?? ''}`.toLowerCase();
  const words = text.split(/\W+/).filter(Boolean);

  let positiveCount = 0;
  let negativeCount = 0;

  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) positiveCount++;
    if (NEGATIVE_WORDS.has(w)) negativeCount++;
  }

  const total = positiveCount + negativeCount;
  if (total === 0) return { label: 'neutral', score: 0 };

  const rawScore = (positiveCount - negativeCount) / total;
  // Clamp to [-1, 1]
  const score = Math.max(-1, Math.min(1, rawScore));

  let label: SentimentLabel;
  if (score >= 0.5) label = 'strongly_positive';
  else if (score > 0.1) label = 'positive';
  else if (score > -0.1) label = 'neutral';
  else if (score > -0.5) label = 'negative';
  else label = 'strongly_negative';

  return { label, score: Math.round(score * 1000) / 1000 };
}

// ── Main Normalizer ──────────────────────────────────────────────

export function normalizeRawItem(raw: RawNewsItem): NewsEvent {
  const dedupHash = computeDedupHash(raw);
  const category = classifyCategory(raw.title, raw.body);
  const { label: sentiment, score: sentimentScore } = scoreSentiment(raw.title, raw.body);
  const entities = resolveEntities(raw.title, raw.body, raw.rawMeta);

  const symbols: string[] = [];
  const sectors: string[] = [];
  const macroFactors: string[] = [];
  const commodities: string[] = [];

  for (const e of entities) {
    switch (e.entityType) {
      case 'symbol':       symbols.push(e.entityValue); break;
      case 'sector':       sectors.push(e.entityValue); break;
      case 'macro_factor': macroFactors.push(e.entityValue); break;
      case 'commodity':    commodities.push(e.entityValue); break;
    }
  }

  return {
    sourceId:       raw.sourceId,
    externalId:     raw.externalId,
    dedupHash,
    title:          raw.title,
    body:           raw.body,
    url:            raw.url,
    category,
    sentiment,
    sentimentScore,
    publishedAt:    raw.publishedAt,
    fetchedAt:      raw.fetchedAt,
    entities,
    symbols:        [...new Set(symbols)],
    sectors:        [...new Set(sectors)],
    macroFactors:   [...new Set(macroFactors)],
    commodities:    [...new Set(commodities)],
    isProcessed:    true,
  };
}

/**
 * Batch normalize an array of raw items.
 */
export function normalizeAll(items: RawNewsItem[]): NewsEvent[] {
  return items.map(normalizeRawItem);
}
