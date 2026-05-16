// ════════════════════════════════════════════════════════════════
//  GET /api/signals/stream  — Server-Sent Events
//
//  Long-lived HTTP stream that pushes the current top-50 signal
//  snapshot every STREAM_INTERVAL_MS. Replaces the dashboard's
//  polling-based refresh with a push model — the client opens one
//  connection at page load and receives new snapshots as the
//  rescore / regen loops mutate q365_signals on the server.
//
//  WHY SSE, NOT WEBSOCKET:
//    This is a one-way server-→-client stream. SSE is half the
//    complexity of a WebSocket for that use case: no frame protocol,
//    no handshake negotiation, browser auto-reconnect is built in,
//    and it rides plain HTTP so any proxy / CDN handles it fine.
//    The existing price-tick WS (`streamServer.ts`) stays untouched;
//    this SSE is a separate, lighter-weight channel for the signal
//    *list* itself (row add/remove/rerank), not per-tick prices.
//
//  CONNECTION LIFECYCLE:
//    1. Browser opens EventSource → this handler runs.
//    2. On connect we push an immediate snapshot (`event: snapshot`)
//       so the user sees data without waiting a full interval.
//    3. Every STREAM_INTERVAL_MS we push again (`event: signals`).
//    4. When the browser closes the tab / navigates away / refreshes,
//       req.signal fires abort. Our cleanup clears the timer and
//       closes the controller so no leaked loops survive.
//    5. On transport errors the BROWSER auto-reconnects after ~3s
//       (EventSource default) — we do nothing special.
//
//  RATE CONSIDERATIONS:
//    Per-connection getActiveConfirmedSnapshots + Yahoo enrichment // @deprecated marker
//    costs a DB query + up to N Yahoo fetches. The Yahoo fetcher has // @deprecated marker
//    its own TTL cache, so a single dashboard open imposes at most
//    one DB query per cache window. A small team of 5 operators =
//    5 connections = ~1 DB query/second peak. Fine.
// ════════════════════════════════════════════════════════════════

import { NextRequest } from 'next/server';
import { requireSession } from '@/lib/session';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';
import { getActiveConfirmedSnapshots } from '@/lib/signal-engine/repository/readConfirmedSnapshots';
import { resolveBatch } from '@/lib/marketData/resolver/marketDataResolver';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import {
  applyConfirmedCap,
  confirmedSnapshotCmp,
  strictApproved,
  type SortableSnapshotRow,
}                            from '@/lib/signals/confirmedSignalPolicy';
import {
  type ConfirmedSignalRow,
}                            from '@/lib/signals/signalsResponseMapper';
// strictApproved + the threshold/classification constants are now
// imported from the canonical policy module. SSE and HTTP transports
// share one copy — no more drift risk between routes.

export const dynamic = 'force-dynamic';
export const revalidate = 0;

// 1s push cadence — operator wants the dashboard to feel "live": prices,
// scores, and direction flips should reflect the latest DB state within
// a second of being written. The Phase-12 in-memory partition + gates
// over ~100 rows per push are sub-millisecond, and the SWR cache below
// keeps the DB query rate to ~1/s/process regardless of subscriber count.
// Step 7(a) of the budget-fix PR: 5s push cadence. The SWR cache
// window is 4s; pushing every 1s forced a fresh enrichment fetch on
// every other tick. 5s + 4s SWR ⇒ ~3 actual upstream fetches/min
// instead of ~12 — eliminates the silent SSE quota drain.
const STREAM_INTERVAL_MS = 5_000;

// Module-level SWR cache shared across all SSE connections in this
// process. Without it, every browser tab that opens the stream fired
// its own DB query and waited up to 10s for the cold response — that
// "OFFLINE for 20 seconds" symptom the user reported on first load.
//
// With the cache:
//   - Cold load: first connection waits up to 6s for the DB. If the
//     query is slow, the stream still pushes an empty-but-valid frame
//     so the UI flips from CONNECTING → LIVE immediately. Real data
//     arrives in the next push tick once the DB returns.
//   - Warm load: subsequent connections + ticks use the cached value
//     instantly while a single background refresh updates it.
//
// Cache fresh window — set to 4s (NOT 800ms) even though we push every 1s.
// PRODUCTION TUNING: an 800ms window on a 1s push means every push hits
// the DB cold (cache stale by the time the next tick arrives) → with
// pool=30 and 1-second SSE per client, the pool exhausts in seconds and
// "Queue limit reached" errors flood the logs. With 4s freshness:
//   - 4 of every 5 pushes return cached data (microseconds)
//   - Only 1 of 5 actually queries the DB
//   - DB load drops 5x while the user still sees 1-second refresh on
//     the wire (the cached data is at most 4s stale, which is invisible
//     to a human watching prices update).
// SWR cache state, the timeout helper, and `invalidateStreamSignalsCache`
// moved to @/lib/signals/streamSignalsCache. Reason: Next.js Route
// Handlers may only export a fixed allowlist (HTTP methods etc.);
// exporting the invalidator from this file violated that rule and
// produced a TS2344 in .next/types.
//
// Behaviour is byte-identical — see streamSignalsCache.ts.
import {
  getCachedOrFetch,
  type StreamCacheResult,
}                            from '@/lib/signals/streamSignalsCache';

type CachedSignalsResult = StreamCacheResult<unknown>;

/**
 * Read source: confirmed snapshots ONLY. The q365_signals fallback
 * has been removed per the institutional-filter spec — SSE must
 * never surface live-scanner rows in the main table. If the
 * confirmed-snapshot pool is empty, SSE pushes signals: [] and the
 * dashboard correctly renders the empty state.
 */
async function enrichLivePricesForStream(rows: any[]): Promise<any[]> {
  // Per-tick enrichment via the central resolver. One batch call to
  // IndianAPI (with cache-fan-out) replaces the previous per-symbol
  // Yahoo fan-out. The resolver also writes the per-symbol cache so // @deprecated marker
  // the next tick is served from cache without an upstream call.
  const targets = rows.map((r) => ({
    row: r,
    sym: String(r.tradingsymbol ?? r.symbol ?? '').toUpperCase(),
  })).filter((t) => t.sym);

  if (targets.length === 0) return rows;

  const symbols = targets.map((t) => t.sym);
  const TIMEOUT_MS = 4_000;

  const resolvePromise = resolveBatch(symbols, { quiet: true });
  const timeout = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), TIMEOUT_MS),
  );
  const result = await Promise.race([resolvePromise, timeout]);
  if (result === 'timeout') return rows;

  for (const { row, sym } of targets) {
    const snap = result.snapshots.get(sym);
    if (snap && Number.isFinite(snap.price) && snap.price > 0) {
      row.livePrice   = snap.price;
      row.livePChange = Number.isFinite(snap.changePercent) ? snap.changePercent : null;
      row.liveSource  = result.provider === 'yahoo_emergency' ? 'yahoo' : 'indianapi'; // @deprecated marker
      row.liveTickTs  = snap.timestamp || Date.now();
    }
  }
  return rows;
}

// computeFallbackUiFields removed: SSE no longer surfaces q365_signals
// fallback rows, so there are no "raw scanner" rows to retrofit
// confirmed-snapshot UI columns onto.

async function readConfirmedSnapshotsOnly(): Promise<any[]> {
  // Pull a wider window from the reader (200) so the strict gate +
  // cap have material to work with even when most snapshots fail
  // the 75/70 floor. Cap is applied AFTER the gate.
  const snaps = await getActiveConfirmedSnapshots({ limit: 200 });
  if (snaps.length === 0) return [];
  // Apply the same institutional gate + sort + cap as the HTTP route.
  // This is what guarantees SSE and HTTP frames agree row-for-row.
  const gated: ConfirmedSignalRow[] = (snaps as ConfirmedSignalRow[])
    .filter(strictApproved)
    .sort((a: SortableSnapshotRow, b: SortableSnapshotRow) => confirmedSnapshotCmp(a, b));
  const capped = applyConfirmedCap(gated);
  // Live-price enrichment so SSE pushes fresh livePrice every cycle —
  // not the static frozen entry. Cached so subsequent ticks within the
  // 8s TTL hit the cache.
  return enrichLivePricesForStream(capped);
}

async function getConfirmedSnapshotsCached(): Promise<CachedSignalsResult> {
  return getCachedOrFetch<unknown>(readConfirmedSnapshotsOnly);
}

// ── Stream source — confirmed snapshots only ────────────────────
//
// Two-layer split: this stream reads from q365_confirmed_signal_snapshots
// where every row has already cleared the rejection engine, the live
// validation gate, and the rr/conf/edge floor. There is therefore no
// per-tick gating here. A row's status can move from ACTIVE to one of
// {TARGET_HIT, STOP_LOSS_HIT, INVALIDATED, EXPIRED} via the lifecycle
// worker — the reader filters to status='ACTIVE' AND valid_until>NOW()
// at the SQL level, so the SSE never has to redo that check.
//
// Phase-12 partition / Phase-8 live re-validation removed from this
// path: those operate on q365_signals (the live scanner table), not
// on locked snapshots.

// Lazy load — enrichWithLiveLtp lives in the REST route file and
// is not yet a standalone module. We call a lighter path here:
// just read the DB + filter invalidation. Live prices still arrive
// over the existing WebSocket (useLivePrices). SSE is for the
// SIGNAL LIST mutating — not for per-tick prices.

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return new Response('Unauthorized', { status: 401 }); }

  // Universe init guard — resolveBatch calls isInNifty500() (sync getter;
  // throws when the cache isn't hydrated). Without this, the first SSE
  // connection on a cold instrumentation boot crashes the stream before
  // the first snapshot frame is sent.
  const universeReady = await ensureUniverseReady();
  if (!universeReady.ok) {
    return new Response(
      JSON.stringify({ error: 'Universe not ready', code: 'UNIVERSE_NOT_READY', detail: universeReady.error }),
      { status: 503, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      // Declared up-front so onAbort can safely reference them even if
      // the request aborts during `await push(true)` below — before the
      // intervals are assigned. Earlier we hit a TDZ crash here that
      // killed the whole Node process when a client disconnected mid-fetch.
      let tick:      ReturnType<typeof setInterval> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;

      // SSE framing helper. Events use named-event form so the
      // client can listen with addEventListener('snapshot', ...)
      // rather than the generic 'message' event — keeps snapshot
      // vs signals vs error handling on separate listeners.
      const send = (event: string, payload: unknown): void => {
        if (closed) return;
        try {
          const frame =
            `event: ${event}\n` +
            `data: ${JSON.stringify(payload)}\n\n`;
          controller.enqueue(encoder.encode(frame));
        } catch {
          closed = true;
        }
      };

      // Abort wiring — fires when the browser closes the tab, the
      // user navigates away, or Next restarts. Without this the
      // setInterval below runs forever, leaking DB queries.
      const onAbort = (): void => {
        if (closed) return;
        closed = true;
        if (tick)      clearInterval(tick);
        if (heartbeat) clearInterval(heartbeat);
        try { controller.close(); } catch { /* already closed */ }
      };
      req.signal.addEventListener('abort', onAbort);

      // Initial comment frame — SSE recipients (and some proxies)
      // need *something* to see the connection is alive before the
      // first real event lands.
      controller.enqueue(encoder.encode(': connected\n\n'));

      // Core push. Called immediately on connect and then every
      // STREAM_INTERVAL_MS. Errors are caught and surfaced as an
      // 'error' event rather than killing the stream; the browser
      // would only auto-reconnect after `controller.close()`.
      async function push(firstTime = false): Promise<void> {
        if (closed) return;
        // Step 7(b): off-hours short-circuit. Outside market hours
        // there's no live tape to enrich against. We still ship the
        // last cached snapshot so the dashboard stays responsive,
        // but we DO NOT trigger a fresh upstream fetch. Saves the
        // entire weekend SSE drain.
        const market = getMarketStatus();
        if (!market.isOpen) {
          try {
            // Off-hours frame must carry the same `mode='market_closed'`
            // envelope the HTTP /api/signals route emits, so the
            // dashboard banner stays populated regardless of which
            // transport fires first. Reading q365_market_close_snapshot
            // is a single SELECT — no upstream call.
            const { db } = await import('@/lib/db');
            let market_data: Array<Record<string, unknown>> = [];
            try {
              const { rows } = await db.query<{
                symbol: string; price: string | number;
                change_abs: string | number | null;
                change_pct: string | number | null;
                volume:     string | number | null;
                snapshot_ts: Date | string;
              }>(
                `SELECT symbol, price, change_abs, change_pct, volume, snapshot_ts
                   FROM q365_market_close_snapshot
                  ORDER BY symbol LIMIT 500`,
              );
              const num = (v: unknown) => {
                if (v === null || v === undefined || v === '') return null;
                const n = typeof v === 'number' ? v : Number(v);
                return Number.isFinite(n) ? n : null;
              };
              market_data = (rows as any[]).map((r) => ({
                symbol:         String(r.symbol),
                price:          num(r.price) ?? 0,
                change:         num(r.change_abs),
                change_percent: num(r.change_pct),
                volume:         num(r.volume),
                timestamp:      r.snapshot_ts instanceof Date
                                  ? r.snapshot_ts.toISOString()
                                  : String(r.snapshot_ts),
              }));
            } catch { /* table missing on fresh DB → empty market_data */ }
            const has_data = market_data.length > 0;
            send(firstTime ? 'snapshot' : 'signals', {
              // ── Market-aware envelope — matches HTTP route ───────────
              mode:        'market_closed',
              data_source: has_data ? 'market_close_snapshot' : 'none',
              market_data,
              message:     has_data
                ? 'Market closed — showing last close data'
                : 'Market closed — no snapshot data available',
              market_state: market.state,
              market_label: market.label,
              // ── Legacy fields kept for back-compat with the LKG gate
              //    (acceptResponse refuses empty signals[] without
              //     empty_confirmed=true; setting it true here lets the
              //     stream commit a clean closed state).
              signals:                [],
              emerging:               [],
              emerging_opportunities: [],
              count:                  0,
              direction_breakdown:    { BUY: 0, SELL: 0 },
              main_signals_count:     0,
              buy_count:              0,
              sell_count:             0,
              empty_confirmed:        true,
              validation_status:      'MARKET_CLOSED',
              market_open:            false,
              cached_off_hours:       true,
              ts:                     Date.now(),
            });
          } catch { /* swallow; the heartbeat keeps the connection */ }
          return;
        }
        try {
          const t0 = Date.now();
          // SWR-cached + bounded read. On cold start (no cache yet), waits
          // up to SIGNALS_FETCH_TIMEOUT_MS then ships an empty frame so
          // the EventSource flips to OPEN/LIVE on the client side rather
          // than hanging in CONNECTING for 20+ seconds while the DB chews.
          const cached = await getConfirmedSnapshotsCached();
          // Confirmed snapshots are ALREADY gate-validated and locked.
          // No per-push re-gating — the lifecycle worker is the only
          // mutation source, and it only changes the status field.
          const mainTable = cached.data as any[];
          const emerging: any[] = [];
          // No staged fallback — SSE reads confirmed snapshots only.

          const buyCount  = mainTable.filter((r) => String(r.direction ?? '').toUpperCase() === 'BUY').length;
          const sellCount = mainTable.filter((r) => String(r.direction ?? '').toUpperCase() === 'SELL').length;

          // Validation envelope — same contract as /api/signals so the
          // frontend's Last-Known-Good guard works identically across
          // both transports. CRITICAL: when cached.verified is false
          // (timeout/error) we ship empty_confirmed=false so the client
          // ignores the empty frame instead of clobbering its state.
          //
          // Critical bug fix: this stream only reads confirmed_snapshots,
          // but the HTTP /api/signals route also has a q365_signals
          // fallback. When confirmed_snapshots is empty AND the HTTP
          // fallback is delivering rows, the SSE used to claim
          // empty_confirmed=true — and the page's Last-Known-Good gate
          // accepted that as authoritative truth and wiped the 77 rows
          // the HTTP poll just landed. Set empty_confirmed=false so the
          // LKG gate refuses to overwrite a populated table with an
          // empty SSE frame. We're not lying — we genuinely don't know
          // whether the live scanner table has rows the HTTP path could
          // have surfaced; we only know our slice is empty.
          let validation_status: 'OK' | 'NO_SIGNALS_CONFIRMED' | 'API_ERROR';
          let empty_confirmed = false;
          if (!cached.verified) {
            validation_status = 'API_ERROR';
          } else if (mainTable.length === 0) {
            validation_status = 'NO_SIGNALS_CONFIRMED';
            empty_confirmed   = false;
          } else {
            validation_status = 'OK';
          }

          // Confirmed snapshots have no batch_id concept (batches are a
          // q365_signals scanner artefact). The frontend's lastBatchIdRef
          // guard is meaningful only on the live-scanner path; here we
          // emit null and the guard becomes a no-op.
          const latestBatchId: string | null = null;

          const payload = {
            // ── Validation envelope ─────────────────────────────────
            response_generated_at: new Date().toISOString(),
            validation_status,
            empty_confirmed,
            is_partial_scan:        false,                    // SSE has no batch-coverage probe; HTTP poll owns that gate
            latest_batch_id:        latestBatchId,
            main_signals_count:     mainTable.length,
            buy_count:              buyCount,
            sell_count:             sellCount,
            emerging_count:         emerging.length,
            fallback_used:          'none' as const,           // SSE never falls back; confirmed-snapshots only
            cache_source:           cached.source,
            // ── Existing payload (unchanged) ────────────────────────
            // The frontend binds `payload.signals` directly into its
            // `signals` state — emit ONLY the gated main-table rows
            // here so the SSE stream and the HTTP poll agree.
            signals:                mainTable,
            emerging_opportunities: emerging,
            count:                  mainTable.length,
            direction_breakdown:    { BUY: buyCount, SELL: sellCount },
            ts:                     Date.now(),
            elapsed:                Date.now() - t0,
          };
          send(firstTime ? 'snapshot' : 'signals', payload);
        } catch (err: any) {
          send('error', { error: err?.message ?? 'stream-fetch-failed' });
        }
      }

      // Immediate push so the user doesn't wait STREAM_INTERVAL_MS
      // for the first data frame.
      await push(true);

      tick = setInterval(() => { void push(false); }, STREAM_INTERVAL_MS);

      // Keep-alive heartbeat every 20s — an SSE comment line that
      // stops intermediate proxies (nginx, Cloudflare) from closing
      // idle connections. The data itself is the 5s push, but if
      // push() ever stalls (long DB query), the heartbeat keeps the
      // socket from being reaped.
      heartbeat = setInterval(() => {
        if (closed) {
          if (heartbeat) clearInterval(heartbeat);
          return;
        }
        try { controller.enqueue(encoder.encode(': ping\n\n')); }
        catch { closed = true; if (heartbeat) clearInterval(heartbeat); }
      }, 20_000);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type':     'text/event-stream; charset=utf-8',
      'Cache-Control':    'no-cache, no-store, no-transform',
      'Connection':       'keep-alive',
      // Tells nginx reverse-proxies not to buffer the response —
      // without this, events accumulate in the proxy until the
      // connection closes.
      'X-Accel-Buffering': 'no',
    },
  });
}
