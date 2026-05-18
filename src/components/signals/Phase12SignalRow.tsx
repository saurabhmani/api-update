'use client';
// ════════════════════════════════════════════════════════════════
//  Phase-12 Signal Row Cells
//
//  Reusable cell renderers for the seven Phase-12 required UI
//  fields. Drop these into any signals table — the page-level
//  layout decides where they go in the row, this file just owns
//  the cell-level formatting + colour bands.
//
//    final_score             0-100 with band colour
//    classification          INSTITUTIONAL_HIGH_CONVICTION etc.
//    risk_score              0-100 with inverted band (lower=better)
//    portfolio_fit_score     0-100 with band colour
//    stress_survival_score   0-100 with hard floor at 60
//    risk_reward             ratio rendered as 1:N
//    explanation summary     summary_reason from Phase-10 block
// ════════════════════════════════════════════════════════════════

import type { CSSProperties } from 'react';
import type {
  SignalClassification,
  SignalExplanation,
} from '@/types/phase11Signal';
import {
  mapRejectionToCode,
  toProfessionalLabel,
  type RejectionCode,
} from '@/lib/signals/signalDisplayShaper';

// ── Shared band colour helpers ─────────────────────────────────

interface BandColour { color: string; bg: string }

function bandHigherIsBetter(score: number): BandColour {
  if (score >= 80) return { color: '#065F46', bg: '#D1FAE5' };
  if (score >= 65) return { color: '#1D4ED8', bg: '#DBEAFE' };
  if (score >= 50) return { color: '#92400E', bg: '#FEF3C7' };
  return                  { color: '#991B1B', bg: '#FEE2E2' };
}

function bandLowerIsBetter(score: number): BandColour {
  if (score <= 30) return { color: '#065F46', bg: '#D1FAE5' };
  if (score <= 50) return { color: '#1D4ED8', bg: '#DBEAFE' };
  if (score <= 70) return { color: '#92400E', bg: '#FEF3C7' };
  return                  { color: '#991B1B', bg: '#FEE2E2' };
}

function pillStyle(b: BandColour): CSSProperties {
  return {
    display:    'inline-block',
    background: b.bg,
    color:      b.color,
    fontSize:   11,
    fontWeight: 700,
    padding:    '2px 8px',
    borderRadius: 99,
    minWidth:   38,
    textAlign:  'center',
  };
}

// ── Classification ─────────────────────────────────────────────

// Spec INSTITUTIONAL §UX-SIMPLIFY (2026-05) — institutional-tier
// classifications only. NO_TRADE and WATCHLIST_ONLY are deliberately
// NOT in this map; rows carrying those classifications are routed
// through the canonical RejectionCode path below so the badge shows
// the SPECIFIC reason (REJECTED_LOW_CONFIDENCE / REJECTED_LOW_RR /
// REJECTED_MARKET_REGIME / DEVELOPING_SETUP / etc) instead of any
// generic "No Trade" / "Watchlist" string. The previous local
// VETO_PATTERNS map produced human-friendly-but-non-canonical labels
// ("Liquidity Blocked", "Risk Veto") which broke spec §4 "never
// display NO_TRADE" — replaced wholesale by mapRejectionToCode().
const CLASSIFICATION_META: Partial<Record<SignalClassification, { label: string; color: string; bg: string }>> = {
  INSTITUTIONAL_HIGH_CONVICTION: { label: 'Institutional',  color: '#0F172A', bg: '#E0E7FF' },
  HIGH_CONVICTION:               { label: 'High Conviction', color: '#065F46', bg: '#D1FAE5' },
  MEDIUM_CONVICTION:             { label: 'Medium',          color: '#1E40AF', bg: '#DBEAFE' },
  LOW_CONVICTION:                { label: 'Low',             color: '#475569', bg: '#F1F5F9' },
  VALID_SIGNAL:                  { label: 'Valid',           color: '#1D4ED8', bg: '#DBEAFE' },
  DEVELOPING_SETUP:              { label: 'DEVELOPING_SETUP', color: '#92400E', bg: '#FEF3C7' },
  // NO_TRADE / WATCHLIST_ONLY removed — see comment block above.
};

// Per-RejectionCode visual treatment. Mirrors the badge styling used
// by the REJECTED-tab table in src/app/signals/page.tsx so a reader
// gets the SAME pill colour for the SAME code in both surfaces.
const REJECTION_CODE_STYLE: Partial<Record<RejectionCode, { color: string; bg: string }>> = {
  REJECTED_LOW_CONFIDENCE:   { color: '#991B1B', bg: '#FEE2E2' },
  REJECTED_LOW_FINAL_SCORE:  { color: '#991B1B', bg: '#FEE2E2' },
  REJECTED_LOW_RR:           { color: '#991B1B', bg: '#FEE2E2' },
  REJECTED_MARKET_REGIME:    { color: '#9F1239', bg: '#FFE4E6' },
  REJECTED_HIGH_VOLATILITY:  { color: '#991B1B', bg: '#FEE2E2' },
  REJECTED_STALE_DATA:       { color: '#475569', bg: '#F1F5F9' },
  REJECTED_FAILED_STABILITY: { color: '#991B1B', bg: '#FEE2E2' },
  REJECTED_LIVE_INVALIDATED: { color: '#9A3412', bg: '#FFEDD5' },
  REJECTED_PORTFOLIO_FIT:    { color: '#991B1B', bg: '#FEE2E2' },
  REJECTED_RISK_TOO_HIGH:    { color: '#991B1B', bg: '#FEE2E2' },
  REJECTED_INVALID_PRICES:   { color: '#991B1B', bg: '#FEE2E2' },
  REJECTED_NO_STRATEGY:      { color: '#475569', bg: '#F1F5F9' },
  REJECTED_DUPLICATE:        { color: '#475569', bg: '#F1F5F9' },
  REJECTED_LOW_LIQUIDITY:    { color: '#991B1B', bg: '#FEE2E2' },
  REJECTED_LOW_MATURITY:     { color: '#92400E', bg: '#FEF3C7' },
  REJECTED_LOW_CYCLES:       { color: '#92400E', bg: '#FEF3C7' },
  REJECTED_NO_EDGE:          { color: '#991B1B', bg: '#FEE2E2' },
  DEFERRED_WAIT_TRIGGER:     { color: '#92400E', bg: '#FEF3C7' },
  DEVELOPING_SETUP:          { color: '#92400E', bg: '#FEF3C7' },
  APPROVED:                  { color: '#065F46', bg: '#D1FAE5' },
  UNKNOWN:                   { color: '#475569', bg: '#F1F5F9' },
};

export function ClassificationBadge({
  value,
  rejectionCodes,
  rejectionReasons,
  signalStatus,
  scenarioTag,
  isRelaxed,
  isScannerCandidate,
  executionAllowed,
  effectiveApprovalStatus,
  rawApprovalStatus,
  decisionChanged,
  demotionReason,
  institutionalBlockers,
}: {
  value?: SignalClassification | string | null;
  /** Used to resolve the SPECIFIC RejectionCode when classification is
   *  NO_TRADE / WATCHLIST_ONLY (or any non-institutional value). The
   *  badge shows that code verbatim — no generic "No Trade" fallback. */
  rejectionCodes?:   string[] | null;
  rejectionReasons?: string[] | null;
  /** Signal status from the engine — disambiguates bare NO_TRADE rows
   *  whose `rejection_codes` are empty. When this is DEVELOPING_SETUP
   *  the badge renders DEVELOPING_SETUP regardless of classification,
   *  matching what the stock-detail page shows. */
  signalStatus?:    string | null;
  /** Scenario tag — when 'NO_STRATEGY', a NO_TRADE row with no codes
   *  resolves to REJECTED_NO_STRATEGY rather than the generic literal. */
  scenarioTag?:     string | null;
  /** Provenance flags — drive the "Emerging Opportunity" / "Early
   *  Opportunity" / "Monitor" / "Risk Restricted" overrides on the
   *  professional label (UX-PROFESSIONAL-LABELS spec). */
  isRelaxed?:           boolean | null;
  isScannerCandidate?:  boolean | null;
  executionAllowed?:    boolean | null;
  /** Phase 3 + 5 + 6 institutional decision gate — when present, the
   *  badge uses these to decide the user-facing label rather than the
   *  raw classification. Demotion-only (APPROVED→WATCHLIST etc.). The
   *  raw classification is preserved on the tooltip for diagnostics. */
  effectiveApprovalStatus?: 'APPROVED' | 'WATCHLIST' | 'REJECTED' | 'AVOID' | null;
  rawApprovalStatus?:       'APPROVED' | 'WATCHLIST' | 'REJECTED' | 'AVOID' | null;
  decisionChanged?:         boolean | null;
  demotionReason?:          string | null;
  institutionalBlockers?:   string[] | null;
}) {
  if (!value) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;

  const upper = String(value).toUpperCase();
  const institutional = CLASSIFICATION_META[upper as SignalClassification];
  // Professional-label context: provenance flags + execution gate +
  // raw classification. Drives the "Emerging Opportunity" / "Early
  // Opportunity" / "Monitor" / "Risk Restricted" overrides (UX-
  // PROFESSIONAL-LABELS spec).
  const labelContext = {
    is_relaxed:           isRelaxed === true,
    is_scanner_candidate: isScannerCandidate === true,
    execution_allowed:    executionAllowed,
    classification:       upper,
  };

  // Phase 3 + 5 + 6 institutional decision gate. When the gate demoted
  // an APPROVED/HIGH_CONVICTION row to WATCHLIST/REJECTED/AVOID, the
  // user-facing decision is the EFFECTIVE one. Demotion-only — the
  // gate never promotes, so we only act when effective is stricter
  // than the raw classification.
  const effectiveUpper = String(effectiveApprovalStatus ?? '').toUpperCase();
  const gateDemoted = decisionChanged === true
    && (effectiveUpper === 'WATCHLIST' || effectiveUpper === 'REJECTED' || effectiveUpper === 'AVOID');
  const gateTitle = gateDemoted
    ? `Adjusted by institutional gate — ${demotionReason ?? 'further confirmation required.'}`
       + (institutionalBlockers && institutionalBlockers.length > 0
           ? `\nBlockers: ${institutionalBlockers.join('; ')}`
           : '')
       + (rawApprovalStatus ? `\nRaw status: ${rawApprovalStatus}` : '')
    : null;

  // Institutional-grade classifications (HIGH_CONVICTION etc.) render
  // their friendly label by default — but when the row carries the
  // is_relaxed / is_scanner_candidate provenance flags, the
  // professional-label override surfaces "Early Opportunity" / "Emerging
  // Opportunity" so the user sees that this isn't a strict-approved row.
  if (institutional) {
    // Final-decision gate takes precedence over institutional labels.
    // When the gate demoted the row, render the appropriate restricted
    // label instead of the green "Institutional"/"High Conviction" pill.
    if (gateDemoted) {
      const demotedStyle = effectiveUpper === 'AVOID' || effectiveUpper === 'REJECTED'
        ? { color: '#991B1B', bg: '#FEE2E2' }
        : { color: '#92400E', bg: '#FEF3C7' };
      const demotedLabel = effectiveUpper === 'AVOID'      ? 'Approval Restricted'
                         : effectiveUpper === 'REJECTED'   ? 'Approval Restricted'
                         :                                    'Watchlist Only';
      return (
        <span style={{
          display:    'inline-block',
          background: demotedStyle.bg,
          color:      demotedStyle.color,
          fontSize:   10,
          fontWeight: 700,
          padding:    '2px 8px',
          borderRadius: 99,
          letterSpacing: 0.4,
          whiteSpace: 'nowrap',
        }}
        title={gateTitle ?? ''}
        >
          {demotedLabel}
        </span>
      );
    }
    const overrideLabel = (isRelaxed === true || isScannerCandidate === true)
      ? toProfessionalLabel('APPROVED', labelContext)
      : null;
    return (
      <span style={{
        display:    'inline-block',
        background: institutional.bg,
        color:      institutional.color,
        fontSize:   10,
        fontWeight: 700,
        padding:    '2px 8px',
        borderRadius: 99,
        letterSpacing: 0.4,
        whiteSpace: 'nowrap',
      }}
      title={institutional.label + (overrideLabel ? ` (engine class: ${institutional.label})` : '')}
      >
        {overrideLabel ?? institutional.label}
      </span>
    );
  }

  // Spec INSTITUTIONAL §UX-SIMPLIFY §4 — never render "NO_TRADE".
  // Resolve a specific RejectionCode from the upstream rejection_codes
  // / rejection_reasons / signal_status / scenario_tag. Cascade order:
  //   1. explicit rejection codes (canonical)
  //   2. free-form rejection reasons (pattern matched)
  //   3. signal_status / scenario_tag context (disambiguates bare
  //      NO_TRADE rows whose rejection_codes are empty — common in
  //      the relaxed pool where the engine wrote NO_TRADE without
  //      attaching a specific code)
  //   4. classification name itself (DEVELOPING_SETUP / WATCHLIST_ONLY
  //      / NO_TRADE → DEFERRED_WAIT_TRIGGER fallback per spec)
  //   5. UNKNOWN — only when none of the above resolves; operator
  //      sees the literal string in a muted pill so the upstream
  //      gap is visible instead of silently labelled.
  let code: RejectionCode = mapRejectionToCode(
    (rejectionReasons ?? []).join(' ') || null,
    rejectionCodes ?? null,
  );
  const ssUpper      = String(signalStatus ?? '').toUpperCase();
  const scenarioUpper = String(scenarioTag ?? '').toUpperCase();
  if (code === 'UNKNOWN') {
    // Step 3 — context-driven disambiguation.
    if (ssUpper === 'DEVELOPING_SETUP')                code = 'DEVELOPING_SETUP';
    else if (scenarioUpper === 'NO_STRATEGY')          code = 'REJECTED_NO_STRATEGY';
    // Step 4 — classification-name fallback.
    else if (upper === 'DEVELOPING_SETUP')             code = 'DEVELOPING_SETUP';
    else if (upper === 'WATCHLIST_ONLY' || upper === 'WATCHLIST') code = 'DEFERRED_WAIT_TRIGGER';
    // NO_TRADE without context — these rows are in the relaxed pool
    // by virtue of appearing in the table at all, so DEFERRED_WAIT_TRIGGER
    // ("Wait for Trigger" per spec) is the most accurate interpretation:
    // the engine flagged them not-tradable-yet but they're held in the
    // scanner queue. Never fall through to the literal "NO_TRADE" label.
    else if (upper === 'NO_TRADE')                     code = 'DEFERRED_WAIT_TRIGGER';
  }
  const style = REJECTION_CODE_STYLE[code] ?? REJECTION_CODE_STYLE.UNKNOWN!;

  // Spec UX-PROFESSIONAL-LABELS — the visible label is the user-facing
  // institutional term ("Liquidity Blocked" / "Awaiting Confirmation" /
  // "Monitor" / etc.); the technical RejectionCode lives on the
  // tooltip for operator inspection. Production users never see raw
  // engine enums like REJECTED_LOW_CONFIDENCE or DEVELOPING_SETUP.
  const labelText = toProfessionalLabel(code, labelContext);
  const titleText = code === 'UNKNOWN'
    ? `Unknown classification: ${String(value)}`
    : `${code}${rejectionReasons && rejectionReasons.length > 0 ? ` — ${rejectionReasons[0]}` : ''}`;

  return (
    <span
      style={{
        display:    'inline-block',
        background: style.bg,
        color:      style.color,
        fontSize:   10,
        fontWeight: 800,
        padding:    '2px 8px',
        borderRadius: 4,
        letterSpacing: 0.3,
        whiteSpace: 'nowrap',
      }}
      title={titleText}
    >
      {labelText}
    </span>
  );
}

// ── Score pills ─────────────────────────────────────────────────

export function FinalScorePill({ value }: { value?: number | null }) {
  if (value == null) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  return <span style={pillStyle(bandHigherIsBetter(Number(value)))}>{Math.round(Number(value))}</span>;
}

export function RiskScorePill({ value }: { value?: number | null }) {
  if (value == null) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  return <span style={pillStyle(bandLowerIsBetter(Number(value)))}>{Math.round(Number(value))}</span>;
}

export function PortfolioFitPill({ value }: { value?: number | null }) {
  if (value == null) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  return <span style={pillStyle(bandHigherIsBetter(Number(value)))}>{Math.round(Number(value))}</span>;
}

/**
 * Stress survival pill. Below 60 is the Phase-7 fragile band — we
 * tag those with a "FRAGILE" suffix because a fragile row should
 * never be in the main table; if one appears the operator wants
 * to see WHY it slipped through.
 */
export function StressSurvivalPill({ value }: { value?: number | null }) {
  if (value == null) return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  const score   = Number(value);
  const fragile = score < 60;
  const band    = fragile
    ? { color: '#991B1B', bg: '#FEE2E2' }
    : bandHigherIsBetter(score);
  return (
    <span style={pillStyle(band)} title={fragile ? 'Fragile — below 60 hard floor' : 'Resilient'}>
      {Math.round(score)}{fragile ? ' ⚠' : ''}
    </span>
  );
}

export function RiskRewardCell({ value }: { value?: number | null }) {
  if (value == null || !Number.isFinite(Number(value))) {
    return <span style={{ color: '#CBD5E1', fontSize: 11 }}>—</span>;
  }
  const rr   = Number(value);
  const band = rr >= 2 ? { color: '#065F46', bg: '#D1FAE5' }
             : rr >= 1.5 ? { color: '#1D4ED8', bg: '#DBEAFE' }
             :             { color: '#991B1B', bg: '#FEE2E2' };
  return <span style={pillStyle(band)}>1:{rr.toFixed(1)}</span>;
}

// ── Explanation ────────────────────────────────────────────────

/**
 * Summary line from the Phase-10 explanation block. Used in the
 * row's expanded view or as a tooltip-only field on the compact
 * row. The raw summary_reason string is already formatted by the
 * explainability engine; we just render it verbatim with a small
 * leading icon.
 */
export function ExplanationSummary({
  explanation,
  fallback = 'No explanation available.',
}: {
  explanation?: SignalExplanation | null;
  fallback?:    string;
}) {
  const text = explanation?.summary_reason?.trim() || fallback;
  return (
    <div style={{
      fontSize:   12,
      lineHeight: 1.5,
      color:      '#334155',
      padding:    '6px 10px',
      background: '#F8FAFC',
      borderLeft: '3px solid #3B82F6',
      borderRadius: 4,
    }}>
      {text}
    </div>
  );
}
