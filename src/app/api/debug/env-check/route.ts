/**
 * GET /api/debug/env-check — IndianAPI / provider env diagnostics.
 */
import { NextResponse } from 'next/server';
import {
  getMarketDataProvider,
  indianApiCredentialsPresent,
  isIndianApiEnabled,
} from '@/lib/marketData/providerFlags';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const enabled = isIndianApiEnabled();
  const creds = indianApiCredentialsPresent();
  const key =
    process.env.INDIANAPI_API_KEY?.trim()
    || process.env.INDIANAPI_KEY?.trim()
    || process.env.INDIAN_API_KEY?.trim()
    || '';

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
      indianapi: {
        enabled,
        credentialsConfigured: creds,
        api_key_loaded: key.length > 0,
        api_key_length: key.length,
        api_key_prefix: key ? key.slice(0, 4) : null,
      },
      kite: {
        note: 'Kite market-data integration removed',
        configured: false,
      },
      breaker: null,
      scheduler_active: schedulerActive,
      flags: {
        MARKET_DATA_PROVIDER: process.env.MARKET_DATA_PROVIDER ?? 'unset',
        resolved_provider: getMarketDataProvider(),
        INDIANAPI_ENABLED: process.env.INDIANAPI_ENABLED ?? 'unset',
        YAHOO_EMERGENCY_FALLBACK_ENABLED: process.env.YAHOO_EMERGENCY_FALLBACK_ENABLED ?? 'unset',
        NSE_DIRECT_FALLBACK_ENABLED: process.env.NSE_DIRECT_FALLBACK_ENABLED ?? 'unset',
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
