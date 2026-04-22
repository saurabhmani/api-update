// ════════════════════════════════════════════════════════════════
//  News Scoring Engine — Type System
//
//  All scoring dimensions are on 0–100 scale (except sentiment
//  which is -100 to +100). Final composites are 0–100.
//
//  RULE: Sentiment alone cannot drive decisions — it's weighted
//  at 0.18 and capped when trust is low.
// ════════════════════════════════════════════════════════════════

import type { NewsSourceId, NewsCategory } from './newsEngine.types';

// ── Per-Dimension Scores ─────────────────────────────────────────

/** Source reliability. 0 = unknown/suspicious, 100 = institutional-grade. */
export interface TrustScore {
  score:    number;       // 0–100
  tier:     'institutional' | 'mainstream' | 'aggregator' | 'social' | 'unknown';
  factors:  string[];     // human-readable reasons
}

/** Directional sentiment. -100 = strongly bearish, +100 = strongly bullish. */
export interface SentimentDimensionScore {
  score:          number;   // -100 to +100
  magnitude:      number;   // 0–100 absolute strength
  wordHitCount:   number;
  direction:      'bullish' | 'bearish' | 'neutral';
}

/** How materially important is this event? */
export interface ImportanceScore {
  score:    number;       // 0–100
  factors:  string[];
}

/** Is this genuinely new information or rehash? */
export interface NoveltyScore {
  score:          number;   // 0–100
  recentDupes:    number;   // similar events in last 24h
  isBreaking:     boolean;
}

/** Time decay — how fresh is the event? */
export interface FreshnessScore {
  score:      number;     // 0–100
  ageMinutes: number;
  decayBand:  'live' | 'recent' | 'aging' | 'stale' | 'expired';
}

/** How directly does this event reference the target symbol? */
export interface DirectnessScore {
  score:        number;   // 0–100
  matchType:    'primary_subject' | 'mentioned' | 'sector_peer' | 'macro_indirect' | 'none';
  entityCount:  number;   // total entities linked
  symbolCount:  number;   // symbols directly mentioned
}

/** Is there reason to suspect this news is manipulative / pump-and-dump? */
export interface ManipulationSuspicionScore {
  score:    number;       // 0–100
  flags:    ManipulationFlag[];
}

export type ManipulationFlag =
  | 'low_trust_source'
  | 'social_amplification'
  | 'hyperbolic_language'
  | 'missing_attribution'
  | 'micro_cap_pump'
  | 'timing_suspicious'    // published outside market hours for max impact
  | 'coordinated_burst'    // many similar items in short window
  | 'no_institutional_coverage';

// ── Full Score Card ──────────────────────────────────────────────

export interface NewsScoreCard {
  newsEventId:    number;
  symbol:         string;           // which symbol this score is FOR
  trust:          TrustScore;
  sentiment:      SentimentDimensionScore;
  importance:     ImportanceScore;
  novelty:        NoveltyScore;
  freshness:      FreshnessScore;
  directness:     DirectnessScore;
  manipulation:   ManipulationSuspicionScore;

  // ── Composites ──────────────────────────────────────────────
  symbolImpactScore:      number;   // 0–100 (weighted formula)
  eventRiskScore:         number;   // 0–100 (risk to acting on this event)
  manipulationRiskBoost:  number;   // 0–50 additive penalty for signal layer

  scoredAt:       string;           // ISO-8601
}

// ── Scoring Config ───────────────────────────────────────────────

export interface ScoringWeights {
  trust:        number;
  importance:   number;
  sentiment:    number;   // absolute sentiment magnitude
  freshness:    number;
  novelty:      number;
  directness:   number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  trust:        0.22,
  importance:   0.20,
  sentiment:    0.18,
  freshness:    0.15,
  novelty:      0.15,
  directness:   0.10,
};

// ── Source Trust Tiers ───────────────────────────────────────────

export const SOURCE_TRUST_CONFIG: Record<NewsSourceId, { baseTrust: number; tier: TrustScore['tier'] }> = {
  // Official sources — highest credibility
  official_exchange:  { baseTrust: 92, tier: 'institutional' },
  corporate_filings:  { baseTrust: 90, tier: 'institutional' },
  // Media sources — standard credibility
  finnhub:            { baseTrust: 82, tier: 'institutional' },
  rss_et:             { baseTrust: 75, tier: 'mainstream' },
  rss_mc:             { baseTrust: 72, tier: 'mainstream' },
  newsdata:           { baseTrust: 68, tier: 'mainstream' },
  gnews:              { baseTrust: 55, tier: 'aggregator' },
  // Deals sources — high credibility for deal-specific content
  deals_feed:         { baseTrust: 78, tier: 'mainstream' },
  // Social sources — lower credibility, higher manipulation scrutiny
  social_signals:     { baseTrust: 35, tier: 'social' },
};

// ── Category Importance Weights ──────────────────────────────────

export const CATEGORY_IMPORTANCE: Record<string, number> = {
  earnings:           90,
  merger_acquisition: 88,
  regulatory:         85,
  macro_policy:       82,
  credit_rating:      80,
  insider_trade:      78,
  management_change:  75,
  corporate_action:   72,
  ipo_listing:        70,
  commodity:          65,
  sector_move:        60,
  global_cue:         58,
  general:            30,
};

// ── Scoring Pipeline Result ──────────────────────────────────────

export interface ScoringResult {
  totalScored:    number;
  symbolScores:   number;     // total (event × symbol) score cards produced
  errors:         string[];
  durationMs:     number;
}
