// ════════════════════════════════════════════════════════════════
//  GET /api/signals/health-report
//
//  One-shot system verification endpoint. Aggregates:
//    1. Current signal set (closed-mode loader off-hours, confirmed
//       snapshots during live hours).
//    2. Rotation diff vs the previous health-report invocation.
//    3. API budget snapshot (daily / monthly counters).
//    4. NSE market state + weekend detection.
//    5. Live-data freshness check (only meaningful when market_open).
//
//  Returns the spec's exact JSON shape so a single curl produces a
//  go/no-go verdict the operator can read at a glance.
//
//  Module-scope state survives across invocations within a process —
//  use Postman/curl twice (with a pipeline run in between) to see
//  rotation_detected=true. Reset on server restart.
// ════════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getMarketStatus, isMarketOpen } from '@/lib/marketData/marketHours';
import { snapshot as budgetSnapshot } from '@/lib/marketData/apiBudgetGuard';
import { CONFIG } from '@/lib/marketData/schedulerConfig';
import { loadClosedMarketSignals } from '@/lib/signals/closedMarketSignals';
import { loadConfirmedSignalsBundle } from '@/lib/signals/confirmedSignalsService';
import { recordSnapshot } from '@/lib/signals/signalRotationTracker';
import {
  getNseDirectFallbackConfig,
  isNseDirectFallbackEnabled,
}                                     from '@/lib/marketData/providerFlags';
import { getConsecutiveIndianApiFailures } from '@/lib/marketData/resolver/marketDataResolver';
import { getNseDirectStatus }         from '@/lib/marketData/providers/nseDirectProvider';
import { db }                         from '@/lib/db';
import { ensureUniverseReady }        from '@/lib/startup/ensureUniverseReady';
import type { ConfirmedSignalRow } from '@/lib/signals/signalsResponseMapper';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

// ── Live-data freshness probe (module-scope) ──────────────────────
// On each call we compute a fingerprint of every signal's
// (livePrice, liveTickTs). If the fingerprint hasn't changed since
// the previous call AND the market is open, live_data is NOT_WORKING.
// If it changed, live_data is WORKING. Off-hours we skip the check.
let lastPriceFingerprint: string | null = null;
let lastObservedAtMs:     number | null = null;

function buildPriceFingerprint(rows: ConfirmedSignalRow[]): string {
  const parts: string[] = [];
  for (const r of rows) {
    const ts = (r as any).liveTickTs ?? r.confirmed_at ?? '';
    parts.push(`${r.id ?? '?'}:${r.livePrice ?? r.entry_price ?? 0}:${ts}`);
  }
  return parts.sort().join('|');
}

type LiveDataStatus = 'WORKING' | 'NOT_WORKING' | 'MARKET_CLOSED' | 'INSUFFICIENT_DATA';

function evaluateLiveData(
  rows: ConfirmedSignalRow[],
  marketOpen: boolean,
): { status: LiveDataStatus; fingerprintChanged: boolean | null } {
  const fingerprint = buildPriceFingerprint(rows);
  const prev = lastPriceFingerprint;
  // Always update the fingerprint so the *next* call has a baseline.
  lastPriceFingerprint = fingerprint;
  const observedAt = Date.now();
  const sinceLast = lastObservedAtMs == null ? null : observedAt - lastObservedAtMs;
  lastObservedAtMs = observedAt;

  if (!marketOpen) return { status: 'MARKET_CLOSED', fingerprintChanged: null };
  if (rows.length === 0) return { status: 'INSUFFICIENT_DATA', fingerprintChanged: null };
  if (prev == null)      return { status: 'INSUFFICIENT_DATA', fingerprintChanged: null };
  // First two calls within 2 seconds → too tight to claim "not updating".
  if (sinceLast != null && sinceLast < 2000) {
    return { status: 'INSUFFICIENT_DATA', fingerprintChanged: null };
  }
  const changed = prev !== fingerprint;
  return {
    status: changed ? 'WORKING' : 'NOT_WORKING',
    fingerprintChanged: changed,
  };
}

// ── Endpoint ──────────────────────────────────────────────────────
export async function GET(): Promise<Response> {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  // UNIVERSE-RACE-2026-05 — same entry-point guard the dashboard's
  // /api/signals route uses. loadConfirmedSignalsBundle below calls
  // resolveBatch which dispatches through isInNifty500; without this
  // guard a boot-race poll on /api/signals/health-report saw
  // NIFTY500_UNIVERSE_NOT_INITIALIZED and surfaced an empty health card.
  // ensureUniverseReady is a no-op once the cache is hydrated (cheap to
  // call from a hot path).
  const universeReady = await ensureUniverseReady();
  if (!universeReady.ok) {
    return NextResponse.json(
      {
        ok:    false,
        error: 'UNIVERSE_NOT_READY',
        detail: universeReady.error,
      },
      { status: 503, headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
    );
  }

  const limit = 30;
  const market = getMarketStatus();
  const marketOpen = market.isOpen;

  // 1) Current signal set — same path /api/signals?action=all uses.
  let signals: ConfirmedSignalRow[] = [];
  let signalQuality: 'STRICT' | 'RELAXED' | 'NONE' | 'LIVE' = 'LIVE';
  let strictCount = 0;
  let relaxedUsed = false;
  let dataSource: string = 'confirmed_signals';
  if (!marketOpen) {
    const bundle = await loadClosedMarketSignals({ limit });
    signals       = bundle.signals;
    signalQuality = bundle.signalQuality;
    strictCount   = bundle.strictCount;
    relaxedUsed   = bundle.relaxedUsed;
    dataSource    = bundle.signals.length > 0 ? 'last_close_signals' : 'market_close_snapshot';
  } else {
    const bundle = await loadConfirmedSignalsBundle({ limit });
    signals       = bundle.finalRows;
    signalQuality = signals.length > 0 ? 'STRICT' : 'NONE';
    strictCount   = signals.length;
  }

  // 2) Rotation diff vs the previous health-report observation.
  const diff = recordSnapshot(signals.map((s) => ({
    id:        Number(s.id ?? 0),
    symbol:    (s.symbol ?? s.tradingsymbol ?? null) as string | null,
    direction: (s.direction ?? null) as string | null,
  })));

  // 3) Budget snapshot.
  const budget = await budgetSnapshot();
  const dailyLimit   = CONFIG.budget.dailySoftCap;          // 2500
  const monthlySoft  = CONFIG.budget.monthlySoftCap;        // 70000
  const monthlyHard  = CONFIG.budget.monthlyHardLimit;      // 85000
  const monthlyMax   = CONFIG.budget.monthlyFreeze;         // 90000
  const withinLimits = budget.dayTotal < dailyLimit && budget.monthTotal < monthlySoft;

  // 4) Weekend detection — sourced from the central market envelope so
  //     this route can never disagree with the wall-clock truth used by
  //     /api/signals, /api/rankings, /api/ticker, etc.
  const isWeekend = market.state === 'closed'
    && /weekend/i.test(market.label);
  const weekendApiBlocked = !isWeekend
    ? null                                    // not applicable
    : budget.dayTotal === 0 && dataSource !== 'confirmed_signals';

  // 4b) NSE-specific block — exchange the system trades on. Surfaces
  //     session window, holiday gate, NSE-direct fallback config, and
  //     a count of NSE rows currently in the strict pool. Helps the
  //     operator confirm at a glance:
  //       - which exchange we're reporting on
  //       - whether today is a holiday
  //       - whether the NSE-direct rare fallback would engage
  //       - how many NSE rows are in q365_signals right now
  const nseDirectCfg     = getNseDirectFallbackConfig();
  const nseDirectStatus  = await getNseDirectStatus();
  const nseDirectArmed =
       nseDirectCfg.enabled
    && getConsecutiveIndianApiFailures() >= nseDirectCfg.triggerFailures;
  let nseSignalsTotalActive: number | null = null;
  try {
    const { rows } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c
         FROM q365_signals
        WHERE exchange = 'NSE'
          AND UPPER(COALESCE(signal_status,'')) = 'APPROVED_SIGNAL'
          AND COALESCE(invalidation_reason,'') = ''`);
    nseSignalsTotalActive = Number((rows as any[])[0]?.c ?? 0);
  } catch { /* probe failure is non-fatal */ }
  const nseHoliday = market.state === 'holiday';
  const nseSession =
      market.state === 'open'     ? 'OPEN'
    : market.state === 'pre-open' ? 'PRE_OPEN'
    : market.state === 'holiday'  ? 'HOLIDAY'
    :                               'CLOSED';

  // 5) Live-data freshness.
  const live = evaluateLiveData(signals, marketOpen);

  // 6) System verdict — single line per the spec ladder.
  // Order matters: API rule violations dominate, then live-data,
  // then rotation/staleness.
  //
  // SYSTEM_STATIC only fires when the engine SHOULD be rotating
  // signals but isn't — i.e. market is open. Off-hours the signal
  // set is intentionally frozen on the last-close pool, so a
  // zero-rotation observation off-hours is the spec'd correct
  // behaviour, not a fault.
  let systemStatus: 'SYSTEM_HEALTHY' | 'SYSTEM_STATIC' | 'API_RULES_BROKEN' | 'LIVE_DATA_NOT_UPDATING';
  if (!withinLimits) {
    systemStatus = 'API_RULES_BROKEN';
  } else if (isWeekend && budget.dayTotal > 0) {
    systemStatus = 'API_RULES_BROKEN';
  } else if (marketOpen && live.status === 'NOT_WORKING') {
    systemStatus = 'LIVE_DATA_NOT_UPDATING';
  } else if (
    marketOpen &&
    !diff.first_observation &&
    diff.new_count === 0 && diff.removed_count === 0 &&
    diff.previous_count > 0
  ) {
    systemStatus = 'SYSTEM_STATIC';
  } else {
    systemStatus = 'SYSTEM_HEALTHY';
  }

  const report = {
    // ── Spec response shape ──────────────────────────────────
    total_signals:        diff.current_count,
    new_signals:          diff.new_count,
    removed_signals:      diff.removed_count,
    unchanged:            diff.unchanged_count,
    rotation_detected:    (diff.new_count + diff.removed_count) > 0,

    api_calls_today:      budget.dayTotal,
    api_calls_month:      budget.monthTotal,
    within_limits:        withinLimits,
    daily_limit:          dailyLimit,
    monthly_limit:        monthlySoft,
    monthly_hard_limit:   monthlyHard,
    monthly_freeze:       monthlyMax,
    degradation_level:    budget.level,

    weekend_api_blocked:  weekendApiBlocked,
    is_weekend:           isWeekend,
    market_open:          marketOpen,
    market_state:         market.state,
    market_label:         market.label,

    // ── NSE block — exchange-specific health ──────────────────
    nse: {
      // Spec contract: this system trades NSE cash equity only. The
      // block confirms which exchange the report is for, plus the
      // session window and the rare NSE-direct fallback state.
      exchange:                     'NSE',
      session:                      nseSession,           // OPEN | PRE_OPEN | CLOSED | HOLIDAY
      session_open_ist:             market.sessionOpenIst,
      session_close_ist:            market.sessionCloseIst,
      now_ist:                      market.nowIst,
      is_holiday:                   nseHoliday,
      is_weekend:                   isWeekend,
      label:                        market.label,
      signals_total_active:         nseSignalsTotalActive,
      direct_fallback: {
        enabled:                    isNseDirectFallbackEnabled(),
        trigger_after_failures:     nseDirectCfg.triggerFailures,
        max_symbols_per_day:        nseDirectCfg.maxSymbolsPerDay,
        min_delay_ms:               nseDirectCfg.minDelayMs,
        consecutive_indianapi_fail: getConsecutiveIndianApiFailures(),
        would_engage_now:           nseDirectArmed,
        // Safety state from the NSE-direct provider itself —
        // tripped/backoff/daily-cap visibility for the operator.
        // `tripped_until` non-null means we hit a 403/captcha/non-JSON
        // and have stopped calling NSE until the next IST midnight.
        // `backoff_until` non-null means a soft failure streak is in
        // exponential cooldown.
        tripped_until:              nseDirectStatus.trippedUntil,
        backoff_until:              nseDirectStatus.backoffUntil,
        consecutive_soft_failures:  nseDirectStatus.consecutiveSoftFailures,
        daily_used:                 nseDirectStatus.dailyCount,
        daily_cap:                  nseDirectStatus.dailyCap,
        cache_ttl_seconds:          nseDirectStatus.cacheTtlSeconds,
        provider_priority:          ['indianapi', 'nse_direct'],
        yahoo_disabled:             true,
      },
    },

    live_data_status:     live.status === 'WORKING' ? 'WORKING'
                        : live.status === 'NOT_WORKING' ? 'NOT_WORKING'
                        : live.status,                   // 'MARKET_CLOSED' | 'INSUFFICIENT_DATA'
    fingerprint_changed:  live.fingerprintChanged,

    system_status:        systemStatus,

    // ── Diagnostics — useful when system_status != HEALTHY ───
    diagnostics: {
      first_observation:  diff.first_observation,
      signal_quality:     signalQuality,
      strict_count:       strictCount,
      relaxed_used:       relaxedUsed,
      data_source:        dataSource,
      previous_count:     diff.previous_count,
      current_count:      diff.current_count,
      rotation_percent:   diff.rotation_percent,
      new_ids_sample:     diff.new.slice(0, 5),
      removed_ids_sample: diff.removed.slice(0, 5),
      unchanged_sample:   diff.unchanged.slice(0, 5),
      observation_count:  diff.lifecycle.length,
      ist_weekday:        new Date(Date.now() + 5.5 * 3_600_000).getUTCDay(),
      recorded_at:        diff.recorded_at,
    },
  };

  // Spec log line — grep on `HEALTH-REPORT` to confirm the endpoint
  // ran and which verdict it returned.
  console.log(
    `HEALTH-REPORT  status=${systemStatus}  signals=${diff.current_count}  ` +
    `new=${diff.new_count}  removed=${diff.removed_count}  ` +
    `daily=${budget.dayTotal}/${dailyLimit}  monthly=${budget.monthTotal}/${monthlySoft}  ` +
    `market_open=${marketOpen}  weekend=${isWeekend}  live=${live.status}`,
  );

  return NextResponse.json(report, {
    headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' },
  });
}
