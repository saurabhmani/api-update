// ════════════════════════════════════════════════════════════════
//  Event Risk Classifier
//
//  Maps news category + content signals to event risk categories
//  with specific risk scores, penalties, and suppression rules.
//
//  STRICT RULES:
//    - Fraud/scandal → always suppress trade
//    - Earnings imminent → elevated risk, warn but don't suppress
//    - Macro shock + high → suppress
//    - Risk penalty bounded 0–10
// ════════════════════════════════════════════════════════════════

import type { NewsCategory } from '../types/newsEngine.types';
import type { EventRiskDetail, EventRiskCategory } from '../types/impact.types';

// ── Category → Risk mapping ──────────────────────────────────────

interface RiskRule {
  eventCategory:  EventRiskCategory;
  baseRisk:       number;
  suppressAt:     number;       // risk threshold that triggers suppression
  reason:         string;
}

const CATEGORY_RISK_MAP: Record<NewsCategory, RiskRule> = {
  earnings: {
    eventCategory: 'earnings_imminent',
    baseRisk: 55,
    suppressAt: 999,    // never suppress for earnings alone — warn
    reason: 'Earnings approaching: elevated volatility expected',
  },
  regulatory: {
    eventCategory: 'regulatory_action',
    baseRisk: 60,
    suppressAt: 80,
    reason: 'Regulatory action: outcome uncertainty high',
  },
  merger_acquisition: {
    eventCategory: 'none',
    baseRisk: 40,
    suppressAt: 999,
    reason: 'M&A activity: may cause gap risk',
  },
  macro_policy: {
    eventCategory: 'macro_shock',
    baseRisk: 65,
    suppressAt: 85,
    reason: 'Macro policy event: broad market risk',
  },
  management_change: {
    eventCategory: 'management_crisis',
    baseRisk: 50,
    suppressAt: 75,
    reason: 'Management change: governance uncertainty',
  },
  insider_trade: {
    eventCategory: 'fraud_scandal',
    baseRisk: 70,
    suppressAt: 70,     // always suppress
    reason: 'Insider trading alert: regulatory risk',
  },
  credit_rating: {
    eventCategory: 'credit_event',
    baseRisk: 55,
    suppressAt: 80,
    reason: 'Credit rating event: solvency risk signal',
  },
  ipo_listing: {
    eventCategory: 'none',
    baseRisk: 30,
    suppressAt: 999,
    reason: 'IPO/listing event: price discovery phase',
  },
  global_cue: {
    eventCategory: 'geopolitical',
    baseRisk: 50,
    suppressAt: 80,
    reason: 'Global/geopolitical event: contagion risk',
  },
  commodity: {
    eventCategory: 'commodity_shock',
    baseRisk: 40,
    suppressAt: 85,
    reason: 'Commodity price event: input cost risk',
  },
  sector_move: {
    eventCategory: 'none',
    baseRisk: 25,
    suppressAt: 999,
    reason: 'Sector rotation: watch for momentum shift',
  },
  corporate_action: {
    eventCategory: 'none',
    baseRisk: 20,
    suppressAt: 999,
    reason: 'Corporate action: ex-date or record date',
  },
  general: {
    eventCategory: 'none',
    baseRisk: 10,
    suppressAt: 999,
    reason: 'General news: low trading impact',
  },
};

// ── Fraud / Scandal Detection ────────────────────────────────────

const FRAUD_PATTERNS = [
  /\b(fraud|scam|ponzi|embezzlement|money\s*laundering)\b/i,
  /\b(SEBI\s*ban|SEBI\s*order|suspended|debarred)\b/i,
  /\b(forensic\s*audit|accounting\s*irregularity|misstatement)\b/i,
  /\b(whistleblower|governance\s*failure|siphon)\b/i,
  /\b(arrested|CBI|ED\s*raid|enforcement\s*directorate)\b/i,
];

function detectFraud(title: string, body: string | null): boolean {
  const text = `${title} ${body ?? ''}`;
  return FRAUD_PATTERNS.some((p) => p.test(text));
}

// ── Macro Shock Detection ────────────────────────────────────────

const MACRO_SHOCK_PATTERNS = [
  /\b(emergency\s*rate|surprise\s*cut|surprise\s*hike|flash\s*crash)\b/i,
  /\b(black\s*swan|circuit\s*breaker|trading\s*halt)\b/i,
  /\b(currency\s*crisis|debt\s*crisis|sovereign\s*default)\b/i,
  /\b(war|invasion|military\s*action|nuclear)\b/i,
  /\b(pandemic|lockdown|global\s*shutdown)\b/i,
];

function detectMacroShock(title: string, body: string | null): boolean {
  const text = `${title} ${body ?? ''}`;
  return MACRO_SHOCK_PATTERNS.some((p) => p.test(text));
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Classify event risk from a news event's category + content.
 * Returns risk score, penalty, and suppression decision.
 */
export function classifyEventRisk(
  category: NewsCategory,
  title: string,
  body: string | null,
  sentimentScore: number,        // -100 to +100
  manipulationScore: number,     // 0–100
  importanceScore: number,       // 0–100
): EventRiskDetail {
  const rule = CATEGORY_RISK_MAP[category];

  let riskScore = rule.baseRisk;
  let eventCategory = rule.eventCategory;
  let reason = rule.reason;
  let suppressTrade = false;

  // ── Fraud override: always highest risk ────────────────────
  if (detectFraud(title, body)) {
    eventCategory = 'fraud_scandal';
    riskScore = 95;
    suppressTrade = true;
    reason = 'FRAUD/SCANDAL DETECTED: trade suppressed — regulatory/legal risk extreme';
  }

  // ── Macro shock override ───────────────────────────────────
  if (detectMacroShock(title, body)) {
    if (eventCategory !== 'fraud_scandal') {
      eventCategory = 'macro_shock';
      riskScore = Math.max(riskScore, 85);
      suppressTrade = true;
      reason = 'MACRO SHOCK: trade suppressed — extreme market disruption';
    }
  }

  // ── Sentiment amplifier (strongly negative = higher risk) ──
  if (sentimentScore < -50) {
    riskScore = Math.min(100, riskScore + 15);
  } else if (sentimentScore < -25) {
    riskScore = Math.min(100, riskScore + 8);
  }

  // ── Manipulation amplifier ─────────────────────────────────
  if (manipulationScore >= 50) {
    riskScore = Math.min(100, riskScore + 10);
  } else if (manipulationScore >= 30) {
    riskScore = Math.min(100, riskScore + 5);
  }

  // ── Importance amplifier ───────────────────────────────────
  if (importanceScore >= 80) {
    riskScore = Math.min(100, riskScore + 8);
  }

  // ── Suppression check (non-fraud/macro) ────────────────────
  if (!suppressTrade && riskScore >= rule.suppressAt) {
    suppressTrade = true;
    reason += ' — risk threshold breached, trade suppressed';
  }

  // ── Risk penalty: bounded 0–10 ─────────────────────────────
  const riskPenalty = Math.min(10, Math.round(riskScore / 10));

  return {
    category: eventCategory,
    riskScore: clamp(riskScore, 0, 100),
    riskPenalty,
    suppressTrade,
    reason,
  };
}

/**
 * Aggregate multiple event risk details into a single risk assessment.
 * Takes the worst-case across all events.
 */
export function aggregateEventRisks(risks: EventRiskDetail[]): EventRiskDetail {
  if (risks.length === 0) {
    return { category: 'none', riskScore: 0, riskPenalty: 0, suppressTrade: false, reason: 'No events' };
  }

  // Worst-case: highest risk wins
  let worst = risks[0];
  for (const r of risks) {
    if (r.riskScore > worst.riskScore) worst = r;
    if (r.suppressTrade && !worst.suppressTrade) worst = r;
  }

  return worst;
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}
