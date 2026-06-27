// Public Signal Ledger — outcome row types (Postgres migration 032)

/** Valid outcome values enforced by chk_q365_signal_outcomes_outcome. */
export type SignalOutcomeLedgerStatus =
  | 'WIN'
  | 'LOSS'
  | 'PARTIAL_WIN'
  | 'PARTIAL_LOSS'
  | 'NEUTRAL'
  | 'OPEN'
  | 'PENDING'
  | 'EXPIRED'
  | 'INVALIDATED'
  | 'INSUFFICIENT_DATA';

export const SIGNAL_OUTCOME_LEDGER_STATUSES: readonly SignalOutcomeLedgerStatus[] = [
  'WIN',
  'LOSS',
  'PARTIAL_WIN',
  'PARTIAL_LOSS',
  'NEUTRAL',
  'OPEN',
  'PENDING',
  'EXPIRED',
  'INVALIDATED',
  'INSUFFICIENT_DATA',
] as const;

export function isSignalOutcomeLedgerStatus(v: string): v is SignalOutcomeLedgerStatus {
  return (SIGNAL_OUTCOME_LEDGER_STATUSES as readonly string[]).includes(v);
}

/** Persisted row in q365_signal_outcomes (MySQL, migration 032). */
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

/** Input for inserting a new ledger outcome. */
export interface SignalOutcomeLedgerInsert {
  signalId: number;
  strategyId: string;
  symbol: string;
  outcome: SignalOutcomeLedgerStatus;
  outcomeAt: string | Date;
  daysHeld: number;
  maxGainPct?: number | null;
  candleCheckCount?: number;
  resolvedAt?: string | Date;
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
