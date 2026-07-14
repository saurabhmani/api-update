// ════════════════════════════════════════════════════════════════
//  GET /api/usage
//
//  Kite-primary ops projection. Returns availability / rate-limit
//  health from @/lib/kite/health — no monthly vendor quotas, never
//  503 for plan-ceiling burn.
//
//  Read-only. No DB writes. Cheap; safe to poll.
//  Public — no session required so the dashboard's compliance banner
//  can render without an authenticated context.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { getMarketDataProvider } from '@/lib/marketData/providerFlags';
import { getKiteHealth } from '@/lib/kite/health';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const market     = getMarketStatus();
  const kite       = getKiteHealth();
  const current_provider = getMarketDataProvider();

  const compliance =
    !kite.configured ? 'BORDERLINE'
      : kite.auth_failed ? 'UNSAFE'
        : kite.rate_limited ? 'BORDERLINE'
          : kite.available ? 'SAFE'
            : 'BORDERLINE';

  const reasons: string[] = [];
  if (!kite.configured) reasons.push('kite_not_configured');
  if (kite.auth_failed) reasons.push('kite_auth_failed');
  if (kite.rate_limited) reasons.push('kite_rate_limited');
  if (kite.configured && !kite.available && !kite.auth_failed && !kite.rate_limited) {
    reasons.push('kite_unavailable');
  }

  return NextResponse.json(
    {
      compliance,
      reasons,
      current_provider,
      provider_limits: {
        kite: {
          kind: 'rate_limit_events',
          monthly_quota: null,
          rate_limit_events: kite.rate_limit_events,
          auth_failed: kite.auth_failed,
          available: kite.available,
        },
      },
      kite: {
        configured: kite.configured,
        available: kite.available,
        auth_failed: kite.auth_failed,
        rate_limited: kite.rate_limited,
        rate_limit_events: kite.rate_limit_events,
        last_success_at: kite.last_success_at,
        calls_today: kite.calls_today,
        requests: kite.requests,
        successes: kite.successes,
        failures: kite.failures,
        monthly_quota: null,
      },
      market: {
        is_open:  market.isOpen,
        state:    market.state,
        label:    market.label,
        weekend:  (() => {
          const istNow = new Date(Date.now() + 5.5 * 3_600_000);
          const wd = istNow.getUTCDay();
          return wd === 0 || wd === 6;
        })(),
      },
      server_now: new Date().toISOString(),
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    },
  );
}
