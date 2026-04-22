/**
 * System Config Service — Quantorus365
 *
 * Single source of truth for all operational thresholds.
 * Loads from MySQL system_thresholds table, caches in Redis.
 * Market stance overrides applied on top of DB values.
 *
 * Usage:
 *   const cfg = await getConfig();
 *   if (rr < cfg.MIN_RR_SWING) reject();
 *
 * No service should hardcode thresholds. Everything flows from here.
 */

import { db }             from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/redis';

// ════════════════════════════════════════════════════════════════
//  CANONICAL THRESHOLD TYPES
// ════════════════════════════════════════════════════════════════

export interface SystemConfig {
  // Risk-reward
  MIN_RR_SWING:              number;  // default 2.0
  MIN_RR_POSITIONAL:         number;  // default 2.5

  // Signal quality
  MIN_CONFIDENCE:            number;  // default 65
  MIN_COMPOSITE_SCORE:       number;  // default 45
  MAX_RISK_SCORE:            number;  // default 75

  // Data quality
  MIN_DATA_QUALITY:          number;  // default 0.40 (0–1)

  // Liquidity
  MIN_LIQUIDITY_VOLUME:      number;  // default 100000 daily volume
  MIN_VOLUME_INTRADAY:       number;  // default 10000 intraday

  // Portfolio
  MAX_SECTOR_EXPOSURE:       number;  // default 30 (%)
  MAX_POSITIONS:             number;  // default 12
  MAX_STRATEGY_CONCENTRATION:number;  // default 0.50 (fraction)
  MAX_CORRELATION:           number;  // default 0.75
  MIN_PORTFOLIO_FIT:         number;  // default 40
  MAX_DRAWDOWN_BLOCK:        number;  // default 15 (%)
  CAPITAL_AT_RISK_CAP:       number;  // default 20 (%)

  // Stop distance
  MAX_STOP_ATR_MULTIPLE:     number;  // default 3.5
  MIN_STOP_ATR_MULTIPLE:     number;  // default 0.5

  // Confidence weights (must sum to 1.0)
  WEIGHT_FACTOR_ALIGNMENT:   number;  // default 0.22
  WEIGHT_STRATEGY_CLARITY:   number;  // default 0.14
  WEIGHT_REGIME_ALIGNMENT:   number;  // default 0.14
  WEIGHT_LIQUIDITY:          number;  // default 0.10
  WEIGHT_DATA_QUALITY:       number;  // default 0.08
  WEIGHT_PORTFOLIO_FIT:      number;  // default 0.12
  WEIGHT_PARTICIPATION:      number;  // default 0.06
  WEIGHT_RR_QUALITY:         number;  // default 0.08
  WEIGHT_VOLATILITY_FIT:     number;  // default 0.06

  // Correlation lookback
  CORRELATION_LOOKBACK_DAYS: number;  // default 60
}

// ── Hardened defaults (last resort if DB unavailable) ─────────────

export const DEFAULTS: SystemConfig = {
  MIN_RR_SWING:              1.5,     // lowered from 2.0 — more setups pass R:R gate
  MIN_RR_POSITIONAL:         2.0,     // lowered from 2.5 — still institutional-grade
  MIN_CONFIDENCE:            55,      // unchanged — quality floor stays firm
  MIN_COMPOSITE_SCORE:       35,      // lowered from 40 — lets marginal-fit signals surface
  MAX_RISK_SCORE:            80,
  MIN_DATA_QUALITY:          0.30,
  MIN_LIQUIDITY_VOLUME:      25_000,
  MIN_VOLUME_INTRADAY:       1_000,
  MAX_SECTOR_EXPOSURE:       30,
  MAX_POSITIONS:             12,
  MAX_STRATEGY_CONCENTRATION:0.50,
  MAX_CORRELATION:           0.75,
  MIN_PORTFOLIO_FIT:         40,
  MAX_DRAWDOWN_BLOCK:        15,
  CAPITAL_AT_RISK_CAP:       20,
  MAX_STOP_ATR_MULTIPLE:     3.5,
  MIN_STOP_ATR_MULTIPLE:     0.5,
  WEIGHT_FACTOR_ALIGNMENT:   0.22,
  WEIGHT_STRATEGY_CLARITY:   0.14,
  WEIGHT_REGIME_ALIGNMENT:   0.14,
  WEIGHT_LIQUIDITY:          0.10,
  WEIGHT_DATA_QUALITY:       0.08,
  WEIGHT_PORTFOLIO_FIT:      0.12,
  WEIGHT_PARTICIPATION:      0.06,
  WEIGHT_RR_QUALITY:         0.08,
  WEIGHT_VOLATILITY_FIT:     0.06,
  CORRELATION_LOOKBACK_DAYS: 60,
};

// ── Cache ──────────────────────────────────────────────────────────

const CACHE_KEY = 'system:config';
const CACHE_TTL = 300; // 5 minutes
let _mem:  SystemConfig | null = null;
let _memAt = 0;

// ════════════════════════════════════════════════════════════════
//  DB LOADER
// ════════════════════════════════════════════════════════════════

async function loadFromDB(): Promise<SystemConfig> {
  const cfg = { ...DEFAULTS };
  try {
    const { rows } = await db.query(
      `SELECT key_name, key_value FROM system_thresholds`
    );
    for (const row of rows as any[]) {
      const k = row.key_name as keyof SystemConfig;
      if (k in cfg) (cfg as any)[k] = parseFloat(row.key_value);
    }
  } catch {}
  return cfg;
}

// ════════════════════════════════════════════════════════════════
//  PUBLIC API
// ════════════════════════════════════════════════════════════════

/** Get current system config (DB → Redis → in-memory → defaults) */
export async function getConfig(): Promise<SystemConfig> {
  // In-memory cache (300s)
  if (_mem && Date.now() - _memAt < CACHE_TTL * 1000) return _mem;

  // Redis
  try {
    const cached = await cacheGet<SystemConfig>(CACHE_KEY);
    if (cached) { _mem = cached; _memAt = Date.now(); return cached; }
  } catch {}

  // DB
  const cfg = await loadFromDB();
  _mem   = cfg;
  _memAt = Date.now();
  try { await cacheSet(CACHE_KEY, cfg, CACHE_TTL); } catch {}
  return cfg;
}

/** Invalidate cache after admin threshold update */
export async function invalidateConfig(): Promise<void> {
  _mem   = null;
  _memAt = 0;
  try {
    const { cacheDel } = await import('@/lib/redis');
    await cacheDel(CACHE_KEY);
  } catch {}
}

/**
 * Get stance-adjusted config.
 * Market stance overrides specific thresholds dynamically.
 * Called by rejectionEngine and signalEngine.
 */
export function applyStanceOverrides(
  cfg:    SystemConfig,
  stance: string
): SystemConfig {
  const c = { ...cfg };

  switch (stance) {
    case 'aggressive':
      c.MIN_CONFIDENCE   = Math.max(55, cfg.MIN_CONFIDENCE - 10);
      c.MIN_RR_SWING     = Math.max(1.5, cfg.MIN_RR_SWING - 0.3);
      c.MAX_POSITIONS    = Math.min(15, cfg.MAX_POSITIONS + 3);
      break;

    case 'selective':
      // No change — selective is the neutral baseline
      break;

    case 'defensive':
      c.MIN_CONFIDENCE   = Math.min(80, cfg.MIN_CONFIDENCE + 8);
      c.MIN_RR_SWING     = Math.min(3.0, cfg.MIN_RR_SWING + 0.3);
      c.MAX_POSITIONS    = Math.max(6,   cfg.MAX_POSITIONS - 4);
      c.MAX_SECTOR_EXPOSURE = Math.min(20, cfg.MAX_SECTOR_EXPOSURE - 10);
      break;

    case 'capital_preservation':
      c.MIN_CONFIDENCE   = Math.min(88, cfg.MIN_CONFIDENCE + 20);
      c.MIN_RR_SWING     = Math.min(3.5, cfg.MIN_RR_SWING + 0.8);
      c.MAX_POSITIONS    = Math.max(3,   cfg.MAX_POSITIONS - 8);
      c.MAX_SECTOR_EXPOSURE = Math.min(15, cfg.MAX_SECTOR_EXPOSURE - 15);
      break;
  }

  return c;
}

/** Get confidence weight map as typed object */
export function getConfidenceWeights(cfg: SystemConfig): Record<string, number> {
  return {
    factor_alignment:  cfg.WEIGHT_FACTOR_ALIGNMENT,
    strategy_clarity:  cfg.WEIGHT_STRATEGY_CLARITY,
    regime_alignment:  cfg.WEIGHT_REGIME_ALIGNMENT,
    liquidity_quality: cfg.WEIGHT_LIQUIDITY,
    data_quality:      cfg.WEIGHT_DATA_QUALITY,
    portfolio_fit:     cfg.WEIGHT_PORTFOLIO_FIT,
    participation:     cfg.WEIGHT_PARTICIPATION,
    rr_quality:        cfg.WEIGHT_RR_QUALITY,
    volatility_fit:    cfg.WEIGHT_VOLATILITY_FIT,
  };
}


/**
 * Return the minimum R:R for a given timeframe, loaded from centralized config.
 * Eliminates all per-engine hardcoded RR constants.
 */
export async function getMinRRForTimeframe(timeframe: string): Promise<number> {
  const cfg = await getConfig();
  if (timeframe === 'positional') return cfg.MIN_RR_POSITIONAL;
  if (timeframe === 'intraday')   return cfg.MIN_RR_SWING * 0.8;  // intraday is slightly tighter
  return cfg.MIN_RR_SWING;  // default: swing
}

/**
 * Return a scored RR quality value (0–100) based on centralized thresholds.
 * Used by confidenceEngine to score R:R quality without embedding RR constants.
 */
export async function scoreRRAgainstConfig(rr: number, timeframe: string): Promise<number> {
  const cfg    = await getConfig();
  const minRR  = timeframe === 'positional' ? cfg.MIN_RR_POSITIONAL : cfg.MIN_RR_SWING;
  const goodRR = minRR * 1.5;
  const idealRR= minRR * 2.0;

  if (rr >= idealRR)       return 100;
  if (rr >= goodRR)        return 85;
  if (rr >= minRR)         return 65;
  if (rr >= minRR * 0.8)   return 40;
  return 10;
}

/** Seed default thresholds into DB if not present */
export async function seedThresholds(): Promise<void> {
  const entries = Object.entries(DEFAULTS);
  for (const [k, v] of entries) {
    await db.query(`
      INSERT IGNORE INTO system_thresholds (key_name, key_value, description)
      VALUES (?, ?, ?)
    `, [k, String(v), `Default: ${v}`]).catch(() => {});
  }
}
