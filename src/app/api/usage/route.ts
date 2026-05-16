// ════════════════════════════════════════════════════════════════
//  GET /api/usage
//
//  Production-safety projection endpoint. Returns the SAFE /
//  BORDERLINE / UNSAFE label backing the user's spec:
//
//    Daily limit:     INDIANAPI_DAILY_LIMIT      (default 2500)
//    Monthly target:  INDIANAPI_MONTHLY_TARGET   (default 70_000)
//    Monthly ceiling: INDIANAPI_MONTHLY_CEILING  (default 90_000)
//
//  Banding:
//    SAFE       — daily under 80% AND projected monthly under target.
//    BORDERLINE — daily ≥ 80% OR projected monthly ≥ target.
//    UNSAFE     — daily exceeded OR monthly ≥ ceiling OR projection >
//                 ceiling at the current burn rate.
//
//  Read-only. No DB writes, no IndianAPI write. Cheap; safe to poll.
//  Public — no session required so the dashboard's compliance banner
//  can render without an authenticated context. Counters are usage
//  totals, not user data; exposing them is intended.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import {
  getApiUsage,
  getComplianceProjection,
  INDIANAPI_PER_RUN_LIMIT,
} from '@/providers/adapters/indianApiUsageTracker';
import { getMarketStatus } from '@/lib/marketData/marketHours';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const usage      = getApiUsage();
  const projection = getComplianceProjection();
  const market     = getMarketStatus();

  const status = projection.label === 'UNSAFE' ? 503
               : projection.label === 'BORDERLINE' ? 200
               : 200;

  return NextResponse.json(
    {
      // ── Headline label ──────────────────────────────────────
      compliance:  projection.label,
      reasons:     projection.reasons,
      // ── Daily ───────────────────────────────────────────────
      daily: {
        used:       projection.daily,
        limit:      projection.daily_limit,
        remaining:  projection.daily_remaining,
        percent:    projection.daily_percent,
        exceeded:   usage.daily_exceeded,
      },
      // ── Monthly ─────────────────────────────────────────────
      monthly: {
        used:                projection.monthly,
        target:              projection.monthly_target,
        ceiling:             projection.monthly_ceiling,
        remaining_to_ceiling: projection.monthly_remaining,
        // Linear projection at current burn rate.
        projection:          projection.monthly_projection,
        projection_pct_target:  projection.monthly_projection_pct_target,
        projection_pct_ceiling: projection.monthly_projection_pct_ceiling,
        days_elapsed:        projection.days_elapsed,
        days_remaining:      projection.days_remaining,
        projection_over_ceiling: projection.projection_over_ceiling,
      },
      // ── Per-run hard ceiling ────────────────────────────────
      per_run: {
        active:    usage.per_run_active,
        count:     usage.per_run_count,
        limit:     usage.per_run_limit,
        remaining: usage.per_run_remaining,
        exceeded:  usage.per_run_exceeded,
      },
      // ── Estimates the spec asked for ────────────────────────
      // requests-per-run uses the configured per-run cap as the
      // worst-case (real runs typically come in well under that
      // due to the 80-symbol universe cap + 10-min freshness skip).
      // The day/month figures are the linear projection above.
      estimate: {
        worst_case_per_run: INDIANAPI_PER_RUN_LIMIT,
        daily_now:          projection.daily,
        monthly_now:        projection.monthly,
        monthly_eom:        projection.monthly_projection,
        // Headroom = (target - projection) / target. Negative when
        // we're projected to overshoot the target.
        safety_buffer_pct_target:
          projection.monthly_target > 0
            ? Math.round(
                ((projection.monthly_target - projection.monthly_projection)
                  / projection.monthly_target) * 1000,
              ) / 10
            : 0,
        safety_buffer_pct_ceiling:
          projection.monthly_ceiling > 0
            ? Math.round(
                ((projection.monthly_ceiling - projection.monthly_projection)
                  / projection.monthly_ceiling) * 1000,
              ) / 10
            : 0,
      },
      // ── Market context ──────────────────────────────────────
      market: {
        is_open:  market.isOpen,
        state:    market.state,
        label:    market.label,
        // The spec's STEP 5 hard refusal — operator surfaces this
        // to confirm the weekend block is active. Computed from the
        // IST weekday rather than market.state because `MarketState`
        // collapses weekend + post-close into 'closed'.
        weekend:  (() => {
          const istNow = new Date(Date.now() + 5.5 * 3_600_000);
          const wd = istNow.getUTCDay();
          return wd === 0 || wd === 6;
        })(),
      },
      server_now: new Date().toISOString(),
      date:       usage.date,
      month:      usage.month,
    },
    {
      status,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    },
  );
}
