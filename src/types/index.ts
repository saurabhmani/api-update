// ── Onboarding Preferences ───────────────────────────────────────
export type TraderType  = 'beginner' | 'active_trader' | 'options_trader';
export type RiskProfile = 'low' | 'medium' | 'high';
export type AlertMode   = 'instant' | 'digest' | 'limited';

// ── Feature Entitlements ──────────────────────────────────────────
export interface UserFeatures {
  plan: string;
  features: Record<string, boolean>;
  signals_used_today: number;
  signals_limit: number;
}

// ── User & Auth ───────────────────────────────────────────────────
export interface User {
  id: number;
  email: string;
  name: string | null;
  role: 'user' | 'admin';
  is_active: boolean;
  totp_enabled: boolean;
  last_login_at: string | null;
  created_at: string;
}

export interface SessionUser {
  id: number;
  email: string;
  name: string | null;
  role: 'user' | 'admin';
}

// ── Instrument ───────────────────────────────────────────────────
export interface Instrument {
  id: number;
  instrument_key: string;
  exchange: string;
  tradingsymbol: string;
  name: string | null;
  instrument_type: string | null;
  expiry: string | null;
  strike: number | null;
  option_type: string | null;
  lot_size: number | null;
  tick_size: number | null;
  is_active: boolean;
}

// ── Market Tick / Quote ───────────────────────────────────────────
export interface Tick {
  instrument_key: string;
  ltp: number | null;
  open?: number |
   null;
  high?: number | null;
  low?: number | null;
  close?: number | null;
  volume?: number | null;
  oi?: number | null;
  net_change?: number | null;
  pct_change?: number | null;
  bid?: number | null;
  ask?: number | null;
  ts: string;
}

// ── Candle ───────────────────────────────────────────────────────
export interface Candle {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi?: number;
}

// ── Watchlist ─────────────────────────────────────────────────────
export interface WatchlistItem {
  id: number;
  watchlist_id: number;
  instrument_key: string;
  tradingsymbol: string;
  exchange: string;
  name: string | null;
  added_at: string;
  // hydrated from market data
  ltp?: number | null;
  pct_change?: number | null;
  net_change?: number | null;
}

// ── Portfolio ─────────────────────────────────────────────────────
export interface PortfolioPosition {
  id: number;
  portfolio_id: number;
  instrument_key: string | null;
  tradingsymbol: string;
  exchange: string | null;
  quantity: number;
  buy_price: number;
  current_price: number | null;
  added_at: string;
  // computed
  invested?: number;
  current_value?: number;
  pnl?: number;
  pnl_pct?: number;
}

export interface PortfolioSummary {
  total_invested: number;
  current_value: number;
  total_pnl: number;
  pnl_pct: number;
  positions_count: number;
}

// ── News ──────────────────────────────────────────────────────────
export interface NewsArticle {
  id: number;
  title: string;
  slug: string | null;
  summary: string | null;
  content: string | null;
  thumbnail: string | null;
  category_id: number | null;
  category_name?: string | null;
  is_published: boolean;
  is_featured: boolean;
  published_at: string | null;
  created_at: string;
}

export interface NewsCategory {
  id: number;
  name: string;
  slug: string | null;
}

// ── Notification ──────────────────────────────────────────────────
export interface Notification {
  id: number;
  user_id: number;
  message: string;
  type: string;
  is_read: boolean;
  created_at: string;
}

// ── Alert ────────────────────────────────────────────────────────
export interface Alert {
  id: number;
  user_id: number;
  instrument_key: string | null;
  tradingsymbol: string | null;
  condition: string;
  target_price: number | null;
  is_active: boolean;
  triggered_at: string | null;
  created_at: string;
}

// ── Report ────────────────────────────────────────────────────────
export interface Report {
  id: number;
  user_id: number;
  name: string | null;
  report_type: string;
  format: string;
  status: 'pending' | 'completed' | 'failed';
  file_path: string | null;
  created_at: string;
}

// ── Rankings ──────────────────────────────────────────────────────
export interface RankedStock {
  id: number;
  instrument_key: string;
  tradingsymbol: string;
  exchange: string;
  name: string | null;
  score: number;
  rank_position: number;
  pct_change: number | null;
  ltp: number | null;
  volume: number | null;
}

// ── User Onboarding Preferences ──────────────────────────────────
export interface UserOnboarding {
  id?: number;
  user_id?: number;
  trader_type: TraderType;
  preferred_segments: string[];
  risk_profile: RiskProfile;
  ui_mode: string;
  alert_mode: AlertMode;
  onboarding_completed?: boolean;
  default_dashboard?: string;
  timezone?: string;
  alert_email?: string | null;
  updated_at?: string;
}

// ── API Response wrapper ──────────────────────────────────────────
export interface ApiResponse<T = unknown> {
  data?: T;
  error?: string;
  message?: string;
}
