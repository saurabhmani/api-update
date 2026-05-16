// ════════════════════════════════════════════════════════════════
//  GET /api/market-data/usage
//
//  Single source-of-truth for the IndianAPI budget ledger. Returns:
//    - daily_calls       : monotonic counter (UTC day) maintained by
//                          apiBudgetGuard.spend()
//    - monthly_calls     : same, monthly window
//    - remaining_quota   : monthlyHardLimit - monthly_calls (clamped ≥ 0)
//    - degradation_level : 'normal' | 'soft' | 'hard' | 'freeze'
//      → soft        engaged at INDIANAPI_BUDGET_REDUCE_THRESHOLD   (default 0.85)
//      → hard        engaged at INDIANAPI_BUDGET_CRITICAL_THRESHOLD (default 0.95)
//      → freeze      engaged at INDIANAPI_MONTHLY_LIMIT             (default 100_000)
//    - thresholds        : { soft, hard, freeze, dailySoftCap }
//    - per_type          : { batch, movers, deep, hist, news, corp, search, adhoc }
//    - skipped_today     : sum of refusals today (budget + market-closed)
//    - upstream          : best-effort cross-check from /usage on the
//                          IndianAPI account itself. null if the upstream
//                          call fails — the local counter remains
//                          authoritative.
//
//  Read-only. No DB writes, no IndianAPI write. Cheap; safe to poll.
//  Auth: same `requireSession` as the rest of the dashboard endpoints.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { snapshot } from '@/lib/marketData/apiBudgetGuard';
import { CONFIG } from '@/lib/marketData/schedulerConfig';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { getIndianApiConfig } from '@/lib/marketData/providers/indianApiEndpoints';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

interface UpstreamUsage {
  total_requests:     number;
  hard_limit:         number;
  remaining_requests: number;
  endpoint_usage?:    Record<string, number>;
}

async function fetchUpstreamUsage(): Promise<UpstreamUsage | null> {
  const cfg = getIndianApiConfig();
  if (!cfg.apiKey) return null;
  try {
    const res = await fetch(`${cfg.baseUrl}/usage`, {
      headers: { 'X-API-Key': cfg.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(2_500),
    });
    if (!res.ok) return null;
    return (await res.json()) as UpstreamUsage;
  } catch {
    return null;
  }
}

export async function GET(): Promise<Response> {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const [snap, upstream] = await Promise.all([
    snapshot(),
    fetchUpstreamUsage(),
  ]);

  const monthlyLimit = CONFIG.budget.monthlyFreeze;
  const remainingLocal = Math.max(0, monthlyLimit - snap.monthTotal);
  const usagePercent = monthlyLimit > 0
    ? Math.round((snap.monthTotal / monthlyLimit) * 1000) / 10
    : 0;

  const market = getMarketStatus();

  // Standardised payload — matches the spec the operator pinned:
  //   { daily_calls, monthly_calls, remaining_quota, ... }
  const body = {
    // ── Spec-required fields ─────────────────────────────────
    daily_calls:      snap.dayTotal,
    monthly_calls:    snap.monthTotal,
    remaining_quota:  remainingLocal,

    // ── Extended ops fields ──────────────────────────────────
    monthly_limit:        monthlyLimit,
    monthly_usage_pct:    usagePercent,
    daily_soft_cap:       CONFIG.budget.dailySoftCap,
    degradation_level:    snap.level,
    max_deep_per_cycle:   snap.maxDeepPerCycle,
    trigger_multiplier:   snap.triggerMultiplier,
    skipped_today:        snap.skippedToday,
    per_type_monthly:     snap.byType,
    thresholds: {
      soft:    CONFIG.budget.monthlySoftCap,
      hard:    CONFIG.budget.monthlyHardLimit,
      freeze:  CONFIG.budget.monthlyFreeze,
      daily:   CONFIG.budget.dailySoftCap,
    },
    market: {
      is_open:    market.isOpen,
      state:      market.state,
      label:      market.label,
    },

    // ── Authoritative cross-check from the IndianAPI account ─
    // null when the upstream call fails or no key is configured.
    // Local counter is authoritative; this is an audit aid.
    upstream: upstream ? {
      total_requests:     upstream.total_requests,
      hard_limit:         upstream.hard_limit,
      remaining_requests: upstream.remaining_requests,
      endpoint_usage:     upstream.endpoint_usage ?? null,
      // Drift = local - upstream. Positive = local over-counted (rare,
      // usually a denied request that still spent locally for accounting).
      // Negative = local missed a call (shouldn't happen if every adapter
      // path goes through runIndianApi).
      drift_local_minus_upstream: snap.monthTotal - upstream.total_requests,
    } : null,

    // Window keys for sanity (UTC day + month buckets).
    month_key:     snap.monthKey,
    day_key:       snap.dayKey,
    server_now:    new Date().toISOString(),
  };

  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
