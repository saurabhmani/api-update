// GET /api/market-data/usage — removed vendor budget ledger removed (Phase 3).
import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getMarketStatus } from '@/lib/marketData/marketHours';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const market = getMarketStatus();
  return NextResponse.json({
    daily_calls: 0,
    monthly_calls: 0,
    remaining_quota: null,
    monthly_limit: null,
    monthly_usage_pct: 0,
    daily_soft_cap: null,
    degradation_level: 'normal',
    max_deep_per_cycle: 6,
    trigger_multiplier: 1,
    skipped_today: 0,
    per_type_monthly: {},
    thresholds: null,
    market: {
      is_open: market.isOpen,
      state: market.state,
      label: market.label,
    },
    upstream: null,
    decommissioned: true,
    note: 'removed vendor budget ledger removed; live data uses Kite.',
  });
}
