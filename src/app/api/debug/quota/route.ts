// ════════════════════════════════════════════════════════════════
//  GET /api/debug/quota
//
//  Spec QUOTA_TRACKING — returns the current IndianAPI usage report
//  in the canonical shape:
//
//    {
//      daily:   { used, limit, remaining, percent },
//      monthly: { used, safe_limit, hard_limit, remaining_safe,
//                 remaining_hard, percent, percent_safe },
//      state:   "SAFE" | "WARNING" | "CRITICAL" | "BLOCKED",
//      limit_near, reduce_polling, block_non_essential, block_all,
//      resets:  { daily_at, monthly_at }
//    }
//
//  Counters are IST-aligned (00:00 IST daily reset, 1st of IST month
//  monthly reset) and Redis-backed (with in-process fallback). Read-
//  only; never calls upstream.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { getQuotaReport } from '@/lib/monitor/apiQuota';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const report = await getQuotaReport();
  return NextResponse.json(report, {
    status:  200,
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
