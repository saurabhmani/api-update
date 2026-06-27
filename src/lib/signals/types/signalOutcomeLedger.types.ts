// Public Signal Ledger — outcome row types (MySQL migration 032)

/** Canonical resolution outcomes for the Outcome Resolution Engine. */
export type SignalResolutionOutcome = 'T1_HIT' | 'SL_HIT' | 'EXPIRED' | 'ACTIVE';

export const SIGNAL_RESOLUTION_OUTCOMES: readonly SignalResolutionOutcome[] = [
  'T1_HIT',
  'SL_HIT',
  'EXPIRED',
  'ACTIVE',
] as const;

/** Terminal outcomes — rows must not be updated once set. */
export const TERMINAL_SIGNAL_OUTCOMES: readonly string[] = [
  'T1_HIT',
  'SL_HIT',
  'EXPIRED',
  'WIN',
  'LOSS',
] as const;

export type SignalOutcomeLedgerStatus =
  | SignalResolutionOutcome
  | 'WIN'
  | 'LOSS'
  | 'PARTIAL_WIN'
  | 'PARTIAL_LOSS'
  | 'NEUTRAL'
  | 'OPEN'
  | 'PENDING'
  | 'INVALIDATED'
  | 'INSUFFICIENT_DATA';

export const SIGNAL_OUTCOME_EXPIRE_TRADING_DAYS = 15;

/** Persisted row in q365_signal_outcomes (MySQL). */
export interface SignalOutcomeLedgerRow {
  id: number;
  signalId: number;
  strategyId: string;
  symbol: string;
  outcome: SignalOutcomeLedgerStatus;
  outcomeAt: string;
  daysHeld: number;
  maxGainPct: number | null;
  candleCheckCount: number;
  resolvedAt: string;
}

export interface SignalOutcomeLedgerInsert {
  signalId: number;
  strategyId: string;
  symbol: string;
  outcome: SignalOutcomeLedgerStatus;
  outcomeAt: string | Date;
  daysHeld: number;
  maxGainPct?: number | null;
  candleCheckCount?: number;
}

export interface SignalOutcomeLedgerListFilter {
  strategyId?: string;
  outcome?: SignalOutcomeLedgerStatus;
  symbol?: string;
  since?: string | Date;
  limit?: number;
}

export interface SignalOutcomeCoverage {
  totalSignals: number;
  withOutcome: number;
  withoutOutcome: number;
  coveragePct: number | null;
}

export function isTerminalOutcome(outcome: string): boolean {
  return (TERMINAL_SIGNAL_OUTCOMES as readonly string[]).includes(outcome);
}
