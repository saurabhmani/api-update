// Dual-source market data — canonical types for cross-vendor validation.

export type FeedSourceId = 'yahoo' | 'kite';

export type ValidationStatus =
  | 'confirmed'
  | 'pending_validation'
  | 'single_source'
  | 'no_reliable_data'
  | 'data_mismatch';

export type ApprovalStatus =
  | 'approved'
  | 'held'
  | 'awaiting_confirmation'
  | 'rejected';

export type ConfirmationStatus =
  | 'confirmed'
  | 'pending'
  | 'single_source'
  | 'mismatch'
  | 'stale'
  | 'unavailable';

export type ConfidenceBand =
  | 'institutional'   // 98–100
  | 'high'            // 90–97
  | 'moderate'        // 80–89
  | 'reject';         // <80

/** Normalized tick from any vendor — never overwrites the other source. */
export interface NormalizedFeedTick {
  symbol:       string;
  exchange:     string;
  source:       FeedSourceId;
  ltp:          number;
  open:         number;
  high:         number;
  low:          number;
  close:        number;
  volume:       number;
  bid:          number | null;
  ask:          number | null;
  change:       number;
  changePercent: number;
  sourceTimestamp: number;
  receivedAt:     number;
  latencyMs:      number;
  raw?:           Record<string, unknown>;
}

export interface SourceFetchResult {
  source:    FeedSourceId;
  ok:        boolean;
  tick:      NormalizedFeedTick | null;
  error:     string | null;
  latencyMs: number;
}

export interface CrossSourceMetrics {
  priceDiffBps:      number | null;
  volumeDiffPct:     number | null;
  timestampSkewMs:   number | null;
  ohlcConsistent:    boolean | null;
  outlierDetected:   boolean;
  missingCandles:    boolean;
  delayedUpdate:     boolean;
}

export interface FeedValidationResult {
  symbol:            string;
  status:            ValidationStatus;
  metrics:           CrossSourceMetrics;
  yahoo:             NormalizedFeedTick | null;
  kite:              NormalizedFeedTick | null;
  reasons:           string[];
  validatedAt:       number;
}

export interface ApprovalDecision {
  symbol:              string;
  allowed:             boolean;
  status:              ApprovalStatus;
  validationStatus:    ValidationStatus;
  confidenceScore:     number;
  confidenceBand:      ConfidenceBand;
  authoritativeSource: FeedSourceId | null;
  authoritativeLtp:    number | null;
  reasons:             string[];
  decidedAt:           number;
}

export interface ConfirmationResult {
  symbol:             string;
  status:             ConfirmationStatus;
  validation:         FeedValidationResult;
  approval:           ApprovalDecision;
  indicatorsAgree:    boolean | null;
  institutionalPass:  boolean | null;
  riskPass:           boolean | null;
  dataFreshnessLive:  boolean;
  confirmedAt:        number;
}

export interface DualSourceBatchResult {
  symbol:       string;
  validation:   FeedValidationResult;
  approval:     ApprovalDecision;
  confirmation: ConfirmationResult;
  publishTick:  NormalizedFeedTick | null;
}

export interface DualSourceConfig {
  enabled:                 boolean;
  priceToleranceBps:       number;
  volumeTolerancePct:      number;
  timestampToleranceMs:    number;
  outlierSpikeBps:         number;
  allowSingleSourceSignals: boolean;
  authoritativeOnConflict: FeedSourceId | null;
  minConfidenceForSignal:  number;
  yahooConcurrency:        number;
  kiteConcurrency:       number;
}

export interface DualSourceMonitoringSnapshot {
  enabled:              boolean;
  yahoo:                FeedHealthSlice;
  kite:                 FeedHealthSlice;
  lastValidationAt:     number | null;
  symbolsTracked:       number;
  confirmedCount:       number;
  pendingCount:         number;
  mismatchCount:        number;
  singleSourceCount:    number;
  noDataCount:          number;
  recent:               Array<{
    symbol:             string;
    validationStatus:   ValidationStatus;
    approvalStatus:     ApprovalStatus;
    confirmationStatus: ConfirmationStatus;
    confidenceScore:    number;
    yahooLtp:           number | null;
    kiteLtp:          number | null;
    priceDiffBps:       number | null;
    validatedAt:        number;
  }>;
}

export interface FeedHealthSlice {
  source:          FeedSourceId;
  lastSuccessAt:   number | null;
  lastErrorAt:     number | null;
  lastError:       string | null;
  successCount:    number;
  errorCount:      number;
  avgLatencyMs:    number;
  lastLtp:         number | null;
}
