'use client';
// ════════════════════════════════════════════════════════════════
//  useSignalsPolling — single hook owning the data + polling stack
//  for /signals.
//
//  Extracted from src/app/signals/page.tsx as the first step of the
//  page-component split. Behaviour is preserved byte-for-byte; the
//  only change is location. The page now passes one input
//  (`pipelineRunning`) and consumes the returned object.
//
//  Owns:
//    • State: signals / emerging / loading / freshness / lkgWarning /
//             scanProgress / directionFlips / termLogs.
//    • Refs:  reqSeqRef / loadAbortRef / pollStartedRef / autoRanRef /
//             LKG refs (batchId / responseAt / rowsCount) /
//             lastSseFingerprintRef / autoRebuild refs /
//             prevDirectionByIdRef / directionFlipClearRef.
//    • Handlers: pushLog / acceptResponse / commitAccepted /
//                load / triggerAutoRebuild / autoRefreshIfStale.
//    • Live transports: useLivePrices (WS), useSignalStream (SSE).
//    • All useEffects: SSE handler, direction-flip detector,
//                      5-min auto-scan, initial-load + 5s poll,
//                      WS connect log, UI tick, 10s Yahoo fallback poll. // @deprecated marker
//
//  Stays in the page: tab, query, search, runPipeline, render.
//
//  Why one large hook rather than four small ones: every piece of
//  state above co-mutates inside `acceptResponse` / `commitAccepted`
//  / `load`. Splitting them produced cyclic ref-passing. Future
//  passes can decompose further once the polling subsystem stops
//  changing weekly.
// ════════════════════════════════════════════════════════════════

import { useEffect, useState, useRef, MutableRefObject } from 'react';
import { useLivePrices } from '@/lib/hooks/useLivePrices';
import { useSignalStream } from './useSignalStream';
import type { SignalExplanation } from '@/types/phase11Signal';

// ── Shared row contract ──────────────────────────────────────────
//
// The full SignalRow shape lives here so the page and any future
// extracted components (ConfirmedSignalsTable, EmergingOpportunitiesPanel)
// can import it without circular references back into the page file.
export interface SignalRow {
  id:                number;
  tradingsymbol:     string;
  /** Some API payloads (bootstrap rows, Phase-12 promoted snapshots)
   *  carry the raw `symbol` column alongside `tradingsymbol`. The
   *  page reads `tradingsymbol ?? symbol` defensively when assembling
   *  the dedupe key, so the optional field is part of the row shape. */
  symbol?:           string | null;
  exchange:          string;
  direction:         string | null;
  isExtra?:          boolean;
  timeframe:         string;
  confidence:        number;
  confidence_score:  number;
  conviction_band:   string | null;
  risk_score:        number;
  risk:              string;
  opportunity_score: number;
  entry_price:       number;
  stop_loss:         number;
  target1:           number;
  target2:           number | null;
  risk_reward:       number;
  regime:            string;
  market_stance:     string;
  scenario_tag:      string;
  factor_scores:     Record<string, number> | null;
  ltp:               number | null;
  pct_change:        number | null;
  livePrice:         number | null;
  livePChange:       number | null;
  liveSource:        string | null;
  liveTickTs?:       number | null;
  live_invalidated?:    boolean;
  live_warnings?:       string[];
  live_penalty_applied?: number;
  generated_at:      string;
  final_score?:            number | null;
  classification?:         string | null;
  signal_status?:          string | null;
  portfolio_fit_score?:    number | null;
  stress_survival_score?:  number | null;
  recommended_quantity?:   number | null;
  recommended_capital?:    number | null;
  live_valid?:             boolean | null;
  rejection_codes?:        string[];
  rejection_reasons?:      string[];
  live_validation_reasons?: string[];
  explanation?:            SignalExplanation | null;
  profit_percent?:           number | null;
  loss_percent?:             number | null;
  expected_edge_percent?:    number | null;
  win_probability?:          number | null;
  validation_gates_passed?:  number | null;
  valid_until?:              string | null;
  status?:                   string | null;
  confirmed_at?:             string | null;
  maturity_score?:                   number | null;
  validation_cycles_passed?:         number | null;
  signal_age_minutes_at_promotion?:  number | null;
  conviction_level?:                 'MEDIUM' | 'HIGH' | 'INSTITUTIONAL' | string | null;
  stability_passed?:                 boolean | null;
  /** Spec SMART-RELAXED — true when the row passed the relaxed
   *  predicate but NOT the strict main-table gate. The UI renders
   *  "⚠️ Early Signal" instead of "Confirmed" for these rows. */
  is_relaxed?:                       boolean;
  // PHASE_2_DUE_DILIGENCE_2026-05 — per-row enrichments attached
  // server-side. Optional so older payloads still type-check.
  dueDiligence?:                     DueDiligenceReview;
  performanceReview?:                PerformanceReview;
  // ── Phase 3 + 5 + 6 institutional decision gate ─────────────
  // Populated by enrichSignalIntelligence on the server. The UI
  // prefers `effectiveApprovalStatus` / `effectiveAction` for the
  // user-facing decision and surfaces `decisionChanged` /
  // `demotionReason` / `institutionalBlockers` as supporting
  // context. Raw fields are kept for diagnostics. Optional so
  // older payloads / non-enriched tiers still type-check.
  rawApprovalStatus?:                'APPROVED' | 'WATCHLIST' | 'REJECTED' | 'AVOID' | null;
  effectiveApprovalStatus?:          'APPROVED' | 'WATCHLIST' | 'REJECTED' | 'AVOID' | null;
  rawAction?:                        'APPROVED' | 'WATCHLIST' | 'REJECTED' | 'AVOID' | null;
  effectiveAction?:                  'APPROVED' | 'WATCHLIST' | 'REJECTED' | 'AVOID' | null;
  decisionChanged?:                  boolean | null;
  demotionReason?:                   string | null;
  institutionalBlockers?:            string[] | null;
  institutionalWarnings?:            string[] | null;
  decisionTrace?:                    Array<{ layer: string; reason: string; severity: string; meta?: unknown }> | null;
}

// ── LKG envelope (subset of API response) ────────────────────────
type LkgEnvelope = {
  response_generated_at?: string | null;
  validation_status?:     string | null;
  empty_confirmed?:       boolean;
  is_partial_scan?:       boolean;
  latest_batch_id?:       string | null;
  emerging_opportunities?: SignalRow[] | null;
  request_id?:            string | null;
  mode?:                  'market_closed' | 'live' | string | null;
};

// ── Scan-progress shape (for the inline header badge) ────────────
export interface ScanProgress {
  done:       number;
  total:      number;
  inFlight:   boolean;
  lastSymbol: string | null;
  startedAt:  number;
}

// ── Legacy Kite status shape ──────────────────────────────────── // @deprecated marker
// In Yahoo-only mode we always return null at runtime, but the page's // @deprecated marker
// render code still uses optional-chaining on these fields. Typing
// the slot as a wide nullable union keeps that code TS-clean.
export interface KiteStatusShape { // @deprecated marker
  connected?:      boolean;
  loginRequired?:  boolean;
  marketIsOpen?:   boolean;
  marketLabel?:    string;
  lastTickTimeIST?: string | null;
  lastTickIST?:    string | null;
  tickAgeMs?:      number | null;
  tickRatePerSec?: number | null;
  lastError?:      string | null;
}

export interface UseSignalsPollingOptions {
  /** Driven by the page's `runPipeline` flow. The 5-min auto-scan and
   *  the auto-rebuild trigger inside `load` skip when this is true so
   *  a manual run isn't double-fired by the auto layer. */
  pipelineRunning: boolean;
}

/** Market-closed envelope surfaced by /api/signals when the NSE
 *  cash session is closed. The page renders `market_data` instead
 *  of the (empty) signals list whenever `mode === 'market_closed'`. */
export interface MarketClosedEnvelope {
  mode:         'market_closed';
  /** `last_close_signals` is what the route sets when the closed-market
   *  signal loader produced rows from q365_signals (bootstrap-seeded
   *  or otherwise persisted strict/relaxed-tier signals). The other
   *  two values mean "no signals — only the snapshot price view" or
   *  "no data at all". */
  data_source:  'last_close_signals' | 'market_close_snapshot' | 'none';
  message:      string;
  market_state: 'closed' | 'pre-open' | 'holiday' | string;
  market_label: string;
  market_data:  Array<{
    symbol:         string;
    price:          number;
    change:         number | null;
    change_percent: number | null;
    volume:         number | null;
    open:           number | null;
    high:           number | null;
    low:            number | null;
    prev_close:     number | null;
    timestamp:      string;
  }>;
  /** Spec MAIN-TABLE-STRICT §4 — scanner candidates that didn't clear
   *  the maturity gate. Surfaced separately so the dashboard can
   *  render a "Scanner Candidates (Not Yet Tradable)" panel without
   *  polluting the confirmed signals table. Always defined; empty
   *  when nothing is in the pipeline. */
  scanner_candidates: SignalRow[];
  /** Unified counter block for the top summary cards and diagnostic banners. */
  counters: {
    approvedTotal:       number;
    approvedBuy:         number;
    approvedSell:        number;
    highPotentialTotal:  number;
    watchlistTotal:      number;
    rejectedTotal:       number;
    /** Sum of all non-approved candidates. */
    candidateTotal:      number;
  };
}

// Spec INSTITUTIONAL §UX-SIMPLIFY — binary tab data. The polling hook
// surfaces the institutional `rejected[]` pool and the dominant-cause
// funnel so the REJECTED tab can render without a second fetch. Shape
// is the wire shape from `signalDisplayShaper.DisplayShape` /
// `signalFunnelBuilder.SignalFunnel` — duplicated as a structural type
// so the page imports stay flat.
export interface RejectedDisplayRow {
  symbol:             string;
  display_status:     'APPROVED' | 'REJECTED';
  display_reason:     string;
  rejection_code:     string;
  approval_stage:     string;
  confidence:         number | null;
  final_score:        number | null;
  rr:                 number | null;
  regime:             string | null;
  classification:     string | null;
  signal_status:      string | null;
  execution_allowed:  boolean;
  rejection_reason:   string | null;
}

// PRODUCTION_TABS_2026-05 — collapsed to four production tabs.
// Backend tier fields stay granular (developing / scanner_candidates /
// watchlist / risk_restricted) but the UI groups them so users always
// see meaningful data:
//   APPROVED       → signals[]
//   HIGH_POTENTIAL → high_potential[]
//   WATCHLIST      → developing[] + scanner_candidates[] + watchlist[]
//   REJECTED       → rejected[] + risk_restricted[]
// The server's `default_tab` field can still emit the granular labels
// (AWAITING_CONFIRMATION / EMERGING_OPPORTUNITY / MONITOR /
// RISK_RESTRICTED); the page maps those onto WATCHLIST / REJECTED.
export type DashboardTab =
  | 'APPROVED'
  | 'HIGH_POTENTIAL'
  | 'WATCHLIST'
  | 'REJECTED';

export interface TierCounts {
  execution_ready:        number;
  high_potential:         number;
  awaiting_confirmation:  number;
  emerging_opportunity:   number;
  monitor:                number;
  risk_restricted:        number;
}

export interface ConditionalFloors {
  confidence: number;
  rr:         number;
  max_rows:   number;
}

export interface SignalFunnelSummary {
  scanned:                  number;
  matched:                  number;
  approved:                 number;
  rejected:                 number;
  rejected_low_confidence:  number;
  rejected_rr:              number;
  rejected_market_regime:   number;
  rejected_stale:           number;
  rejected_stability:       number;
  rejected_other:           number;
  window_minutes?:          number;
}

export interface MarketStatus {
  isOpen: boolean;
  label:  string;
  state:  string;
}

export interface DataFreshness {
  isStale:    boolean;
  ageMinutes: number;
  label:      string;
}

export interface SignalCounters {
  approvedTotal:       number;
  approvedBuy:         number;
  approvedSell:        number;
  highPotentialTotal:  number;
  watchlistTotal:      number;
  rejectedTotal:       number;
  /** Sum of all non-approved candidates. */
  candidateTotal:      number;
}

// ── PHASE_1_RANKING_AND_NEAREST_SIGNAL_2026-05 ──
export type ClosestSourceTier =
  | 'high_potential'
  | 'watchlist'
  | 'developing'
  | 'scanner_candidate'
  | 'rejected_soft';

export interface ClosestToApprovalRow {
  symbol:                 string;
  tradingsymbol:          string | null;
  direction:              string | null;
  final_score:            number | null;
  confidence_score:       number | null;
  risk_reward:            number | null;
  approvalGap:            number;
  approvalGapPercent:     number;
  missingApprovalFactors: string[];
  nearestSignalRank:      number;
  sourceTier:             ClosestSourceTier;
  isClosestToApproval:    boolean;
  status:                 string;
  is_stale?:              boolean;
  is_bootstrap?:          boolean;
  // PHASE_2_DUE_DILIGENCE_2026-05
  dueDiligence?:          DueDiligenceReview;
  performanceReview?:     PerformanceReview;
}

// ── PHASE_2_DUE_DILIGENCE_2026-05 ──
export type DueDiligenceStatus = 'PASSED' | 'FAILED' | 'PENDING' | 'NOT_AVAILABLE';
export type DueDiligenceSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface DueDiligenceReview {
  status:               DueDiligenceStatus;
  summary:              string;
  primaryReason:        string;
  secondaryReasons:     string[];
  confirmationPassed:   string[];
  confirmationFailed:   string[];
  riskFindings:         string[];
  dataFindings:         string[];
  marketFindings:       string[];
  indicatorFindings:    string[];
  performanceFindings:  string[];
  learningNotes:        string[];
  nextAction:           string;
  severity:             DueDiligenceSeverity;
  explainabilityScore:  number;
}

export type PerformanceReviewStatus = 'PENDING' | 'COMPLETED' | 'INSUFFICIENT_DATA';
export type PerformanceOutcome = 'SUCCESS' | 'FAILED' | 'NEUTRAL' | 'PENDING' | 'UNKNOWN';
export type PerformanceReviewWindow = '15M' | '30M' | '1H' | 'EOD' | 'MULTI_DAY' | null;

export interface PerformanceReview {
  reviewStatus:             PerformanceReviewStatus;
  entryPrice:               number | null;
  currentPrice:             number | null;
  targetPrice:              number | null;
  stopLoss:                 number | null;
  movePercent:              number | null;
  maxFavorableMovePercent:  number | null;
  maxAdverseMovePercent:    number | null;
  targetHit:                boolean | null;
  stopLossHit:              boolean | null;
  timeToTargetMinutes:      number | null;
  timeToStopMinutes:        number | null;
  reviewWindow:             PerformanceReviewWindow;
  outcome:                  PerformanceOutcome;
  insufficientDataReasons:  string[];
}

export interface DueDiligenceBlockedReason {
  reason: string;
  count:  number;
}

export interface DueDiligenceSummary {
  totalReviewed:              number;
  approvedReviewed:           number;
  highPotentialReviewed:      number;
  watchlistReviewed:          number;
  rejectedReviewed:           number;
  topBlockReasons:            DueDiligenceBlockedReason[];
  highScoreNotApproved:       number;
  staleBlocked:               number;
  lowRiskRewardBlocked:       number;
  volumePending:              number;
  marketConfirmationPending:  number;
  dataQualityWarnings:        number;
}

// ── PHASE_3_DAILY_INTELLIGENCE_2026-05 ──
export type DailyReportDataStatus =
  | 'LIVE' | 'STALE' | 'FALLBACK' | 'BOOTSTRAP' | 'INSUFFICIENT_DATA';
export type DailyReportStatus =
  | 'COMPLETE' | 'PARTIAL' | 'PENDING' | 'INSUFFICIENT_DATA';

export interface DailyReportPreview {
  reportDate:             string;
  reportStatus:           DailyReportStatus;
  headline:               string;
  approvedWinRate:        number | null;
  highPotentialPerformed: number | null;
  topBlockReason:         string | null;
  dataStatus:             DailyReportDataStatus;
  ready:                  boolean;
}

// ── PHASE_5_HEALTH_OBSERVABILITY_2026-05 ──
export type EngineHealthOverallStatus =
  | 'HEALTHY' | 'WARNING' | 'DEGRADED' | 'BROKEN' | 'UNKNOWN';

export interface EngineHealthPreview {
  overallStatus:               EngineHealthOverallStatus;
  canGenerateApprovedSignals:  boolean;
  canGenerateCandidates:       boolean;
  primaryBlockingReason:       string | null;
  engineHealthUrl:             string;
}

export interface ClosestToApprovalEnvelope {
  total:        number;
  signals:      ClosestToApprovalRow[];
  generatedAt:  string;
  reason:       string;
}

export interface UseSignalsPollingResult {
  // ── Data the page renders ──
  signals:        SignalRow[];
  /** Spec INSTITUTIONAL §UX-SIMPLIFY — REJECTED tab pool. Every
   *  scanned row that did NOT pass institutional approval, with its
   *  per-row `rejection_code` sub-badge. */
  rejected:       RejectedDisplayRow[];
  /** Spec §UX-SIMPLIFY — dominant-cause funnel summary for the
   *  REJECTED-tab header. */
  funnel:         SignalFunnelSummary | null;
  /** @deprecated Spec §UX-SIMPLIFY — Emerging Opportunities section
   *  retired; emerging_opportunities is always []. Kept on the result
   *  shape so existing destructures don't break. New UI must read
   *  `rejected` instead. */
  emerging:       SignalRow[];
  loading:        boolean;
  freshness:      any;
  lkgWarning:     string | null;
  scanProgress:   ScanProgress | null;
  directionFlips: { sellToBuy: Set<number>; buyToSell: Set<number> };
  termLogs:       string[];
  /** Two-tier filter status from the latest /api/signals response.
   *  Drives the "High Confidence" / "Medium Confidence" badge. */
  signalQuality:  'STRICT' | 'RELAXED' | 'NONE' | null;
  /** Non-null only when the API returned mode=market_closed. Null
   *  during live market hours. The page should render a market-data
   *  list instead of the (empty) signals card when this is set. */
  marketClosed:   MarketClosedEnvelope | null;
  // ── INSTITUTIONAL_TIER_2026-05 + CONDITIONAL_FALLBACK_2026-05 ──
  // Five-tier wire fields. The page renders one tab per tier reading
  // these arrays directly. signals[] above is the strict APPROVED
  // tier; the fields below carry every other quality bucket the
  // engine produced.
  highPotential:          SignalRow[];
  developing:             SignalRow[];
  /** Top-level `scanner_candidates` array from the live tier wire
   *  shape. Mirrors `marketClosed.scanner_candidates` from the
   *  closed-market path so the EMERGING tab reads from the same
   *  field name regardless of mode. */
  scannerCandidates:      SignalRow[];
  watchlist:              SignalRow[];
  riskRestricted:         SignalRow[];
  conditionalModeActive:  boolean;
  tierCounts:             TierCounts | null;
  emptyStateMessage:      string | null;
  /** Server's hint for which tab to land on when the page first
   *  renders — APPROVED when signals[] non-empty, HIGH_POTENTIAL
   *  when conditional fallback engaged, etc. */
  defaultTab:             DashboardTab | null;
  conditionalFloors:      ConditionalFloors | null;

  // ── FIX FINAL SIGNAL VISIBILITY 2026-05 ──
  marketStatus:           MarketStatus | null;
  dataFreshness:          DataFreshness | null;
  reasonSummary:          string | null;
  lastApiRequestAt:       string | null;
  lastSuccessAt:          string | null;
  isBootstrap:            boolean;
  isFallback:             boolean;
  approvedSignals:        SignalRow[];
  /** Numeric count of Tier 1 approved signals. */
  approvedCount:          number;
  highPotentialSignals:   SignalRow[];
  watchlistSignals:       SignalRow[];
  rejectedSignals:        any[];
  counters:               SignalCounters | null;

  // ── PHASE_1_RANKING_AND_NEAREST_SIGNAL_2026-05 ──
  /** Wire envelope from the backend describing the top non-approved
   *  candidates by approval gap. Always present (with empty signals
   *  array when approved set is non-empty); the page renders the
   *  "Closest to Approval" section only when counters.approvedTotal === 0. */
  closestToApproval:      ClosestToApprovalEnvelope | null;
  nearestSignals:         ClosestToApprovalRow[];

  // ── PHASE_2_DUE_DILIGENCE_2026-05 ──
  /** Aggregate due-diligence stats across every reviewed tier. Drives
   *  the top "Due Diligence Summary" strip on the Signal Engine page. */
  dueDiligenceSummary:    DueDiligenceSummary | null;

  // ── PHASE_3_DAILY_INTELLIGENCE_2026-05 ──
  /** Lightweight preview of the daily report. The Signal Engine page
   *  renders a small badge / link to the full report at /signals/daily-report. */
  dailyReportPreview:     DailyReportPreview | null;

  // ── PHASE_5_HEALTH_OBSERVABILITY_2026-05 ──
  /** Lightweight engine-health preview. The Signal Engine page renders
   *  an overall-status chip + a link to /signals/engine-health. */
  healthPreview:          EngineHealthPreview | null;

  // ── Live transports passed through ──
  wsPrices:     ReturnType<typeof useLivePrices>['prices'];
  wsConnected:  boolean;
  wsLastAt:     number | null;
  wsMarketOpen: boolean;
  // Always null in Yahoo-only mode, but typed as a wide nullable // @deprecated marker
  // union so render code that does `kiteStatus?.marketIsOpen`, // @deprecated marker
  // `kiteStatus?.connected`, etc. type-checks. Mirrors the original // @deprecated marker
  // inline declaration in page.tsx.
  kiteStatus:   null | KiteStatusShape; // @deprecated marker
  stream:       ReturnType<typeof useSignalStream>;

  // ── Actions the page calls ──
  pushLog:            (line: string) => void;
  load:               (opts?: { spinner?: boolean; heavy?: boolean }) => Promise<void>;
  triggerAutoRebuild: (reason: string) => Promise<void>;

  // ── Refs the page's runPipeline reads ──
  lkgBatchIdRef: MutableRefObject<string | null>;
}

export function useSignalsPolling(opts: UseSignalsPollingOptions): UseSignalsPollingResult {
  const { pipelineRunning } = opts;

  const [signals,  setSignals]  = useState<SignalRow[]>([]);
  // Spec §UX-SIMPLIFY — Emerging Opportunities retired. The state is
  // kept (always []) so legacy destructures don't crash; the page
  // never renders this list.
  const [emerging, setEmerging] = useState<SignalRow[]>([]);
  // Spec INSTITUTIONAL §UX-SIMPLIFY — REJECTED tab pool + funnel
  // summary. Hydrated from the same /api/signals payload that ships
  // signals[]; SSE pushes don't carry these fields, so the REJECTED
  // tab is HTTP-poll-driven (acceptable: it changes on the same
  // cadence as q365_signals writes, not per tick).
  const [rejected, setRejected] = useState<RejectedDisplayRow[]>([]);
  const [funnel,   setFunnel]   = useState<SignalFunnelSummary | null>(null);
  const [loading,  setLoading]  = useState(true);
  // LKG persistence: once we have signals, we hold them even during loading
  // to prevent flickering. This is the "mask" the SRE spec requested.
  const hasDataRef = useRef(false);
  const [freshness, setFreshness] = useState<any>(null);
  // Two-tier filter status — server emits 'STRICT' | 'RELAXED' | 'NONE'
  // on every /api/signals response. The page renders a badge ("High
  // Confidence" / "Medium Confidence") off this so operators see why
  // borderline rows are appearing in tier-2 mode.
  const [signalQuality, setSignalQuality] =
    useState<'STRICT' | 'RELAXED' | 'NONE' | null>(null);
  const [termLogs, setTermLogs] = useState<string[]>([]);
  // Set when the API returns mode='market_closed'. Null during live
  // market hours. The page reads this to render the market-data list.
  const [marketClosed, setMarketClosed] = useState<MarketClosedEnvelope | null>(null);
  // INSTITUTIONAL_TIER_2026-05 + CONDITIONAL_FALLBACK_2026-05 — five-tier
  // dashboard state. signals[] above remains the strict APPROVED tier;
  // these arrays hold every other quality bucket the engine produced
  // so the page can render one tab per tier without re-fetching.
  const [highPotential,         setHighPotential]         = useState<SignalRow[]>([]);
  const [developing,            setDeveloping]            = useState<SignalRow[]>([]);
  const [scannerCandidates,     setScannerCandidates]     = useState<SignalRow[]>([]);
  const [watchlist,             setWatchlist]             = useState<SignalRow[]>([]);
  const [riskRestricted,        setRiskRestricted]        = useState<SignalRow[]>([]);
  const [conditionalModeActive, setConditionalModeActive] = useState<boolean>(false);
  const [tierCounts,            setTierCounts]            = useState<TierCounts | null>(null);
  const [emptyStateMessage,     setEmptyStateMessage]     = useState<string | null>(null);
  const [defaultTab,            setDefaultTab]            = useState<DashboardTab | null>(null);
  const [conditionalFloors,     setConditionalFloors]     = useState<ConditionalFloors | null>(null);

  // ── FIX FINAL SIGNAL VISIBILITY 2026-05 ──
  const [marketStatus,          setMarketStatus]          = useState<MarketStatus | null>(null);
  const [dataFreshness,         setDataFreshness]         = useState<DataFreshness | null>(null);
  const [reasonSummary,         setReasonSummary]         = useState<string | null>(null);
  const [lastApiRequestAt,      setLastApiRequestAt]      = useState<string | null>(null);
  const [lastSuccessAt,         setLastSuccessAt]         = useState<string | null>(null);
  const [isBootstrap,           setIsBootstrap]           = useState<boolean>(false);
  const [isFallback,            setIsFallback]            = useState<boolean>(false);
  const [approvedSignals,       setApprovedSignals]       = useState<SignalRow[]>([]);
  const [approvedCount,         setApprovedCount]         = useState<number>(0);
  const [highPotentialSignals,  setHighPotentialSignals]  = useState<SignalRow[]>([]);
  const [watchlistSignals,      setWatchlistSignals]      = useState<SignalRow[]>([]);
  const [rejectedSignals,       setRejectedSignals]       = useState<any[]>([]);
  const [counters,              setCounters]              = useState<SignalCounters | null>(null);
  // PHASE_1_RANKING_AND_NEAREST_SIGNAL_2026-05 — closest-to-approval
  // envelope. Hydrated from the same /api/signals payload that ships
  // signals[]. The "Closest to Approval" page section reads from these
  // states; if backend omits, frontend falls back to computing locally.
  const [closestToApproval,     setClosestToApproval]     = useState<ClosestToApprovalEnvelope | null>(null);
  const [nearestSignals,        setNearestSignals]        = useState<ClosestToApprovalRow[]>([]);
  // PHASE_2_DUE_DILIGENCE_2026-05
  const [dueDiligenceSummary,   setDueDiligenceSummary]   = useState<DueDiligenceSummary | null>(null);
  // PHASE_3_DAILY_INTELLIGENCE_2026-05
  const [dailyReportPreview,    setDailyReportPreview]    = useState<DailyReportPreview | null>(null);
  // PHASE_5_HEALTH_OBSERVABILITY_2026-05
  const [healthPreview,         setHealthPreview]         = useState<EngineHealthPreview | null>(null);
  // Kite status polling removed — Yahoo-only mode. Market-hours info // @deprecated marker
  // now comes exclusively from the /api/signals freshness block.
  const kiteStatus: null | KiteStatusShape = null; // @deprecated marker

  // Monotonic request id — only the latest issued load() is allowed
  // to write into state. Any response that arrives after a newer
  // request has already been issued is discarded. This is what
  // prevents the heavy-then-light race where a slower stale response
  // overwrites a fresher one.
  const reqSeqRef = useRef(0);
  // Active AbortController for the in-flight HTTP load(). When a new
  // load() starts, it aborts any prior pending fetch so the newer
  // request actually wins on the wire instead of merely winning the
  // post-arrival sequence guard. Without this, a slow request issued
  // 30s ago could still resolve and consume CPU running JSON.parse +
  // commit logic before the seq guard rejects its result.
  const loadAbortRef = useRef<AbortController | null>(null);
  // Tracks whether the first heavy load has resolved, so we don't
  // start the 2s light poll until there is a stable baseline.
  const pollStartedRef = useRef(false);
  // One-shot guard: the stale-signal auto-refresh fires at most
  // once per page load, regardless of how many times load() runs.
  const autoRanRef = useRef(false);
  // ── Last-Known-Good (LKG) guard refs ─────────────────────────────
  // These prevent the populated → zero flicker by tracking the last
  // good state we accepted into React state. A new response is
  // committed only if it is both (a) newer-or-equal than what we
  // already have AND (b) one of: non-empty / explicitly empty-confirmed.
  // See acceptResponse() below for the full predicate.
  const lkgBatchIdRef    = useRef<string | null>(null);
  const lkgResponseAtRef = useRef<number | null>(null);
  const lkgRowsCountRef  = useRef<number>(0);
  // Latest server-issued request_id we've successfully applied. Used
  // to drop late-arriving responses whose request_id is older than the
  // most recent one already on screen — protects against the
  // race where two HTTP polls (or HTTP + SSE) land out-of-order and
  // the older response overwrites the newer table.
  const lkgServerRequestIdRef = useRef<string | null>(null);
  // Last-known mode (market_closed | live). Polling cadence and the
  // empty-overwrite guard depend on this. Kept as a ref because
  // the cadence-controlling effects must read the latest value
  // without re-subscribing on every change.
  const lastModeRef = useRef<'market_closed' | 'live' | null>(null);
  // Sticky-empty threshold removed per institutional-filter spec:
  // when the API ships empty_confirmed=true the UI clears immediately.
  const [lkgWarning, setLkgWarning] = useState<string | null>(null);

  // Fingerprint of the last applied SSE snapshot — id + direction +
  // final_score per row. With the stream pushing every 1s but the
  // engine only mutating data every few minutes, ~99% of frames carry
  // identical data. The fingerprint guard short-circuits setSignals on
  // those no-op frames, skipping the React reconciliation pass over
  // ~100 rows entirely. Kept in a ref so it never causes a render.
  const lastSseFingerprintRef = useRef<string>('');

  // ── Auto-rebuild on partial-scan / all-failed state ─────────────
  // When the latest batch covered <50% of the universe (or every
  // stored row failed the strict gate), kick the Yahoo full-universe // @deprecated marker
  // scanner silently in the background. No UI banner — once the new
  // batch lands the table populates naturally via the existing
  // SSE/poll path.
  const autoRebuildLastAtRef   = useRef<number>(0);
  const autoRebuildInFlightRef = useRef<boolean>(false);

  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);

  // ── Direction-flip tracking ────────────────────────────────────
  // Per-symbol previous direction map. When a new scan lands, any row
  // whose direction flipped (BUY → SELL or SELL → BUY) gets a 2.5s
  // CSS row flash. Tracked in a ref so updating it does NOT trigger
  // a re-render — only the resulting flip Sets (state) cause one
  // render burst per scan. Sets clear automatically.
  const prevDirectionByIdRef = useRef<Map<number, string>>(new Map());
  const [directionFlips, setDirectionFlips] = useState<{
    sellToBuy: Set<number>;
    buyToSell: Set<number>;
  }>({ sellToBuy: new Set(), buyToSell: new Set() });
  const directionFlipClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pushLog = (line: string) => {
    const ts = new Date().toLocaleTimeString();
    setTermLogs(prev => [`[${ts}] ${line}`, ...prev].slice(0, 200));
  };

  // ── Last-Known-Good acceptance gate ─────────────────────────────
  //
  // Refuses to overwrite a populated state with empty unless the API
  // explicitly confirms empty. Also rejects:
  //   - Stale batches      (latest_batch_id is older than what we have)
  //   - Stale wire payloads (response_generated_at older than last accepted)
  //   - Partial scans replacing a healthy full-scan view
  //   - Same-batch frames that would shrink the table by >30%
  const acceptResponse = (
    incoming: { rows: SignalRow[]; envelope: LkgEnvelope; transport: 'http' | 'sse' },
  ): { accept: boolean; reason: string } => {
    const { rows, envelope, transport } = incoming;
    const incomingTs    = envelope.response_generated_at
      ? new Date(envelope.response_generated_at).getTime()
      : null;
    const incomingBatch = envelope.latest_batch_id ?? null;
    const validation    = envelope.validation_status ?? null;
    const emptyConfirmed = envelope.empty_confirmed === true;
    const isPartial      = envelope.is_partial_scan === true;

    if (incomingTs != null && lkgResponseAtRef.current != null && incomingTs < lkgResponseAtRef.current) {
      return { accept: false, reason: `stale wire payload (older than last accepted by ${lkgResponseAtRef.current - incomingTs}ms)` };
    }

    // Spec §1: request_id guard. Server stamps every response with
    // a monotonic-ish id (e.g. `srv-{timestamp}-{random}`). When two
    // responses race (HTTP poll + SSE frame, or two overlapping
    // polls), the one with the smaller id is older. We compare
    // lexicographically — id format `srv-{Date.now()}-...` orders
    // identically to numeric, and falls back gracefully on ids that
    // don't match the pattern.
    const incomingReqId = envelope.request_id ?? null;
    if (incomingReqId && lkgServerRequestIdRef.current
        && incomingReqId < lkgServerRequestIdRef.current) {
      return {
        accept: false,
        reason: `stale request_id (${incomingReqId} < ${lkgServerRequestIdRef.current})`,
      };
    }

    if (incomingBatch && lkgBatchIdRef.current && incomingBatch < lkgBatchIdRef.current) {
      return { accept: false, reason: `older batch_id (${incomingBatch} < ${lkgBatchIdRef.current})` };
    }

    // Spec §2: prevent empty-overwrite under market_closed. The
    // closed-market loader can transiently return signals=[] when
    // the relaxed-fallback DB row has just been invalidated; we
    // refuse to clear the populated table on that frame regardless
    // of the empty_confirmed flag.
    const incomingMode = envelope.mode ?? null;
    if (
      rows.length === 0 &&
      lkgRowsCountRef.current > 0 &&
      incomingMode === 'market_closed'
    ) {
      return {
        accept: false,
        reason: `market_closed empty frame refused — holding ${lkgRowsCountRef.current} rows`,
      };
    }

    if (rows.length === 0 && lkgRowsCountRef.current > 0 && !emptyConfirmed) {
      return {
        accept: false,
        reason: `empty response without empty_confirmed (validation=${validation ?? 'unknown'}) — likely transport error, holding ${lkgRowsCountRef.current} rows`,
      };
    }

    if (isPartial && lkgRowsCountRef.current > 0 && (!incomingBatch || incomingBatch === lkgBatchIdRef.current)) {
      return {
        accept: false,
        reason: `partial scan refused while LKG holds ${lkgRowsCountRef.current} rows from a fuller batch`,
      };
    }

    if (
      lkgRowsCountRef.current > 0 &&
      rows.length > 0 &&
      incomingBatch &&
      incomingBatch === lkgBatchIdRef.current &&
      rows.length < lkgRowsCountRef.current * 0.7
    ) {
      return {
        accept: false,
        reason: `${transport} frame would shrink table ${lkgRowsCountRef.current} → ${rows.length} on same batch — refused`,
      };
    }

    return { accept: true, reason: 'ok' };
  };

  const commitAccepted = (envelope: LkgEnvelope, rows: SignalRow[]): void => {
    if (envelope.response_generated_at) {
      const ts = new Date(envelope.response_generated_at).getTime();
      if (Number.isFinite(ts)) lkgResponseAtRef.current = ts;
    }
    if (envelope.latest_batch_id) lkgBatchIdRef.current = envelope.latest_batch_id;
    if (envelope.request_id) lkgServerRequestIdRef.current = envelope.request_id;
    if (envelope.mode === 'market_closed' || envelope.mode === 'live') {
      lastModeRef.current = envelope.mode;
    }
    lkgRowsCountRef.current = rows.length;
    if (rows.length > 0 || envelope.empty_confirmed) {
      setLkgWarning(null);   // healthy (populated or confirmed-empty) → clear banner
    }
  };

  // ── load: HTTP poll path ───────────────────────────────────────
  // `heavy` = trigger pipeline + full refresh (first load, manual refresh).
  // `light` = fast re-read with live-price enrichment only (poll path).
  // The light path hits forceRefresh=false so the API skips the auto-
  // pipeline and just re-runs enrichWithLiveLtp against the DB rows —
  // sub-second round trip, safe to call every 2 seconds.
  const load = async (loadOpts: { spinner?: boolean; heavy?: boolean } = {}) => {
    const { spinner = true, heavy = true } = loadOpts;
    // Claim the next sequence number. Any response whose seq is not
    // the most recent one issued will be dropped on arrival via the
    // `mySeq !== reqSeqRef.current` guard below.
    const mySeq = ++reqSeqRef.current;
    // Auto-abort REMOVED — see prior commit. The seq counter alone
    // is sufficient protection: when a stale response finally lands,
    // the `mySeq !== reqSeqRef.current` check discards it before any
    // state mutation.
    const myController = new AbortController();
    loadAbortRef.current = myController;
    if (spinner) setLoading(true);
    try {
      const t0 = Date.now();
      const reqId = `cli-${mySeq}-${Date.now()}`;
      // limit=20 — the institutional-filter spec hard-caps the
      // confirmed-snapshot table to ≤20 rows on the server. Asking for
      // 20 keeps the URL honest. The server cap is binding regardless.
      const url = `/api/signals?action=all&limit=20&request_id=${encodeURIComponent(reqId)}`;
      const res = await fetch(url, { cache: 'no-store', signal: myController.signal });
      const data = await res.json();
      const rows: SignalRow[] = data.signals ?? [];

      if (mySeq !== reqSeqRef.current) {
        if (heavy) {
          pushLog(`[API] GET /api/signals  ${res.status}  (dropped — superseded by newer request)  ${Date.now() - t0}ms`);
        }
        return;
      }

      // Surface the market-closed envelope (or clear it when live)
      // so the page can render market_data immediately on this poll.
      // Update BEFORE the LKG accept-guard so that even a refused
      // response can still flip the UI between live ↔ market_closed.
      if (data.mode === 'market_closed') {
        setMarketClosed({
          mode:         'market_closed',
          data_source:  data.data_source ?? 'none',
          message:      data.message ?? '',
          market_state: data.market_state ?? 'closed',
          market_label: data.market_label ?? 'Market Closed',
          market_data:  Array.isArray(data.market_data) ? data.market_data : [],
          scanner_candidates: Array.isArray(data.scanner_candidates)
            ? (data.scanner_candidates as SignalRow[])
            : [],
          counters: data.counters && typeof data.counters === 'object'
            ? (data.counters as SignalCounters)
            : {
              approvedTotal: 0, approvedBuy: 0, approvedSell: 0,
              highPotentialTotal: 0, watchlistTotal: 0, rejectedTotal: 0,
              candidateTotal: 0
            },
        });
      } else {
        setMarketClosed(null);
      }

      const envelope = {
        response_generated_at: data.response_generated_at,
        validation_status:     data.validation_status,
        empty_confirmed:       data.empty_confirmed,
        is_partial_scan:       data.is_partial_scan,
        latest_batch_id:       data.latest_batch_id,
        request_id:            data.request_id,
        mode:                  data.mode,
      };
      const decision = acceptResponse({ rows, envelope, transport: 'http' });
      if (!decision.accept) {
        pushLog(`UI UPDATE SKIPPED (STALE) — http  request_id=${data.request_id ?? '?'}  reason=${decision.reason}`);
        if (data.validation_status === 'PARTIAL_SCAN') {
          setLkgWarning('Partial scan detected. Showing last full validated batch.');
        } else if (rows.length === 0 && lkgRowsCountRef.current > 0) {
          setLkgWarning('Latest refresh returned empty/partial data; showing last validated signals.');
        }
        return;
      }
      setSignals((prev) => {
        if (rows.length > 0) {
          hasDataRef.current = true;
          return rows;
        }
        // If incoming is empty but not confirmed-empty, hold previous signals
        if (prev.length > 0 && !envelope.empty_confirmed) {
          // eslint-disable-next-line no-console
          console.log('[SIGNALS_LKG_HOLD]', { prevLen: prev.length, reason: 'empty-but-not-empty-confirmed' });
          return prev;
        }
        return rows;
      });
      const emergingRows: SignalRow[] = (data.emerging_opportunities ?? []) as SignalRow[];
      setEmerging(emergingRows);
      // INSTITUTIONAL_TIER_2026-05 + CONDITIONAL_FALLBACK_2026-05 —
      // hydrate the five-tier dashboard fields. LKG-PRESERVE (2026-05):
      // when this poll's tier arrays are empty AND the response was
      // not explicitly empty_confirmed AND the prior cycle had rows,
      // we hold the previous tier arrays instead of clearing them.
      // This stops the flicker-to-empty / WATCHLIST↔REJECTED bounce
      // when the backend ships a transient empty frame.
      const incomingEmptyConfirmed = data.empty_confirmed === true;
      const tierApply = <T,>(incoming: unknown, prevLen: number, setter: (v: T[]) => void): void => {
        const arr = Array.isArray(incoming) ? (incoming as T[]) : [];
        if (arr.length === 0 && prevLen > 0 && !incomingEmptyConfirmed) {
          // Hold previous state; show a degraded banner.
          // eslint-disable-next-line no-console
          console.log('[TIER_LKG_HOLD]', { prevLen, reason: 'empty-but-not-empty-confirmed' });
          setLkgWarning((w) => w ?? 'Backend returned an empty tier frame — holding last validated rows.');
          return;
        }
        setter(arr);
      };
      // We can't read previous state synchronously here without a ref,
      // but functional setState gives us the prior length cleanly.
      setHighPotential((prev) => {
        const arr = Array.isArray(data.high_potential) ? (data.high_potential as SignalRow[]) : [];
        if (arr.length === 0 && prev.length > 0 && !incomingEmptyConfirmed) {
          // eslint-disable-next-line no-console
          console.log('[TIER_LKG_HOLD]', { tier: 'high_potential', prev: prev.length });
          return prev;
        }
        return arr;
      });
      setDeveloping((prev) => {
        const arr = Array.isArray(data.developing) ? (data.developing as SignalRow[]) : [];
        if (arr.length === 0 && prev.length > 0 && !incomingEmptyConfirmed) {
          // eslint-disable-next-line no-console
          console.log('[TIER_LKG_HOLD]', { tier: 'developing', prev: prev.length });
          return prev;
        }
        return arr;
      });
      setScannerCandidates((prev) => {
        const arr = Array.isArray(data.scanner_candidates) ? (data.scanner_candidates as SignalRow[]) : [];
        if (arr.length === 0 && prev.length > 0 && !incomingEmptyConfirmed) {
          // eslint-disable-next-line no-console
          console.log('[TIER_LKG_HOLD]', { tier: 'scanner_candidates', prev: prev.length });
          return prev;
        }
        return arr;
      });
      setWatchlist((prev) => {
        const arr = Array.isArray(data.watchlist) ? (data.watchlist as SignalRow[]) : [];
        if (arr.length === 0 && prev.length > 0 && !incomingEmptyConfirmed) {
          // eslint-disable-next-line no-console
          console.log('[TIER_LKG_HOLD]', { tier: 'watchlist', prev: prev.length });
          return prev;
        }
        return arr;
      });
      setRiskRestricted((prev) => {
        const arr = Array.isArray(data.risk_restricted) ? (data.risk_restricted as SignalRow[]) : [];
        if (arr.length === 0 && prev.length > 0 && !incomingEmptyConfirmed) {
          // eslint-disable-next-line no-console
          console.log('[TIER_LKG_HOLD]', { tier: 'risk_restricted', prev: prev.length });
          return prev;
        }
        return arr;
      });
      void tierApply;
      setConditionalModeActive(data.conditional_mode_active === true);
      setTierCounts(
        data.tier_counts && typeof data.tier_counts === 'object'
          ? (data.tier_counts as TierCounts)
          : null,
      );
      setEmptyStateMessage(
        typeof data.empty_state_message === 'string' ? data.empty_state_message : null,
      );
      setDefaultTab(
        typeof data.default_tab === 'string' ? (data.default_tab as DashboardTab) : null,
      );
      setConditionalFloors(
        data.conditional_floors && typeof data.conditional_floors === 'object'
          ? (data.conditional_floors as ConditionalFloors)
          : null,
      );

      // ── FIX FINAL SIGNAL VISIBILITY 2026-05 ──
      setMarketStatus(data.marketStatus ?? null);
      setDataFreshness(data.dataFreshness ?? null);
      setReasonSummary(data.reasonSummary ?? null);
      setLastApiRequestAt(data.lastApiRequestAt ?? null);
      setLastSuccessAt(data.lastSuccessAt ?? null);
      setIsBootstrap(data.isBootstrap === true);
      setIsFallback(data.isFallback === true);
      setApprovedSignals(Array.isArray(data.approvedSignals) ? data.approvedSignals : []);
      setApprovedCount(typeof data.approvedCount === 'number' ? data.approvedCount : (data.signals?.length ?? 0));
      setHighPotentialSignals(Array.isArray(data.highPotentialSignals) ? data.highPotentialSignals : []);
      setWatchlistSignals(Array.isArray(data.watchlistSignals) ? data.watchlistSignals : []);
      setRejectedSignals(Array.isArray(data.rejectedSignals) ? data.rejectedSignals : []);
      setCounters(
        data.counters && typeof data.counters === 'object'
          ? (data.counters as SignalCounters)
          : null,
      );

      // ── PHASE_1_RANKING_AND_NEAREST_SIGNAL_2026-05 ──
      // Closest-to-Approval / nearestSignals. Prefer backend-computed
      // envelope; fall back to a frontend-computed nearest set when the
      // backend omitted the field but approved set is empty and other
      // tiers have rows.
      if (data.closestToApproval && typeof data.closestToApproval === 'object'
          && Array.isArray((data.closestToApproval as any).signals)) {
        const env = data.closestToApproval as ClosestToApprovalEnvelope;
        setClosestToApproval(env);
        setNearestSignals(env.signals);
      } else if (Array.isArray(data.nearestSignals)) {
        const rowsArr = data.nearestSignals as ClosestToApprovalRow[];
        setClosestToApproval({
          total:       rowsArr.length,
          signals:     rowsArr,
          generatedAt: new Date().toISOString(),
          reason:      'No approved signal is available right now. Showing nearest candidates by final score and approval gap.',
        });
        setNearestSignals(rowsArr);
      } else {
        // Frontend fallback — build from local pools when backend
        // didn't surface the field. Mirrors backend logic.
        const approvedTotal = Number(
          (data.counters as any)?.approvedTotal
          ?? (Array.isArray(data.approvedSignals) ? data.approvedSignals.length : 0)
        );
        if (approvedTotal === 0) {
          const fallback = computeNearestFallback({
            highPotential: data.highPotentialSignals,
            watchlist:     data.watchlistSignals,
            developing:    data.developing,
            scanner:       data.scanner_candidates,
            rejected:      data.rejectedSignals,
          });
          setClosestToApproval({
            total:       fallback.length,
            signals:     fallback,
            generatedAt: new Date().toISOString(),
            reason:      'No approved signal is available right now. Showing nearest candidates by final score and approval gap.',
          });
          setNearestSignals(fallback);
        } else {
          setClosestToApproval({
            total:       0,
            signals:     [],
            generatedAt: new Date().toISOString(),
            reason:      'Approved signals available — closest-to-approval surfaced for reference only.',
          });
          setNearestSignals([]);
        }
      }
      // ── PHASE_2_DUE_DILIGENCE_2026-05 ──
      // Backend ships dueDiligenceSummary as an object on every response.
      // Defensive null-guard so a payload without the field doesn't
      // crash the hook on older deployments.
      if (data.dueDiligenceSummary && typeof data.dueDiligenceSummary === 'object') {
        setDueDiligenceSummary(data.dueDiligenceSummary as DueDiligenceSummary);
      } else {
        setDueDiligenceSummary(null);
      }

      // ── PHASE_3_DAILY_INTELLIGENCE_2026-05 ──
      if (data.dailyReportPreview && typeof data.dailyReportPreview === 'object') {
        setDailyReportPreview(data.dailyReportPreview as DailyReportPreview);
      } else {
        setDailyReportPreview(null);
      }

      // ── PHASE_5_HEALTH_OBSERVABILITY_2026-05 ──
      if (data.healthPreview && typeof data.healthPreview === 'object') {
        setHealthPreview(data.healthPreview as EngineHealthPreview);
      } else {
        setHealthPreview(null);
      }
      // Spec frontend-debug — print the new contract so an operator
      // can verify the page is reading the tier fields. One line per
      // poll; signature below dedupes inside the page render path.
      // eslint-disable-next-line no-console
      console.log('[TIER UI]', {
        signals:                 rows.length,
        high_potential:          Array.isArray(data.high_potential) ? data.high_potential.length : 0,
        developing:              Array.isArray(data.developing) ? data.developing.length : 0,
        scanner_candidates:      Array.isArray(data.scanner_candidates) ? data.scanner_candidates.length : 0,
        watchlist:               Array.isArray(data.watchlist) ? data.watchlist.length : 0,
        risk_restricted:         Array.isArray(data.risk_restricted) ? data.risk_restricted.length : 0,
        conditional_mode_active: data.conditional_mode_active === true,
        default_tab:             data.default_tab ?? null,
        empty_state_message:     data.empty_state_message ?? null,
      });
      // Spec INSTITUTIONAL §UX-SIMPLIFY — pull the REJECTED-tab pool
      // and dominant-cause funnel from the HTTP envelope. SSE doesn't
      // carry these fields; the REJECTED tab refreshes only on HTTP
      // polls. Always set (even to []/null) so a transition from
      // populated → empty clears the UI instead of showing stale rows.
      if (Array.isArray(data.rejected)) {
        setRejected((prev) => {
          const arr = data.rejected as RejectedDisplayRow[];
          if (arr.length === 0 && prev.length > 0 && !incomingEmptyConfirmed) {
            // eslint-disable-next-line no-console
            console.log('[TIER_LKG_HOLD]', { tier: 'rejected', prev: prev.length });
            return prev;
          }
          return arr;
        });
      } else {
        setRejected((prev) => (incomingEmptyConfirmed ? [] : prev));
      }
      if (data.funnel && typeof data.funnel === 'object') {
        setFunnel(data.funnel as SignalFunnelSummary);
      } else {
        setFunnel(null);
      }
      // Surface signal_quality so the page can render the badge. Falls
      // back to null when the server didn't include the field (live
      // path) so the badge component renders nothing.
      const sq = data.signal_quality;
      if (sq === 'STRICT' || sq === 'RELAXED' || sq === 'NONE') {
        setSignalQuality(sq);
      }
      commitAccepted(envelope, rows);
      // Spec §3: stop the spinner whenever a response arrives.
      // If we already have data, we keep loading=false to prevent flickering
      // the skeleton table over the top of existing LKG signals.
      if (rows.length > 0 || hasDataRef.current) {
        setLoading(false);
      } else {
        // Only keep loading=true if we still have zero rows and zero LKG.
        setLoading(false);
      }
      // Spec §8 debug log — kept stable so console grep works.
      // eslint-disable-next-line no-console
      console.log('API SIGNALS:', rows.length, '  rendered:', rows.length, '  quality:', sq ?? 'unknown');
      pushLog(`UI UPDATE APPLIED — http  request_id=${data.request_id ?? '?'}  rows=${rows.length}  mode=${data.mode ?? '?'}  quality=${sq ?? '?'}`);

      // ── Auto-rebuild detection ─────────────────────────────────
      // Fires the Yahoo full-universe scan automatically when the // @deprecated marker
      // user would otherwise see a partial-scan empty banner.
      const fresh = data.freshness ?? {};
      const marketOpen     = fresh.market_open !== false;
      const coverage       = data.scan_coverage_percent ?? fresh.scan_coverage_percent ?? null;
      const totalStored    = fresh.total_stored_signals ?? 0;
      const engineKind     = fresh.latest_batch_engine_kind ?? null;
      const isPartial      = data.is_partial_scan === true;
      const lowCoverage    = engineKind !== 'scanner'
        && coverage != null && coverage < 50;
      const allFailedGate  = rows.length === 0 && totalStored > 0;
      const tooFewSignals  = rows.length < 30 && totalStored > 0 && engineKind !== 'scanner';
      const dbCompletelyEmpty = totalStored === 0 && rows.length === 0;
      const allowOffHours = dbCompletelyEmpty;
      if (
        (marketOpen || allowOffHours) &&
        !pipelineRunning &&
        (isPartial || lowCoverage || allFailedGate || tooFewSignals || dbCompletelyEmpty)
      ) {
        const reason = isPartial
          ? `partial scan flagged (coverage=${coverage ?? '?'}%)`
          : lowCoverage
            ? `low coverage (${coverage}% of universe)`
            : tooFewSignals
              ? `thin main table (${rows.length} rows < 30 target)`
              : dbCompletelyEmpty
                ? `q365_signals empty (no signals ever persisted) — bootstrapping`
                : `${totalStored} stored row${totalStored === 1 ? '' : 's'} all failed strict gate`;
        void triggerAutoRebuild(reason);
      }

      if (typeof window !== 'undefined' && heavy) {
        const sellMatched = rows.filter((s) =>
          String(s.direction ?? '').toUpperCase().trim() === 'SELL'
        ).length;
        const buyMatched = rows.filter((s) =>
          String(s.direction ?? '').toUpperCase().trim() === 'BUY'
        ).length;
        // eslint-disable-next-line no-console
        console.log('[UI SIGNALS]', {
          total:         rows.length,
          buy:           buyMatched,
          sell:          sellMatched,
          api_breakdown: data.direction_breakdown ?? null,
          sample_dirs:   rows.slice(0, 5).map((r) => r.direction),
        });
        // eslint-disable-next-line no-console
        console.log('[SELL COUNT]', sellMatched);
      }
      if (data.freshness) {
        setFreshness({ ...data.freshness, is_partial_scan: data.is_partial_scan === true });
        // eslint-disable-next-line no-console
        console.log('[CLIENT] DATA DATE:', {
          signal_latest: data.freshness.signal_latest_generated,
          signal_age_min: data.freshness.signal_age_minutes,
          candle_latest: data.freshness.candle_latest_ts,
          candle_age_hours: data.freshness.candle_age_hours,
          tick_state: data.freshness.tick_ws_state,
          tick_newest_age_ms: data.freshness.tick_newest_age_ms,
          server_now: data.freshness.server_now,
        });
        if (heavy) {
          pushLog(
            `[FRESH] signal=${data.freshness.signal_latest_generated ?? '—'} (${data.freshness.signal_age_minutes ?? '?'}m)  ` +
            `candle=${data.freshness.candle_latest_ts ?? '—'} (${data.freshness.candle_age_hours ?? '?'}h)  ` +
            `ws=${data.freshness.tick_ws_state}`
          );
        }
      }
      if (heavy) {
        const buys  = rows.filter(s => s.direction === 'BUY').length;
        const sells = rows.filter(s => s.direction === 'SELL').length;
        pushLog(`[API] GET /api/signals  ${res.status}  rows=${rows.length} BUY=${buys} SELL=${sells}  ${Date.now() - t0}ms`);
      }
    } catch (e: any) {
      const isAbort =
        myController.signal.aborted ||
        e?.name === 'AbortError' ||
        e?.code === 20 ||
        e?.code === 'ABORT_ERR' ||
        String(e?.message ?? '').toLowerCase().includes('abort');
      if (isAbort) return;
      if (mySeq === reqSeqRef.current) {
        pushLog(`[API] GET /api/signals FAILED  ${e?.message ?? e}`);
      }
    }
    finally {
      if (spinner && mySeq === reqSeqRef.current) setLoading(false);
      if (loadAbortRef.current === myController) loadAbortRef.current = null;
    }
  };

  // ── Live transports ────────────────────────────────────────────
  const {
    prices: wsPrices,
    connected: wsConnected,
    lastAt: wsLastAt,
    marketOpen: wsMarketOpen,
  } = useLivePrices();

  const stream = useSignalStream(true);

  // ── SSE handler ────────────────────────────────────────────────
  // Replaces the need for a periodic /api/signals refetch. The server
  // pushes a fresh snapshot; we mirror it into state through the same
  // acceptResponse() gate the HTTP load() uses, so both transports are
  // subject to identical Last-Known-Good rules.
  useEffect(() => {
    if (!stream.lastPushAt) return;
    const rows = stream.signals as SignalRow[];
    const env  = stream.envelope ?? {
      response_generated_at:  null as string | null,
      validation_status:      null as string | null,
      empty_confirmed:        false,
      is_partial_scan:        false,
      latest_batch_id:        null as string | null,
      emerging_opportunities: null as any[] | null,
    };

    // Sync market-closed state from the SSE envelope so the banner
    // shows even when the stream beats the first HTTP poll. Mirrors
    // the same logic the HTTP load() runs above (line ~401). Without
    // this, a fresh page-load during off-hours sees an empty signals
    // table for ~5s before the first HTTP poll wakes up.
    const sseEnv = stream.envelope as any;
    if (sseEnv?.mode === 'market_closed') {
      setMarketClosed({
        mode:         'market_closed',
        data_source:  sseEnv.data_source ?? 'none',
        message:      sseEnv.message ?? '',
        market_state: sseEnv.market_state ?? 'closed',
        market_label: sseEnv.market_label ?? 'Market Closed',
        market_data:  Array.isArray(sseEnv.market_data) ? sseEnv.market_data : [],
        scanner_candidates: Array.isArray(sseEnv.scanner_candidates)
          ? (sseEnv.scanner_candidates as SignalRow[])
          : [],
        counters: sseEnv.counters ?? {
          approvedTotal: 0,
          approvedBuy: 0,
          approvedSell: 0,
          highPotentialTotal: 0,
          watchlistTotal: 0,
          rejectedTotal: 0,
          candidateTotal: 0,
        },
      });
    } else if (sseEnv?.mode === 'live') {
      setMarketClosed(null);
    }

    // Spec §4: stop polling/streaming updates when the server has
    // signalled market_closed. The static last-close payload is by
    // design immutable until market opens — every additional SSE
    // frame is wasted reconciliation work and a contention source
    // with the HTTP poll. Bail before the accept-gate so we don't
    // even pretend to consider it.
    if (lastModeRef.current === 'market_closed' && sseEnv?.mode !== 'live') {
      pushLog('UI UPDATE SKIPPED (STALE) — sse  reason=market_closed mode (static data)');
      return;
    }

    // Pass mode + request_id through to the gate so the request_id /
    // empty-overwrite checks fire on this transport too.
    const envWithMode = {
      ...(env as LkgEnvelope),
      mode:       sseEnv?.mode ?? null,
      request_id: sseEnv?.request_id ?? (env as any)?.request_id ?? null,
    };
    const decision = acceptResponse({ rows, envelope: envWithMode, transport: 'sse' });
    if (!decision.accept) {
      pushLog(`UI UPDATE SKIPPED (STALE) — sse  request_id=${envWithMode.request_id ?? '?'}  reason=${decision.reason}`);
      return;
    }

    // No-op frame fast-path. Most 1s SSE pushes carry the same rows
    // as the previous frame; skip React reconciliation when nothing
    // material changed. Fingerprint covers livePrice too.
    let fp = '';
    for (const r of rows) {
      fp += `${r.id}:${r.direction ?? ''}:${r.final_score ?? ''}:${r.livePrice ?? ''}|`;
    }
    if (fp === lastSseFingerprintRef.current && rows.length > 0) {
      commitAccepted(envWithMode, rows);
      return;
    }
    lastSseFingerprintRef.current = fp;

    setSignals(rows);
    if (rows.length > 0) {
      setLoading(false);
    }

    // Emerging update — SSE-vs-HTTP source split: if SSE has nothing
    // to add for emerging, let the HTTP poll continue to own it.
    if (env.emerging_opportunities && Array.isArray(env.emerging_opportunities) && env.emerging_opportunities.length > 0) {
      setEmerging(env.emerging_opportunities as SignalRow[]);
    }

    commitAccepted(envWithMode, rows);

    pushLog(`UI UPDATE APPLIED — sse  request_id=${envWithMode.request_id ?? '?'}  rows=${rows.length}  mode=${sseEnv?.mode ?? '?'}  changed=${stream.changedIds.size}  new=${stream.newIds.size}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream.lastPushAt]);

  // ── Direction-flip detector ───────────────────────────────────
  useEffect(() => {
    if (signals.length === 0) return;
    const sellToBuy = new Set<number>();
    const buyToSell = new Set<number>();
    for (const s of signals) {
      if (s.id == null) continue;
      const dir = String(s.direction ?? '').toUpperCase();
      const prev = prevDirectionByIdRef.current.get(s.id);
      if (prev != null && prev !== dir) {
        if (prev === 'SELL' && dir === 'BUY') sellToBuy.add(s.id);
        if (prev === 'BUY'  && dir === 'SELL') buyToSell.add(s.id);
      }
      prevDirectionByIdRef.current.set(s.id, dir);
    }
    if (sellToBuy.size === 0 && buyToSell.size === 0) return;

    setDirectionFlips({ sellToBuy, buyToSell });
    pushLog(`[DIRECTION FLIP] ${sellToBuy.size} → BUY (green), ${buyToSell.size} → SELL (red)`);

    if (directionFlipClearRef.current) clearTimeout(directionFlipClearRef.current);
    directionFlipClearRef.current = setTimeout(() => {
      setDirectionFlips({ sellToBuy: new Set(), buyToSell: new Set() });
      directionFlipClearRef.current = null;
    }, 2_500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signals]);

  // ── 5-min auto-scan ────────────────────────────────────────────
  useEffect(() => {
    const AUTO_SCAN_INTERVAL_MS = 5 * 60_000;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      if (autoRebuildInFlightRef.current) return;
      if (pipelineRunning) return;
      const marketOpen = freshness?.market_open !== false;
      if (!marketOpen) return;
      pushLog('[AUTO-SCAN] 5-min interval triggered — running full universe scan');
      void triggerAutoRebuild('5-min auto-refresh');
    }, AUTO_SCAN_INTERVAL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freshness?.market_open, pipelineRunning]);

  // ── Initial load + 5s poll ─────────────────────────────────────
  useEffect(() => {
    pushLog('[ENV] mode=' + (process.env.NODE_ENV ?? 'unknown') + '  page=/signals  transport=ws+sse');

    const loadingTimeoutId = setTimeout(() => {
      setLoading((cur) => {
        if (cur) {
          pushLog('[UI] initial load timed out after 30s — clearing spinner so empty-state renders');
        }
        return false;
      });
    }, 30_000);

    load({ heavy: true }).finally(() => {
      clearTimeout(loadingTimeoutId);
      autoRefreshIfStale();
    });

    // Spec §4: stop polling when market closed. Off-hours the
    // backend serves an immutable last-close payload — re-fetching
    // every 5s just races multiple async responses against each
    // other (the 0/4 flicker the user reported). We slow to a 60s
    // heartbeat so the page still detects market-open promptly,
    // and run the fast 5s cadence only during live hours.
    const FAST_POLL_MS  = 5_000;
    const SLOW_POLL_MS  = 60_000;
    let currentPollMs   = FAST_POLL_MS;
    let pollId: ReturnType<typeof setInterval>;
    const arm = () => {
      pollId = setInterval(() => {
        const wantMs = lastModeRef.current === 'market_closed' ? SLOW_POLL_MS : FAST_POLL_MS;
        if (wantMs !== currentPollMs) {
          clearInterval(pollId);
          currentPollMs = wantMs;
          pushLog(`[POLL] cadence → ${wantMs}ms (market_${lastModeRef.current ?? 'unknown'})`);
          arm();
          return;
        }
        load({ spinner: false, heavy: false });
      }, currentPollMs);
    };
    arm();

    return () => {
      clearTimeout(loadingTimeoutId);
      clearInterval(pollId);
      reqSeqRef.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (wsConnected) pushLog('[WS] connected — receiving live prices');
    else             pushLog('[WS] disconnected — attempting reconnect');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsConnected]);

  // ── UI tick (5s heartbeat) ────────────────────────────────────
  // Forces a re-render so "LAST TICK: Xs ago" stays fresh even when
  // the WS is silent. 5s granularity is plenty for a seconds-ago
  // display.
  const [, setUiTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setUiTick((t) => (t + 1) % 1_000_000), 5_000);
    return () => clearInterval(id);
  }, []);

  // ── Yahoo-fallback refresh poll (10s) ────────────────────────── // @deprecated marker
  useEffect(() => {
    const FALLBACK_POLL_MS = 10_000;
    const WS_ACTIVE_WINDOW_MS = 10_000;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const sseActive =
        stream.connected &&
        stream.lastPushAt != null &&
        Date.now() - stream.lastPushAt <= 15_000;
      if (sseActive) return;

      // Spec §4: hard stop when market closed. lastModeRef wins over
      // the freshness probe because it reflects what the SERVER
      // returned on the most recent /api/signals call — the freshness
      // block can lag if the freshness probe has its own caching.
      if (lastModeRef.current === 'market_closed') return;
      const marketClosed =
        (kiteStatus as { marketIsOpen?: boolean } | null)?.marketIsOpen === false || // @deprecated marker
        freshness?.market_open === false;
      if (marketClosed) return;

      const wsIsActive =
        wsConnected &&
        wsPrices.size > 0 &&
        wsLastAt != null &&
        Date.now() - wsLastAt <= WS_ACTIVE_WINDOW_MS;
      if (wsIsActive) return;
      load({ spinner: false, heavy: false });
    }, FALLBACK_POLL_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsConnected, wsLastAt, wsPrices, kiteStatus, freshness, stream.connected, stream.lastPushAt]); // @deprecated marker

  // ── triggerAutoRebuild ─────────────────────────────────────────
  const AUTO_REBUILD_COOLDOWN_MS = 5 * 60_000;
  const AUTO_REBUILD_DEADLINE_MS = 5 * 60_000;
  const triggerAutoRebuild = async (reason: string): Promise<void> => {
    if (autoRebuildInFlightRef.current) return;
    const since = Date.now() - autoRebuildLastAtRef.current;
    if (since < AUTO_REBUILD_COOLDOWN_MS) {
      pushLog(`[AUTO-REBUILD] skipped — cooldown (${Math.round((AUTO_REBUILD_COOLDOWN_MS - since) / 1000)}s remaining)`);
      return;
    }
    autoRebuildInFlightRef.current = true;
    autoRebuildLastAtRef.current   = Date.now();
    pushLog(`[AUTO-REBUILD] triggered — ${reason}`);
    try {
      // Concurrency intentionally NOT set: the scanner's flag-gated
      // default (4 when YAHOO_GLOBAL_LIMITER=true, 32 otherwise) is
      // the right policy. Hardcoding 32 here would override that and
      // re-introduce the breaker-trip on cold-start.
      const res = await fetch('/api/scanner/custom-universe/run?async=true', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          async:       true,
          dryRun:      false,
        }),
      });
      if (!res.ok && res.status !== 409) {
        pushLog(`[AUTO-REBUILD] POST returned ${res.status} — abandoning`);
        autoRebuildInFlightRef.current = false;
        return;
      }
      if (res.ok) {
        try {
          const body = await res.json();
          if (body?.batchId) {
            pushLog(`[AUTO-REBUILD] scanner accepted — batch=${body.batchId} · full universe (~2,767 symbols), concurrency=16`);
          }
        } catch { /* body parse failure is non-fatal */ }
      } else {
        pushLog('[AUTO-REBUILD] scanner already in flight — re-attaching to existing run');
      }

      const startBatch = lkgBatchIdRef.current;
      const deadline   = Date.now() + AUTO_REBUILD_DEADLINE_MS;
      let signalsPollTick = 0;
      let scannerFinishedSeen = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2_000));

        let scannerInFlight: boolean | null = null;
        try {
          const sres = await fetch('/api/scanner/custom-universe/status', { cache: 'no-store' });
          if (sres.ok) {
            const sjson = await sres.json();
            scannerInFlight = sjson?.inFlight === true;
            const p = sjson?.progress;
            if (p && typeof p.done === 'number' && typeof p.total === 'number') {
              setScanProgress({
                done:       p.done,
                total:      p.total,
                inFlight:   sjson.inFlight === true,
                lastSymbol: p.lastSymbol ?? null,
                startedAt:  p.startedAt ?? Date.now(),
              });
            } else if (sjson?.inFlight === false) {
              setScanProgress(null);
            }
          }
        } catch { /* status endpoint hiccup — keep last known progress */ }

        const justFinished = scannerInFlight === false && !scannerFinishedSeen;
        if (justFinished) scannerFinishedSeen = true;
        if (justFinished || (++signalsPollTick) % 2 === 0) {
          await load({ spinner: false, heavy: false });
          const cur = lkgBatchIdRef.current;
          if (cur && cur !== startBatch) {
            pushLog(`[AUTO-REBUILD] new batch landed: ${cur} (after ${Math.round((Date.now() - autoRebuildLastAtRef.current) / 1000)}s) — polling stopped`);
            setScanProgress(null);
            break;
          }
          if (justFinished) {
            pushLog('[AUTO-REBUILD] scanner finished but batch unchanged — stopping poll loop');
            setScanProgress(null);
            break;
          }
        }
      }
      if (Date.now() >= deadline) {
        pushLog('[AUTO-REBUILD] deadline reached — scanner still running, UI will refresh on next normal poll');
      }
    } catch (e: any) {
      pushLog(`[AUTO-REBUILD] failed: ${e?.message ?? e}`);
    } finally {
      autoRebuildInFlightRef.current = false;
      setScanProgress(null);
    }
  };

  // ── Stale-signal auto-refresh (one-shot per page load) ─────────
  // Fires from the initial-load .finally(). Reads /api/signals once
  // for the authoritative age, kicks the pipeline if stale, reloads.
  // Silent — pipelineRunning stays false so the Run button remains
  // clickable.
  const autoRefreshIfStale = async () => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;

    let ageMin: number | null = null;
    let marketOpen = true;
    try {
      const r = await fetch('/api/signals?action=all&limit=1', { cache: 'no-store' });
      if (r.ok) {
        const j = await r.json();
        ageMin     = j?.freshness?.signal_age_minutes ?? null;
        marketOpen = j?.freshness?.market_open !== false;
      }
    } catch { /* fall through — if we can't read, don't auto-run */ }

    if (ageMin == null || ageMin <= 15 || !marketOpen) {
      pushLog(`[AUTO] signals fresh (age=${ageMin ?? '?'}m, market_open=${marketOpen}) — skipping auto-run`);
      return;
    }

    pushLog(`[AUTO] signals stale (age=${ageMin}m) — auto-running pipeline in background`);
    try {
      const res = await fetch('/api/run-signal-engine', { method: 'POST' });
      if (!res.ok) {
        pushLog(`[AUTO] pipeline POST returned ${res.status} — skipping reload`);
        return;
      }
      await load({ spinner: false, heavy: true });
      pushLog('[AUTO] background pipeline complete — UI reloaded');
    } catch (e: any) {
      pushLog(`[AUTO] background pipeline failed: ${e?.message ?? e}`);
    }
  };

  // pollStartedRef is preserved as a load-tracking marker for any
  // future reader. Kept as a ref to avoid a render and to remain
  // byte-compatible with the prior page-level state. The variable is
  // referenced via the React hook lifecycle below; the linter sees it
  // as unused otherwise.
  void pollStartedRef;

  return {
    signals, rejected, funnel, emerging, loading, freshness, lkgWarning, scanProgress,
    directionFlips, termLogs, signalQuality, marketClosed,
    // INSTITUTIONAL_TIER_2026-05 + CONDITIONAL_FALLBACK_2026-05 fields.
    highPotential, developing, scannerCandidates, watchlist, riskRestricted,
    conditionalModeActive, tierCounts, emptyStateMessage,
    defaultTab, conditionalFloors,
    // ── FIX FINAL SIGNAL VISIBILITY 2026-05 ──
    marketStatus, dataFreshness, reasonSummary, lastApiRequestAt, lastSuccessAt,
    isBootstrap, isFallback, approvedSignals, approvedCount, highPotentialSignals, watchlistSignals,
    rejectedSignals, counters,
    // PHASE_1_RANKING_AND_NEAREST_SIGNAL_2026-05
    closestToApproval, nearestSignals,
    // PHASE_2_DUE_DILIGENCE_2026-05
    dueDiligenceSummary,
    // PHASE_3_DAILY_INTELLIGENCE_2026-05
    dailyReportPreview,
    // PHASE_5_HEALTH_OBSERVABILITY_2026-05
    healthPreview,
    wsPrices, wsConnected, wsLastAt, wsMarketOpen, kiteStatus, stream, // @deprecated marker
    pushLog, load, triggerAutoRebuild,
    lkgBatchIdRef,
  };
}

// ── PHASE_1_RANKING_AND_NEAREST_SIGNAL_2026-05 ──
// Frontend fallback when the backend response doesn't carry
// closestToApproval / nearestSignals. Mirrors the institutional logic
// in src/lib/signals/signalRanking.ts so the page never looks empty
// even on older deployments. We deliberately keep the math simple
// here so it's safe to run on every poll.

const APPROVAL_TARGET_FINAL_SCORE = 80;
const APPROVAL_TARGET_CONFIDENCE  = 75;
const APPROVAL_TARGET_RR          = 2.0;

function toFiniteNumber(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function buildMissingForFallback(row: any): string[] {
  const reasons: string[] = [];
  const fs = toFiniteNumber(row?.final_score ?? row?.composite_final_score ?? row?.institutional_score);
  const cs = toFiniteNumber(row?.confidence_score ?? row?.confidence);
  const rr = toFiniteNumber(row?.risk_reward ?? row?.rr_ratio);
  if (fs > 0 && fs < APPROVAL_TARGET_FINAL_SCORE) reasons.push(`Final score below ${APPROVAL_TARGET_FINAL_SCORE}`);
  if (cs > 0 && cs < APPROVAL_TARGET_CONFIDENCE)   reasons.push(`Confidence below ${APPROVAL_TARGET_CONFIDENCE}`);
  if (rr > 0 && rr < APPROVAL_TARGET_RR)           reasons.push(`Risk reward below ${APPROVAL_TARGET_RR.toFixed(1)}`);
  const fresh = String(row?.freshness_state ?? '').toUpperCase();
  const decay = String(row?.decay_state ?? '').toLowerCase();
  if (fresh === 'STALE' || decay === 'stale' || decay === 'aging') {
    reasons.push('Provider data is stale — awaiting fresh tick confirmation');
  }
  if (row?.is_developing_setup === true) reasons.push('Awaiting breakout confirmation');
  if (row?.is_scanner_candidate === true) reasons.push('Awaiting maturity confirmation');
  if (reasons.length === 0) reasons.push('Awaiting institutional confirmation');
  return reasons;
}

function isHardInvalidatedFallback(row: any): boolean {
  if (row?.live_invalidated === true) return true;
  if (row?.execution_allowed === false) return true;
  if (row?.invalidation_reason && String(row.invalidation_reason).trim() !== '') return true;
  const status = String(row?.status ?? '').toUpperCase();
  if (['INVALIDATED', 'EXPIRED', 'STOP_LOSS_HIT', 'CLOSED', 'CANCELLED', 'TERMINATED'].includes(status)) return true;
  return false;
}

function computeNearestFallback(pools: {
  highPotential?: unknown;
  watchlist?: unknown;
  developing?: unknown;
  scanner?: unknown;
  rejected?: unknown;
}): ClosestToApprovalRow[] {
  const seen = new Set<string>();
  const out: Array<{ row: ClosestToApprovalRow; gap: number; finalScore: number; confidence: number; rr: number }> = [];
  const tierMap: Array<{ pool: unknown; tier: ClosestSourceTier; soft: boolean }> = [
    { pool: pools.highPotential, tier: 'high_potential',    soft: false },
    { pool: pools.watchlist,     tier: 'watchlist',         soft: false },
    { pool: pools.developing,    tier: 'developing',        soft: false },
    { pool: pools.scanner,       tier: 'scanner_candidate', soft: false },
    { pool: pools.rejected,      tier: 'rejected_soft',     soft: true  },
  ];
  for (const { pool, tier } of tierMap) {
    if (!Array.isArray(pool)) continue;
    for (const row of pool as any[]) {
      if (!row) continue;
      if (isHardInvalidatedFallback(row)) continue;
      const symbol = String(row.symbol ?? row.tradingsymbol ?? '').trim();
      if (!symbol) continue;
      const key = symbol.toUpperCase();
      if (seen.has(key)) continue;
      const finalScore = toFiniteNumber(row.final_score ?? row.composite_final_score ?? row.institutional_score);
      const confidence = toFiniteNumber(row.confidence_score ?? row.confidence);
      const riskReward = toFiniteNumber(row.risk_reward ?? row.rr_ratio);
      if (finalScore === 0 && confidence === 0) continue;
      const finalGap      = Math.max(0, APPROVAL_TARGET_FINAL_SCORE - finalScore);
      const confidenceGap = Math.max(0, APPROVAL_TARGET_CONFIDENCE  - confidence);
      const rrGap         = Math.max(0, APPROVAL_TARGET_RR          - riskReward) * 10;
      const stalePenalty  = (String(row?.freshness_state ?? '').toUpperCase() === 'STALE'
                          || String(row?.decay_state ?? '').toLowerCase() === 'stale'
                          || String(row?.decay_state ?? '').toLowerCase() === 'aging') ? 10 : 0;
      const approvalGap = Math.round((finalGap + confidenceGap + rrGap + stalePenalty) * 100) / 100;
      const status = tier === 'high_potential'    ? 'High Potential'
                   : tier === 'watchlist'         ? 'Watchlist'
                   : tier === 'developing'        ? 'Awaiting Confirmation'
                   : tier === 'scanner_candidate' ? 'Emerging Opportunity'
                   :                                'Rejected (Soft)';
      out.push({
        row: {
          symbol,
          tradingsymbol:          row.tradingsymbol ?? symbol,
          direction:              row.direction ?? null,
          final_score:            finalScore > 0 ? finalScore : null,
          confidence_score:       confidence > 0 ? confidence : null,
          risk_reward:            riskReward > 0 ? riskReward : null,
          approvalGap,
          approvalGapPercent:     Math.min(100, Math.round(approvalGap)),
          missingApprovalFactors: buildMissingForFallback(row),
          nearestSignalRank:      0, // re-stamped after sort
          sourceTier:             tier,
          isClosestToApproval:    true,
          status,
          is_stale:               stalePenalty > 0 || undefined,
        },
        gap: approvalGap, finalScore, confidence, rr: riskReward,
      });
      seen.add(key);
    }
  }
  out.sort((a, b) => {
    if (a.gap !== b.gap) return a.gap - b.gap;
    if (a.finalScore !== b.finalScore) return b.finalScore - a.finalScore;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return b.rr - a.rr;
  });
  return out.slice(0, 5).map((entry, idx) => ({ ...entry.row, nearestSignalRank: idx + 1 }));
}
