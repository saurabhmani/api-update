// ════════════════════════════════════════════════════════════════
//  Phase-11 Canonical Signal Row
//
//  Single source of truth for the 16 fields every layer (DB, Redis
//  cache, API response, frontend) agrees on. Everything downstream
//  imports these types — keeping shape changes traceable to one
//  file instead of leaking through the codebase.
//
//  Required fields (per the Phase-11 contract):
//
//    final_score                  Phase-4 composite (0-100)
//    classification               Phase-4 6-band string
//    confidence_score             Phase-1/2 conviction (0-100)
//    risk_score                   Phase-1/2 standalone risk (0-100)
//    portfolio_fit_score          Phase-3 portfolio fit (0-100)
//    risk_reward                  reward / risk ratio
//    stress_survival_score        Phase-7 stress survival (0-100)
//    signal_status                tri-state product classification
//    rejection_codes              Phase-5 union of blocking codes
//    rejection_reasons            parallel human-readable reasons
//    factor_scores                Phase-4 8-factor block
//    explanation                  Phase-10 7-section explanation
//    recommended_quantity         Phase-9 sizer shares
//    recommended_capital          Phase-9 sizer capital
//    live_valid                   Phase-8 live-validation gate
//    live_validation_reasons      Phase-8 validation reasons
//
//  Identity / display fields (symbol, direction, prices, generated_at)
//  are typed alongside so any caller can build a complete row from
//  this one import.
// ════════════════════════════════════════════════════════════════

export type SignalDirection      = 'BUY' | 'SELL' | 'HOLD';
export type SignalStatus         = 'APPROVED_SIGNAL' | 'DEVELOPING_SETUP' | 'NO_TRADE';
export type SignalClassification =
  | 'INSTITUTIONAL_HIGH_CONVICTION'
  | 'HIGH_CONVICTION'
  // Spec DATA-QUALITY §2 — final-score-bucketed values used by the
  // closed-market response shapers (normalizeClassification).
  | 'MEDIUM_CONVICTION'
  | 'LOW_CONVICTION'
  | 'VALID_SIGNAL'
  | 'DEVELOPING_SETUP'
  | 'WATCHLIST_ONLY'
  | 'NO_TRADE';

/** Phase-4 8-factor breakdown. Every entry is 0-100. */
export interface FactorScores {
  strategy_quality:    number;
  trend_alignment:     number;
  momentum:            number;
  volume_confirmation: number;
  risk_reward:         number;
  liquidity:           number;
  market_regime:       number;
  portfolio_fit:       number;
}

/** Phase-10 explanation block. One human-readable sentence per slot. */
export interface SignalExplanation {
  summary_reason:             string;
  factor_score_explanation:   string;
  risk_explanation:           string;
  portfolio_explanation:      string;
  stress_explanation:         string;
  rejection_explanation:      string;
  final_decision_explanation: string;
}

/**
 * Canonical signal row. This is the shape persisted to MySQL
 * (denormalised onto q365_signals via the Phase-11 columns + JSON
 * blobs), cached in Redis, returned by the API, and consumed by
 * the frontend.
 */
export interface Phase11SignalRow {
  // ── Identity ──────────────────────────────────────────────
  id?:               number;
  symbol:            string;
  direction:         SignalDirection;
  generated_at:      string;

  // ── Required Phase-11 fields ──────────────────────────────
  final_score:             number;
  classification:          SignalClassification;
  confidence_score:        number;
  risk_score:              number;
  portfolio_fit_score:     number;
  risk_reward:             number;
  stress_survival_score:   number | null;
  signal_status:           SignalStatus;
  rejection_codes:         string[];
  rejection_reasons:       string[];
  factor_scores:           FactorScores;
  explanation:             SignalExplanation;
  recommended_quantity:    number;
  recommended_capital:     number;
  live_valid:              boolean | null;
  live_validation_reasons: string[];
}

/**
 * Minimal projection used by ranking / list views. Drops the
 * explanation block (too verbose for tables) but keeps every
 * field needed to render the row.
 */
export type Phase11SignalSummary = Omit<Phase11SignalRow, 'explanation'>;
