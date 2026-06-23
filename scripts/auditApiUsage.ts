/**
 * auditApiUsage.ts — projected monthly IndianAPI quota under the
 * post-budget-fix scheduler config. Prints a single line per major
 * call path plus a daily/monthly total. CI gates a merge below 95k.
 *
 * Strategy: this is a STATIC simulation, not a live mock-driver. We
 * enumerate the call sites whose cadences are knobs (env or cron
 * strings), apply the cache-first amortisation, and print expected
 * daily / monthly load. The numbers are reproducible and easy to
 * reason about without booting the full Next process.
 *
 * Usage:
 *   npx tsx scripts/auditApiUsage.ts
 *
 * To override a knob:
 *   CANDLE_MAX_PER_CYCLE=80 npx tsx scripts/auditApiUsage.ts
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';
import {
  PROJECTED_BUDGET_CEILING,
  computeMonthlyProjection,
  evaluateAuditBudget,
} from './auditApiUsageCore';

dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });

function _runAuditApiUsage(): void {
  const {
    paths,
    tradingDayTotal,
    weekendDailyCost,
    tradingDaysPerMonth,
    monthlyProjection,
  } = computeMonthlyProjection(process.env);

  console.log('=== auditApiUsage projection ===');
  for (const p of paths) {
    const padded = p.name.padEnd(50);
    console.log(`[audit] ${padded} ${String(p.perDay).padStart(7)} calls/day  · ${p.notes}`);
  }
  console.log('='.repeat(72));
  console.log(`[audit] TRADING-DAY TOTAL                            ${String(tradingDayTotal).padStart(7)} calls`);
  console.log(`[audit] WEEKEND-DAY TOTAL                            ${String(weekendDailyCost).padStart(7)} calls`);
  console.log(
    `[audit] PROJECTED MONTHLY (${tradingDaysPerMonth}td × ${tradingDayTotal} + 8wd × ${weekendDailyCost}) = ${monthlyProjection} calls`,
  );
  console.log('='.repeat(72));

  // CI gate — warn before the paid-plan hard stop.
  //   • 100K/month  — contract ceiling (INDIANAPI_MONTHLY_LIMIT /
  //                   BUDGET_MONTHLY_FREEZE in .env.local)
  //   • 95K/month   — this script's PROJECTED_BUDGET_CEILING (CI warning)
  //   • 100K hard freeze — enforced at runtime by indianApiUsageTracker /
  //                       apiBudgetGuard; not duplicated here.
  if (evaluateAuditBudget(monthlyProjection) === 'fail') {
    console.error(
      `[audit] FAIL — projected monthly ${monthlyProjection} > ceiling ${PROJECTED_BUDGET_CEILING}. ` +
      `Re-tune AUDIT_LIVE_FEED_SYMBOLS, CACHE_TTL_LIVE_PRICE_MS, or CANDLE_MAX_PER_CYCLE before merging.`,
    );
    process.exit(1);
  }
  console.log(`[audit] PASS — projected monthly ${monthlyProjection} < ceiling ${PROJECTED_BUDGET_CEILING}`);
  process.exit(0);
}

_runAuditApiUsage();
