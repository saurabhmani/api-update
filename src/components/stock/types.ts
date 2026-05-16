// ═══════════════════════════════════════════════════════════════════
//  Quantorus365 Stock Dashboard — Type Definitions
// ═══════════════════════════════════════════════════════════════════

export interface CandleBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number;
}

export interface SignalReason {
  rank: number;
  factor_key: string | null;
  text: string;
}

export interface StockData {
  symbol: string;
  instrument_key: string;
  name: string | null;
  ltp: number;
  open: number;
  day_high: number;
  day_low: number;
  prev_close: number;
  change_abs: number;
  change_percent: number;
  volume: number;
  vwap: number | null;
  week52_high: number;
  week52_low: number;
  candles: CandleBar[];
  candle_interval: string;
  score: number | null;
  rank_position: number | null;
  signal_type: string | null;
  confidence: number | null;
  signal_strength: string | null;
  entry_price: number | null;
  stop_loss: number | null;
  target1: number | null;
  target2: number | null;
  risk_reward: number | null;
  reasons: SignalReason[];
  signal_age_min: number | null;

  // Signal intelligence
  risk_score: number | null;
  portfolio_fit: number | null;
  conviction_band: string | null;     // high_conviction | actionable | watchlist | reject
  scenario_tag: string | null;        // TREND_CONTINUATION | ... | NO_STRATEGY
  market_stance: string | null;       // aggressive | selective | defensive | capital_preservation
  rejection_reasons: string[];
  rejection_codes: string[];
  signal_status: 'APPROVED_SIGNAL' | 'DEVELOPING_SETUP' | 'NO_TRADE' | null;

  // Verdict-context fields. The detail API returns these; the type
  // didn't declare them so DecisionPanel couldn't see them, which
  // caused the "table says BUY, detail says approved" contradiction
  // when signal_status='APPROVED_SIGNAL' was paired with a blocking
  // classification (WATCHLIST_ONLY / NO_TRADE) or execution_allowed=false.
  // Surface them so the panel can render the conflict honestly
  // instead of treating signal_status as the only verdict input.
  classification?:        string | null;
  raw_classification?:    string | null;
  execution_allowed?:     boolean;
  is_relaxed?:            boolean;
  is_scanner_candidate?:  boolean;
  signal_state_changed?:  boolean;
  previous_status?:       string | null;
  current_status?:        string | null;
  downgrade_reason?:      string | null;
  signal_note?:           string | null;

  data_source: string;
  as_of: string;
}

export interface NewsItem {
  id: number;
  title: string;
  source: string;
  url: string;
  published_at: string;
  sentiment?: string;
}

export const TABS = [
  { id: 'overview',      label: 'Overview'       },
  { id: 'signals',       label: 'Signals'        },
  { id: 'technicals',    label: 'Technicals'     },
  { id: 'financials',    label: 'Financials'     },
  { id: 'news',          label: 'News & Events'  },
  { id: 'portfolio-fit', label: 'Portfolio Fit'  },
  { id: 'ai',            label: 'AI Insight'     },
  { id: 'dexter',        label: 'Dexter AI'      },
  { id: 'history',       label: 'History'        },
] as const;

export type TabId = typeof TABS[number]['id'];

export const INTERVALS = ['1minute', '5minute', '15minute', '1day'] as const;
export type Interval = typeof INTERVALS[number];

export const INTERVAL_LABEL: Record<Interval, string> = {
  '1minute': '1m',
  '5minute': '5m',
  '15minute': '15m',
  '1day': '1D',
};
