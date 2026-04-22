// ════════════════════════════════════════════════════════════════
//  Manipulation Engine — Phase 1 Type System
//
//  This is the structured foundation for manipulation surveillance.
//  The design intentionally keeps direct proof language out of the
//  types themselves: Severity + confidence fields let each detector
//  speak probabilistically ("suspected", "probable") when daily
//  OHLCV alone cannot confirm the behavior.
// ════════════════════════════════════════════════════════════════

/**
 * Full event taxonomy — every detector must map to exactly one of these.
 * Do NOT collapse synonyms; surveillance value comes from specificity.
 */
export type EventType =
  | 'abnormal_volume_spike'
  | 'abnormal_turnover_spike'
  | 'abnormal_gap_behavior'
  | 'abnormal_intraday_range'
  | 'repeated_upper_shadow_distribution'
  | 'repeated_lower_shadow_absorption'
  | 'suspicious_close_ramping'
  | 'suspicious_opening_gap_fade'
  | 'range_expansion_without_followthrough'
  | 'breakout_with_weak_delivery_proxy'
  | 'operator_style_price_lifting'
  | 'circular_interest_suspected'
  | 'illiquid_price_marking'
  | 'probable_pump_risk'
  | 'probable_dump_risk';

export type Severity = 'low' | 'medium' | 'high' | 'severe';

export type SuspicionBand = 'low' | 'watch' | 'elevated' | 'high' | 'severe';

export interface SuspicionBucket {
  band: SuspicionBand;
  min: number;
  max: number;
  label: string;
}

// ── Inputs ──────────────────────────────────────────────────────

/** A single daily OHLCV bar, optionally enriched with turnover/delivery. */
export interface DailyBar {
  date: string;         // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Value traded (price × volume). Optional — not all feeds carry it. */
  turnover?: number;
  /** Delivery percentage proxy (0–100). Optional. */
  deliveryPct?: number;
}

export interface SymbolMeta {
  symbol: string;
  sector?: string;
  /** Pre-computed 20-day averages if the caller already has them. */
  avgVolume20?: number;
  avgTurnover20?: number;
}

// ── Features ────────────────────────────────────────────────────

export interface VolumeFeatures {
  volumeVs20dAvg: number;              // ratio: today / 20d avg
  turnoverVs20dAvg: number | null;     // null when turnover unavailable
  streakOfHighVolumeDays: number;      // consecutive days ≥ 2× avg
  volumePriceDivergenceFlag: boolean;  // high volume + flat/negative return
}

export interface CandleStructureFeatures {
  bodyPctOfRange: number;              // |close−open| / (high−low)
  upperShadowPct: number;              // (high−max(open,close)) / range
  lowerShadowPct: number;              // (min(open,close)−low) / range
  closeLocationInRange: number;        // (close−low) / range  ∈ [0,1]
  gapPct: number;                      // (open − prevClose) / prevClose × 100
  trueRangePct: number;                // TR / prevClose × 100
  abnormalRangeFlag: boolean;
}

export interface PriceBehaviorFeatures {
  return1d: number;                    // percent
  return3d: number;
  return5d: number;
  reversalAfterSpikeFlag: boolean;
  breakoutFollowthroughFlag: boolean | null;
  exhaustionFlag: boolean;
}

export interface LiquidityFragilityFeatures {
  avgVolume20: number;
  avgTurnover20: number | null;
  /** |return1d| / log(1 + volume) — higher = bigger move per unit of flow. */
  priceImpactProxy: number;
  illiquidityRiskFlag: boolean;
}

export interface CompositeAnomalyFeatures {
  repeatedRampPattern: boolean;
  repeatedDistributionPattern: boolean;
  eventClusterCount: number;           // anomalies in trailing N bars
  anomalyDensity20d: number;           // eventClusterCount / 20
}

/**
 * All features for one bar. This is the single object every detector
 * consumes — the feature builder is the one place that touches raw bars.
 */
export interface ManipulationFeatures extends
  VolumeFeatures,
  CandleStructureFeatures,
  PriceBehaviorFeatures,
  LiquidityFragilityFeatures,
  CompositeAnomalyFeatures {
  date: string;
  symbol: string;
}

// ── Detector contracts ──────────────────────────────────────────

export interface DetectorEvidence {
  key: string;
  value: number | string | boolean;
  description: string;
}

export interface DetectorResult {
  detectorName: string;
  eventType: EventType;
  triggered: boolean;
  /** 0–100 — this detector's contribution to the overall suspicion score. */
  detectorScore: number;
  /** Human-readable label ("Probable pump risk", "Distribution tail"). */
  detectorLabel: string;
  severity: Severity;
  /** 0–1 — how confident the detector is that the label fits. */
  confidence: number;
  evidence: DetectorEvidence[];
}

/**
 * Detectors receive the feature for the bar they're evaluating PLUS a
 * trailing window of features so they can reason about repetition,
 * clustering, and before/after behavior without re-running math.
 */
export interface DetectorInput {
  symbol: string;
  current: ManipulationFeatures;
  /** Historical features ending with `current`. Length may vary. */
  history: ManipulationFeatures[];
  /** Raw bar for the current date — some detectors want OHLC, not just features. */
  currentBar: DailyBar;
  /** Trailing raw bars ending with `currentBar`. */
  barHistory: DailyBar[];
  meta: SymbolMeta;
  /** Phase 2: optional richer inputs. Detectors must tolerate `undefined`/`null`. */
  advanced?: AdvancedBarInputs;
}

export type DetectorFn = (input: DetectorInput) => DetectorResult;

// ── Snapshot + persistence records ──────────────────────────────

/**
 * The per-symbol manipulation snapshot for a given date. Stored as one
 * row per (symbol, date) in q365_manipulation_snapshots.
 */
export interface ManipulationSnapshot {
  symbol: string;
  snapshotDate: string;
  manipulationScore: number;
  suspicionBand: SuspicionBand;
  features: ManipulationFeatures;
  triggeredEvents: DetectorResult[];
  /** Short one-line explanation for dashboards. */
  explanation: string;
  /** Phase 2: aggregated risk labels derived from triggered detectors. */
  riskLabels?: RiskLabel[];
}

export interface ManipulationEventRecord {
  id?: number;
  symbol: string;
  eventDate: string;
  eventType: EventType;
  severity: Severity;
  confidence: number;
  score: number;
  evidence: DetectorEvidence[];
  createdAt?: string;
}

export interface SignalManipulationLink {
  id?: number;
  signalId: string;
  symbol: string;
  manipulationSnapshotId: number;
  penaltyApplied: number;
  warningAdded: string | null;
  createdAt?: string;
}

// ── Integration hook return shape (signal engine side) ──────────

export interface ManipulationHookResult {
  symbol: string;
  snapshotDate: string | null;
  score: number;
  band: SuspicionBand;
  shouldPenalize: boolean;
  shouldReject: boolean;
  warning: string | null;
  /** Suggested confidence penalty (0–25). Signal engine applies or ignores. */
  suggestedPenalty: number;
  topEvents: Array<{ eventType: EventType; severity: Severity; label: string }>;
}

// ════════════════════════════════════════════════════════════════
//  Phase 2 — Risk labels, providers, penalty records
// ════════════════════════════════════════════════════════════════

/**
 * Human-meaningful surveillance labels. Multiple labels can apply to one
 * snapshot — they are inferred from the set of triggered detectors and
 * are deliberately probabilistic ("possible", "probable") because daily
 * OHLCV cannot prove intent.
 */
export type RiskLabel =
  | 'probable_operator_activity'
  | 'probable_distribution'
  | 'probable_pump_setup'
  | 'probable_dump_setup'
  | 'possible_trap_breakout'
  | 'possible_trap_breakdown'
  | 'suspicious_turnover_behavior'
  | 'spoof_proxy_observed'
  | 'wash_proxy_observed';

// ── Optional intraday / orderbook / corporate event inputs ──────

export interface IntradayBar {
  timestamp: string;   // ISO
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OrderbookSnapshot {
  timestamp: string;
  bidLevels: Array<{ price: number; size: number }>;
  askLevels: Array<{ price: number; size: number }>;
}

export interface CorporateEvent {
  date: string;
  type: 'earnings' | 'dividend' | 'split' | 'merger' | 'other';
  description?: string;
}

/** Optional provider for intraday bars — return null if no data. */
export interface IntradayProvider {
  fetchIntraday(symbol: string, date: string): Promise<IntradayBar[] | null>;
}
export interface OrderbookProvider {
  fetchOrderbookHistory(symbol: string, date: string): Promise<OrderbookSnapshot[] | null>;
}
export interface DeliveryProvider {
  fetchDeliveryPct(symbol: string, date: string): Promise<number | null>;
}
export interface CorpEventProvider {
  fetchEvents(symbol: string, fromDate: string, toDate: string): Promise<CorporateEvent[]>;
}

/**
 * Bundle of optional data sources passed into the scan pipeline. Every
 * field is optional — detectors that need richer data must check for
 * null and emit a "proxy" label rather than failing.
 */
export interface AdvancedDataSources {
  intraday?: IntradayProvider;
  orderbook?: OrderbookProvider;
  delivery?: DeliveryProvider;
  corpEvents?: CorpEventProvider;
}

/** Per-bar advanced inputs (already-fetched, not provider). */
export interface AdvancedBarInputs {
  intradayBars?: IntradayBar[] | null;
  orderbookSnapshots?: OrderbookSnapshot[] | null;
  deliveryPct?: number | null;
  upcomingCorporateEvent?: CorporateEvent | null;
}

// ── Detector input now carries optional advanced inputs ─────────

// (DetectorInput interface below was already defined; we add an
// optional `advanced` field via declaration merging-friendly extension.)

// ── Persistence: detector-level + penalty rows (Phase 2) ────────

export interface DetectorResultRecord {
  id?: number;
  snapshotId: number;
  detectorName: string;
  triggered: boolean;
  severity: Severity;
  score: number;
  evidence: DetectorEvidence[];
  createdAt?: string;
}

export interface ManipulationPenaltyRecord {
  id?: number;
  signalId: string;
  snapshotId: number;
  confidencePenalty: number;
  riskPenalty: number;
  rejectionFlag: boolean;
  reason: string;
  createdAt?: string;
}

// ════════════════════════════════════════════════════════════════
//  Phase 3 — Watchlists, calibration, backtest tagging
// ════════════════════════════════════════════════════════════════

export type WatchlistType =
  | 'suspicious_symbols'
  | 'high_risk_operator'
  | 'event_cluster';

export interface WatchlistEntry {
  id?: number;
  symbol: string;
  watchlistType: WatchlistType;
  scoreAtAdd: number;
  bandAtAdd: SuspicionBand;
  reason: string | null;
  addedAt?: string;
  coolingOffUntil: string | null;
}

export type WatchlistChangeType = 'added' | 'removed' | 'downgraded' | 'refreshed';

export interface WatchlistChangeRecord {
  id?: number;
  symbol: string;
  watchlistType: WatchlistType;
  changeType: WatchlistChangeType;
  score: number | null;
  band: SuspicionBand | null;
  reason: string | null;
  changedAt?: string;
}

export interface CalibrationSnapshotRecord {
  id?: number;
  runId: string | null;
  snapshotDate: string;
  bucketBand: SuspicionBand;
  sampleSize: number;
  winRate: number | null;        // 0–100
  avgPnlPct: number | null;
  falseBreakoutRate: number | null;
  createdAt?: string;
}
