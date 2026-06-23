/**
 * Pure projection + CI gate for scripts/auditApiUsage.ts.
 * Exported for unit tests (compile check + ceiling thresholds).
 */

export interface AuditPathCalls {
  name: string;
  perDay: number;
  notes: string;
}

export interface AuditProjection {
  paths: AuditPathCalls[];
  tradingDayTotal: number;
  weekendDailyCost: number;
  tradingDaysPerMonth: number;
  monthlyProjection: number;
}

/** CI warning ceiling — see auditApiUsage.ts header comment. */
export const PROJECTED_BUDGET_CEILING = 95_000;

export type AuditBudgetVerdict = 'pass' | 'fail';

export function evaluateAuditBudget(monthlyProjection: number): AuditBudgetVerdict {
  return monthlyProjection > PROJECTED_BUDGET_CEILING ? 'fail' : 'pass';
}

function intEnv(env: NodeJS.ProcessEnv, k: string, d: number): number {
  return Math.max(0, Number(env[k]) || d);
}

/** Static IndianAPI load model — must stay in sync with auditApiUsage.ts. */
export function computeMonthlyProjection(
  env: NodeJS.ProcessEnv = process.env,
): AuditProjection {
  const CANDLE_MAX_PER_CYCLE = intEnv(env, 'CANDLE_MAX_PER_CYCLE', 100);
  const QUOTE_TTL_S = intEnv(
    env,
    'QUOTE_TTL_S',
    Math.max(1, Math.round((Number(env.CACHE_TTL_LIVE_PRICE_MS) || 60_000) / 1000)),
  );
  // INDIANAPI_EMULATED_BATCH_MAX is the per-call /stock fan-out CAP (HTTP pool
  // sizing + getBatchQuotes ceiling). Live-feed TTL refreshes amortise over the
  // confirmed-monitoring pool (~90 symbols), not the full batch cap — see
  // simulateTradingDay.ts cache-first model and AUDIT_LIVE_FEED_SYMBOLS.
  const EMULATED_BATCH_CAP = intEnv(env, 'INDIANAPI_EMULATED_BATCH_MAX', 50);
  const LIVE_FEED_SYMBOLS = intEnv(
    env,
    'AUDIT_LIVE_FEED_SYMBOLS',
    Math.min(EMULATED_BATCH_CAP, 90),
  );
  const TRADING_HOURS = 6.25;
  const TRADING_DAYS_PER_MONTH = 22;

  const paths: AuditPathCalls[] = [];

  paths.push({
    name: 'pre-open candle warmup (09:25 IST)',
    perDay: 500,
    notes: 'force=true noCap=true; ONE allowed full sweep/day',
  });

  const stalledTicks = 2;
  const partialTicks = 4;
  const partialFraction = 0.3;
  const candleCallsPerDay =
    stalledTicks * CANDLE_MAX_PER_CYCLE +
    partialTicks * Math.round(CANDLE_MAX_PER_CYCLE * partialFraction);
  paths.push({
    name: '15-min candle refresh (curated subset, maxAgeHours filter)',
    perDay: candleCallsPerDay,
    notes: `~${stalledTicks} cap-engaged + ${partialTicks} partial ticks/day`,
  });

  const liveFeedSeconds = TRADING_HOURS * 3600;
  const liveFeedRefreshes = Math.ceil(liveFeedSeconds / Math.max(1, QUOTE_TTL_S));
  const liveFeedCalls = liveFeedRefreshes * LIVE_FEED_SYMBOLS;
  paths.push({
    name: 'live feed (Tier A + rescore + lifecycle + SSE + /signals)',
    perDay: liveFeedCalls,
    notes: `shared cache: ${liveFeedRefreshes} refreshes × ${LIVE_FEED_SYMBOLS} symbols (TTL=${QUOTE_TTL_S}s; batch cap=${EMULATED_BATCH_CAP})`,
  });

  paths.push({
    name: 'Tier B trigger-deep (every 20 min)',
    perDay: Math.ceil((TRADING_HOURS * 60) / 20) * 6,
    notes: '6 deep symbols max per cycle',
  });

  paths.push({
    name: 'Tier C intel (hourly + 2/weekend)',
    perDay: Math.ceil(TRADING_HOURS),
    notes: 'news / corporate, cache-heavy',
  });

  paths.push({
    name: 'maturity worker',
    perDay: 0,
    notes: 'DB-only after Step 8',
  });

  paths.push({
    name: 'manipulation scan (EOD + daily scan repairs)',
    perDay: intEnv(env, 'AUDIT_MANIPULATION_CALLS_PER_DAY', 5),
    notes: '18:30 scan is DB-only; occasional EOD-ingest repair calls',
  });

  paths.push({
    name: 'operator-driven (charts, single-quote, search)',
    perDay: intEnv(env, 'AUDIT_OPERATOR_CALLS_PER_DAY', 150),
    notes: 'ad-hoc; cache-first hits 80%',
  });

  const weekendDailyCost = 5;
  const tradingDayTotal = paths.reduce((s, p) => s + p.perDay, 0);
  const monthlyProjection =
    tradingDayTotal * TRADING_DAYS_PER_MONTH +
    weekendDailyCost * 8;

  return {
    paths,
    tradingDayTotal,
    weekendDailyCost,
    tradingDaysPerMonth: TRADING_DAYS_PER_MONTH,
    monthlyProjection,
  };
}
