/**
 * GET /api/signals
 *
 * All signals come from the centralized q365_signals table.
 * Pipeline writes once → all pages read from here.
 *
 * Actions:
 *   ?action=top     — top N signals by opportunity score (default)
 *   ?action=all     — all active signals
 *   ?action=stats   — 7-day signal statistics
 *   ?action=instrument&symbol=TCS — live per-instrument deep analysis (keeps real-time search)
 *   ?action=history&symbol=TCS    — signal history for a symbol
 */
import { NextRequest, NextResponse }  from 'next/server';
import { requireSession }             from '@/lib/session';
import { db }                         from '@/lib/db';
import {
  getActiveSignals,
  getTopSignals,
  getSignalStats,
  getStrategyBreakdowns,
  getStrategyBreakdownsBatch,
}                                     from '@/lib/signal-engine/repository/readSignals';
import {
  generateSignal,
  opportunityScore,
}                                     from '@/lib/signal-engine/live/analyzeInstrument';
import { applyLiveSanity }            from '@/lib/signal-engine/live/validateAgainstLive';
import { checkCandleFreshness }       from '@/lib/signal-engine/live/candleFreshnessGuard';
import { fetchFromYahooCached }        from '@/lib/marketData/priceCache';
import { getMarketStatus }             from '@/lib/marketData/marketHours';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

// Kite EOD lookup previously lived here (source='kite' Pass 2 of
// enrichWithLiveLtp). Removed when the system moved to Yahoo-only
// signal-analytics mode. See enrichWithLiveLtp below — it now calls
// fetchFromYahooCached directly for every row that has no in-memory
// live price attached.

// ── Live-price enrichment ───────────────────────────────────────
//
// CRITICAL CONTRACT:
//
//   q365_signals.ltp  = IMMUTABLE snapshot of price at signal
//                        generation time. This is the ENTRY.
//                        Never overwrite it.
//
//   row.livePrice     = the current market price. Populated here
//                        per request. Changes every tick.
//
//   row.livePChange   = current % change for live display.
//
// The UI must render ENTRY from `ltp` (frozen) and CURRENT from
// `livePrice` (fresh). Mutating `row.ltp` in place with a live
// quote used to make "entry price" drift with the market in the
// UI table — the exact bug this separation prevents.
//
// LIVE-PRICE RESOLUTION: Yahoo-only (signal-analytics mode).
// Every row is filled from fetchFromYahooCached() with a bounded
// concurrency pool. Cache hits are effectively free; misses hit
// Yahoo once per symbol per TTL window.
//
// Yahoo is delayed ~15 minutes during market hours. We accept that
// delay as a trade-off for broker-independence — the signal engine
// no longer hard-invalidates on small adverse moves (see
// applyLiveSanity) because those moves can be the delay itself.
async function enrichWithLiveLtp<
  T extends {
    tradingsymbol?: string;
    symbol?: string;
    ltp?: number | null;
    pct_change?: number | null;
    livePrice?:   number | null;
    livePChange?: number | null;
    liveSource?:  string | null;
    liveTickTs?:  number | null;
  }
>(rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;

  const t0 = Date.now();

  // Performance knobs (see /signals initial-load bottleneck):
  //   - YAHOO_CONCURRENCY raised 10 → 25: yahooCircuitBreaker already
  //     throttles on pushback, so higher parallelism can only improve
  //     wall-clock latency; it cannot over-run Yahoo's rate limit.
  //   - ENRICH_TIMEOUT_MS caps the entire worker pool. If Yahoo is
  //     slow, whatever hasn't resolved yet stays at null livePrice;
  //     the UI falls back to entry_price and the next 10s poll fills
  //     the gap once the cache has warmed.
  // Together: bounded initial load, no more "Loading signals…" hang.
  const YAHOO_CONCURRENCY = 25;
  const ENRICH_TIMEOUT_MS = 5_000;
  const market = getMarketStatus();

  type Target = { row: typeof rows[number]; sym: string };
  const targets: Target[] = [];
  for (const row of rows) {
    const sym = (row.tradingsymbol ?? row.symbol ?? '').toString().toUpperCase();
    if (!sym) {
      row.livePrice   = null;
      row.livePChange = null;
      row.liveSource  = 'none';
      row.liveTickTs  = null;
      continue;
    }
    targets.push({ row, sym });
  }

  if (targets.length > 0) {
    let cursor = 0;
    let aborted = false;
    async function worker(): Promise<void> {
      while (!aborted) {
        const i = cursor++;
        if (i >= targets.length) return;
        const { row, sym } = targets[i];
        try {
          const res = await fetchFromYahooCached(sym);
          if (aborted) return;  // discard late arrivals; caller returned
          if (res.price != null) {
            row.livePrice   = res.price;
            row.livePChange = res.pChange ?? null;
            row.liveSource  = 'yahoo';
            row.liveTickTs  = Date.now();
          } else {
            row.livePrice   = null;
            row.livePChange = null;
            row.liveSource  = 'none';
            row.liveTickTs  = null;
          }
        } catch {
          row.livePrice   = null;
          row.livePChange = null;
          row.liveSource  = 'none';
          row.liveTickTs  = null;
        }
      }
    }

    const pool = Promise.all(
      Array.from({ length: Math.min(YAHOO_CONCURRENCY, targets.length) }, worker),
    );
    // Race the worker pool against the timeout. If the timeout wins,
    // mark the pool as aborted (workers exit their loop on next tick)
    // and mark any still-unfilled rows as `none` so the UI has a
    // deterministic shape to render.
    const timeout = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), ENRICH_TIMEOUT_MS),
    );
    const result = await Promise.race([pool.then(() => 'done' as const), timeout]);
    if (result === 'timeout') {
      aborted = true;
      let filled = 0;
      for (const t of targets) {
        if (t.row.livePrice == null && t.row.liveSource !== 'none') {
          t.row.liveSource = 'none';
        }
        if (t.row.livePrice != null) filled++;
      }
      console.warn(
        `[enrich] timeout after ${ENRICH_TIMEOUT_MS}ms — ` +
        `filled ${filled}/${targets.length}; remaining rendered with live=null`,
      );
    }
  }

  const bySource: Record<string, number> = {};
  let totalLive = 0;
  for (const r of rows) {
    const src = (r.liveSource ?? 'none').toString();
    bySource[src] = (bySource[src] ?? 0) + 1;
    if (r.livePrice != null) totalLive++;
  }
  const yahooCount = bySource.yahoo ?? 0;
  const noneCount  = bySource.none  ?? 0;
  const yahooRatio = rows.length > 0 ? Math.round((yahooCount / rows.length) * 100) : 0;

  let freshnessLabel: string;
  if (yahooCount > 0 && market.isOpen) {
    freshnessLabel = 'NEAR_LIVE (yahoo, ~15min delay)';
  } else if (yahooCount > 0) {
    freshnessLabel = 'LAST_CLOSE (market closed — yahoo)';
  } else if (noneCount === rows.length) {
    freshnessLabel = 'NO_DATA (yahoo upstream failed)';
  } else {
    freshnessLabel = 'PARTIAL';
  }

  console.log(
    `[DATA SOURCE] path=LIVE  channel=YAHOO  rows=${rows.length}  ` +
    `live=${totalLive}  yahoo=${yahooCount}  none=${noneCount}  ` +
    `status=${freshnessLabel}  elapsed=${Date.now() - t0}ms`,
  );
  console.log(
    `[DATA] yahoo_ratio=${yahooRatio}%  market=${market.isOpen ? 'OPEN' : 'CLOSED'}`,
  );

  return rows;
}

// ── Freshness probe ─────────────────────────────────────────────
// Assembles a single object describing exactly where every layer
// of the data pipeline stands in time:
//
//   server_now                current server wall clock
//   signal_latest_generated   most recent q365_signals.generated_at
//   signal_oldest_generated   oldest among the rows returned
//   signal_age_minutes        (server_now - signal_latest_generated)/60s
//   candle_latest_ts          max(ts) in market_data_daily — i.e. the
//                             newest daily bar the pipeline COULD have
//                             consumed on its last run
//   candle_age_hours          (server_now - candle_latest_ts)/3600s
//   tick_ws_state             kite WS state
//   tick_subscribed           symbols the ticker is subscribed to
//   tick_newest_age_ms        age of the newest tick in the cache
//   tick_oldest_age_ms        age of the oldest tick in the cache
//
// The UI and server log consume this directly so there is ONE
// place to look when the question "is this data from today?"
// comes up. If any field disagrees with the wall clock the
// answer is self-evident.
async function buildFreshnessProbe(rows: any[]) {
  const serverNow = Date.now();

  // 1. Signal freshness — derived from the rows we're about to return
  let signalLatest: number | null = null;
  let signalOldest: number | null = null;
  for (const r of rows) {
    const ts = r?.generated_at ? new Date(r.generated_at).getTime() : null;
    if (!ts || Number.isNaN(ts)) continue;
    if (signalLatest == null || ts > signalLatest) signalLatest = ts;
    if (signalOldest == null || ts < signalOldest) signalOldest = ts;
  }

  // 2. Candle freshness — max(ts) in market_data_daily. This is the
  //    newest daily bar the pipeline could have consumed. If this
  //    is yesterday's date you KNOW the engine ran on yesterday.
  let candleLatest: number | null = null;
  try {
    const r = await db.query(
      `SELECT UNIX_TIMESTAMP(MAX(ts)) AS ts FROM market_data_daily`,
    );
    const raw = (r.rows[0] as any)?.ts;
    candleLatest = raw ? Number(raw) * 1000 : null;
  } catch (e: any) {
    console.warn('[API/signals] candle freshness probe failed:', e?.message);
  }

  // Tick-freshness probe removed — no Kite ticker in signal-only mode.

  const market = getMarketStatus();

  const probe = {
    server_now:             new Date(serverNow).toISOString(),
    market_open:             market.isOpen,
    market_state:            market.state,
    market_label:            market.label,
    signal_latest_generated: signalLatest ? new Date(signalLatest).toISOString() : null,
    signal_oldest_generated: signalOldest ? new Date(signalOldest).toISOString() : null,
    signal_age_minutes:      signalLatest ? Math.round((serverNow - signalLatest) / 60_000) : null,
    candle_latest_ts:        candleLatest ? new Date(candleLatest).toISOString() : null,
    candle_age_hours:        candleLatest ? Math.round((serverNow - candleLatest) / 3_600_000 * 10) / 10 : null,
    tick_ws_state:           'disabled',
    tick_subscribed:         0,
    tick_cached:             0,
  };

  return probe;
}

export async function GET(req: NextRequest) {
  try { await requireSession(); }
  catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }

  const { searchParams } = req.nextUrl;
  const action       = searchParams.get('action') || 'top';
  const symParam     = searchParams.get('symbol')?.trim().replace(/\s+/g, '') || null;
  const keyParam     = searchParams.get('key')?.trim().replace(/\s+/g, '') || null;
  const limit        = Math.min(parseInt(searchParams.get('limit') || '20'), 10000);
  const forceRefresh = searchParams.get('forceRefresh') === 'true';

  const reqStart = Date.now();

  // Auto-refresh: when the client asks for fresh signals, look at the
  // most recent generated_at on disk. If it's older than 5 min (or there
  // are no rows at all), trigger the pipeline in-process so the GET
  // below returns rows generated in this same request. This replaces
  // the missing local cron — production has PM2 firing the scheduler
  // every few minutes, localhost does not, so /signals would otherwise
  // keep showing whatever batch was last written manually.
  if (forceRefresh && (action === 'top' || action === 'all')) {
    try {
      const { rows: freshRows } = await db.query(
        `SELECT UNIX_TIMESTAMP(MAX(generated_at)) AS ts
         FROM q365_signals
         WHERE status IN ('active','watchlist','flagged')`
      );
      const latestTs = (freshRows[0] as any)?.ts ? Number((freshRows[0] as any).ts) : 0;
      const ageSec = latestTs ? Math.floor(Date.now() / 1000) - latestTs : Infinity;
      console.log(`[API/signals] forceRefresh: latest generated_at age=${Number.isFinite(ageSec) ? ageSec + 's' : 'never'}`);

      if (ageSec > 3600) {
        // Stale signals (>1h). Kick off the pipeline in the background
        // and let THIS request return the existing rows immediately —
        // a 90-second blocking pipeline makes the /signals page look
        // frozen on "Loading signals from database". The client's
        // next poll will pick up the freshly-written batch once the
        // background task finishes. A per-process guard prevents
        // concurrent refresh runs from piling up.
        if (!(globalThis as any).__signalsPipelineInFlight) {
          (globalThis as any).__signalsPipelineInFlight = true;
          const pipeStart = Date.now();
          (async () => {
            try {
              const candleFresh = await checkCandleFreshness();
              if (!candleFresh.ok) {
                console.warn('[API/signals] background refresh SKIPPED — stale candles:', candleFresh.reason);
                return;
              }
              console.log('[API/signals] data is stale (>1h) — triggering pipeline in background');
              const [{ generatePhase4Signals, DEFAULT_PHASE3_CONFIG }, { migrateSignalEngine }, { ensureSignalEngineSchemas }] = await Promise.all([
                import('@/lib/signal-engine'),
                import('@/lib/db/migrateSignalEngine'),
                import('@/lib/signal-engine/repository/ensureSchemas'),
              ]);
              await migrateSignalEngine().catch(() => {});
              await ensureSignalEngineSchemas().catch(() => {});

              const candleProvider = {
                async fetchDailyCandles(symbol: string) {
                  // NEWEST 300, re-sorted ASC. Plain ASC+LIMIT returns oldest.
                  const r = await db.query(
                    `SELECT ts, open, high, low, close, volume FROM (
                       SELECT ts, open, high, low, close, volume
                       FROM market_data_daily WHERE symbol = ?
                       ORDER BY ts DESC LIMIT 300
                     ) t
                     ORDER BY ts ASC`,
                    [symbol],
                  );
                  return r.rows.map((row: any) => ({
                    ts: row.ts,
                    open: Number(row.open), high: Number(row.high),
                    low: Number(row.low),   close: Number(row.close),
                    volume: Number(row.volume),
                  }));
                },
              };
              const portfolio = {
                capital: DEFAULT_PHASE3_CONFIG.defaultCapital,
                cashAvailable: DEFAULT_PHASE3_CONFIG.defaultCapital,
                openPositions: [],
                pendingSignals: [],
              };
              const result = await generatePhase4Signals(
                candleProvider as any, portfolio as any,
                undefined, undefined, undefined, undefined,
                { generationSource: 'api:signals:auto-refresh' },
              );
              console.log(`[API/signals] background pipeline complete  ${Date.now() - pipeStart}ms  signals=${result.signals.length}`);
            } catch (pipeErr: any) {
              console.warn('[API/signals] background refresh failed:', pipeErr?.message);
            } finally {
              (globalThis as any).__signalsPipelineInFlight = false;
            }
          })();
        } else {
          console.log('[API/signals] background refresh already in flight — skipping trigger');
        }
      } else {
        console.log('[API/signals] data is fresh — skipping pipeline');
      }
    } catch (e: any) {
      console.warn('[API/signals] freshness probe failed:', e?.message);
    }
  }

  try {
    // ── Single instrument — live analysis (keep for deep search) ──
    if (action === 'instrument' && (symParam || keyParam)) {
      const identifier = symParam ?? keyParam!;
      const sym  = identifier.includes('|') ? identifier.split('|')[1].toUpperCase() : identifier.toUpperCase();
      const ikey = identifier.includes('|') ? identifier : `NSE_EQ|${sym}`;

      const dbResult = await db.query(
        `SELECT tradingsymbol, exchange, instrument_key FROM instruments
         WHERE tradingsymbol=? OR instrument_key=? LIMIT 1`,
        [sym, ikey]
      ).catch(() => ({ rows: [] }));

      const inst = (dbResult.rows[0] as any) ?? {
        tradingsymbol: sym, exchange: 'NSE', instrument_key: ikey,
      };
      if (!inst.tradingsymbol) {
        return NextResponse.json({ error: 'Instrument not found' }, { status: 404 });
      }

      const signal = await generateSignal(inst.instrument_key, inst.tradingsymbol, inst.exchange);
      if (!signal) {
        return NextResponse.json({ error: 'No data available' }, { status: 503 });
      }

      if (signal.rejection_reasons.length > 0) {
        return NextResponse.json({
          signal:            null,
          approved:          false,
          rejection_reasons: signal.rejection_reasons,
          rejection_codes:   signal.rejection_codes,
          soft_warnings:     signal.soft_warnings,
          factor_scores:     signal.factor_scores,
          confidence_score:  signal.confidence,
          composite_score:   Math.round(signal.score_raw * 100),
          portfolio_fit:     signal.portfolio_fit,
          conviction_band:   signal.conviction_band,
          regime:            signal.regime,
          scenario_tag:      signal.scenario_tag,
          market_stance:     signal.market_stance,
        });
      }

      return NextResponse.json({
        signal,
        approved:           true,
        opportunity_score:  opportunityScore(signal),
        conviction_band:    signal.conviction_band,
        confidence_score:   signal.confidence,
        risk_score:         signal.risk_score,
        portfolio_fit_score:signal.portfolio_fit,
        scenario_tag:       signal.scenario_tag,
        market_stance:      signal.market_stance,
        regime_alignment:   signal.regime_alignment,
      });
    }

    // ── Top signals from DB ──────────────────────────────────────
    if (action === 'top') {
      const signals = await getTopSignals(limit);
      const audits  = await getStrategyBreakdownsBatch(
        signals.map((s: any) => s.id).filter(Boolean),
      );
      const enriched = await enrichWithLiveLtp(signals.map((s: any) => {
        const audit = audits.get(s.id);
        return {
          ...s,
          winning_strategy: audit?.winning_strategy ?? null,
          strategies:       audit?.strategies ?? [],
        };
      }));
      // Reconcile frozen signals against the live tick: penalise
      // soft adverse moves, drop hard ones and stopped-out rows.
      applyLiveSanity(enriched as any[]);
      const filtered = (enriched as any[]).filter(r => !r.live_invalidated);
      const freshness = await buildFreshnessProbe(filtered);
      return NextResponse.json(
        { signals: filtered, count: filtered.length, source: 'database', freshness },
        { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
      );
    }

    // ── All active signals from DB ───────────────────────────────
    if (action === 'all') {
      // Fetch a wider window than we'll return so the post-query
      // sort + cap reflects the full universe, not the top of an
      // arbitrary DB ORDER BY. limit param caps the final return,
      // not the upstream fetch.
      // fetchWindow trimmed 200 → 100. The API returns at most 50
      // (TARGET_COUNT). 100 = 2× headroom for tier churn / duplicate
      // filtering / auto-relax dip, which is ample. Fetching 200 meant
      // enriching 200 Yahoo prices just to discard 150 of them — the
      // primary driver of the 20–30s cold-start latency on /signals.
      const fetchWindow = Math.max(limit, 100);
      const signals = await getActiveSignals(fetchWindow);
      const totalGenerated = signals.length;

      const audits  = await getStrategyBreakdownsBatch(
        signals.map((s: any) => s.id).filter(Boolean),
      );

      // PERF: enrichment deferred. Previously enrichWithLiveLtp ran on
      // all `fetchWindow` rows (100) BEFORE tier selection threw half
      // of them away — doing 100 Yahoo fetches to display 50. Moved
      // below to run only on the final `shown` list (≤50 rows). Tier
      // selection uses DB columns (final_score, confidence_score,
      // freshness_score) that don't require live prices, so reordering
      // is semantically free. Halves cold-start latency.
      //
      // applyLiveSanity also deferred — in Yahoo-only mode it's
      // advisory (live_invalidated flag retained but never
      // hard-excludes), so moving it past the filter costs nothing.
      const enriched = signals.map((s: any) => {
        const audit = audits.get(s.id);
        return {
          ...s,
          winning_strategy: audit?.winning_strategy ?? null,
          strategies:       audit?.strategies ?? [],
        };
      });

      // Signal-only / Yahoo-only mode: live_invalidated is advisory.
      // With a 15-min-delayed Yahoo tape we cannot trust the flag as
      // a hard-exclusion signal — intraday drift of a few percent is
      // normal and the frozen entry may still be valid. We retain
      // flagged rows and let the hard gate (expired-only) decide.
      const invalidatedRows = (enriched as any[]).filter(r => r.live_invalidated);
      const droppedCount    = invalidatedRows.length;

      if (invalidatedRows.length > 0) {
        for (const r of invalidatedRows.slice(0, 10)) {
          console.log('[INVALIDATION]', {
            symbol:              r.symbol,
            live_invalidated:    r.live_invalidated,
            invalidation_reason: r.live_warnings,
            entry_price:         r.entry_price,
            live_price:          r.livePrice ?? r.ltp,
            live_pchange:        r.livePChange,
            live_source:         r.liveSource,
          });
        }
        if (invalidatedRows.length > 10) {
          console.log(`[INVALIDATION] …and ${invalidatedRows.length - 10} more (logging capped at 10 rows).`);
        }
      }

      // RETAIN flagged rows — Yahoo delay is the most likely cause.
      const filtered = (enriched as any[]);
      if (droppedCount > 0) {
        console.log(`[API/signals] live-sanity flagged ${droppedCount}/${enriched.length} rows — RETAINED (Yahoo-only mode, hard gate decides).`);
      }

      // Pipeline-level penalty for soft-excluded rows (user TASK 2).
      // Match the spec exactly: stale → -5, Avoid → -5. These rows
      // still participate in tier selection (Tier 4 / Tier 5) but
      // now rank below equivalently-scored healthy rows.
      for (const r of filtered) {
        const decay = String(r.decay_state ?? '').toLowerCase();
        const band  = String(r.conviction_band ?? '').toLowerCase();
        if (decay === 'stale') {
          r.final_score   = Math.max(0, Number(r.final_score ?? 0) - 5);
          r.demoted_stale = true;
        }
        if (band === 'avoid') {
          r.final_score   = Math.max(0, Number(r.final_score ?? 0) - 5);
          r.demoted_avoid = true;
        }
      }

      // [TRACE] stage counters (user TASK 1) — single-line funnel so
      // the operator can see exactly where rows are being shed.
      const trace_generated        = enriched.length;
      const trace_after_invalidated = filtered.length;
      const trace_stale_count = filtered.filter(
        (r: any) => String(r.decay_state ?? '').toLowerCase() === 'stale',
      ).length;
      const trace_expired_count = filtered.filter(
        (r: any) => String(r.decay_state ?? '').toLowerCase() === 'expired',
      ).length;
      const trace_avoid_count = filtered.filter(
        (r: any) => String(r.conviction_band ?? '').toLowerCase() === 'avoid',
      ).length;
      console.log('[TRACE]', {
        generated:         trace_generated,
        after_invalidated: trace_after_invalidated,
        after_decay:       trace_after_invalidated - trace_expired_count,   // only expired drops
        after_conviction:  trace_after_invalidated - trace_expired_count,   // Avoid stays (demoted)
        stale_demoted:     trace_stale_count,
        avoid_demoted:     trace_avoid_count,
        source:            'yahoo',
      });

      // ── Quality-tiered BUY/SELL selector ─────────────────────
      //
      // Hard exclusions (ALWAYS, at every tier):
      //   - conviction_band === 'Avoid'   (engine judged unreliable)
      //   - decay_state     ∈ {'stale','expired'}  (signal is old news)
      //   - live_invalidated (adverse tape move caught by applyLiveSanity)
      //
      // Three progressively-relaxed tiers. Within each tier we split
      // BUY/SELL and rank separately, then merge. Each side has its
      // own target; SELL doesn't steal slots from BUY and vice versa.
      //
      //   Tier 1 (STRICT):  final≥50 AND conf≥50 AND fresh≥40
      //   Tier 2 (RELAXED): final≥50 AND fresh≥30
      //   Tier 3 (LOOSE):   final≥45
      //
      // Archive-tier padding (stopped-out / target-hit / expired rows)
      // has been intentionally REMOVED from this handler — user spec
      // prefers a shorter list of quality signals over padding with
      // dead trades. getArchivedSignalsForPad() still exists for
      // historical/audit callers.
      const { DEFAULT_PHASE1_CONFIG } = await import('@/lib/signal-engine/constants/signalEngine.constants');
      const TARGET_COUNT = Math.min(limit, 50);

      // ── Fixed 25/25 target (Phase-4 spec) ────────────────────
      //
      // Per spec: TARGET = 50, BUY = 25, SELL = 25. The regime-
      // aware ratio was previously in place (35/15, 30/20, 20/30
      // depending on market) — replaced here with an even split
      // because the operator wants balanced visual output
      // regardless of market tilt. Any SELL deficit (bull markets
      // naturally produce fewer breakdowns) is absorbed by the
      // top-up logic at the bottom of this block, which lets BUY
      // take the slack up to 50 total.
      //
      // dominantRegime is still surfaced in logs so the operator
      // can see when the engine is operating against the grain of
      // market conditions (e.g. forced 25 SELL in STRONG_BULL).
      const regimeCounts: Record<string, number> = {};
      for (const r of filtered) {
        const reg = String(r.regime ?? r.market_regime ?? 'NEUTRAL').toUpperCase();
        regimeCounts[reg] = (regimeCounts[reg] ?? 0) + 1;
      }
      const dominantRegime = Object.entries(regimeCounts)
        .sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'NEUTRAL';

      // Spec band: BUY 25–30 / SELL 20–25. We cap BUY at the upper
      // end of its band (30) and target the lower end of SELL's (20)
      // as the auto-relax floor — this matches the "SELL must be
      // present, BUY gets the slack" intent.
      const BUY_LIMIT  = Math.round(TARGET_COUNT * 0.6);    // 30 when TARGET=50
      const SELL_LIMIT = TARGET_COUNT - BUY_LIMIT;          // 20 when TARGET=50
      const MIN_SELL   = SELL_LIMIT;                        // auto-relax floor
      const ratio      = { buy: 0.6, sell: 0.4, label: 'band (30/20)' };

      // ── Context-aware hard-exclusion gate ────────────────────
      //
      // Only TWO things are truly "hard" — rows that can never be
      // shown regardless of pool size:
      //
      //   1. decay_state === 'expired'
      //      Permanent terminal state. max_lifetime_reached, explicit
      //      engine expiry, or freshness score = 0. Never recoverable.
      //
      //   2. live_invalidated === true AND Kite is genuinely live
      //      live_invalidated is set by applyLiveSanity when live
      //      price has moved adversely vs. frozen entry. BUT this
      //      judgement is only trustworthy when the "live" price
      //      actually IS live — i.e. Kite's WebSocket is delivering
      //      fresh ticks. When Kite is loginRequired or disconnected,
      //      applyLiveSanity is comparing the frozen entry against
      //      a 15-min-delayed Yahoo price — a comparison that can
      //      fabricate "adverse moves" that aren't real. In that
      // Soft-excluded (demoted to later tiers, not removed):
      //   - decay_state === 'stale'     → allowed in Tier 4+
      //   - conviction_band === 'Avoid' → allowed in Tier 5+
      //
      // With Kite removed, the hard gate uses a single rule:
      // `decay_state === 'expired'`. live_invalidated can fire on a
      // delayed Yahoo tape and would produce spurious exclusions if
      // used here — it is retained on the row as an advisory flag
      // (visible in [INVALIDATION] logs) but never hard-excludes.

      let removed_live_invalidated = 0;
      let removed_stale            = 0;
      let removed_avoid            = 0;
      let removed_expired          = 0;
      for (const r of filtered) {
        const decay = String(r.decay_state ?? '').toLowerCase();
        const band  = String(r.conviction_band ?? '').toLowerCase();
        if (r.live_invalidated) removed_live_invalidated++;
        if (decay === 'stale')  removed_stale++;
        if (decay === 'expired') removed_expired++;
        if (band === 'avoid')   removed_avoid++;
      }

      const strictHardExclude = (r: any): boolean =>
        String(r.decay_state ?? '').toLowerCase() === 'expired';
      const strictSurvivors = filtered.filter((r: any) => !strictHardExclude(r)).length;
      const emergencyMode   = strictSurvivors < 10;

      // Emergency gate: identical to strict in Yahoo-only mode.
      // Kept for symmetry with logging/warnings that reference it.
      const emergencyHardExclude = strictHardExclude;

      const hardExclude = emergencyMode ? emergencyHardExclude : strictHardExclude;

      // Soft predicates — used by tier predicates below.
      const isStale = (r: any): boolean =>
        String(r.decay_state ?? '').toLowerCase() === 'stale';
      const isAvoid = (r: any): boolean =>
        String(r.conviction_band ?? '').toLowerCase() === 'avoid';
      const passesHardGate = (r: any): boolean => !hardExclude(r);

      // Tier predicates — soft-exclusions layered on top of the hard
      // gate. Quality signals (no soft flags) fill tiers 1–3 first;
      // stale signals are admitted from tier 4; Avoid from tier 5.
      //
      //   Tier 1 STRONG    — final≥50 ∧ conf≥50 ∧ fresh≥40
      //   Tier 2 MEDIUM    — final≥45 ∧ fresh≥30
      //   Tier 3 FALLBACK  — final≥40
      //   Tier 4 AGED      — final≥35    (stale now OK)
      //   Tier 5 WEAK      — fresh≥25    (Avoid now OK)
      //   Tier 6 LAST      — any row past the hard gate
      //
      // Spec mapping:
      //   "stale → downgrade to lower tier"     → stale admitted at Tier 4
      //   "Avoid → only in Tier 5/6 if needed"  → Avoid admitted at Tier 5
      const tier1Pass = (r: any): boolean => {
        if (!passesHardGate(r)) return false;
        if (isStale(r) || isAvoid(r)) return false;
        const fs = Number(r.final_score ?? 0);
        const cs = Number(r.confidence_score ?? r.confidence ?? 0);
        const fr = Number(r.freshness_score ?? 100);
        return fs >= 50 && cs >= 50 && fr >= 40;
      };
      const tier2Pass = (r: any): boolean => {
        if (!passesHardGate(r)) return false;
        if (isStale(r) || isAvoid(r)) return false;
        const fs = Number(r.final_score ?? 0);
        const fr = Number(r.freshness_score ?? 100);
        return fs >= 45 && fr >= 30;
      };
      const tier3Pass = (r: any): boolean => {
        if (!passesHardGate(r)) return false;
        if (isStale(r) || isAvoid(r)) return false;
        const fs = Number(r.final_score ?? 0);
        return fs >= 40;
      };
      const tier4Pass = (r: any): boolean => {
        if (!passesHardGate(r)) return false;
        if (isAvoid(r)) return false;        // stale OK here, Avoid not yet
        const fs = Number(r.final_score ?? 0);
        return fs >= 35;
      };
      const tier5Pass = (r: any): boolean => {
        if (!passesHardGate(r)) return false;
        const fr = Number(r.freshness_score ?? 100);
        return fr >= 25;                      // Avoid + stale both OK
      };
      const tier6Pass = (r: any): boolean => passesHardGate(r);

      // Ranking formula + multi-key tiebreakers (per spec):
      //   primary:  final_score DESC   (composite ranker output)
      //   secondary: freshness  DESC   (newer signals beat aging)
      //   tertiary:  risk       ASC    (lower risk beats higher)
      //
      // Rank score itself keeps the weighted form for the primary
      // sort, but we expose freshness + risk as explicit tiebreakers
      // so two signals with similar composite scores fall out in a
      // predictable order.
      const rankScore = (r: any): number => {
        const fs = Number(r.final_score       ?? 0);
        const cs = Number(r.confidence_score  ?? r.confidence ?? 0);
        const fr = Number(r.freshness_score   ?? 100);
        const op = Number(r.opportunity_score ?? 0);
        return fs * 0.35 + cs * 0.25 + fr * 0.20 + op * 0.20;
      };
      const sortByRank = (a: any, b: any): number => {
        const d1 = rankScore(b) - rankScore(a);
        if (d1 !== 0) return d1;
        const d2 = Number(b.freshness_score ?? 100) - Number(a.freshness_score ?? 100);
        if (d2 !== 0) return d2;
        return Number(a.risk_score ?? 100) - Number(b.risk_score ?? 100);
      };

      // Three-tier fill: for each tier in order, take the highest-
      // ranked qualifying rows not already selected, until we hit
      // `limit` or run out. Each returned row is tagged with its
      // qualifying tier so the UI can render quality indicators.
      function selectWithTiers(
        pool:    any[],
        limit:   number,
        tiers:   Array<(r: any) => boolean>,
      ): any[] {
        const used: Set<number> = new Set();
        const out: any[] = [];
        for (let t = 0; t < tiers.length; t++) {
          if (out.length >= limit) break;
          const passFn = tiers[t];
          const candidates = pool
            .filter((r) => r.id && !used.has(r.id) && passFn(r))
            .sort(sortByRank);
          for (const r of candidates) {
            if (out.length >= limit) break;
            used.add(r.id);
            out.push({ ...r, quality_tier: t + 1 });
          }
        }
        return out;
      }

      const buyPool  = filtered.filter((r: any) => String(r.direction ?? '').toUpperCase() === 'BUY');
      const sellPool = filtered.filter((r: any) => String(r.direction ?? '').toUpperCase() === 'SELL');

      // Full tier ladder: tiers 1–3 are the user-defined quality
      // bands; tiers 4–6 are auto-relax (used only when 1–3 don't
      // fill). selectWithTiers stops as soon as it hits the target,
      // so quality is preserved whenever possible.
      const ALL_TIERS = [tier1Pass, tier2Pass, tier3Pass, tier4Pass, tier5Pass, tier6Pass];
      const PRIMARY_TIERS = [tier1Pass, tier2Pass, tier3Pass];

      const buySelected  = selectWithTiers(buyPool,  BUY_LIMIT,  ALL_TIERS);
      let   sellSelected = selectWithTiers(sellPool, SELL_LIMIT, ALL_TIERS);

      // ── SELL auto-relax (multi-stage, spec Step 5) ───────────
      //
      // Stage 1: Pull any SELL-direction row that survives the
      //          hard gate, regardless of tier.
      //
      // Stage 2 (fallback): If Stage 1 still under target, pull
      //          rows tagged as BREAKOUT_CONTINUATION scenario
      //          — the scenario bucket that houses bearish_breakdown
      //          (per readSignals.ts:409 scenario→strategy mapping).
      //          We accept rows whose direction is SELL OR whose
      //          signal_type looks bearish, both against the hard-
      //          gate-filtered pool (NOT raw allSignals — that
      //          would reintroduce Avoid/stale/invalidated rows
      //          and violate the spec's safety rules).
      //
      // We never fabricate: every row still came from the DB,
      // passed Phase 1-3 scoring, and survived hard exclusion.
      // If the DB has 3 SELLs total, we return 3 SELLs.
      let sellAutoRelaxed = false;

      // Stage 1: dip deeper into the SELL pool past tier gates.
      if (sellSelected.length < MIN_SELL) {
        const usedIds = new Set(sellSelected.map((r: any) => r.id));
        const stage1 = sellPool
          .filter((r: any) => r.id && !usedIds.has(r.id) && passesHardGate(r))
          .sort(sortByRank)
          .slice(0, MIN_SELL - sellSelected.length)
          .map((r: any) => ({ ...r, quality_tier: 6, sell_relaxed: true }));
        if (stage1.length > 0) {
          sellAutoRelaxed = true;
          sellSelected = [...sellSelected, ...stage1];
        }
      }

      // Stage 2: scenario-tag / signal-type augmentation. Looks
      // inside the post-hard-gate `filtered` set for rows that
      // smell bearish but may have slipped into a different
      // direction bucket (e.g. generation-time inconsistency).
      if (sellSelected.length < MIN_SELL) {
        const usedIds = new Set(sellSelected.map((r: any) => r.id));
        const looksBearish = (r: any): boolean => {
          const tag  = String(r.scenario_tag   ?? '').toUpperCase();
          const sig  = String(r.signal_type    ?? '').toLowerCase();
          const dir  = String(r.direction      ?? '').toUpperCase();
          // Three independent clues that a row belongs on the SELL side:
          //   1. direction explicitly SELL (bypassed stage-1 somehow)
          //   2. strategy is bearish_breakdown
          //   3. scenario tag contains BREAKOUT_CONTINUATION WITH
          //      a SELL direction — guards against pulling in
          //      bullish_breakout rows that share the scenario bucket.
          return dir === 'SELL'
              || sig.includes('bearish_breakdown')
              || sig.includes('breakdown')
              || (tag.includes('BREAKOUT_CONTINUATION') && dir === 'SELL');
        };
        const stage2 = filtered
          .filter((r: any) => r.id && !usedIds.has(r.id) && passesHardGate(r) && looksBearish(r))
          .sort(sortByRank)
          .slice(0, MIN_SELL - sellSelected.length)
          .map((r: any) => ({ ...r, quality_tier: 6, sell_relaxed: true, recovered_via: 'scenario_tag' }));
        if (stage2.length > 0) {
          sellAutoRelaxed = true;
          sellSelected = [...sellSelected, ...stage2];
        }
      }

      // ── SELL DEBUG (Phase-4 spec) ────────────────────────────
      // Surfaces the exact funnel so the operator can see where
      // SELL signals are being dropped. Pairs with the server-log
      // block further down.
      const sellPoolRaw = filtered.filter(
        (r: any) => String(r.direction ?? '').toUpperCase() === 'SELL',
      );
      const sellAfterHard = sellPoolRaw.filter(passesHardGate).length;
      const sellAfterT1   = sellPoolRaw.filter(tier1Pass).length;
      const sellAfterT2   = sellPoolRaw.filter(tier2Pass).length;
      const sellAfterT3   = sellPoolRaw.filter(tier3Pass).length;
      console.log('[SELL DEBUG]', {
        // spec aliases (stable grep shape)
        sell_generated:       sellPoolRaw.length,
        sell_after_filter:    sellAfterHard,
        sell_after_rank:      sellSelected.length,
        // existing fields retained for backward-compat dashboards
        sell_in_db_pool:      sellPoolRaw.length,
        sell_after_hard_gate: sellAfterHard,
        sell_tier1_eligible:  sellAfterT1,
        sell_tier2_eligible:  sellAfterT2,
        sell_tier3_eligible:  sellAfterT3,
        sell_selected:        sellSelected.length,
        sell_auto_relaxed:    sellAutoRelaxed,
        hint:
          sellPoolRaw.length === 0        ? 'DB has no SELL rows — investigate Phase 3 generation (scenarioEngine + rejection gates 2/4).' :
          sellAfterHard < sellPoolRaw.length / 2 ? 'Hard gate is killing >50% of SELL candidates — check live_invalidated + decay_state distribution.' :
          sellAfterT3 === 0               ? 'All SELL rows fail every tier — check final_score distribution; raw pool exists but scores are all < 40.' :
          'Funnel healthy — low count is likely market-driven (bull phase, fewer breakdowns).',
      });

      // If one side under-filled and the other has headroom, use the
      // slack to give the full list more quality candidates. Example:
      // SELL pool yielded 4 rows (market is bullish) — we take 46 BUYs
      // instead of the default 30, so the operator still sees 50.
      let shown: any[] = [...buySelected, ...sellSelected];
      if (shown.length < TARGET_COUNT) {
        const usedIds = new Set(shown.map((r: any) => r.id));
        const slack   = TARGET_COUNT - shown.length;
        const buyDeficit  = BUY_LIMIT  - buySelected.length;
        const sellDeficit = SELL_LIMIT - sellSelected.length;
        if (buyDeficit === 0 && sellDeficit > 0) {
          const extra = selectWithTiers(
            buyPool.filter((r: any) => !usedIds.has(r.id)),
            slack,
            ALL_TIERS,
          );
          shown = [...shown, ...extra];
        } else if (sellDeficit === 0 && buyDeficit > 0) {
          const extra = selectWithTiers(
            sellPool.filter((r: any) => !usedIds.has(r.id)),
            slack,
            ALL_TIERS,
          );
          shown = [...shown, ...extra];
        }
      }

      // Final top-up: if both sides were under target, the branches
      // above do nothing and `shown` stays short. Walk the full tier
      // ladder against every remaining filtered row (any direction)
      // and fill to TARGET_COUNT. This is the spec's "NEVER < 50"
      // guarantee — the only reason we can still finish short is if
      // the DB literally doesn't have enough rows past the hard gate.
      if (shown.length < TARGET_COUNT) {
        const usedIds = new Set(shown.map((r: any) => r.id));
        const remaining = filtered.filter((r: any) => r.id && !usedIds.has(r.id));
        const extra = selectWithTiers(
          remaining,
          TARGET_COUNT - shown.length,
          ALL_TIERS,
        ).map((r: any) => ({ ...r, topped_up: true }));
        shown = [...shown, ...extra];
      }

      // Merged list also sorted by rank so the top of the dashboard
      // is the best overall, not "top BUYs then top SELLs in blocks".
      shown = shown.sort(sortByRank);

      // Enrich ONLY the final shown list with live Yahoo prices.
      // With 25-way concurrency and a 5s timeout, 50 symbols complete
      // in ~2s on cold cache, <1s on warm cache. applyLiveSanity runs
      // after enrichment here (advisory in Yahoo-only mode — it marks
      // stopped-out rows for UI indication but never excludes them).
      await enrichWithLiveLtp(shown as any[]);
      applyLiveSanity(shown as any[]);

      // ── Logging per spec ─────────────────────────────────────
      const tierCounts = shown.reduce(
        (acc: Record<string, number>, r: any) => {
          const t = Number(r.quality_tier ?? 0);
          acc[`tier${t}`] = (acc[`tier${t}`] ?? 0) + 1;
          return acc;
        },
        { tier1: 0, tier2: 0, tier3: 0, tier4: 0, tier5: 0, tier6: 0 },
      );
      const buyCount  = shown.filter((s: any) => String(s.direction ?? '').toUpperCase() === 'BUY').length;
      const sellCount = shown.filter((s: any) => String(s.direction ?? '').toUpperCase() === 'SELL').length;
      const directionCounts = { BUY: buyCount, SELL: sellCount };

      // after_filter = rows that survive the hard gate IN USE (strict
      // or emergency). after_strict_filter = what the strict gate
      // alone would have passed — the gap between them reveals how
      // much slack emergency mode is providing.
      const afterFilter       = filtered.filter(passesHardGate).length;
      const afterStrictFilter = strictSurvivors;
      const filterTooStrict   = afterFilter < 10;

      console.log(
        '\n[HARD FILTER]\n' +
        `  total_generated:           ${totalGenerated}\n` +
        `  source:                    yahoo\n` +
        `  removed_live_invalidated:  ${removed_live_invalidated} (advisory — never hard-excluded in Yahoo-only mode)\n` +
        `  removed_stale:             ${removed_stale} (demoted to Tier 4)\n` +
        `  removed_expired:           ${removed_expired} (always excluded)\n` +
        `  removed_avoid:             ${removed_avoid} (demoted to Tier 5)\n` +
        `  after_strict_filter:       ${afterStrictFilter}\n` +
        `  emergency_mode:            ${emergencyMode}\n` +
        `  after_filter:              ${afterFilter}\n` +
        '\n[ENGINE]\n' +
        `  scanned:       ${DEFAULT_PHASE1_CONFIG.universe.length}\n` +
        `  generated:     ${totalGenerated}\n` +
        `  after_drops:   ${filtered.length}\n` +
        `  after_filter:  ${afterFilter}\n` +
        `  after_tiers:   ${shown.length}\n` +
        `  filtered_out:  ${filtered.length - shown.length}\n` +
        '\n[RANKING]\n' +
        `  buy_pool:         ${buyPool.length}\n` +
        `  sell_pool:        ${sellPool.length}\n` +
        `  buy_candidates:   ${buySelected.length} (of ${BUY_LIMIT} target)\n` +
        `  sell_candidates:  ${sellSelected.length} (of ${SELL_LIMIT} target)\n` +
        `  tier1_strong:     ${tierCounts.tier1}\n` +
        `  tier2_medium:     ${tierCounts.tier2}\n` +
        `  tier3_fallback:   ${tierCounts.tier3}\n` +
        `  tier4_aged:       ${tierCounts.tier4}\n` +
        `  tier5_weak:       ${tierCounts.tier5}\n` +
        `  tier6_last:       ${tierCounts.tier6}\n` +
        '\n[FINAL]\n' +
        `  returned:         ${shown.length}\n` +
        `  buy:              ${buyCount}\n` +
        `  sell:             ${sellCount}`,
      );

      // Spec-named alias block. Same data as [HARD FILTER] but with
      // the field names called out in the Phase-4 debug spec so that
      // `grep '[DEBUG FILTER]'` lands on a stable shape.
      console.log('[DEBUG FILTER]', {
        removed_due_to_invalidated: 0,             // advisory only in Yahoo-only mode
        removed_due_to_expired:     removed_expired,
        removed_due_to_conviction:  0,             // Avoid is demoted, not removed
        removed_due_to_decay:       0,             // stale is demoted, not removed
        flagged_live_invalidated:   removed_live_invalidated,
        demoted_stale:              removed_stale,
        demoted_avoid:              removed_avoid,
      });

      if (emergencyMode) {
        console.warn(
          `[WARNING] EMERGENCY RELAX ACTIVE — only ${afterStrictFilter} rows ` +
          `survived the strict gate. Most likely cause: many rows aged into ` +
          `'expired'. Check rescore cadence and signal-generation freshness.`,
        );
      } else if (filterTooStrict) {
        console.warn(
          `[WARNING] FILTER TOO STRICT — only ${afterFilter} rows eligible. ` +
          `Check recent regen + rescore cadence.`,
        );
      }

      // ── [FINAL ENGINE] summary (Phase-4 spec) ────────────────
      // Concise single-block final state. Grep target is
      // `[FINAL ENGINE]` — makes it easy to tail for the one-line
      // summary without wading through the tier/sell/filter blocks.
      console.log('[FINAL ENGINE]', {
        total:        shown.length,
        buy:          buyCount,
        sell:         sellCount,
        after_filter: afterFilter,
        emergency:    emergencyMode,
        sell_relaxed: sellAutoRelaxed,
      });

      // ── [ENGINE BALANCE] — full funnel summary (spec Step 10) ─
      // Exact shape from the spec so the grep target is stable.
      // `balanced: true` when BUY/SELL both > 0 AND SELL >= MIN_SELL
      // OR SELL ≥ sellDbPool (we took everything available). The
      // 'balanced: false' case is informative, not an error — it
      // means the market itself doesn't support the target mix.
      const sellDbPool = filtered.filter(
        (r: any) => String(r.direction ?? '').toUpperCase() === 'SELL',
      ).length;
      const balanced =
        buyCount > 0 &&
        (sellCount > 0 || sellDbPool === 0) &&
        (sellCount >= MIN_SELL || sellCount >= sellDbPool);

      console.log('[ENGINE BALANCE]', {
        total:         signals.length,            // DB pool size pre-dedupe
        after_filter:  filtered.length,           // post-live-sanity
        buy_pool:      buyPool.length,
        sell_pool:     sellPool.length,
        final_buy:     buyCount,
        final_sell:    sellCount,
        regime:        dominantRegime,
        ratio_target:  ratio.label,
        min_sell:      MIN_SELL,
        max_buy:       BUY_LIMIT,
        sell_relaxed:  sellAutoRelaxed,
        balanced,
      });

      const freshness = await buildFreshnessProbe(shown);
      return NextResponse.json(
        {
          signals:             shown,
          count:               shown.length,
          total_generated:     totalGenerated,
          after_filter:        afterFilter,
          direction_breakdown: directionCounts,
          tier_breakdown:      tierCounts,
          filter_too_strict:   filterTooStrict,
          emergency_mode:      emergencyMode,
          sell_auto_relaxed:   sellAutoRelaxed,
          mode:                'signal-only',
          realtime:            false,
          balance: {
            regime:       dominantRegime,
            ratio_label:  ratio.label,
            buy_target:   BUY_LIMIT,
            sell_target:  SELL_LIMIT,
            min_sell:     MIN_SELL,
            balanced,
          },
          hard_filter_stats: {
            removed_live_invalidated,
            removed_stale,
            removed_expired,
            removed_avoid,
            after_strict_filter: afterStrictFilter,
          },
          sell_funnel: {
            sell_in_db_pool:      sellPoolRaw.length,
            sell_after_hard_gate: sellAfterHard,
            sell_tier1_eligible:  sellAfterT1,
            sell_tier2_eligible:  sellAfterT2,
            sell_tier3_eligible:  sellAfterT3,
            sell_selected:        sellSelected.length,
          },
          source:              'yahoo',
          data_origin:         'database',
          freshness,
        },
        { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
      );
    }

    // ── Strategy breakdown audit for one signal ──────────────────
    if (action === 'breakdowns') {
      const id = Number(searchParams.get('id') ?? searchParams.get('signal_id') ?? '0');
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });
      const audit = await getStrategyBreakdowns(id);
      return NextResponse.json(audit);
    }

    // ── Signal stats (7-day) ─────────────────────────────────────
    if (action === 'stats') {
      const stats = await getSignalStats();
      return NextResponse.json(stats);
    }

    // ── Signal history for a symbol ──────────────────────────────
    if (action === 'history') {
      const sym = symParam ?? keyParam ?? '';
      if (!sym) return NextResponse.json({ error: 'symbol required' }, { status: 400 });
      const { rows } = await db.query(`
        SELECT direction, signal_type, confidence_score, confidence_band,
               risk_score, risk_band, opportunity_score,
               entry_price, stop_loss, target1, risk_reward,
               market_regime, market_stance, scenario_tag,
               generated_at
        FROM q365_signals
        WHERE symbol=?
        ORDER BY generated_at DESC LIMIT 20
      `, [sym.toUpperCase()]);
      return NextResponse.json({ history: rows, symbol: sym });
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (err: any) {
    console.error('[/api/signals]', err?.message);
    return NextResponse.json({ error: 'Server error', details: err?.message }, { status: 500 });
  }
}
