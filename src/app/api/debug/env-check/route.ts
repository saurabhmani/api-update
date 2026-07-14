// GET /api/debug/env-check — Kite / provider env diagnostics (Phase 3).
import { NextResponse } from 'next/server';
import { getKiteHealth, isKiteConfigured } from '@/lib/kite/health';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const kiteConfigured = isKiteConfigured();
  const kite = getKiteHealth();
  const apiKey = (process.env.KITE_API_KEY ?? '').trim();
  const accessToken = (process.env.KITE_ACCESS_TOKEN ?? '').trim();

  const schedulerActive = (() => {
    const sched = (process.env.Q365_INPROC_SCHEDULER ?? '').trim().toLowerCase();
    if (sched === '1' || sched === 'true') return true;
    if (sched === '0' || sched === 'false') return false;
    const regen = (process.env.Q365_INPROC_REGEN ?? '').trim().toLowerCase();
    if (regen === '1' || regen === 'true') return true;
    return process.env.NODE_ENV === 'development';
  })();

  return NextResponse.json(
    {
      kite: {
        configured: kiteConfigured,
        available: kite.available,
        auth_failed: kite.auth_failed,
        rate_limited: kite.rate_limited,
        api_key_loaded: apiKey.length > 0,
        api_key_length: apiKey.length,
        api_key_prefix: apiKey ? apiKey.slice(0, 4) : null,
        access_token_loaded: accessToken.length > 0,
      },
      breaker: null,
      scheduler_active: schedulerActive,
      flags: {
        MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER ?? 'unset',
        YAHOO_EMERGENCY_FALLBACK_ENABLED: process.env.YAHOO_EMERGENCY_FALLBACK_ENABLED ?? 'unset',
        NSE_DIRECT_FALLBACK_ENABLED: process.env.NSE_DIRECT_FALLBACK_ENABLED ?? 'unset',
        SIGNAL_RELAX_MODE: process.env.SIGNAL_RELAX_MODE ?? 'unset',
        Q365_INPROC_REGEN: process.env.Q365_INPROC_REGEN ?? 'unset',
        NODE_ENV: process.env.NODE_ENV ?? 'unset',
      },
      recommendation: !kiteConfigured
        ? 'KITE_API_KEY / KITE_ACCESS_TOKEN not loaded. Add them to .env.local and restart.'
        : kite.auth_failed
        ? 'Kite credentials loaded but authentication failed — refresh KITE_ACCESS_TOKEN.'
        : kite.rate_limited
        ? 'Kite rate limit active — backoff and retry.'
        : 'Kite is configured and healthy.',
      decommissioned_legacy_vendor: true,
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    },
  );
}
