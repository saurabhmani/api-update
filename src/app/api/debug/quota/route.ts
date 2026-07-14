// GET /api/debug/quota — removed vendor quota removed (Phase 3 decommission).
import { NextResponse } from 'next/server';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  return NextResponse.json({
    daily:   { used: 0, limit: 0, remaining: 0, percent: 0 },
    monthly: {
      used: 0, safe_limit: 0, hard_limit: 0,
      remaining_safe: 0, remaining_hard: 0, percent: 0, percent_safe: 0,
    },
    state: 'SAFE',
    limit_near: false,
    reduce_polling: false,
    block_non_essential: false,
    block_all: false,
    resets: { daily_at: null, monthly_at: null },
    decommissioned: true,
    note: 'removed vendor quota tracking removed; Kite has no shared monthly quota ledger.',
  }, {
    status:  200,
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
