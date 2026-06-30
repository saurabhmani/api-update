// Public Signals API — shared types

export const PUBLIC_SIGNAL_SORT_FIELDS = ['created_at', 'confidence_score'] as const;
export type PublicSignalSortField = (typeof PUBLIC_SIGNAL_SORT_FIELDS)[number];

export const PUBLIC_SIGNAL_OUTCOMES = [
  'T1_HIT', 'SL_HIT', 'EXPIRED', 'ACTIVE',
  'WIN', 'LOSS', 'OPEN', 'PENDING',
] as const;

export type PublicSignalOutcomeFilter = (typeof PUBLIC_SIGNAL_OUTCOMES)[number];

export interface PublicSignalsQuery {
  page: number;
  limit: number;
  strategy?: string;
  symbol?: string;
  outcome?: string;
  fromDate?: string;
  toDate?: string;
  sort: PublicSignalSortField;
  sortDir: 'asc' | 'desc';
}

export interface PublicSignalRow {
  id: number;
  symbol: string;
  strategy_id: string;
  direction: string;
  entry_price: number | null;
  stop_loss: number | null;
  target_1: number | null;
  target_2: number | null;
  target_3: number | null;
  confidence_score: number | null;
  created_at: string;
  outcome: string | null;
  outcome_at: string | null;
  days_held: number | null;
  max_gain_pct: number | null;
}

export interface PublicSignalsSummary {
  win_rate: number;
  total_signals: number;
  active_signals: number;
  signals_this_month: number;
  best_strategy: string | null;
  average_confidence: number;
}

export interface PublicSignalsFeedResult {
  data: PublicSignalRow[];
  page: number;
  total: number;
  summary: PublicSignalsSummary;
  win_rate: number;
  cached?: boolean;
}
