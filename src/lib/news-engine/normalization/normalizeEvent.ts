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
// Rule-based sentiment. Two-pass design:
//   1. Phrase pass — matches multi-word expressions that a single-word
//      tokenizer cannot resolve. "profit fall", "sell-off", "miss
//      estimates", "buy recommendation" are the exact cases the user
//      reported wrong. Phrases carry ±2 weight — a phrase outweighs a
//      solitary opposite-polarity word. Without this pass, "profit
//      fall" became [profit, fall] → pos=1 neg=1 → neutral. Wrong.
//   2. Word pass — single-token scan, each hit carries ±1.
//
// Final tier rule — uses ABSOLUTE net signal, not normalized ratio.
// Previously `total = pos+neg` was the denominator, so a headline
// with one positive word and zero negative got ratio=1.0 → strongly_
// positive. That's why the DB over-produced strongly_positive.
// Now: strongly_* requires net >= 3 net signal strength; milder
// labels otherwise.
//
// Score range kept at [-1, 1] for downstream consumers, but it's now
// `clamp(net / 5, -1, 1)` — meaning you need ~5 net hits to saturate.

const POSITIVE_PHRASES: string[] = [
  // actions / recommendations
  'buy recommendation', 'buy rating', 'upgrade to buy', 'target raised',
  'price target raised', 'strong buy', 'overweight rating',
  // performance
  'record profit', 'record high', 'all-time high', 'beat estimates',
  'beat expectations', 'beat forecast', 'exceeds expectations',
  'better than expected', 'strong growth', 'robust growth', 'profit jump',
  'profit surge', 'profit rises', 'revenue jump', 'revenue surge',
  'sales growth', 'margin expansion', 'earnings beat',
  // market moves
  'hits record', 'hits high', 'breakout above', 'breaks out',
  'sharp rally', 'strong rally', 'bull run',
  // corporate
  'dividend hike', 'bonus issue', 'stock split announced', 'share buyback',
  'order win', 'new contract', 'acquisition completed',
];

const NEGATIVE_PHRASES: string[] = [
  // performance drops
  'profit fall', 'profit falls', 'profit drop', 'profit plunge',
  'profit slump', 'profit miss', 'profit warning', 'earnings miss',
  'revenue fall', 'revenue miss', 'revenue decline', 'sales drop',
  'sales fall', 'margin pressure', 'margin compression', 'margin squeeze',
  'miss estimates', 'miss expectations', 'miss forecast',
  'worse than expected', 'below estimates', 'below expectations',
  // actions / recommendations
  'sell recommendation', 'sell rating', 'downgrade to sell',
  'target cut', 'target lowered', 'underweight rating', 'price target cut',
  // market moves
  'sell-off', 'sell off', 'heavy selling', 'sharp fall', 'sharp decline',
  'sharp drop', 'stock plunge', 'stock crash', 'shares tumble',
  'shares fall', 'shares drop', 'shares plunge', 'hits low', 'hits 52-week low',
  'bear market', 'bear run',
  // corporate / governance
  'dividend cut', 'debt concerns', 'debt burden', 'regulatory action',
  'sebi probe', 'sebi action', 'tax notice', 'fraud charge',
  'class action', 'insolvency', 'bankruptcy filing', 'going concern',
];

const POSITIVE_WORDS = new Set([
  'surge', 'rally', 'jump', 'gain', 'rise', 'bull', 'bullish', 'upbeat',
  'outperform', 'upgrade', 'beat', 'record', 'boom', 'optimistic',
  'growth', 'dividend', 'buyback', 'strong', 'recovery', 'breakout',
  'expansion', 'approve', 'exceed', 'robust', 'momentum',
]);
// `profit`, `positive`, `high` removed from single-word positives —
// too ambiguous without context. "profit fall" / "52-week high" /
// "positive news → no…" are common traps.

const NEGATIVE_WORDS = new Set([
  'crash', 'plunge', 'drop', 'fall', 'decline', 'bear', 'bearish', 'slump',
  'loss', 'downgrade', 'miss', 'bust', 'pessimistic', 'weak',
  'default', 'penalty', 'fraud', 'scam', 'ban', 'warning',
  'correction', 'selloff', 'negative', 'contraction', 'reject',
  'concern', 'recession', 'crisis', 'fail',
]);

function countPhraseHits(lowerText: string, phrases: string[]): number {
  let n = 0;
  for (const p of phrases) {
    if (lowerText.includes(p)) n++;
  }
  return n;
}

function scoreSentiment(title: string, body: string | null): { label: SentimentLabel; score: number } {
  const text  = `${title} ${body ?? ''}`.toLowerCase();
  const words = text.split(/\W+/).filter(Boolean);

  // Phrases weighted 2× — a phrase is a stronger signal than a
  // solitary opposite-polarity keyword (fixes "profit fall" neutral bug).
  const posPhrases = countPhraseHits(text, POSITIVE_PHRASES);
  const negPhrases = countPhraseHits(text, NEGATIVE_PHRASES);

  let posWords = 0;
  let negWords = 0;
  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) posWords++;
    if (NEGATIVE_WORDS.has(w)) negWords++;
  }

  const posSignal = posPhrases * 2 + posWords;
  const negSignal = negPhrases * 2 + negWords;
  const net       = posSignal - negSignal;
  const total     = posSignal + negSignal;

  if (total === 0) return { label: 'neutral', score: 0 };

  // Absolute-threshold tier rule. `strongly_*` requires at least
  // 3 net signal strength AND the opposite polarity must be weak
  // (at most 1/3 of the dominant polarity), so "great earnings but
  // slim margin risk" → positive, not strongly_positive.
  let label: SentimentLabel;
  const dominant    = Math.max(posSignal, negSignal);
  const opposite    = Math.min(posSignal, negSignal);
  const decisive    = dominant >= 3 && opposite <= dominant / 3;

  if (net >=  3 && decisive) label = 'strongly_positive';
  else if (net >=  1)        label = 'positive';
  else if (net <= -3 && decisive) label = 'strongly_negative';
  else if (net <= -1)        label = 'negative';
  else                        label = 'neutral';

  // Score in [-1, 1], saturating at ~5 net hits.
  const score = Math.max(-1, Math.min(1, net / 5));
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
