// ════════════════════════════════════════════════════════════════
//  News Scoring Engine — 7 Individual Scorers
//
//  Each scorer takes a NewsEvent and returns a typed score object.
//  All scores are deterministic (no ML / no external calls).
//
//  Dimensions:
//    1. trustScore          — source reliability
//    2. sentimentScore      — directional sentiment (-100 to +100)
//    3. importanceScore     — material impact weight
//    4. noveltyScore        — is this genuinely new info?
//    5. freshnessScore      — time decay
//    6. directnessScore     — how directly it references a symbol
//    7. manipulationScore   — suspicion of manipulative intent
// ════════════════════════════════════════════════════════════════

import type { NewsEvent, NewsCategory } from '../types/newsEngine.types';
import type {
  TrustScore,
  SentimentDimensionScore,
  ImportanceScore,
  NoveltyScore,
  FreshnessScore,
  DirectnessScore,
  ManipulationSuspicionScore,
  ManipulationFlag,
} from '../types/scoring.types';
import { SOURCE_TRUST_CONFIG, CATEGORY_IMPORTANCE } from '../types/scoring.types';

// ════════════════════════════════════════════════════════════════
//  1. TRUST SCORER
// ════════════════════════════════════════════════════════════════

export function scoreTrust(event: NewsEvent): TrustScore {
  const config = SOURCE_TRUST_CONFIG[event.sourceId] ?? { baseTrust: 30, tier: 'unknown' as const };
  let score = config.baseTrust;
  const factors: string[] = [`base:${config.tier}(${config.baseTrust})`];

  // Boost for named/reputable sources embedded in rawMeta
  const hasUrl = !!event.url && event.url.startsWith('https');
  if (hasUrl) {
    score += 3;
    factors.push('+3:https_url');
  }

  // Penalty for very short body (low-effort aggregation)
  if (!event.body || event.body.length < 50) {
    score -= 10;
    factors.push('-10:thin_body');
  }

  // Boost for events with entities resolved (structured = more trustworthy)
  if (event.symbols.length > 0) {
    score += 5;
    factors.push('+5:has_symbols');
  }

  // Category-based trust modifier
  const highTrustCategories: NewsCategory[] = ['earnings', 'regulatory', 'credit_rating', 'corporate_action'];
  if (highTrustCategories.includes(event.category)) {
    score += 8;
    factors.push(`+8:high_trust_category(${event.category})`);
  }

  return {
    score: clamp(score, 0, 100),
    tier: config.tier,
    factors,
  };
}

// ════════════════════════════════════════════════════════════════
//  2. SENTIMENT SCORER (enhanced over Phase 1 normalizer)
// ════════════════════════════════════════════════════════════════

// Extended word lists with financial domain specificity
const STRONG_POS = new Set([
  'surge', 'soar', 'skyrocket', 'blockbuster', 'record-high', 'outperform',
  'breakout', 'boom', 'stellar', 'blowout', 'unprecedented',
]);
const MILD_POS = new Set([
  'rally', 'jump', 'gain', 'rise', 'bullish', 'upbeat', 'upgrade',
  'beat', 'high', 'optimistic', 'growth', 'profit', 'dividend',
  'buyback', 'strong', 'recovery', 'positive', 'expansion', 'approve',
  'exceed', 'robust', 'momentum', 'improve', 'boost', 'rebound',
]);
const STRONG_NEG = new Set([
  'crash', 'plunge', 'collapse', 'default', 'fraud', 'scam', 'bankrupt',
  'catastrophe', 'crisis', 'meltdown', 'wipeout', 'plummet',
]);
const MILD_NEG = new Set([
  'drop', 'fall', 'decline', 'bearish', 'slump', 'loss', 'downgrade',
  'miss', 'weak', 'penalty', 'ban', 'warning', 'risk', 'correction',
  'selloff', 'sell-off', 'negative', 'contraction', 'reject', 'debt',
  'concern', 'fear', 'recession', 'fail', 'cautious', 'slowdown',
  'underperform', 'disappoint', 'pressure', 'retreat',
]);

// Negation window: "not", "no", "don't" etc. flip the next sentiment word
const NEGATION_WORDS = new Set(['not', 'no', 'never', 'neither', 'nor', "don't", "doesn't", "didn't", "won't", "isn't", "aren't"]);

export function scoreSentiment(event: NewsEvent): SentimentDimensionScore {
  const text = `${event.title} ${event.body ?? ''}`.toLowerCase();
  const words = text.split(/\W+/).filter(Boolean);

  let rawScore = 0;
  let hitCount = 0;
  let negateNext = false;

  for (const w of words) {
    if (NEGATION_WORDS.has(w)) {
      negateNext = true;
      continue;
    }

    let wordVal = 0;
    if (STRONG_POS.has(w)) wordVal = 2;
    else if (MILD_POS.has(w)) wordVal = 1;
    else if (STRONG_NEG.has(w)) wordVal = -2;
    else if (MILD_NEG.has(w)) wordVal = -1;

    if (wordVal !== 0) {
      if (negateNext) wordVal = -wordVal * 0.5; // negation dampens rather than fully flips
      rawScore += wordVal;
      hitCount++;
    }

    negateNext = false;
  }

  // Normalize: max possible |score| is roughly 2*hitCount
  // Map to -100..+100 using sigmoid-like compression
  const maxMagnitude = Math.max(hitCount * 2, 1);
  const normalized = (rawScore / maxMagnitude) * 100;
  const score = clamp(Math.round(normalized), -100, 100);
  const magnitude = Math.abs(score);

  let direction: SentimentDimensionScore['direction'];
  if (score > 10) direction = 'bullish';
  else if (score < -10) direction = 'bearish';
  else direction = 'neutral';

  return { score, magnitude, wordHitCount: hitCount, direction };
}

// ════════════════════════════════════════════════════════════════
//  3. IMPORTANCE SCORER
// ════════════════════════════════════════════════════════════════

export function scoreImportance(event: NewsEvent): ImportanceScore {
  let score = CATEGORY_IMPORTANCE[event.category] ?? 30;
  const factors: string[] = [`category:${event.category}(${score})`];

  // Multi-symbol events are more important (broad impact)
  if (event.symbols.length >= 3) {
    score += 8;
    factors.push(`+8:multi_symbol(${event.symbols.length})`);
  } else if (event.symbols.length === 0) {
    score -= 10;
    factors.push('-10:no_symbols');
  }

  // Macro factors amplify importance
  if (event.macroFactors.length > 0) {
    const macroBoost = Math.min(event.macroFactors.length * 5, 15);
    score += macroBoost;
    factors.push(`+${macroBoost}:macro(${event.macroFactors.join(',')})`);
  }

  // Commodity linkage adds importance for resource-sensitive sectors
  if (event.commodities.length > 0) {
    score += 5;
    factors.push(`+5:commodity_linked`);
  }

  // Longer body = likely more substance
  const bodyLen = event.body?.length ?? 0;
  if (bodyLen > 300) {
    score += 5;
    factors.push('+5:substantive_body');
  } else if (bodyLen < 30) {
    score -= 8;
    factors.push('-8:headline_only');
  }

  return { score: clamp(score, 0, 100), factors };
}

// ════════════════════════════════════════════════════════════════
//  4. NOVELTY SCORER
// ════════════════════════════════════════════════════════════════

/**
 * Novelty scoring. In the DB-connected pipeline this checks
 * q365_news_events for similar recent titles. Here we accept
 * the count as a parameter so the scorer itself stays pure.
 *
 * @param recentSimilarCount - number of events with overlapping
 *   title tokens published in the last 24 hours.
 */
export function scoreNovelty(
  event: NewsEvent,
  recentSimilarCount: number,
): NoveltyScore {
  // Breaking: first occurrence + high-importance category
  const isBreaking = recentSimilarCount === 0 &&
    ['earnings', 'merger_acquisition', 'regulatory', 'management_change'].includes(event.category);

  let score: number;
  if (recentSimilarCount === 0) {
    score = isBreaking ? 100 : 85;
  } else if (recentSimilarCount <= 2) {
    score = 60;
  } else if (recentSimilarCount <= 5) {
    score = 35;
  } else {
    score = Math.max(10, 35 - (recentSimilarCount - 5) * 5);
  }

  return { score: clamp(score, 0, 100), recentDupes: recentSimilarCount, isBreaking };
}

// ════════════════════════════════════════════════════════════════
//  5. FRESHNESS SCORER
// ════════════════════════════════════════════════════════════════

/**
 * Time-decay freshness. Score decays from 100 (just published)
 * to 0 (older than 48 hours).
 *
 * Decay bands:
 *   live    : 0–30min    → 100–90
 *   recent  : 30m–2h     → 90–70
 *   aging   : 2h–6h      → 70–45
 *   stale   : 6h–24h     → 45–15
 *   expired : >24h       → 15–0
 */
export function scoreFreshness(event: NewsEvent): FreshnessScore {
  const pubTime = new Date(event.publishedAt).getTime();
  const now = Date.now();
  const ageMs = Math.max(0, now - pubTime);
  const ageMinutes = ageMs / 60_000;

  let score: number;
  let decayBand: FreshnessScore['decayBand'];

  if (ageMinutes <= 30) {
    score = lerp(100, 90, ageMinutes / 30);
    decayBand = 'live';
  } else if (ageMinutes <= 120) {
    score = lerp(90, 70, (ageMinutes - 30) / 90);
    decayBand = 'recent';
  } else if (ageMinutes <= 360) {
    score = lerp(70, 45, (ageMinutes - 120) / 240);
    decayBand = 'aging';
  } else if (ageMinutes <= 1440) {
    score = lerp(45, 15, (ageMinutes - 360) / 1080);
    decayBand = 'stale';
  } else {
    // Exponential decay beyond 24h, floor at 0
    const hoursOver24 = (ageMinutes - 1440) / 60;
    score = Math.max(0, 15 * Math.exp(-0.15 * hoursOver24));
    decayBand = 'expired';
  }

  return {
    score: clamp(Math.round(score), 0, 100),
    ageMinutes: Math.round(ageMinutes),
    decayBand,
  };
}

// ════════════════════════════════════════════════════════════════
//  6. DIRECTNESS SCORER
// ════════════════════════════════════════════════════════════════

/**
 * How directly does this event reference a specific symbol?
 * Called per (event, symbol) pair.
 *
 * @param targetSymbol - the symbol we're scoring impact for
 */
export function scoreDirectness(event: NewsEvent, targetSymbol: string): DirectnessScore {
  const symbolCount = event.symbols.length;
  const entityCount = event.entities.length;

  // Check if the target symbol is directly mentioned
  const isDirectlyMentioned = event.symbols.includes(targetSymbol);

  // Check if it's the PRIMARY subject (mentioned in title)
  const titleLower = event.title.toLowerCase();
  const symbolLower = targetSymbol.toLowerCase();
  const isPrimarySubject = isDirectlyMentioned &&
    (titleLower.includes(symbolLower) || symbolCount === 1);

  // Check for sector-peer linkage
  const symbolSectors = event.sectors;
  const isSectorPeer = !isDirectlyMentioned && symbolSectors.length > 0;

  // Check for macro/commodity indirect link
  const isMacroIndirect = !isDirectlyMentioned && !isSectorPeer &&
    (event.macroFactors.length > 0 || event.commodities.length > 0);

  let matchType: DirectnessScore['matchType'];
  let score: number;

  if (isPrimarySubject) {
    matchType = 'primary_subject';
    score = 95;
  } else if (isDirectlyMentioned) {
    matchType = 'mentioned';
    // Dilute if many symbols mentioned (less focused)
    score = symbolCount <= 3 ? 75 : Math.max(50, 75 - (symbolCount - 3) * 5);
  } else if (isSectorPeer) {
    matchType = 'sector_peer';
    score = 35;
  } else if (isMacroIndirect) {
    matchType = 'macro_indirect';
    score = 20;
  } else {
    matchType = 'none';
    score = 0;
  }

  return {
    score: clamp(score, 0, 100),
    matchType,
    entityCount,
    symbolCount,
  };
}

// ════════════════════════════════════════════════════════════════
//  7. MANIPULATION SUSPICION SCORER
// ════════════════════════════════════════════════════════════════

// Hyperbolic / pump language patterns
const HYPERBOLIC_PATTERNS = [
  /\b(multibagger|100%|10x|guaranteed|sure\s*shot|rocket|moon|to\s*the\s*moon)\b/i,
  /\b(next\s*(tata|reliance|infosys)|hidden\s*gem|life\s*changing)\b/i,
  /\b(buy\s*now|don't\s*miss|last\s*chance|urgent|limited\s*time)\b/i,
  /\b(insiders?\s*buying|secret|tip|penny\s*stock\s*alert)\b/i,
];

export function scoreManipulationSuspicion(
  event: NewsEvent,
  trustScore: TrustScore,
  noveltyScore: NoveltyScore,
): ManipulationSuspicionScore {
  let score = 0;
  const flags: ManipulationFlag[] = [];

  // Low trust source → base suspicion
  if (trustScore.score < 40) {
    score += 25;
    flags.push('low_trust_source');
  } else if (trustScore.score < 55) {
    score += 12;
    flags.push('low_trust_source');
  }

  // Social-tier source → amplification risk
  if (trustScore.tier === 'social' || trustScore.tier === 'unknown') {
    score += 20;
    flags.push('social_amplification');
  }

  // Hyperbolic / pump language
  const text = `${event.title} ${event.body ?? ''}`;
  let hyperbolicHits = 0;
  for (const pattern of HYPERBOLIC_PATTERNS) {
    if (pattern.test(text)) hyperbolicHits++;
  }
  if (hyperbolicHits > 0) {
    score += Math.min(hyperbolicHits * 15, 40);
    flags.push('hyperbolic_language');
  }

  // Missing body / no attribution
  if (!event.body || event.body.length < 30) {
    score += 10;
    flags.push('missing_attribution');
  }

  // Coordinated burst: many similar items = suspicious
  if (noveltyScore.recentDupes > 5) {
    score += 15;
    flags.push('coordinated_burst');
  }

  // Timing: published outside IST market hours (suspicious for max retail impact)
  const pubHour = new Date(event.publishedAt).getUTCHours();
  const istHour = (pubHour + 5.5) % 24; // rough IST conversion
  if (istHour >= 20 || istHour < 6) {
    score += 8;
    flags.push('timing_suspicious');
  }

  // Single micro-cap symbol with no institutional coverage = pump risk
  if (event.symbols.length === 1 && trustScore.tier !== 'institutional') {
    // Can't verify micro-cap from news alone, but single-symbol + low trust = flag
    if (trustScore.score < 50) {
      score += 12;
      flags.push('micro_cap_pump');
    }
  }

  return {
    score: clamp(score, 0, 100),
    flags,
  };
}

// ── Utility ──────────────────────────────────────────────────────

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function lerp(start: number, end: number, t: number): number {
  return start + (end - start) * Math.max(0, Math.min(1, t));
}
