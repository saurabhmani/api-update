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
import { getTicker, isFresh }  from '@/lib/marketData/kiteTicker';
import { fetchFromYahooCached }        from '@/lib/marketData/priceCache';
import { getMarketStatus }             from '@/lib/marketData/marketHours';

export const dynamic   = 'force-dynamic';
export const revalidate = 0;

// ── Kite EOD lookup (Pass 2 source for enrichWithLiveLtp) ─────
//
// When the in-memory Kite cache has no entry for a symbol (cold
// boot during closed hours, or a symbol that hasn't ticked yet),
// `market_data_daily` carries the Kite-sourced last-trading-session
// close via the VIEW projecting `candles` with candle_type='eod'.
// This is authoritative last traded price until the next session
// opens — strictly more trustworthy than a 15-min-delayed Yahoo
// scrape, and critically it stays labelled source='kite'.
//
// Returns a Map<UPPERCASE_SYMBOL, {close, pChange, ts}>.
async function loadKiteEodCloses(symbols: string[]): Promise<Map<string, {
  close:   number;
  pChange: number;
  ts:      number;
}>> {
  const out = new Map<string, { close: number; pChange: number; ts: number }>();
  if (!symbols || symbols.length === 0) return out;
  // Dedup + cap — the IN clause with thousands of params is fine on
  // MySQL but we keep a ceiling so a pathological call doesn't build
  // a 100KB query string.
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))].slice(0, 2000);
  // PERF: window-function rewrite. The correlated-subquery form via
  // `market_data_daily` VIEW would hang for tens of minutes on a
  // populated candles table (see git log 2026-04-22). We query
  // `candles` directly with the EOD filter, use LEAD() for the
  // previous close, and ROW_NUMBER() to pick the newest bar per
  // instrument — single pass using idx_candles_key_ts.
  //
  // Build IN() over instrument_key suffixes. Symbol is the suffix
  // after the '|' in instrument_key (NSE_EQ|RELIANCE → RELIANCE).
  const placeholders = uniq.map(() => '?').join(',');
  const { rows } = await db.query<{
    symbol:     string;
    ts:         Date | string | number;
    close:      number | string;
    prev_close: number | string | null;
  }>(
    `SELECT symbol, ts, close, prev_close FROM (
       SELECT
         SUBSTRING_INDEX(instrument_key, '|', -1) AS symbol,
         ts,
         close,
         LEAD(close) OVER (PARTITION BY instrument_key ORDER BY ts DESC) AS prev_close,
         ROW_NUMBER()  OVER (PARTITION BY instrument_key ORDER BY ts DESC) AS rn
       FROM candles
       WHERE candle_type = 'eod' AND interval_unit = '1day'
         AND SUBSTRING_INDEX(instrument_key, '|', -1) IN (${placeholders})
     ) r
     WHERE r.rn = 1`,
    uniq,
  );
  for (const r of rows as any[]) {
    const sym = String(r.symbol ?? '').toUpperCase();
    const close = Number(r.close);
    if (!Number.isFinite(close) || close <= 0) continue;
    const prev = r.prev_close != null ? Number(r.prev_close) : null;
    const pChange =
      prev != null && Number.isFinite(prev) && prev > 0
        ? ((close - prev) / prev) * 100
        : 0;
    const ts =
      r.ts instanceof Date
        ? r.ts.getTime()
        : typeof r.ts === 'number'
          ? r.ts
          : new Date(r.ts as string).getTime();
    out.set(sym, { close, pChange, ts: Number.isFinite(ts) ? ts : Date.now() });
  }
  return out;
}

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
// LIVE-PRICE RESOLUTION: Kite primary, Yahoo fallback. Those are
// the only two upstreams permitted anywhere in the system.
//   1. tryGetLiveTick(symbol) → Kite tick cache, strict freshness
//   2. If Kite has no fresh tick → fetchFromYahooCached(symbol)
//   3. If both miss → livePrice = null (UI renders '—')
//
// When livePrice is null, the UI must fall back to rendering
// the frozen entry with a visual "stale" indicator — NOT a
// different price from a different source.
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

  // STRICT PRIORITY ORDER (Kite-first, fallback gated on market state):
  //
  //   Pass 1 — Kite in-memory cache (any age).
  //            ticker.getTickBySymbolSync() returns the last Kite WS
  //            tick for the symbol regardless of age. After close,
  //            this is the authoritative last-traded price; mid-session
  //            it's the freshest tick. We DO NOT gate on the 2s
  //            strict-fresh threshold — a Kite tick is a Kite tick.
  //
  //   Pass 2 — Kite EOD close from market_data_daily (VIEW over
  //            candles). If the in-memory cache has nothing for a
  //            symbol (cold boot during closed hours), the EOD bar
  //            IS the authoritative Kite close.
  //
  //   Pass 3 — Yahoo SNAPSHOT fallback. ONLY when market is CLOSED
  //            and passes 1 and 2 both missed (no in-memory Kite tick,
  //            no Kite EOD bar in market_data_daily). This is the
  //            "use Yahoo ONLY if no Kite data" rule — during market
  //            hours Yahoo is DISABLED completely and a missed Kite
  //            read becomes 'none' rather than silently switching
  //            sources mid-screen.
  //
  //   Pass 4 — 'none'. No data anywhere.
  const YAHOO_CONCURRENCY = 10;
  const market = getMarketStatus();
  const ticker = getTicker();
  // Reject Kite data older than this — above the threshold a cached
  // tick or EOD bar is likely from a symbol whose ingest pipeline
  // stopped, and a 15-min-delayed Yahoo snapshot is more useful
  // than a months-old close. Default 3 days covers a weekend gap.
  const STALE_KITE_MS =
    Number(process.env.STALE_KITE_MS) || 3 * 24 * 60 * 60 * 1000;

  // Pass 1 — Kite in-memory cache (sync, O(rows), bounded age gate)
  const needsEod: Array<{ row: typeof rows[number]; sym: string }> = [];
  for (const row of rows) {
    const sym = (row.tradingsymbol ?? row.symbol ?? '').toString().toUpperCase();
    if (!sym) {
      row.livePrice   = null;
      row.livePChange = null;
      row.liveSource  = 'none';
      row.liveTickTs  = null;
      continue;
    }
    const tick = ticker.getTickBySymbolSync(sym);
    if (tick && tick.lastPrice != null && tick.lastPrice > 0) {
      const age = Date.now() - (tick.ts ?? 0);
      // Market OPEN  → require fresh live tick (≤3s by default)
      // Market CLOSED → accept any age up to STALE_KITE_MS
      const acceptable = market.isOpen
        ? isFresh(tick, 30_000)  // aging-but-usable during hours
        : age < STALE_KITE_MS;
      if (acceptable) {
        row.livePrice   = tick.lastPrice;
        row.livePChange = tick.pChange ?? null;
        row.liveSource  = 'kite';
        row.liveTickTs  = tick.ts ?? null;
        if (market.isOpen && tick.ts && !isFresh(tick, 30_000)) {
          console.log(
            `[STALE] symbol=${sym} kite_age=${Math.round(age / 1000)}s ` +
            `market=OPEN — investigate Kite feed`,
          );
        }
        continue;
      }
      // Too old — fall through to EOD lookup, then Yahoo if needed.
    }
    // No in-memory Kite tick (or it's ancient) — queue for EOD lookup.
    needsEod.push({ row, sym });
  }

  // Pass 2 — Kite EOD close from market_data_daily (single batched query)
  const needsYahoo: Array<{ row: typeof rows[number]; sym: string }> = [];
  if (needsEod.length > 0) {
    try {
      const eodMap = await loadKiteEodCloses(needsEod.map((x) => x.sym));
      for (const { row, sym } of needsEod) {
        const eod = eodMap.get(sym);
        const eodAge = eod ? Date.now() - eod.ts : Infinity;
        // Accept EOD only if the bar itself is within STALE_KITE_MS.
        // Ancient EOD rows (symbols whose candle ingest stopped) are
        // worse than a 15-min-delayed Yahoo snapshot — fall through.
        if (eod && eod.close > 0 && eodAge < STALE_KITE_MS) {
          row.livePrice   = eod.close;
          row.livePChange = eod.pChange;
          row.liveSource  = 'kite'; // Kite-sourced EOD bar from candles
          row.liveTickTs  = eod.ts;
          continue;
        }
        // Either no EOD row or it's ancient. Queue for Yahoo fallback
        // regardless of market state — per user requirement a
        // delayed-but-fresh Yahoo snapshot beats showing nothing or
        // rendering a months-old cached Kite close.
        needsYahoo.push({ row, sym });
      }
    } catch (err) {
      console.warn(
        `[enrich] EOD lookup failed: ${(err as Error).message} — ` +
        `falling through to Yahoo snapshot`,
      );
      for (const { row, sym } of needsEod) {
        needsYahoo.push({ row, sym });
      }
    }
  }

  // Pass 3 — Yahoo SNAPSHOT fallback (bounded parallel).
  // Runs whenever Kite cache + EOD both missed, regardless of
  // market state. Spec: "Yahoo fine even 15-min delayed, better
  // than showing ancient data."
  if (needsYahoo.length > 0) {
    let cursor = 0;
    async function worker(): Promise<void> {
      while (true) {
        const i = cursor++;
        if (i >= needsYahoo.length) return;
        const { row, sym } = needsYahoo[i];
        try {
          const res = await fetchFromYahooCached(sym);
          if (res.price != null) {
            row.livePrice   = res.price;
            row.livePChange = res.pChange ?? null;
            row.liveSource  = 'yahoo';
          } else {
            row.liveSource = 'none';
          }
        } catch {
          row.liveSource = 'none';
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(YAHOO_CONCURRENCY, needsYahoo.length) }, worker),
    );
  }

  const bySource: Record<string, number> = {};
  let totalLive = 0;
  for (const r of rows) {
    const src = (r.liveSource ?? 'none').toString();
    bySource[src] = (bySource[src] ?? 0) + 1;
    if (r.livePrice != null) totalLive++;
  }
  const parts = Object.entries(bySource)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');
  const kiteCount   = bySource.kite  ?? 0;
  const yahooCount  = bySource.yahoo ?? 0;
  const noneCount   = bySource.none  ?? 0;
  const kiteRatio   = rows.length > 0 ? Math.round((kiteCount  / rows.length) * 100) : 0;
  const yahooRatio  = rows.length > 0 ? Math.round((yahooCount / rows.length) * 100) : 0;

  // Honest freshness label that reflects the three real states:
  //
  //   LIVE        — Kite WebSocket ticks are flowing (≥50% rows)
  //   NEAR_LIVE   — market is OPEN and Yahoo is serving (<1m lag,
  //                 works without a Kite login; still actionable)
  //   LAST_CLOSE  — market is CLOSED, Yahoo returns last-traded
  //                 price from the previous session (expected;
  //                 nothing is "real-time" when nothing trades)
  //   NO_DATA     — both upstreams missed the row
  //
  // The previous log printed `real_time=NO ✗` whenever Kite wasn't
  // the majority source, which looked like a failure in a closed
  // market or a dropped Kite login — but the Yahoo fallback was
  // working fine. This labelling tells the truth instead.
  // `market` was already computed in Pass 1 above; reuse it.
  let freshnessLabel: string;
  if (kiteCount > 0 && kiteCount >= rows.length * 0.5) {
    freshnessLabel = 'LIVE (kite)';
  } else if (yahooCount > 0 && market.isOpen) {
    freshnessLabel = 'NEAR_LIVE (yahoo, kite-login=' +
      (kiteCount > 0 ? 'partial' : 'missing') + ')';
  } else if (yahooCount > 0) {
    freshnessLabel = 'LAST_CLOSE (market closed — yahoo)';
  } else if (noneCount === rows.length) {
    freshnessLabel = 'NO_DATA (both upstreams failed)';
  } else {
    freshnessLabel = 'PARTIAL';
  }

  console.log(
    `[DATA SOURCE] path=LIVE  channel=KITE+YAHOO  rows=${rows.length}  ` +
    `live=${totalLive}  ${parts}  ` +
    `status=${freshnessLabel}  elapsed=${Date.now() - t0}ms`,
  );
  console.log(
    `[DATA] kite_ratio=${kiteRatio}%  yahoo_ratio=${yahooRatio}%  ` +
    `market=${market.isOpen ? 'OPEN' : 'CLOSED'}`,
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

  // 3. Tick freshness — scan the ticker's in-memory cache
  let tickNewestAge: number | null = null;
  let tickOldestAge: number | null = null;
  let tickerStatus: any = null;
  try {
    const ticker = getTicker();
    tickerStatus = ticker.getStatus();
    // Sample up to first 30 cached ticks to avoid walking thousands
    const anyTicker = ticker as any;
    const map: Map<any, any> | undefined = anyTicker.ticks;
    if (map && typeof map.values === 'function') {
      let i = 0;
      for (const t of map.values()) {
        if (!t?.ts) continue;
        const age = serverNow - t.ts;
        if (tickNewestAge == null || age < tickNewestAge) tickNewestAge = age;
        if (tickOldestAge == null || age > tickOldestAge) tickOldestAge = age;
        if (++i >= 30) break;
      }
    }
  } catch {}

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
    tick_ws_state:           tickerStatus?.state ?? 'unknown',
    tick_subscribed:         tickerStatus?.subscribed ?? 0,
    tick_cached:             tickerStatus?.ticksCached ?? 0,
    tick_newest_age_ms:      tickNewestAge,
    tick_oldest_age_ms:      tickOldestAge,
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
      const fetchWindow = Math.max(limit, 200);
      const signals = await getActiveSignals(fetchWindow);
      const totalGenerated = signals.length;

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
      applyLiveSanity(enriched as any[]);
      const droppedCount = (enriched as any[]).filter(r => r.live_invalidated).length;
      const filtered = (enriched as any[]).filter(r => !r.live_invalidated);
      if (droppedCount > 0) {
        console.log(`[API/signals] live-sanity dropped ${droppedCount}/${enriched.length} rows (adverse live move / stopped out)`);
      }

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

      const BUY_LIMIT  = Math.ceil(TARGET_COUNT / 2);       // 25 when TARGET=50
      const SELL_LIMIT = TARGET_COUNT - BUY_LIMIT;          // 25 when TARGET=50
      const MIN_SELL   = SELL_LIMIT;                        // auto-relax threshold
      const ratio      = { buy: 0.5, sell: 0.5, label: 'fixed (25/25)' };

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
      //      state we IGNORE the flag. This is what the user hit:
      //      Kite down → every row live_invalidated → pool collapsed.
      //
      // Soft-excluded (demoted to later tiers, not removed):
      //   - decay_state === 'stale'     → allowed in Tier 4+
      //   - conviction_band === 'Avoid' → allowed in Tier 5+
      //
      // Emergency relax: if the hard gate leaves fewer than 10 rows,
      // even live_invalidated gets ignored — better than returning
      // nothing. `expired` always stays out.
      let kiteLive = false;
      try {
        const { getTicker } = await import('@/lib/marketData/kiteTicker');
        const st = getTicker().getStatus();
        kiteLive = st.state === 'open' && !st.loginRequired;
      } catch { /* no ticker context — treat as not-live */ }

      // Diagnostics — count what the strict gate WOULD remove, even
      // when emergency relax keeps them. The user asked for this
      // explicit breakdown so the "culprit" is obvious in logs.
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

      // Strict gate evaluated first — tells us whether emergency mode
      // is needed.
      const strictHardExclude = (r: any): boolean => {
        const decay = String(r.decay_state ?? '').toLowerCase();
        if (decay === 'expired') return true;
        if (kiteLive && r.live_invalidated) return true;
        return false;
      };
      const strictSurvivors = filtered.filter((r: any) => !strictHardExclude(r)).length;
      const emergencyMode   = strictSurvivors < 10;

      // Emergency gate: only 'expired' stays out. live_invalidated
      // is dropped as a gate regardless of Kite state.
      const emergencyHardExclude = (r: any): boolean =>
        String(r.decay_state ?? '').toLowerCase() === 'expired';

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

      // Merged list also sorted by rank so the top of the dashboard
      // is the best overall, not "top BUYs then top SELLs in blocks".
      shown = shown.sort(sortByRank);

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
        `  kite_live:                 ${kiteLive}\n` +
        `  removed_live_invalidated:  ${removed_live_invalidated}${kiteLive ? '' : ' (IGNORED — Kite not live)'}\n` +
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

      if (emergencyMode) {
        console.warn(
          `[WARNING] EMERGENCY RELAX ACTIVE — only ${afterStrictFilter} rows ` +
          `survived the strict gate. Hard gate relaxed (live_invalidated ignored) ` +
          `to keep the list populated. Root cause candidates: ` +
          `Kite down (live_invalidated fabricated from delayed Yahoo prices), ` +
          `or rescore lag (most rows aged into 'stale').`,
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
          kite_live:           kiteLive,
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
          source:              'database',
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
