// ════════════════════════════════════════════════════════════════
//  GET /api/debug/env-check
//
//  Spec "FIX 403" §7 — diagnostic endpoint that confirms whether
//  INDIANAPI_API_KEY is loaded and roughly the right shape, plus the
//  current breaker / auth-failure state. Never reveals the full key.
//
//  Response shape:
//    {
//      api_key: { loaded, length, prefix, likely_truncated },
//      base_url, timeout_ms,
//      breaker: { state, open, auth_failed, ... },
//      scheduler_active,
//      flags: { ...env-flag summary }
//    }
//
//  Designed so an operator hitting this URL gets the answer to
//  "is my key configured?" in one round-trip without having to
//  grep the boot log.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { getIndianApiConfig } from '@/lib/marketData/providers/indianApiEndpoints';
import { indianApiBreakerState } from '@/providers/adapters/IndianAPIAdapter';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

export async function GET(): Promise<Response> {
  const cfg = getIndianApiConfig();
  // Resolve the apiKey from any of the three accepted env names so an
  // operator using the legacy INDIAN_API_KEY doesn't see a false
  // "not loaded" — the adapter's getIndianApiConfig already handles
  // this, but we use cfg.apiKey here for consistency.
  const apiKey = cfg.apiKey ?? '';
  const loaded = apiKey.length > 0;
  // Empirical: valid IndianAPI live keys are ~48 chars. Anything
  // under 30 is almost certainly a bad copy-paste / truncation.
  const likelyTruncated = loaded && apiKey.length < 30;

  const breaker = indianApiBreakerState();

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
      api_key: {
        loaded,
        length:           apiKey.length,
        // First 5 chars only. The 'sk-live-' prefix is in IndianAPI's
        // public docs so this isn't a secret leak, but it lets the
        // operator confirm the right key was loaded vs. a stale one.
        prefix:           loaded ? apiKey.slice(0, 5) : null,
        likely_truncated: likelyTruncated,
        // Source: which env var actually populated the key.
        source:
          process.env.INDIANAPI_API_KEY?.trim() ? 'INDIANAPI_API_KEY' :
          process.env.INDIANAPI_KEY?.trim()     ? 'INDIANAPI_KEY' :
          process.env.INDIAN_API_KEY?.trim()    ? 'INDIAN_API_KEY' :
          null,
      },
      base_url:   cfg.baseUrl,
      timeout_ms: cfg.timeoutMs,
      breaker,
      scheduler_active: schedulerActive,
      flags: {
        MARKET_DATA_PROVIDER:           process.env.MARKET_DATA_PROVIDER ?? 'unset',
        INDIANAPI_PRIMARY:              process.env.INDIANAPI_PRIMARY ?? 'unset',
        INDIANAPI_ENABLED:              process.env.INDIANAPI_ENABLED ?? 'unset',
        INDIANAPI_BLOCK_OUTSIDE_MARKET: process.env.INDIANAPI_BLOCK_OUTSIDE_MARKET ?? 'unset',
        YAHOO_EMERGENCY_FALLBACK_ENABLED: process.env.YAHOO_EMERGENCY_FALLBACK_ENABLED ?? 'unset',
        NSE_DIRECT_FALLBACK_ENABLED:    process.env.NSE_DIRECT_FALLBACK_ENABLED ?? 'unset',
        SIGNAL_RELAX_MODE:              process.env.SIGNAL_RELAX_MODE ?? 'unset',
        Q365_INPROC_REGEN:              process.env.Q365_INPROC_REGEN ?? 'unset',
        NODE_ENV:                       process.env.NODE_ENV ?? 'unset',
      },
      recommendation: !loaded
        ? 'INDIANAPI_API_KEY is not loaded. Add it to .env.local and restart the server.'
        : likelyTruncated
        ? `Key length (${apiKey.length}) is below the typical ~48-char live key length. Likely truncated by an editor — re-paste the full key from your IndianAPI dashboard.`
        : breaker.auth_failed
        ? 'Key is loaded but IndianAPI is rejecting it (403 latched). The key may be revoked, expired, or your IP blocked. Verify in the IndianAPI dashboard.'
        : breaker.open
        ? `Key is valid but IndianAPI is rate-limited (breaker ${breaker.state}). Will retry in ${Math.round(breaker.remainingMs / 1000)}s.`
        : 'Key is loaded and IndianAPI is responsive.',
    },
    {
      status: 200,
      headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
    },
  );
}
