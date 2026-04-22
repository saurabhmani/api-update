// ════════════════════════════════════════════════════════════════
//  News Impact Engine — Type System (Phase 3)
//
//  Three layers of impact:
//    1. SymbolImpact  — per-symbol trading modifier
//    2. SectorImpact  — sector-wide sentiment + risk
//    3. MarketImpact   — market-wide macro tone
//
//  Plus modifiers, penalties, and warnings that connect
//  to the signal engine, risk engine, and manipulation engine.
//
//  STRICT RULES:
//    - confidenceModifier bounded ±8
//    - riskPenalty bounded 0 to +10 (additive to risk score)
//    - NEVER override existing risk rules
//    - NEVER approve a bad trade due to news
// ════════════════════════════════════════════════════════════════

import type { NewsCategory, SentimentLabel } from './newsEngine.types';

// ── Symbol Impact ────────────────────────────────────────────────

export interface SymbolImpact {
  symbol:               string;
  /** Net confidence modifier from news. Bounded ±8. */
  confidenceModifier:   number;
  /** Additive risk penalty from news events. Bounded 0–10. */
  riskPenalty:          number;
  /** Aggregated sentiment direction for this symbol. */
  netSentiment:         'bullish' | 'bearish' | 'neutral';
  /** Weighted average symbolImpactScore across recent events. */
  aggregateImpact:      number;     // 0–100
  /** News-driven event risk for this specific symbol. */
  eventRiskScore:       number;     // 0–100
  /** Manipulation boost from news scoring. */
  manipulationRiskBoost: number;    // 0–50
  /** Count of scored events contributing to this impact. */
  eventCount:           number;
  /** Human-readable warnings for the signal layer. */
  warnings:             string[];
  /** Event categories driving this impact. */
  activeTags:           NewsCategory[];
  /** Whether news suggests suppressing the signal entirely. */
  suppressSignal:       boolean;
  /** Reason for suppression (if any). */
  suppressionReason:    string | null;
}

// ── Sector Impact ────────────────────────────────────────────────

export interface SectorImpact {
  sector:             string;
  netSentiment:       'bullish' | 'bearish' | 'neutral';
  sentimentStrength:  number;     // 0–100
  /** Average importance of sector-relevant events. */
  avgImportance:      number;     // 0–100
  eventCount:         number;
  activeTags:         NewsCategory[];
  /** Sector-wide risk tone. */
  riskTone:           'favorable' | 'neutral' | 'cautious' | 'adverse';
}

// ── Market Impact ────────────────────────────────────────────────

export interface MarketImpact {
  netSentiment:       'bullish' | 'bearish' | 'neutral';
  sentimentStrength:  number;     // 0–100
  /** Macro factor proximity (RBI, Fed, GDP, elections). */
  macroProximity:     'none' | 'low' | 'moderate' | 'high';
  /** Market-wide event risk. */
  eventRiskScore:     number;     // 0–100
  /** Overall market tone derived from news flow. */
  marketTone:         'strongly_constructive' | 'constructive' | 'neutral' | 'cautious' | 'hostile';
  eventCount:         number;
  activeMacroFactors: string[];
  warnings:           string[];
}

// ── Event Risk Detail (per-category) ─────────────────────────────

export type EventRiskCategory =
  | 'earnings_imminent'
  | 'fraud_scandal'
  | 'macro_shock'
  | 'geopolitical'
  | 'regulatory_action'
  | 'management_crisis'
  | 'commodity_shock'
  | 'credit_event'
  | 'none';

export interface EventRiskDetail {
  category:       EventRiskCategory;
  riskScore:      number;       // 0–100
  riskPenalty:    number;       // 0–10
  suppressTrade:  boolean;
  reason:         string;
}

// ── Full Impact Result ───────────────────────────────────────────

export interface NewsImpactResult {
  /** Per-symbol trading modifiers (only for symbols with scored events). */
  symbolImpacts:  Map<string, SymbolImpact>;
  /** Per-sector aggregate impact. */
  sectorImpacts:  Map<string, SectorImpact>;
  /** Market-wide impact. */
  marketImpact:   MarketImpact;
  /** Timestamp of computation. */
  computedAt:     string;
}

// ── Signal Engine Integration Types ──────────────────────────────

import type { NewsContext } from '@/lib/signal-engine/types/phase4.types';

export interface NewsModifierForSignal {
  symbol:                 string;
  confidenceModifier:     number;     // ±8
  riskPenalty:            number;     // 0–10
  eventRiskScore:         number;     // 0–100
  manipulationRiskBoost:  number;     // 0–50
  suppressSignal:         boolean;
  warnings:               string[];
  /** Full enriched NewsContext for Phase 4 (0-1 normalized). */
  enrichedNewsContext:     NewsContext;
  /** News event IDs + scores that contributed to this modifier (for linkage tracking). */
  newsEventDetails?:       Array<{ eventId: number; impactScore: number; trustScore: number; sentimentScore: number }>;
}

/**
 * @deprecated Use NewsContext from phase4.types.ts directly.
 * Kept as type alias for backward compatibility during transition.
 */
export type EnrichedNewsContext = NewsContext;
