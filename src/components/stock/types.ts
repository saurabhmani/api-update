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
