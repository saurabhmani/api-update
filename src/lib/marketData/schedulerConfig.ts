// ════════════════════════════════════════════════════════════════
//  schedulerConfig — single source of truth for tiering, trigger
//  thresholds, budget limits, and cadence knobs.
//
//  Every tunable that used to be hardcoded in scheduler.ts lives
//  here. Env overrides are honored so ops can adjust without a
//  deploy.
// ════════════════════════════════════════════════════════════════

export type Tier = 1 | 2 | 3;

export interface SchedulerConfig {
  batchChunkSize: number;
  maxDeepFetchesPerCycle: number;
  deepCooldownMs: number;
  newsCooldownMs: number;
  histCooldownMs: number;

  triggerThresholds: {
    pctChangeMin: number;         // %
    pctChangeStrong: number;      // %
    volumeRatioMin: number;
    volumeRatioStrong: number;
    near52wPct: number;           // 0.02 = within 2%
  };

  budget: {
    monthlySoftTarget: number;
    monthlySoftCap: number;
    monthlyHardLimit: number;
    monthlyFreeze: number;
    dailySoftCap: number;
  };
}

function envNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function envList(name: string): string[] | null {
  const v = process.env[name];
  if (!v) return null;
  return v.split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
}

// Tier definitions. Tier 1 = must-monitor, Tier 2 = watchlist,
// Tier 3 = discovery-only (never explicitly batched, surfaced
// through movers / trending).
export const TIER_1_DEFAULT: string[] = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN',
  'HINDUNILVR', 'ITC', 'LT', 'KOTAKBANK', 'BHARTIARTL', 'AXISBANK',
  'ASIANPAINT', 'BAJFINANCE', 'MARUTI', 'HCLTECH', 'WIPRO', 'SUNPHARMA',
  'NTPC', 'TITAN',
];

// Populated at boot by whatever loads NIFTY 500 / watchlist from DB.
let tier1: string[] = envList('SCHEDULER_TIER1') ?? TIER_1_DEFAULT;
let tier2: string[] = envList('SCHEDULER_TIER2') ?? [];
let tier3: string[] = envList('SCHEDULER_TIER3') ?? [];

export function configureTiers(cfg: { tier1?: string[]; tier2?: string[]; tier3?: string[] }): void {
  if (cfg.tier1) tier1 = dedupe(cfg.tier1);
  if (cfg.tier2) tier2 = dedupe(cfg.tier2);
  if (cfg.tier3) tier3 = dedupe(cfg.tier3);
}

export function getTier(tier: Tier): string[] {
  if (tier === 1) return tier1;
  if (tier === 2) return tier2;
  return tier3;
}

/** Symbols that should appear in every Tier A batch pass. */
export function getBatchUniverse(): string[] {
  return dedupe([...tier1, ...tier2]);
}

/** Full universe including discovery — used only by triggerEngine
 *  when resolving symbols surfaced by movers/news. */
export function getFullUniverse(): string[] {
  return dedupe([...tier1, ...tier2, ...tier3]);
}

export function tierOf(symbol: string): Tier {
  const s = symbol.toUpperCase();
  if (tier1.includes(s)) return 1;
  if (tier2.includes(s)) return 2;
  return 3;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.map(s => s.trim().toUpperCase()).filter(Boolean))];
}

export const CONFIG: SchedulerConfig = {
  batchChunkSize:         envNum('SCHEDULER_BATCH_CHUNK', 200),
  maxDeepFetchesPerCycle: envNum('SCHEDULER_MAX_DEEP', 6),
  deepCooldownMs:         envNum('SCHEDULER_DEEP_COOLDOWN_MS', 35 * 60 * 1000),
  newsCooldownMs:         envNum('SCHEDULER_NEWS_COOLDOWN_MS', 60 * 60 * 1000),
  histCooldownMs:         envNum('SCHEDULER_HIST_COOLDOWN_MS', 24 * 60 * 60 * 1000),

  triggerThresholds: {
    pctChangeMin:     envNum('TRIGGER_PCT_MIN', 2.5),
    pctChangeStrong:  envNum('TRIGGER_PCT_STRONG', 3.0),
    volumeRatioMin:   envNum('TRIGGER_VOL_MIN', 2.5),
    volumeRatioStrong:envNum('TRIGGER_VOL_STRONG', 3.0),
    near52wPct:       envNum('TRIGGER_NEAR_52W_PCT', 0.02),
  },

  budget: (() => {
    // Step 8 of the IndianAPI cutover. The IndianAPI plan is
    // 100,000 requests/month with a 2,500–3,000/day safe target.
    // The degradation thresholds map to the spec:
    //   85% of monthly  → 'soft'   (drop hist + non-critical adhoc)
    //   95% of monthly  → 'hard'   (only confirmed monitoring + health)
    //   exhausted        → 'freeze' (DATA_BUDGET_EXHAUSTED — only batch
    //                                quotes for confirmed monitoring +
    //                                feed-health checks pass)
    //
    // Operators can override any of these with the legacy env names
    // (BUDGET_MONTHLY_*); INDIANAPI_MONTHLY_LIMIT / DAILY_SOFT_LIMIT
    // are also honoured per the new .env.example. The first env var
    // that resolves wins, then the spec defaults fill in.
    const monthlyLimit =
      envNum('INDIANAPI_MONTHLY_LIMIT', envNum('BUDGET_MONTHLY_HARD_LIMIT', 100_000));
    const dailyTarget  =
      envNum('INDIANAPI_DAILY_SOFT_LIMIT', envNum('BUDGET_DAILY_SOFT_CAP', 3_000));
    // Honour INDIANAPI_BUDGET_REDUCE_THRESHOLD (soft / 'reduce polling')
    // and INDIANAPI_BUDGET_CRITICAL_THRESHOLD ('only critical calls'),
    // both already shipped in .env.local. Until 2026-05-01 these env
    // values were ignored — the soft/hard caps were hard-coded at
    // 85% / 95% — so an operator could not tune the adaptive ladder
    // without editing source. Both fall back to the legacy 0.85/0.95
    // when unset.
    const reduceThr   = Number(process.env.INDIANAPI_BUDGET_REDUCE_THRESHOLD)   || 0.85;
    const criticalThr = Number(process.env.INDIANAPI_BUDGET_CRITICAL_THRESHOLD) || 0.95;
    const monthlySoftCap   = envNum('BUDGET_MONTHLY_SOFT_CAP',    Math.round(monthlyLimit * reduceThr));
    const monthlyHardLimit = envNum('BUDGET_MONTHLY_HARD_LIMIT',  Math.round(monthlyLimit * criticalThr));
    const monthlyFreeze    = envNum('BUDGET_MONTHLY_FREEZE',      monthlyLimit);
    return {
      monthlySoftTarget: envNum('BUDGET_MONTHLY_SOFT_TARGET', Math.round(monthlyLimit * 0.65)),
      monthlySoftCap,
      monthlyHardLimit,
      monthlyFreeze,
      dailySoftCap: dailyTarget,
    };
  })(),
};

/** Runtime override (e.g. admin endpoint); useful for the budget guard
 *  to degrade `maxDeepFetchesPerCycle` without a deploy. */
export function setConfig<K extends keyof SchedulerConfig>(
  key: K,
  value: SchedulerConfig[K],
): void {
  CONFIG[key] = value;
}
