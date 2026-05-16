// ════════════════════════════════════════════════════════════════
//  signalDisplayShaper — operator-facing display shape + reject
//                       code mapper for /api/signals + stock detail.
//
//  Spec INSTITUTIONAL §M (transparency, no governance bypass):
//  the engine continues to gate institutional approvals strictly,
//  but every row the API ships now carries a clear, specific reason
//  in `display_status` + `display_reason` — never the generic
//  "No Trade" string.
//
//  Pure module — no I/O, no DB, no env reads. Re-usable from the
//  signals route, the stock-detail route, and the funnel builder.
// ════════════════════════════════════════════════════════════════

/** Spec INSTITUTIONAL §UX-SIMPLIFY (2026-05) — operator-facing
 *  display is binary: tradable institutional signal, or not.
 *  The detailed `rejection_code` taxonomy below remains available
 *  as a sub-badge inside the REJECTED tab so the operator can still
 *  see WHY each row failed (LOW_CONFIDENCE / LOW_RR / DEVELOPING_SETUP /
 *  DEFERRED_WAIT_TRIGGER / etc), but the top-level tab structure is
 *  just APPROVED vs REJECTED. */
export type DisplayStatus =
  | 'APPROVED'
  | 'REJECTED';

/** Specific reject codes that replace the legacy "NO_TRADE" pill.
 *  Every rejected row carries exactly one of these so the UI can
 *  render a specific badge + tooltip per cause. */
export type RejectionCode =
  | 'REJECTED_LOW_CONFIDENCE'
  | 'REJECTED_LOW_FINAL_SCORE'
  | 'REJECTED_LOW_RR'
  | 'REJECTED_MARKET_REGIME'
  | 'REJECTED_HIGH_VOLATILITY'
  | 'REJECTED_STALE_DATA'
  | 'REJECTED_FAILED_STABILITY'
  | 'REJECTED_LIVE_INVALIDATED'
  | 'REJECTED_PORTFOLIO_FIT'
  | 'REJECTED_RISK_TOO_HIGH'
  | 'REJECTED_INVALID_PRICES'
  | 'REJECTED_NO_STRATEGY'
  | 'REJECTED_DUPLICATE'
  | 'REJECTED_LOW_LIQUIDITY'
  | 'REJECTED_LOW_MATURITY'
  | 'REJECTED_LOW_CYCLES'
  | 'REJECTED_NO_EDGE'
  | 'DEFERRED_WAIT_TRIGGER'
  | 'DEVELOPING_SETUP'
  | 'APPROVED'
  | 'UNKNOWN';

/** Approval-stage tag for funnel UI. Tells the operator how far down
 *  the pipeline this row went before it was deferred / rejected. */
export type ApprovalStage =
  | 'scanned'
  | 'matched'
  | 'scored'
  | 'gated'
  | 'approved'
  | 'promoted';

export interface ShaperRow {
  // Wide row shape — every consumer (confirmed snapshots, q365_signals,
  // closed-market shaper output) feeds in optional fields. Anything
  // missing falls through to UNKNOWN with a defensive default.
  symbol?:                string | null;
  tradingsymbol?:         string | null;
  direction?:             string | null;
  classification?:        string | null;
  raw_classification?:    string | null;
  signal_status?:         string | null;
  status?:                string | null;
  invalidation_reason?:   string | null;
  live_invalidated?:      boolean | null;
  live_valid?:            boolean | number | null;
  execution_allowed?:     boolean | null;
  rejection_reason?:      string | null;
  rejection_codes?:       string[] | null;
  scenario_tag?:          string | null;
  conviction_band?:       string | null;
  confidence_band?:       string | null;
  confidence?:            number | null;
  confidence_score?:      number | null;
  final_score?:           number | null;
  rr_ratio?:              number | null;
  risk_reward?:           number | null;
  risk_score?:            number | null;
  stress_survival_score?: number | null;
  stability_passed?:      boolean | number | null;
  validation_cycles_passed?: number | null;
  maturity_score?:        number | null;
  market_regime?:         string | null;
  generated_at?:          string | Date | null;
  confirmed_at?:          string | Date | null;
}

export interface DisplayShape {
  symbol:             string;
  display_status:     DisplayStatus;
  display_reason:     string;       // human-readable single sentence
  rejection_code:    RejectionCode;
  approval_stage:    ApprovalStage;
  // Flattened scoring fields for the UI table.
  confidence:        number | null;
  final_score:       number | null;
  rr:                number | null;
  regime:            string | null;
  classification:    string | null;
  signal_status:     string | null;
  execution_allowed: boolean;
  // Original rejection_reason (whatever upstream wrote), for tooltips.
  rejection_reason:  string | null;
}

// Spec INSTITUTIONAL §M (4) — generic NO_TRADE → specific code based
// on the dominant gate that fired. Pattern-matches on the upstream
// rejection_reason / rejection_codes / scenario_tag fields. The match
// order matters: more-specific matches first (e.g. RR is a more
// useful badge than the generic LOW_FINAL_SCORE which RR also drags).
const REJECT_PATTERNS: Array<{ code: RejectionCode; rx: RegExp }> = [
  { code: 'REJECTED_LOW_RR',           rx: /reward[- ]?risk|r[: ]?r |rr_ratio|rr |\bRR\b/i },
  { code: 'REJECTED_LOW_CONFIDENCE',   rx: /confidence (too )?low|conf (\d+) below|low confidence/i },
  { code: 'REJECTED_LOW_FINAL_SCORE',  rx: /final[- ]?score|low score|composite/i },
  { code: 'REJECTED_HIGH_VOLATILITY',  rx: /volatil|atr|high vol/i },
  { code: 'REJECTED_MARKET_REGIME',    rx: /regime|counter[- ]regime|capital[- ]?preservation/i },
  { code: 'REJECTED_STALE_DATA',       rx: /stale|stop[_ ]?loss[_ ]?broken|target[_ ]?reached|expired/i },
  { code: 'REJECTED_FAILED_STABILITY', rx: /stability|unstable|stable=false/i },
  { code: 'REJECTED_LIVE_INVALIDATED', rx: /live[_ ]?invalidated|live[_ ]?reject|engine[_ ]?disagree|revalid/i },
  { code: 'REJECTED_PORTFOLIO_FIT',    rx: /portfolio|fit (too )?low|sector|correlation/i },
  { code: 'REJECTED_RISK_TOO_HIGH',    rx: /risk too high|total risk|risk_score|risk band/i },
  { code: 'REJECTED_INVALID_PRICES',   rx: /invalid_prices|invalid prices|entry|stop|target/i },
  { code: 'REJECTED_NO_STRATEGY',      rx: /no_strategy|no strategy|NO_STRATEGY/i },
  { code: 'REJECTED_DUPLICATE',        rx: /dupl|already exists|duplicate_active/i },
  { code: 'REJECTED_LOW_LIQUIDITY',    rx: /liquid|volume|min_volume/i },
  { code: 'REJECTED_LOW_MATURITY',     rx: /maturity|low_maturity/i },
  { code: 'REJECTED_LOW_CYCLES',       rx: /cycles|low_cycles/i },
  { code: 'REJECTED_NO_EDGE',          rx: /no_edge|edge|expected[_ ]?edge/i },
];

/**
 * Map an arbitrary rejection_reason / rejection_codes string to the
 * specific UI-facing code. Pattern-matched in declaration order, so
 * the most useful badge wins for ambiguous text. Returns UNKNOWN
 * when no pattern matches — operator can grep `display_reason` for
 * the literal text in that case.
 */
export function mapRejectionToCode(
  reason?: string | null,
  codes?: string[] | null,
): RejectionCode {
  // Prefer explicit rejection_codes when present (rejection engine
  // sets these; they're already canonical).
  if (codes && codes.length > 0) {
    for (const c of codes) {
      const u = String(c ?? '').toUpperCase();
      if (u === 'NO_STRATEGY')         return 'REJECTED_NO_STRATEGY';
      if (u === 'CAPITAL_PRESERVATION') return 'REJECTED_MARKET_REGIME';
      if (u.includes('LIQUIDITY'))     return 'REJECTED_LOW_LIQUIDITY';
      if (u.includes('PORTFOLIO'))     return 'REJECTED_PORTFOLIO_FIT';
      if (u.includes('RISK'))          return 'REJECTED_RISK_TOO_HIGH';
      if (u.includes('STALE'))         return 'REJECTED_STALE_DATA';
    }
  }
  const text = String(reason ?? '').trim();
  if (!text) return 'UNKNOWN';
  for (const p of REJECT_PATTERNS) {
    if (p.rx.test(text)) return p.code;
  }
  return 'UNKNOWN';
}

/**
 * Build the operator-facing display sentence. Combines the code with
 * the actual numeric values from the row when available so the badge
 * tooltip reads like "REJECTED · LOW_CONFIDENCE · confidence=52 < 60".
 */
function buildDisplayReason(
  code: RejectionCode,
  row: ShaperRow,
): string {
  const conf = row.confidence_score ?? row.confidence ?? null;
  const fs   = row.final_score ?? null;
  const rr   = row.rr_ratio ?? row.risk_reward ?? null;
  const risk = row.risk_score ?? null;
  switch (code) {
    case 'APPROVED':
      return 'All checks passed — institutional grade';
    case 'DEFERRED_WAIT_TRIGGER':
      return 'Awaiting confirmation trigger — monitor for entry';
    case 'DEVELOPING_SETUP':
      return 'Setup is forming — not yet tradable';
    case 'REJECTED_LOW_CONFIDENCE':
      return conf != null
        ? `confidence=${conf} below institutional floor`
        : 'confidence below institutional floor';
    case 'REJECTED_LOW_FINAL_SCORE':
      return fs != null
        ? `final_score=${fs} below institutional floor`
        : 'final_score below institutional floor';
    case 'REJECTED_LOW_RR':
      return rr != null
        ? `risk_reward=${rr} below required minimum (≥1.5)`
        : 'risk_reward below required minimum';
    case 'REJECTED_MARKET_REGIME':
      return row.market_regime
        ? `market regime "${row.market_regime}" vetoes this signal`
        : 'market regime veto';
    case 'REJECTED_HIGH_VOLATILITY':
      return 'volatility too high — wider stop than risk model permits';
    case 'REJECTED_STALE_DATA':
      return 'price action invalidated — stop hit / target reached / expired';
    case 'REJECTED_FAILED_STABILITY':
      return 'stability not yet established (needs ≥2 stable cycles)';
    case 'REJECTED_LIVE_INVALIDATED':
      return 'live revalidation rejected — engine disagree';
    case 'REJECTED_PORTFOLIO_FIT':
      return 'portfolio fit below floor — sector / correlation / capacity';
    case 'REJECTED_RISK_TOO_HIGH':
      return risk != null
        ? `risk_score=${risk} > 75 ceiling`
        : 'total risk above ceiling';
    case 'REJECTED_INVALID_PRICES':
      return 'entry / stop / target geometry invalid';
    case 'REJECTED_NO_STRATEGY':
      return 'no strategy pattern matched current price action';
    case 'REJECTED_DUPLICATE':
      return 'already an active signal for this symbol+direction';
    case 'REJECTED_LOW_LIQUIDITY':
      return 'volume below institutional liquidity floor';
    case 'REJECTED_LOW_MATURITY':
      return 'maturity score below promotion floor';
    case 'REJECTED_LOW_CYCLES':
      return 'fewer than 2 validation cycles — promote needs more confirmations';
    case 'REJECTED_NO_EDGE':
      return 'expected edge below 1% — payoff geometry too thin';
    case 'UNKNOWN':
    default:
      return row.rejection_reason
        ? `engine: ${row.rejection_reason}`
        : 'no specific reason provided';
  }
}

/**
 * Professional, user-facing labels for the badge text. The internal
 * RejectionCode enum is for operators; users see institutional trading
 * terminology — "Trade Ready", "Awaiting Confirmation", "Liquidity
 * Blocked" — never raw enum strings like "DEVELOPING_SETUP" or
 * "REJECTED_LOW_CONFIDENCE".
 *
 * Spec UX-PROFESSIONAL-LABELS (operator-defined mapping):
 *   APPROVED                  → "Trade Ready"
 *   DEVELOPING_SETUP          → "Awaiting Confirmation"
 *   DEFERRED_WAIT_TRIGGER     → "Awaiting Confirmation"
 *   REJECTED_LOW_LIQUIDITY    → "Liquidity Blocked"
 *   REJECTED_RISK_TOO_HIGH    → "Risk Veto"
 *   REJECTED_PORTFOLIO_FIT    → "Portfolio Conflict"
 *   REJECTED_HIGH_VOLATILITY  → "Volatility Restricted"
 *   REJECTED_MARKET_REGIME    → "Market Regime Conflict"
 *   REJECTED_LIVE_INVALIDATED → "Live Revalidation Failed"
 *   REJECTED_LOW_CONFIDENCE   → "Confidence Insufficient"
 *   REJECTED_LOW_RR           → "Reward/Risk Insufficient"
 *   REJECTED_LOW_FINAL_SCORE  → "Score Insufficient"
 *   REJECTED_FAILED_STABILITY → "Stability Pending"
 *   REJECTED_NO_STRATEGY      → "No Setup Detected"
 *   REJECTED_DUPLICATE        → "Already Active"
 *   REJECTED_LOW_MATURITY     → "Maturity Pending"
 *   REJECTED_LOW_CYCLES       → "Validation Pending"
 *   REJECTED_NO_EDGE          → "Edge Insufficient"
 *   REJECTED_INVALID_PRICES   → "Pricing Invalid"
 *   REJECTED_STALE_DATA       → "Setup Invalidated"
 *
 * Context overrides (when `ctx` carries the row's provenance flags):
 *   is_scanner_candidate=true → "Emerging Opportunity"
 *   is_relaxed=true (no scanner_candidate) → "Early Opportunity"
 *   classification=WATCHLIST_ONLY (no developing context) → "Monitor"
 *   execution_allowed=false (no specific reject code) → "Risk Restricted"
 *
 * The technical RejectionCode is preserved on the badge's title/tooltip
 * for operator inspection — only the visible label is humanized.
 */
const PROFESSIONAL_LABEL: Record<RejectionCode, string> = {
  APPROVED:                  'Trade Ready',
  DEVELOPING_SETUP:          'Awaiting Confirmation',
  DEFERRED_WAIT_TRIGGER:     'Awaiting Confirmation',
  REJECTED_LOW_CONFIDENCE:   'Confidence Insufficient',
  REJECTED_LOW_FINAL_SCORE:  'Score Insufficient',
  REJECTED_LOW_RR:           'Reward/Risk Insufficient',
  REJECTED_HIGH_VOLATILITY:  'Volatility Restricted',
  REJECTED_MARKET_REGIME:    'Market Regime Conflict',
  REJECTED_STALE_DATA:       'Setup Invalidated',
  REJECTED_FAILED_STABILITY: 'Stability Pending',
  REJECTED_LIVE_INVALIDATED: 'Live Revalidation Failed',
  REJECTED_PORTFOLIO_FIT:    'Portfolio Conflict',
  REJECTED_RISK_TOO_HIGH:    'Risk Veto',
  REJECTED_INVALID_PRICES:   'Pricing Invalid',
  REJECTED_NO_STRATEGY:      'No Setup Detected',
  REJECTED_DUPLICATE:        'Already Active',
  REJECTED_LOW_LIQUIDITY:    'Liquidity Blocked',
  REJECTED_LOW_MATURITY:     'Maturity Pending',
  REJECTED_LOW_CYCLES:       'Validation Pending',
  REJECTED_NO_EDGE:          'Edge Insufficient',
  UNKNOWN:                   'Under Review',
};

export interface ProfessionalLabelContext {
  /** Row carries is_relaxed=true (surfaced via the relaxed-pool fallback). */
  is_relaxed?:          boolean | null;
  /** Row carries is_scanner_candidate=true. */
  is_scanner_candidate?: boolean | null;
  /** Row's execution_allowed flag — false marks a hard veto by the
   *  execution gate even when no specific reject code was attached. */
  execution_allowed?:   boolean | null;
  /** Raw classification string (NO_TRADE / WATCHLIST_ONLY / etc.) used
   *  for the "Monitor" override on bare WATCHLIST_ONLY rows. */
  classification?:      string | null;
}

/**
 * Map an internal RejectionCode + optional row context to the
 * professional, user-facing label. Single source of truth for label
 * text shown on the signals table badge AND the stock-detail
 * Execution Readiness panel — both surfaces must use this so they
 * never disagree on terminology.
 */
export function toProfessionalLabel(
  code: RejectionCode,
  ctx?: ProfessionalLabelContext,
): string {
  // Provenance overrides for the relaxed/scanner pool. These take
  // priority over the bare code mapping because they tell the user
  // WHERE the row came from, which is more actionable than a generic
  // "Awaiting Confirmation" for every row in that pool.
  if (ctx?.is_scanner_candidate === true) return 'Emerging Opportunity';
  if (ctx?.is_relaxed === true && code === 'APPROVED') return 'Early Opportunity';
  // WATCHLIST_ONLY without developing context renders as the softer
  // "Monitor" — distinct from "Awaiting Confirmation" which implies
  // an active setup forming.
  const cls = String(ctx?.classification ?? '').toUpperCase();
  if (cls === 'WATCHLIST_ONLY' && code !== 'DEVELOPING_SETUP') return 'Monitor';
  // Hard execution veto with no specific reject code → "Risk Restricted".
  if (ctx?.execution_allowed === false && code === 'UNKNOWN') return 'Risk Restricted';
  return PROFESSIONAL_LABEL[code] ?? 'Under Review';
}

/** Spec INSTITUTIONAL §UX-SIMPLIFY — binary tab classification.
 *  APPROVED is reserved for the institutional whitelist + executable
 *  rows; everything else is REJECTED. The detailed `rejection_code`
 *  carries the WHY (LOW_CONFIDENCE / DEVELOPING_SETUP / etc) for the
 *  per-row badge inside the REJECTED tab. */
function resolveDisplayStatus(row: ShaperRow, _code: RejectionCode): DisplayStatus {
  const ss   = String(row.signal_status ?? '').toUpperCase();
  const exec = row.execution_allowed === true;
  if (ss === 'APPROVED_SIGNAL' && exec) return 'APPROVED';
  return 'REJECTED';
}

/** Resolve approval_stage — how far this row got down the pipeline. */
function resolveApprovalStage(row: ShaperRow, status: DisplayStatus): ApprovalStage {
  if (status === 'APPROVED')   return 'approved';
  if (row.classification != null) return 'scored';
  if (row.signal_status != null) return 'gated';
  return 'matched';
}

/**
 * Convert any row into the operator-facing display shape. Pure
 * function — same input → same output. Safe to call from any layer.
 */
export function toDisplayRow(row: ShaperRow): DisplayShape {
  const symbol = String(row.symbol ?? row.tradingsymbol ?? '').toUpperCase();
  const cls    = String(row.classification ?? '').toUpperCase();
  const rawCls = String(row.raw_classification ?? '').toUpperCase().trim();
  const ss     = String(row.signal_status ?? '').toUpperCase();
  const execAllowed = row.execution_allowed === true;

  // Pre-resolve code so the display sentence + status both use it.
  let code: RejectionCode;
  if (ss === 'APPROVED_SIGNAL' && execAllowed) {
    code = 'APPROVED';
  } else if (rawCls === 'DEVELOPING_SETUP' || cls === 'DEVELOPING_SETUP' || ss === 'DEVELOPING_SETUP') {
    code = 'DEVELOPING_SETUP';
  } else if (rawCls === 'WATCHLIST_ONLY' || cls === 'WATCHLIST_ONLY') {
    code = 'DEFERRED_WAIT_TRIGGER';
  } else if (row.live_invalidated === true || (row.live_valid === false || row.live_valid === 0)) {
    code = 'REJECTED_LIVE_INVALIDATED';
  } else if (row.invalidation_reason) {
    code = mapRejectionToCode(row.invalidation_reason, row.rejection_codes);
    if (code === 'UNKNOWN') code = 'REJECTED_STALE_DATA';
  } else {
    code = mapRejectionToCode(row.rejection_reason, row.rejection_codes);
  }

  const status = resolveDisplayStatus(row, code);
  const reason = buildDisplayReason(code, row);
  const stage  = resolveApprovalStage(row, status);

  return {
    symbol,
    display_status:     status,
    display_reason:     reason,
    rejection_code:     code,
    approval_stage:     stage,
    confidence:         row.confidence_score ?? row.confidence ?? null,
    final_score:        row.final_score ?? null,
    rr:                 row.rr_ratio ?? row.risk_reward ?? null,
    regime:             row.market_regime ?? null,
    classification:     row.classification ?? null,
    signal_status:      row.signal_status ?? null,
    execution_allowed:  execAllowed,
    rejection_reason:   row.rejection_reason ?? row.invalidation_reason ?? null,
  };
}

/** Bulk variant for callers that already have a typed array. */
export function toDisplayRows(rows: readonly ShaperRow[]): DisplayShape[] {
  return rows.map(toDisplayRow);
}
