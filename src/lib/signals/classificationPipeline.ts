import { logger } from '@/lib/logger';

const log = logger.child({ component: 'classificationPipeline' });

export type CanonicalClassification = 
  | 'APPROVED' 
  | 'WATCHLIST' 
  | 'HIGH_POTENTIAL' 
  | 'REJECTED' 
  | 'INVALIDATED' 
  | 'EXPIRED'
  | 'HIDDEN'; // To drop silent rows

export interface ClassificationInput {
  symbol: string;
  source: 'tracker' | 'snapshot' | 'raw_signal';
  signal_status?: string | null;
  classification?: string | null;
  raw_classification?: string | null;
  status?: string | null; // lifecycle status
  live_invalidated?: boolean | null;
  invalidation_reason?: string | null;
  execution_allowed?: boolean | null;
  maturity_score?: number | null;
  stable?: boolean | null;
}

export interface ClassificationResult {
  symbol: string;
  classification: CanonicalClassification;
  reason: string;
  source: string;
}

/**
 * Single source of truth for classifying signals and trackers into the UI buckets.
 * Prevents WATCHLIST <-> REJECTED oscillation by centralizing the rules.
 */
export function classifySignalState(input: ClassificationInput): ClassificationResult {
  const sym = input.symbol;
  const source = input.source;
  const status = String(input.status ?? '').toUpperCase();
  const signal_status = String(input.signal_status ?? '').toUpperCase();
  const classification = String(input.classification ?? input.raw_classification ?? '').toUpperCase();

  // 1. Hard Rejections (INVALIDATED, TERMINAL STATES)
  const TERMINAL_STATES = new Set(['INVALIDATED', 'EXPIRED', 'STOP_LOSS_HIT', 'TARGET_HIT', 'CLOSED', 'TERMINATED', 'CANCELLED', 'REJECTED']);
  if (input.live_invalidated || (input.invalidation_reason && input.invalidation_reason.trim() !== '')) {
    log.info('[CLASSIFICATION_DECISION]', { symbol: sym, decision: 'REJECTED', reason: 'live_invalidated or invalidation_reason present', source });
    return { symbol: sym, classification: 'REJECTED', reason: 'live_invalidated', source };
  }
  if (input.execution_allowed === false) {
    log.info('[CLASSIFICATION_DECISION]', { symbol: sym, decision: 'REJECTED', reason: 'execution_allowed=false', source });
    return { symbol: sym, classification: 'REJECTED', reason: 'execution_allowed=false', source };
  }
  if (status && TERMINAL_STATES.has(status)) {
    // Map EXPIRED directly if needed, but prompt asks INVALIDATED -> REJECTED.
    // If it's a terminal state, it's rejected.
    const isExpired = status === 'EXPIRED';
    log.info('[CLASSIFICATION_DECISION]', { symbol: sym, decision: isExpired ? 'EXPIRED' : 'REJECTED', reason: `terminal lifecycle: ${status}`, source });
    return { symbol: sym, classification: isExpired ? 'EXPIRED' : 'REJECTED', reason: `terminal lifecycle: ${status}`, source };
  }
  if (signal_status === 'INVALIDATED' || classification === 'INVALIDATED') {
    log.info('[CLASSIFICATION_DECISION]', { symbol: sym, decision: 'REJECTED', reason: 'signal_status/classification is INVALIDATED', source });
    return { symbol: sym, classification: 'REJECTED', reason: 'INVALIDATED', source };
  }

  // 2. Tracker Logic (Maturity based mapping)
  if (source === 'tracker') {
    const maturity = input.maturity_score ?? 0;
    if (input.stable === true && status === 'APPROVED') {
      log.info('[TRACKER_SURFACED]', { symbol: sym, decision: 'APPROVED', reason: 'stable=true and lifecycle=APPROVED', source });
      return { symbol: sym, classification: 'APPROVED', reason: 'stable=true and lifecycle=APPROVED', source };
    }
    if (maturity < 40) {
      log.info('[RESPONSE_ROW_DROPPED]', { symbol: sym, decision: 'HIDDEN', reason: `tracker maturity ${maturity} < 40`, source });
      return { symbol: sym, classification: 'HIDDEN', reason: `tracker maturity ${maturity} < 40`, source };
    }
    if (maturity >= 40 && maturity <= 69) {
      log.info('[TRACKER_SURFACED]', { symbol: sym, decision: 'HIGH_POTENTIAL', reason: `tracker maturity ${maturity} (40-69)`, source });
      return { symbol: sym, classification: 'HIGH_POTENTIAL', reason: `tracker maturity ${maturity}`, source };
    }
    if (maturity >= 70) {
      log.info('[TRACKER_SURFACED]', { symbol: sym, decision: 'WATCHLIST', reason: `tracker maturity ${maturity} >= 70`, source });
      return { symbol: sym, classification: 'WATCHLIST', reason: `tracker maturity ${maturity}`, source };
    }
  }

  // 3. Mapping for Snapshots and Raw Signals
  if (status === 'APPROVED' || signal_status === 'APPROVED_SIGNAL' || signal_status === 'APPROVED' || classification === 'APPROVED') {
    log.info('[CLASSIFICATION_DECISION]', { symbol: sym, decision: 'APPROVED', reason: 'APPROVED status/signal_status', source });
    return { symbol: sym, classification: 'APPROVED', reason: 'APPROVED mapping', source };
  }

  if (signal_status === 'DEVELOPING_SETUP' || classification === 'DEVELOPING_SETUP') {
    log.info('[CLASSIFICATION_DECISION]', { symbol: sym, decision: 'WATCHLIST', reason: 'DEVELOPING_SETUP maps to WATCHLIST', source });
    return { symbol: sym, classification: 'WATCHLIST', reason: 'DEVELOPING_SETUP', source };
  }

  if (signal_status === 'CANDIDATE' || classification === 'CANDIDATE') {
    log.info('[CLASSIFICATION_DECISION]', { symbol: sym, decision: 'HIGH_POTENTIAL', reason: 'CANDIDATE maps to HIGH_POTENTIAL', source });
    return { symbol: sym, classification: 'HIGH_POTENTIAL', reason: 'CANDIDATE', source };
  }

  if (signal_status === 'WATCHLIST' || classification === 'WATCHLIST_ONLY' || classification === 'WATCHLIST') {
    log.info('[CLASSIFICATION_DECISION]', { symbol: sym, decision: 'WATCHLIST', reason: 'Explicit WATCHLIST', source });
    return { symbol: sym, classification: 'WATCHLIST', reason: 'WATCHLIST', source };
  }

  if (signal_status === 'NO_TRADE' || classification === 'NO_TRADE') {
    log.info('[CLASSIFICATION_DECISION]', { symbol: sym, decision: 'REJECTED', reason: 'NO_TRADE maps to REJECTED', source });
    return { symbol: sym, classification: 'REJECTED', reason: 'NO_TRADE', source };
  }

  // Fallback map
  log.info('[CLASSIFICATION_DECISION]', { symbol: sym, decision: 'WATCHLIST', reason: 'Fallback default mapping', source });
  return { symbol: sym, classification: 'WATCHLIST', reason: 'fallback', source };
}

export function applyClassificationToRows<T extends ClassificationInput>(rows: T[], contextSource: 'tracker' | 'snapshot' | 'raw_signal'): (T & { canonical_classification: CanonicalClassification })[] {
  const out: (T & { canonical_classification: CanonicalClassification })[] = [];
  for (const r of rows) {
    const input: ClassificationInput = {
      ...r,
      source: contextSource,
    };
    const result = classifySignalState(input);
    if (result.classification !== 'HIDDEN') {
      out.push({ ...r, canonical_classification: result.classification });
    }
  }
  return out;
}
