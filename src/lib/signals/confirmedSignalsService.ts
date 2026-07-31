// ════════════════════════════════════════════════════════════════
//  confirmedSignalsService — the data pipeline behind /api/signals
//  (action='top'|'all') and /api/signals/stream.
//
//  Extracted from src/app/api/signals/route.ts. Behaviour is a
//  byte-for-byte port of the inline implementation; nothing here
//  is new logic.
//
//  What this module does:
//    1. Fetch confirmed snapshots, in-progress trackers, freshness
//       probe, and tracker counts in parallel.
//    2. Yahoo-enrich the snapshot rows (`livePrice` / `livePChange`). // @deprecated marker
//    3. Apply the institutional gate (`strictApproved`), sort
//       deterministically (`confirmedSnapshotCmp`), and slice to the
//       confirmed-snapshot cap (`applyConfirmedCap`).
//    4. Build the below-floor demoted set for the Emerging panel.
//    5. Yahoo-enrich the in-progress tracker rows. // @deprecated marker
//
//  Returns a typed bundle. The caller (route handler) only has to
//  build the response envelope around it.
// ════════════════════════════════════════════════════════════════

import { resolveBatch }               from '@/lib/marketData/resolver/marketDataResolver';
import { getMarketStatus }            from '@/lib/marketData/marketHours';
import { getUserActiveDataSource }    from '@/lib/broker/connections/activeDataSource';
import { getBrokerMarketDataProvider } from '@/lib/marketData/brokerProvider';
import { normalizeInstrument }        from '@/lib/marketData/brokerProvider/instruments/normalize';
import { recordLiveFeedTick }         from '@/lib/marketData/liveFeedState';
import {
  dominantLiveOrigin,
  isSignalLiveFallbackEnabled,
  liveOriginForBroker,
  type DataOrigin,
}                                     from '@/lib/signals/dataOrigin';

import {
  getActiveConfirmedSnapshots,
  getConfirmedSnapshotReadMeta,
}                                     from '@/lib/signal-engine/repository/readConfirmedSnapshots';
import {
  getInProgressTrackers,
  getTrackerCounts,
}                                     from '@/lib/signal-engine/repository/maturityTracker';

import {
  applyConfirmedCap,
  confirmedSnapshotCmp,
  isBelowFloor,
  strictApproved,
  strictApprovedAudit,
  STRICT_CONFIDENCE_FLOOR,
  STRICT_FINAL_FLOOR,
  STRICT_RR_FLOOR,
  STRICT_STRESS_FLOOR,
}                                     from '@/lib/signals/confirmedSignalPolicy';
import {
  applySectorDiversity,
  isFreshEnough,
  rotationCmp,
}                                     from '@/lib/signals/rotationPolicy';
import { type ConfirmedSignalRow }    from '@/lib/signals/signalsResponseMapper';
import {
  type SnapshotFreshnessRaw,
  type TrackerCounts,
}                                     from '@/lib/signals/freshnessService';
import {
  dedupeLatestPerSymbolDirection,
  dedupeOneSymbolOneSignal,
}                                     from '@/lib/signals/closedMarketSignals';
import type { SignalsApiProfiler }    from '@/lib/signals/signalsApiProfiler';

// ────────────────────────────────────────────────────────────────
//  Live-price enrichment
//
//  CRITICAL CONTRACT:
//    q365_signals.ltp = IMMUTABLE entry-time snapshot. Never overwrite.
//    row.livePrice    = current market price; populated per request.
//    row.livePChange  = current % change.
//    row.liveSource   = DataOrigin-ish tag (zerodha_live|shoonya_live|fallback|none)
//
//  Phase 10: when userId is provided, quotes come from that user's
//  active broker adapter. System resolveBatch is ONLY used when
//  SIGNALS_LIVE_FALLBACK is explicitly enabled — never silently claim
//  Zerodha/Shoonya live from Yahoo/Kite cascade.
// ────────────────────────────────────────────────────────────────
export interface EnrichLiveLtpOpts {
  /** Authenticated user — routes quotes through their active broker. */
  userId?: number;
  marketOpen?: boolean;
}

export interface EnrichLiveLtpResult<T> {
  rows: T[];
  liveOrigin: DataOrigin | null;
  fallbackUsed: boolean;
}

export async function enrichWithLiveLtp<
  T extends {
    tradingsymbol?: string;
    symbol?:        string;
    ltp?:           number | null;
    pct_change?:    number | null;
    livePrice?:     number | null;
    livePChange?:   number | null;
    liveSource?:    string | null;
    liveTickTs?:    number | null;
  }
>(rows: T[], opts: EnrichLiveLtpOpts = {}): Promise<T[]> {
  const result = await enrichWithLiveLtpDetailed(rows, opts);
  return result.rows;
}

export async function enrichWithLiveLtpDetailed<
  T extends {
    tradingsymbol?: string;
    symbol?:        string;
    ltp?:           number | null;
    pct_change?:    number | null;
    livePrice?:     number | null;
    livePChange?:   number | null;
    liveSource?:    string | null;
    liveTickTs?:    number | null;
  }
>(rows: T[], opts: EnrichLiveLtpOpts = {}): Promise<EnrichLiveLtpResult<T>> {
  if (rows.length === 0) {
    return { rows, liveOrigin: null, fallbackUsed: false };
  }

  const t0 = Date.now();
  type Target = { row: T; sym: string };
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

  let fallbackUsed = false;
  let brokerFilled = 0;

  if (targets.length > 0 && opts.userId != null) {
    brokerFilled = await enrichFromUserBroker(targets, opts.userId);
  }

  const stillMissing = targets.filter(
    (t) => t.row.livePrice == null || !(t.row.livePrice! > 0),
  );

  if (stillMissing.length > 0 && isSignalLiveFallbackEnabled()) {
    fallbackUsed = true;
    await enrichFromSystemResolver(stillMissing);
  } else if (stillMissing.length > 0 && opts.userId == null && isSignalLiveFallbackEnabled()) {
    // Jobs without a user may use explicit fallback only.
    fallbackUsed = true;
    await enrichFromSystemResolver(stillMissing);
  }

  for (const { row } of targets) {
    if (row.livePrice == null || (row.livePrice ?? 0) <= 0) {
      row.livePrice   = null;
      row.livePChange = null;
      row.liveSource  = 'none';
      row.liveTickTs  = null;
    }
  }

  const liveOrigin = dominantLiveOrigin(rows);
  const bySource: Record<string, number> = {};
  let totalLive = 0;
  for (const r of rows) {
    const src = (r.liveSource ?? 'none').toString();
    bySource[src] = (bySource[src] ?? 0) + 1;
    if (r.livePrice != null) totalLive++;
  }

  const marketOpen = opts.marketOpen ?? getMarketStatus().isOpen;
  console.log(
    `[DATA SOURCE] path=LIVE  channel=${brokerFilled > 0 ? 'USER_BROKER' : fallbackUsed ? 'FALLBACK' : 'NONE'}  ` +
    `rows=${rows.length} live=${totalLive} brokerFilled=${brokerFilled} ` +
    `fallbackUsed=${fallbackUsed} origin=${liveOrigin ?? 'none'} ` +
    `market=${marketOpen ? 'OPEN' : 'CLOSED'} elapsed=${Date.now() - t0}ms ` +
    `sources=${JSON.stringify(bySource)}`,
  );

  return { rows, liveOrigin, fallbackUsed };
}

async function enrichFromUserBroker<
  T extends {
    livePrice?: number | null;
    livePChange?: number | null;
    liveSource?: string | null;
    liveTickTs?: number | null;
  },
>(targets: Array<{ row: T; sym: string }>, userId: number): Promise<number> {
  try {
    const active = await getUserActiveDataSource(userId);
    if (!active.provider || active.needsSelection || !active.isConnected) {
      return 0;
    }
    const provider = getBrokerMarketDataProvider(active.provider);
    const ctx = {
      userId,
      connectionId: active.connectionId ?? undefined,
    };
    await provider.connect(ctx);
    const instruments = targets.map(({ sym }) =>
      normalizeInstrument({ exchange: 'NSE', symbol: sym, instrumentType: 'EQ' }),
    );

    const ENRICH_TIMEOUT_MS = Math.max(
      1_000,
      Number(process.env.SIGNALS_ENRICH_TIMEOUT_MS) || 5_000,
    );
    const quotes = await Promise.race([
      provider.fetchQuote(ctx, instruments),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), ENRICH_TIMEOUT_MS)),
    ]);
    if (!quotes) {
      console.warn(
        `[DATA SOURCE] user broker quote timeout userId=${userId} provider=${active.provider}`,
      );
      return 0;
    }

    const bySym = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q]));
    const originTag = liveOriginForBroker(active.provider);
    let filled = 0;
    for (const { row, sym } of targets) {
      const q = bySym.get(sym);
      if (q && Number.isFinite(q.ltp) && q.ltp > 0) {
        row.livePrice = q.ltp;
        row.livePChange = q.changePercent;
        row.liveSource = originTag;
        row.liveTickTs = q.asOfMs || Date.now();
        filled += 1;
      }
    }
    if (filled > 0) {
      recordLiveFeedTick(Date.now(), undefined, {
        userId: String(userId),
        provider: active.provider,
      });
    }
    return filled;
  } catch (err) {
    console.warn(
      `[DATA SOURCE] user broker enrich failed userId=${userId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
}

async function enrichFromSystemResolver<
  T extends {
    livePrice?: number | null;
    livePChange?: number | null;
    liveSource?: string | null;
    liveTickTs?: number | null;
  },
>(targets: Array<{ row: T; sym: string }>): Promise<void> {
  const symbols = targets.map((t) => t.sym);
  const ENRICH_TIMEOUT_MS = Math.max(
    1_000,
    Number(process.env.SIGNALS_ENRICH_TIMEOUT_MS) || 5_000,
  );
  const resolved = await Promise.race([
    resolveBatch(symbols, { quiet: true }),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ENRICH_TIMEOUT_MS)),
  ]);
  if (!resolved) return;

  for (const { row, sym } of targets) {
    const snap = resolved.snapshots.get(sym);
    if (snap && Number.isFinite(snap.price) && snap.price > 0) {
      row.livePrice = snap.price;
      row.livePChange = Number.isFinite(snap.changePercent) ? snap.changePercent : null;
      // Explicitly tag as fallback — never as zerodha_live / shoonya_live.
      row.liveSource = 'fallback';
      row.liveTickTs = snap.timestamp || Date.now();
    }
  }
}

// ────────────────────────────────────────────────────────────────
//  Bundle returned to the route handler
// ────────────────────────────────────────────────────────────────
export interface ConfirmedSignalsBundle {
  /** Snapshot rows after live enrichment (no gating yet). Used by
   *  the route's stale-batch auto-recovery probe and freshness
   *  envelope (`enriched.length`). */
  enriched:           ConfirmedSignalRow[];
  /** Strict-gate-approved + deterministically-sorted + cap-sliced.
   *  This is what ships in the response `signals` array. */
  finalRows:          ConfirmedSignalRow[];
  /** Below-score-floor candidates demoted to Emerging / Developing. */
  belowFloorDemoted:  ConfirmedSignalRow[];
  /** Tracker rows + livePrice for the Emerging panel. */
  inProgressEnriched: ConfirmedSignalRow[];
  /** Pass-through from the snapshot freshness probe. */
  freshnessRaw:       SnapshotFreshnessRaw;
  /** Tracker counts pass-through (used by funnel + freshness). */
  trackerCounts:      TrackerCounts;
  /** Phase 10 — where signal rows vs live prices came from. */
  dataOrigin:         DataOrigin;
  liveEnrichmentOrigin: DataOrigin | null;
  fallbackUsed:       boolean;
  /** MATURATION_AUDIT_2026-05 — single-line bottleneck diagnosis the
   *  route surfaces on the wire as `approval_bottleneck`. Operators
   *  can inspect it via `curl /api/signals | jq .approval_bottleneck`
   *  without parsing logs. Always populated; `cause === 'none'` means
   *  the cycle produced approvals. */
  approvalBottleneck: {
    stage:           'pipeline' | 'strict_gate' | 'freshness_gate' | 'sector_cap' | 'reader_classification_filter' | 'none';
    cause:           string;
    blocked_rows:    number;
    total_input:     number;
    detail:          string;
    suggested_env?:  string;
    ranked_causes?:  ReadonlyArray<readonly [string, number]>;
  };
}

export interface LoadConfirmedSignalsOpts {
  /** Reader window — how many rows to ask the snapshot reader for.
   *  The cap is applied AFTER the strict gate, so a wider window
   *  gives the gate more material when most snapshots fail floors. */
  limit: number;
  /** Authenticated user — live LTP via their active broker (Phase 10). */
  userId?: number;
  marketOpen?: boolean;
  profile?: Pick<SignalsApiProfiler, 'time' | 'mark'>;
}

/**
 * Single entry point for the confirmed-signals data pipeline.
 *
 * Order matters and is preserved from the inline route.ts version:
 *   1. Promise.all the four DB reads.
 *   2. Yahoo-enrich snapshots. // @deprecated marker
 *   3. Strict gate → sort → cap.
 *   4. Build below-floor demoted set.
 *   5. Yahoo-enrich tracker rows. // @deprecated marker
 *
 * No side effects beyond DB / Yahoo I/O. Same DB state → same bundle. // @deprecated marker
 */
export async function loadConfirmedSignalsBundle(
  opts: LoadConfirmedSignalsOpts,
): Promise<ConfirmedSignalsBundle> {
  const marketIsOpen = opts.marketOpen ?? getMarketStatus().isOpen;
  const loadDatabase = () => Promise.all([
      getActiveConfirmedSnapshots({ limit: opts.limit }),
      getInProgressTrackers(50).catch(() => []),
      getTrackerCounts().catch(
        () => ({ candidate: 0, developing: 0, mature: 0, promoted: 0, terminated: 0, total: 0 }),
      ),
      getConfirmedSnapshotReadMeta().catch(
        () => ({
          freshness: {
            latest_confirmed_at: null,
            latest_confirmed_ms: null,
            active_count: 0,
            total_lifetime: 0,
          },
          diagnostics: {
            totalActive: 0,
            readerEligible: 0,
            excludedByClassification: 0,
            breakdown: [] as Array<{ classification: string; count: number }>,
          },
        }),
      ),
    ] as const);
  const [snapshots, inProgress, trackerCounts, readMeta] =
    opts.profile
      ? await opts.profile.time(
          'database_queries',
          loadDatabase,
          (result) => ({
            rows: result[0].length + result[1].length,
          }),
        )
      : await loadDatabase();
  const freshnessRaw = readMeta.freshness;
  const readerDiag = readMeta.diagnostics;

  // PROMOTION-AUDIT (2026-05) — canonical [SNAPSHOT_READ] tag for the
  // reader path. Pairs with [SNAPSHOT_WRITE] / [PROMOTION_SUCCESS] in
  // the writer so an operator can grep one batch_id and see the full
  // write→read lifecycle. Emits even when 0 rows are returned so a
  // silent-empty bug (snapshots query returns nothing) is visible.
  console.log(
    `[SNAPSHOT_READ] table=q365_confirmed_signal_snapshots ` +
    `active_count=${snapshots.length} ` +
    `in_progress_trackers=${inProgress.length} ` +
    `request_limit=${opts.limit} ` +
    `tracker_counts=` +
    `candidate:${trackerCounts.candidate}/developing:${trackerCounts.developing}/` +
    `mature:${trackerCounts.mature}/promoted:${trackerCounts.promoted}`,
  );

  // Live-price enrichment for snapshots AND in-progress trackers.
  // Phase 10: prefer the authenticated user's active broker quotes.
  // System resolveBatch is only used when SIGNALS_LIVE_FALLBACK=1.
  const snapshotRows = snapshots as ConfirmedSignalRow[];
  const trackerRows = inProgress as ConfirmedSignalRow[];
  const combinedRows = [...snapshotRows, ...trackerRows];
  const shouldEnrichLive = combinedRows.length > 0;
  const enrichOpts = { userId: opts.userId, marketOpen: marketIsOpen };
  const enrichMarketData = async () => shouldEnrichLive
    ? enrichWithLiveLtpDetailed(combinedRows, enrichOpts)
    : { rows: combinedRows, liveOrigin: null as DataOrigin | null, fallbackUsed: false };
  const combinedEnrichment = opts.profile
    ? await opts.profile.time(
        'market_data_fetch',
        enrichMarketData,
        () => ({ providerCalls: shouldEnrichLive ? 1 : 0 }),
      )
    : await enrichMarketData();
  if (!shouldEnrichLive && inProgress.length > 0) {
    console.log(
      `[PERF] enrichWithLiveLtp skipped — confirmed_snapshots=0 ` +
      `in_progress=${inProgress.length} (relaxed/closed loader owns the main table)`,
    );
  }
  const enriched = combinedEnrichment.rows.slice(0, snapshotRows.length);
  const inProgressEnriched = combinedEnrichment.rows.slice(snapshotRows.length);
  const liveEnrichmentOrigin = combinedEnrichment.liveOrigin;
  const fallbackUsed = combinedEnrichment.fallbackUsed;
  // Market state — drives the freshness cap (6h open / 24h closed).
  const processingStartedAt = Date.now();

  // MATURATION_AUDIT_2026-05 — instrumented strict-gate funnel. Run
  // strictApprovedAudit on every enriched row so we can publish a
  // per-stage rejection histogram (which gate kills the most rows?)
  // BEFORE the rows reach the elite gate downstream. The elite-gate
  // log only fires when its input is non-empty, so when every row
  // dies at the strict gate the operator was previously seeing zero
  // diagnostic output — they couldn't tell whether the engine was
  // generating nothing or whether the gate was over-punishing.
  const strictStartedAt = Date.now();
  const strictPassed: ConfirmedSignalRow[] = [];
  const strictDropped: Array<{
    row: ConfirmedSignalRow;
    detail: ReturnType<typeof strictApprovedAudit>;
  }> = [];
  const strictCauseHistogram: Record<string, number> = {};
  for (const row of enriched) {
    const detail = strictApprovedAudit(row);
    if (detail.passed) {
      strictPassed.push(row);
      continue;
    }
    strictDropped.push({ row, detail });
    const first = detail.failed[0] ?? 'unknown';
    const eq = first.indexOf('=');
    const cause = (eq >= 0 ? first.slice(0, eq) : first)
      .replace('rr_ratio', 'risk_reward')
      .replace('confidence_score', 'confidence');
    strictCauseHistogram[cause] = (strictCauseHistogram[cause] ?? 0) + 1;
  }
  opts.profile?.mark('confidence_scoring_filtering', Date.now() - strictStartedAt, {
    rows: strictPassed.length,
  });

  if (enriched.length > 0) {
    // Bucket each dropped row by the FIRST failure (dominant gate)
    // so the histogram answers "what's the #1 blocker today?".
    const num = (v: unknown): number | null => {
      if (v == null) return null;
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : null;
    };
    // Top-30 dropped rows by final_score (strongest near-misses) with
    // the full diagnostic field set the operator asked for.
    const topByFinal = strictDropped
      .map((d) => {
        const r = d.row as unknown as Record<string, unknown>;
        const first = d.detail.failed[0] ?? 'unknown';
        const eq = first.indexOf('=');
        const failed_gate = (eq >= 0 ? first.slice(0, eq) : first)
          .replace('rr_ratio', 'risk_reward')
          .replace('confidence_score', 'confidence');
        const failed_threshold = (() => {
          const floors: Record<string, number> = {
            final_score:           STRICT_FINAL_FLOOR,
            confidence:            STRICT_CONFIDENCE_FLOOR,
            risk_reward:           STRICT_RR_FLOOR,
            stress_survival_score: STRICT_STRESS_FLOOR,
          };
          return floors[failed_gate] ?? null;
        })();
        return {
          symbol:                String((r.symbol ?? r.tradingsymbol ?? '?') as string),
          confidence:            num(r.confidence_score ?? r.confidence),
          final_score:           num(r.final_score),
          maturity_score:        num(r.maturity_score),
          rr:                    num(r.rr_ratio ?? r.risk_reward),
          liquidity_score:       num(r.liquidity_score),
          portfolio_fit:         num(r.portfolio_fit_score),
          stress_survival:       num(r.stress_survival_score),
          freshness_state:       String((r.freshness_state ?? '') as string).toUpperCase() || null,
          conviction:            String((r.conviction_band ?? r.conviction_level ?? '') as string) || null,
          execution_allowed:     r.execution_allowed === false ? false
                              : r.execution_allowed === true  ? true
                              : null,
          signal_status:         String((r.signal_status ?? '') as string).toUpperCase() || null,
          stability_passed:      r.stability_passed ?? null,
          classification:        String((r.classification ?? r.raw_classification ?? '') as string).toUpperCase() || null,
          failed_gate,
          failed_threshold,
          rejection_reason:      first,
          all_failures:          d.detail.failed,
        };
      })
      .sort((a, b) => (b.final_score ?? 0) - (a.final_score ?? 0))
      .slice(0, 30);

    console.log('[STRICT_FUNNEL]', {
      input_count:    enriched.length,
      passed_count:   strictPassed.length,
      dropped_count:  strictDropped.length,
      cause_histogram: strictCauseHistogram,
      floors_active: {
        confidence:           STRICT_CONFIDENCE_FLOOR,
        final:                STRICT_FINAL_FLOOR,
        risk_reward:          STRICT_RR_FLOOR,
        stress_survival:      STRICT_STRESS_FLOOR,
        require_stable:       process.env.SIGNAL_API_REQUIRE_STABLE === '1' ? 'strict (explicit true required)'
                            : process.env.SIGNAL_API_REQUIRE_STABLE === '0' ? 'disabled'
                            : 'lenient (null OK, only false rejects)',
      },
      top_30_by_final: topByFinal,
    });
  }

  // Strict gate → freshness gate → rotation-aware sort → sector
  // diversity → cap. Spec INSTITUTIONAL §B + §I:
  //   - isFreshEnough drops rows older than the active max-age cap.
  //     Market-aware: 6h when OPEN, 24h when CLOSED (so the previous
  //     session's confirmed batch survives the overnight gap).
  //   - rotationCmp ranks by freshness-decayed effective score, with
  //     a cooldown penalty for rows shown for too many consecutive
  //     cycles (unless their score is improving).
  //   - applySectorDiversity caps per-sector occupancy so financials
  //     / IT cannot fill the table on a sector-strong day.
  //   - confirmedSnapshotCmp is preserved as the deterministic tiebreak.
  const rankingStartedAt = Date.now();
  const beforeFreshness = strictPassed;
  let sortedApproved: ConfirmedSignalRow[] = beforeFreshness
    .filter((r) => isFreshEnough(r, { marketOpen: marketIsOpen }))
    .sort((a, b) => {
      const r = rotationCmp(a, b);
      return r !== 0 ? r : confirmedSnapshotCmp(a, b);
    });

  // When the cash session is open, the 6h cap can reject every
  // confirmed snapshot (e.g. morning promotion, afternoon poll) while
  // the same rows are visible after 15:30 via loadClosedMarketSignals.
  // Fall back to the closed-market freshness cap (default 24h) without
  // tagging rows STALE — partitionByTier rejects freshness_state=STALE.
  if (sortedApproved.length === 0 && beforeFreshness.length > 0 && marketIsOpen) {
    const closedCapApproved = beforeFreshness
      .filter((r) => isFreshEnough(r, { marketOpen: false }))
      .sort((a, b) => {
        const r = rotationCmp(a, b);
        return r !== 0 ? r : confirmedSnapshotCmp(a, b);
      });
    if (closedCapApproved.length > 0) {
      sortedApproved = closedCapApproved;
      console.log(
        `[FRESHNESS_FUNNEL] open-market cap rejected all ${beforeFreshness.length} rows; ` +
        `closed-market cap recovered ${closedCapApproved.length}`,
      );
    }
  }

  // Freshness funnel — separate log line so the operator can see
  // whether freshness is the SECOND blocker after strictApproved.
  if (beforeFreshness.length > 0) {
    const freshnessDropped = beforeFreshness.length - sortedApproved.length;
    if (freshnessDropped > 0) {
      console.log('[FRESHNESS_FUNNEL]', {
        input_count:   beforeFreshness.length,
        passed_count:  sortedApproved.length,
        dropped_count: freshnessDropped,
        market_open:   marketIsOpen,
      });
    }
  }
  void strictApproved; // function still exported for callers; this fn now uses the audit variant.

  // ── MATURATION_AUDIT_2026-05 — APPROVAL_BOTTLENECK summary ──
  //
  // Single grep-able line that names the #1 gate killing rows on this
  // request, with a concrete env-var recommendation. Fires in every
  // failure mode so an operator never has to interpret three separate
  // funnel logs:
  //
  //   • input_count = 0           → q365_confirmed_signal_snapshots is
  //                                  empty; the bottleneck is upstream
  //                                  (Phase 4 / maturity tracker).
  //   • strictPassed = 0          → strict gate killed everything;
  //                                  print the dominant cause + env knob.
  //   • sortedApproved = 0        → strict passed N but freshness
  //                                  rejected all of them.
  //   • sortedApproved > 0        → success; emit a one-line confirmation
  //                                  so the log timeline shows the cycle
  //                                  produced approvals.
  //
  // Tuning recommendations are conservative one-step drops the operator
  // pre-authorised: final 60→55, rr 2.0→1.8, etc. The route does NOT
  // self-tune — the operator flips the env var (no code change, no
  // restart needed beyond Next.js dev server hot reload).
  const bottleneckRecommendation = (cause: string): string => {
    if (cause === 'final_score')
      return 'SIGNAL_API_STRICT_FINAL_FLOOR=55  (currently 60)';
    if (cause === 'risk_reward')
      return 'SIGNAL_API_STRICT_RR_FLOOR=1.8  (currently 2.0)';
    if (cause === 'confidence')
      return 'SIGNAL_API_STRICT_CONFIDENCE_FLOOR=65  (currently 70) — but the operator spec asks for 70 to stay; tune RR/final first';
    if (cause === 'stress_survival_score')
      return 'SIGNAL_API_STRICT_STRESS_FLOOR=50  (currently 60)';
    if (cause === 'classification_not_approved')
      return 'engine output classification is outside the approved whitelist; check Phase 4 classification logic, not a gate-tuning issue';
    if (cause === 'stability_passed')
      return 'maturity tracker is writing stability_passed=false; check tracker logic. Gate is already lenient on null values.';
    if (cause === 'invalidation_reason' || cause === 'live_invalidated')
      return 'rows are being invalidated upstream — inspect engine invalidation logic, not the strict gate';
    if (cause === 'execution_allowed')
      return 'engine is setting execution_allowed=false on most rows — inspect Phase 4 execution gating';
    return `inspect [STRICT_FUNNEL].top_30_by_final for rows with rejection_reason starting "${cause}"`;
  };

  type Bottleneck = ConfirmedSignalsBundle['approvalBottleneck'];
  let approvalBottleneck: Bottleneck;

  if (enriched.length === 0) {
    if (readerDiag.excludedByClassification > 0) {
      const topCls = readerDiag.breakdown[0]?.classification ?? 'unknown';
      approvalBottleneck = {
        stage:         'reader_classification_filter',
        cause:         'non_institutional_classification',
        blocked_rows:  readerDiag.excludedByClassification,
        total_input:   readerDiag.totalActive,
        detail:        `${readerDiag.totalActive} ACTIVE snapshots exist but ${readerDiag.excludedByClassification} carry non-institutional classifications (e.g. ${topCls}) and are filtered before the strict gate. Only ${readerDiag.readerEligible} are reader-eligible.`,
        suggested_env: 'Phase 4 must emit INSTITUTIONAL_HIGH_CONVICTION / HIGH_CONVICTION / VALID_SIGNAL before promotion. Lifecycle invalidates misclassified ACTIVE snapshots each tick.',
        ranked_causes: readerDiag.breakdown.map((b) => [b.classification, b.count] as [string, number]),
      };
    } else {
      approvalBottleneck = {
        stage:        'pipeline',
        cause:        'no_candidates_from_pipeline',
        blocked_rows: 0,
        total_input:  0,
        detail:       'q365_confirmed_signal_snapshots returned 0 ACTIVE rows. The bottleneck is UPSTREAM of the strict gate — Phase 4 / maturity tracker is not promoting candidates this cycle.',
        suggested_env: 'check Phase 4 cron + maturity-tracker writer; gate-tuning will not help when the engine ships zero candidates.',
      };
    }
    console.log('[APPROVAL_BOTTLENECK]', approvalBottleneck);
  } else if (strictPassed.length === 0) {
    const ranked = Object.entries(strictCauseHistogram).sort((a, b) => b[1] - a[1]);
    const dominant = ranked[0]?.[0] ?? 'unknown';
    const dominantCount = ranked[0]?.[1] ?? 0;
    approvalBottleneck = {
      stage:         'strict_gate',
      cause:         dominant,
      blocked_rows:  dominantCount,
      total_input:   enriched.length,
      detail:        `Strict gate rejected all ${enriched.length} candidates. Dominant blocker: "${dominant}" (${dominantCount} rows = ${Math.round((dominantCount / enriched.length) * 100)}% of input).`,
      suggested_env: bottleneckRecommendation(dominant),
      ranked_causes: ranked.slice(0, 5),
    };
    console.log('[APPROVAL_BOTTLENECK]', approvalBottleneck);
  } else if (sortedApproved.length === 0) {
    approvalBottleneck = {
      stage:         'freshness_gate',
      cause:         'freshness_gate',
      blocked_rows:  beforeFreshness.length,
      total_input:   enriched.length,
      detail:        `${beforeFreshness.length} rows passed the strict gate but freshness/decay rejected ALL of them. Likely cause: stale_candidate ages > active freshness cap (6h open / 24h closed).`,
      suggested_env: 'increase the freshness cap via the freshness service, or check why every confirmed snapshot is aging past the cap before being shown.',
    };
    console.log('[APPROVAL_BOTTLENECK]', approvalBottleneck);
  } else {
    approvalBottleneck = {
      stage:         'none',
      cause:         'none',
      blocked_rows:  enriched.length - sortedApproved.length,
      total_input:   enriched.length,
      detail:        `Strict gate produced ${strictPassed.length} rows, freshness kept ${sortedApproved.length}. Sector diversity + cap will further trim. APPROVED tab should populate.`,
    };
    console.log('[APPROVAL_BOTTLENECK]', approvalBottleneck);
  }

  const diverseApproved: ConfirmedSignalRow[] = applySectorDiversity(sortedApproved);
  // MATURATION_AUDIT_2026-05 — two-pass dedup mirroring finalizeBundle:
  //   1. dedupeLatestPerSymbolDirection — collapse repeated (symbol,
  //      direction) emissions, keeping the most recent per pair. The
  //      writer's duplicate_active gate prevents this in steady state
  //      but rare race conditions can produce dupes that the reader
  //      must defensively collapse.
  //   2. dedupeOneSymbolOneSignal — collapse cross-direction pairs
  //      (BUY + SELL on the same symbol from a mid-trend flip),
  //      keeping the higher-scoring direction. The dashboard never
  //      ships contradictory signals for one instrument.
  const uniqByPair    = dedupeLatestPerSymbolDirection(diverseApproved);
  const dedupedApproved = dedupeOneSymbolOneSignal(uniqByPair);
  if (dedupedApproved.length < diverseApproved.length) {
    console.log('[LIVE_DEDUP_FUNNEL]', {
      input_count:        diverseApproved.length,
      after_pair_dedup:   uniqByPair.length,
      passed_count:       dedupedApproved.length,
      dropped_pair:       diverseApproved.length - uniqByPair.length,
      dropped_one_symbol: uniqByPair.length     - dedupedApproved.length,
      total_dropped:      diverseApproved.length - dedupedApproved.length,
    });
  }
  const finalRows: ConfirmedSignalRow[] = applyConfirmedCap(dedupedApproved);
  opts.profile?.mark('ranking_sorting_maturity', Date.now() - rankingStartedAt, {
    rows: finalRows.length,
  });

  // Sector diversity / cap funnel — fires only when the cap actually
  // bit. applySectorDiversity can also reject rows when a sector is
  // saturated. Together with applyConfirmedCap (slice-to-N), these
  // are the LAST trims before the row reaches the elite gate.
  if (sortedApproved.length > finalRows.length) {
    console.log('[SECTOR_CAP_FUNNEL]', {
      input_count:    sortedApproved.length,
      after_diversity: diverseApproved.length,
      after_cap:      finalRows.length,
      diversity_dropped: sortedApproved.length - diverseApproved.length,
      cap_dropped:    diverseApproved.length - finalRows.length,
    });
  }

  // Below-floor demoted (Emerging / Developing).
  const belowFloorDemoted: ConfirmedSignalRow[] = enriched
    .filter(isBelowFloor)
    .sort(confirmedSnapshotCmp)
    .map((r: ConfirmedSignalRow) => ({
      ...r,
      is_demoted:          true,
      demoted_reason:      'below_score_floor',
      is_developing_setup: true,
      signal_status:       'DEVELOPING_SETUP',
    } as ConfirmedSignalRow));

  // Tracker enrichment is now produced by the Promise.all above so
  // it runs in parallel with the snapshot enrichment instead of
  // serialising behind it. (Sanity not applied; emerging rows are not
  // actionable, so live_invalidated would just hide trackers the
  // operator wants to watch approaching their stop.)

  // If sector_cap subsequently dropped everything (rare, but possible
  // when sector diversity + cap removes the last surviving rows),
  // override the bottleneck so the wire diagnosis remains correct.
  if (sortedApproved.length > 0 && finalRows.length === 0) {
    approvalBottleneck = {
      stage:        'sector_cap',
      cause:        'sector_diversity_or_cap',
      blocked_rows: sortedApproved.length,
      total_input:  enriched.length,
      detail:       `Strict + freshness produced ${sortedApproved.length} rows, but sector diversity / final cap zeroed them. Inspect [SECTOR_CAP_FUNNEL] log line.`,
      suggested_env: 'check sector caps + Q365_CONFIRMED_CAP — unusual outcome',
    };
    console.log('[APPROVAL_BOTTLENECK]', approvalBottleneck);
  }

  opts.profile?.mark('signal_processing_ranking_filtering', Date.now() - processingStartedAt, {
    rows: finalRows.length,
  });

  return {
    enriched,
    finalRows,
    belowFloorDemoted,
    inProgressEnriched,
    freshnessRaw: freshnessRaw as SnapshotFreshnessRaw,
    trackerCounts,
    approvalBottleneck,
    dataOrigin: 'database',
    liveEnrichmentOrigin,
    fallbackUsed,
  };
}
