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

import {
  getActiveConfirmedSnapshots,
  getConfirmedSnapshotFreshness,
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

// ────────────────────────────────────────────────────────────────
//  Live-price enrichment
//
//  CRITICAL CONTRACT:
//    q365_signals.ltp = IMMUTABLE entry-time snapshot. Never overwrite.
//    row.livePrice    = current market price; populated per request.
//    row.livePChange  = current % change.
//
//  The UI renders ENTRY from `ltp` (frozen) and CURRENT from
//  `livePrice` (fresh). Mutating `row.ltp` with a live quote made
//  "entry price" drift in the UI — the bug this separation prevents.
// ────────────────────────────────────────────────────────────────
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
>(rows: T[]): Promise<T[]> {
  if (rows.length === 0) return rows;

  const t0 = Date.now();
  const market = getMarketStatus();

  // Step 9 of the IndianAPI cutover. Live enrichment goes through
  // the central resolver — IndianAPI batch primary, cache hit, NSE
  // direct rare fallback, Yahoo emergency only when explicitly enabled. // @deprecated marker
  // The resolver returns one envelope for the whole batch, so a 2-sec
  // batch call replaces the previous 25-wide per-symbol Yahoo fan-out. // @deprecated marker
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

  if (targets.length > 0) {
    const symbols = targets.map((t) => t.sym);
    // Always-on debug: shows the symbol set we're about to ask the
    // resolver for. Operators grep on `[DEBUG] calling IndianAPI` to
    // confirm the live-enrichment path is firing.
    console.log(
      `[DEBUG] calling IndianAPI for symbols: [${symbols.slice(0, 10).join(', ')}${symbols.length > 10 ? `, +${symbols.length - 10} more` : ''}]`,
    );
    // Spec "FIX SLOW /api/signals" — hard wall-clock cap on the
    // resolver call. Without this, a 47-tracker enrichment fan-out
    // through IndianAPI's emulated batch (cap=2, 45-60s per call)
    // blocks the entire /api/signals response for 15-25 minutes on
    // a slow upstream. The dev plan's per-IP throttle plus serialised
    // axios calls means the only safe upper bound is a wall-clock
    // race here — when the timeout wins, we ship the rows with
    // livePrice=null (the UI already handles that as "no live tick"
    // and renders the persisted entry/stop). The resolveBatch call
    // is NOT cancelled — its results continue filling the per-symbol
    // quote cache so the next poll within TTL gets fresh data.
    //
    // 5s default is a balance: long enough for a healthy upstream's
    // 1-2s round-trip + cache miss, short enough that a stalled call
    // can't dominate the response. Env-tunable via
    // SIGNALS_ENRICH_TIMEOUT_MS for ops on a paid plan with faster
    // upstream.
    const ENRICH_TIMEOUT_MS = Math.max(
      1_000,
      Number(process.env.SIGNALS_ENRICH_TIMEOUT_MS) || 5_000,
    );
    const enrichStart = Date.now();
    let timedOut = false;
    const resolved = await Promise.race([
      resolveBatch(symbols, { quiet: true }),
      new Promise<null>((resolve) =>
        setTimeout(() => { timedOut = true; resolve(null); }, ENRICH_TIMEOUT_MS),
      ),
    ]);
    const enrichElapsed = Date.now() - enrichStart;
    if (timedOut || !resolved) {
      console.warn(
        `[DEBUG] enrichWithLiveLtp timeout after ${enrichElapsed}ms ` +
        `(symbols=${symbols.length}, cap=${ENRICH_TIMEOUT_MS}ms) — ` +
        `shipping rows without live prices; resolver continues in background`,
      );
      // Stamp every target as "no live data" so the UI knows entry
      // is from the persisted snapshot, not a live tick.
      for (const { row } of targets) {
        row.livePrice   = null;
        row.livePChange = null;
        row.liveSource  = 'none';
        row.liveTickTs  = null;
      }
    } else {
      console.log(
        `[DEBUG] IndianAPI response (${enrichElapsed}ms): provider=${resolved.provider} returned=${resolved.symbolsReturned}/${resolved.symbolsRequested} fallbackUsed=${resolved.fallbackUsed} errorCode=${resolved.errorCode ?? 'none'}`,
      );
      for (const { row, sym } of targets) {
        const snap = resolved.snapshots.get(sym);
        if (snap && Number.isFinite(snap.price) && snap.price > 0) {
          row.livePrice   = snap.price;
          row.livePChange = Number.isFinite(snap.changePercent) ? snap.changePercent : null;
          row.liveSource  = resolved.provider === 'yahoo_emergency' ? 'yahoo' : 'indianapi'; // @deprecated marker
          row.liveTickTs  = snap.timestamp || Date.now();
        } else {
          row.livePrice   = null;
          row.livePChange = null;
          row.liveSource  = 'none';
          row.liveTickTs  = null;
        }
      }
    }
  }

  const bySource: Record<string, number> = {};
  let totalLive = 0;
  for (const r of rows) {
    const src = (r.liveSource ?? 'none').toString();
    bySource[src] = (bySource[src] ?? 0) + 1;
    if (r.livePrice != null) totalLive++;
  }
  const indianCount = bySource.indianapi ?? 0;
  const yahooCount  = bySource.yahoo     ?? 0; // @deprecated marker
  const noneCount   = bySource.none      ?? 0;
  const liveRatio = rows.length > 0
    ? Math.round(((indianCount + yahooCount) / rows.length) * 100) // @deprecated marker
    : 0;

  let freshnessLabel: string;
  if (indianCount > 0 && market.isOpen)        freshnessLabel = 'NEAR_LIVE (indianapi)';
  else if (indianCount > 0)                    freshnessLabel = 'LAST_CLOSE (market closed — indianapi)';
  else if (yahooCount > 0)                     freshnessLabel = 'EMERGENCY_YAHOO (delayed)'; // @deprecated marker
  else if (noneCount === rows.length)          freshnessLabel = 'NO_DATA (provider chain failed)';
  else                                         freshnessLabel = 'PARTIAL';

  // Always-on per spec ("FIX INDIANAPI NOT BEING CALLED" §3 + §9). The
  // VERBOSE_SIGNALS gate was hiding every live-enrichment hop, which
  // made it impossible to confirm from console alone whether IndianAPI
  // was being called. The lines are 2 per request — cheap.
  console.log(
    `[DATA SOURCE] path=LIVE  channel=RESOLVER  rows=${rows.length}  ` +
    `live=${totalLive}  indian=${indianCount}  yahoo=${yahooCount}  none=${noneCount}  ` + // @deprecated marker
    `status=${freshnessLabel}  elapsed=${Date.now() - t0}ms`,
  );
  console.log(
    `[DATA] live_ratio=${liveRatio}%  market=${market.isOpen ? 'OPEN' : 'CLOSED'}`,
  );

  return rows;
}

// ────────────────────────────────────────────────────────────────
//  Bundle returned to the route handler
// ────────────────────────────────────────────────────────────────
export interface ConfirmedSignalsBundle {
  /** Snapshot rows after Yahoo enrichment (no gating yet). Used by // @deprecated marker
   *  the route's stale-batch auto-recovery probe and freshness
   *  envelope (`enriched.length`). */
  enriched:           ConfirmedSignalRow[];
  /** Strict-gate-approved + deterministically-sorted + cap-sliced.
   *  This is what ships in the response `signals` array. */
  finalRows:          ConfirmedSignalRow[];
  /** Below-score-floor candidates demoted to Emerging / Developing. */
  belowFloorDemoted:  ConfirmedSignalRow[];
  /** Tracker rows + Yahoo livePrice for the Emerging panel. */ // @deprecated marker
  inProgressEnriched: ConfirmedSignalRow[];
  /** Pass-through from the snapshot freshness probe. */
  freshnessRaw:       SnapshotFreshnessRaw;
  /** Tracker counts pass-through (used by funnel + freshness). */
  trackerCounts:      TrackerCounts;
  /** MATURATION_AUDIT_2026-05 — single-line bottleneck diagnosis the
   *  route surfaces on the wire as `approval_bottleneck`. Operators
   *  can inspect it via `curl /api/signals | jq .approval_bottleneck`
   *  without parsing logs. Always populated; `cause === 'none'` means
   *  the cycle produced approvals. */
  approvalBottleneck: {
    stage:           'pipeline' | 'strict_gate' | 'freshness_gate' | 'sector_cap' | 'none';
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
  const [snapshots, inProgress, freshnessRaw, trackerCounts] = await Promise.all([
    getActiveConfirmedSnapshots({ limit: opts.limit }),
    getInProgressTrackers(50).catch(() => []),
    getConfirmedSnapshotFreshness(),
    getTrackerCounts().catch(
      () => ({ candidate: 0, developing: 0, mature: 0, promoted: 0, terminated: 0, total: 0 }),
    ),
  ]);

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
  // Spec "FIX SLOW /api/signals" — these two calls are independent
  // (different row sets) and each races a 5s wall-clock cap against
  // resolveBatch. Running them sequentially made the worst case 10s
  // when IndianAPI was slow; firing them in parallel halves that.
  // The synchronous gating below only reads `enriched` (the snapshot
  // result), so promoting `inProgressEnriched` up here is safe.
  const [enrichedRaw, inProgressEnriched] = await Promise.all([
    enrichWithLiveLtp(snapshots as ConfirmedSignalRow[]),
    enrichWithLiveLtp(inProgress as ConfirmedSignalRow[]),
  ]);
  const enriched: ConfirmedSignalRow[] = enrichedRaw;
  // Market state — drives the freshness cap (6h open / 24h closed).
  const marketIsOpen = getMarketStatus().isOpen;

  // MATURATION_AUDIT_2026-05 — instrumented strict-gate funnel. Run
  // strictApprovedAudit on every enriched row so we can publish a
  // per-stage rejection histogram (which gate kills the most rows?)
  // BEFORE the rows reach the elite gate downstream. The elite-gate
  // log only fires when its input is non-empty, so when every row
  // dies at the strict gate the operator was previously seeing zero
  // diagnostic output — they couldn't tell whether the engine was
  // generating nothing or whether the gate was over-punishing.
  const strictAudit = enriched.map((r) => ({
    row:    r,
    detail: strictApprovedAudit(r),
  }));
  const strictPassed: ConfirmedSignalRow[] = strictAudit
    .filter((a) => a.detail.passed)
    .map((a) => a.row);
  const strictDropped = strictAudit.filter((a) => !a.detail.passed);

  if (enriched.length > 0) {
    // Bucket each dropped row by the FIRST failure (dominant gate)
    // so the histogram answers "what's the #1 blocker today?".
    const cause: Record<string, number> = {};
    for (const d of strictDropped) {
      const first = d.detail.failed[0] ?? 'unknown';
      const eq = first.indexOf('=');
      const head = (eq >= 0 ? first.slice(0, eq) : first)
        .replace('rr_ratio',     'risk_reward')
        .replace('confidence_score','confidence');
      cause[head] = (cause[head] ?? 0) + 1;
    }
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
      cause_histogram: cause,
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
  const beforeFreshness = strictPassed;
  const sortedApproved: ConfirmedSignalRow[] = beforeFreshness
    .filter((r) => isFreshEnough(r, { marketOpen: marketIsOpen }))
    .sort((a, b) => {
      const r = rotationCmp(a, b);
      return r !== 0 ? r : confirmedSnapshotCmp(a, b);
    });

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
    approvalBottleneck = {
      stage:        'pipeline',
      cause:        'no_candidates_from_pipeline',
      blocked_rows: 0,
      total_input:  0,
      detail:       'q365_confirmed_signal_snapshots returned 0 ACTIVE rows. The bottleneck is UPSTREAM of the strict gate — Phase 4 / maturity tracker is not promoting candidates this cycle.',
      suggested_env: 'check Phase 4 cron + maturity-tracker writer; gate-tuning will not help when the engine ships zero candidates.',
    };
    console.log('[APPROVAL_BOTTLENECK]', approvalBottleneck);
  } else if (strictPassed.length === 0) {
    // Recompute the cause histogram from strictDropped (already
    // computed above for [STRICT_FUNNEL] but local to that block).
    const cause: Record<string, number> = {};
    for (const d of strictDropped) {
      const first = d.detail.failed[0] ?? 'unknown';
      const eq = first.indexOf('=');
      const head = (eq >= 0 ? first.slice(0, eq) : first)
        .replace('rr_ratio', 'risk_reward')
        .replace('confidence_score', 'confidence');
      cause[head] = (cause[head] ?? 0) + 1;
    }
    const ranked = Object.entries(cause).sort((a, b) => b[1] - a[1]);
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

  return {
    enriched,
    finalRows,
    belowFloorDemoted,
    inProgressEnriched,
    freshnessRaw: freshnessRaw as SnapshotFreshnessRaw,
    trackerCounts,
    approvalBottleneck,
  };
}
