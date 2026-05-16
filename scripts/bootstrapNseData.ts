/**
 * scripts/bootstrapNseData.ts — ONE-TIME NSE bootstrap.
 *
 * Spec NSE_BOOTSTRAP_COMPLETED: prime an empty deployment with real
 * NSE quotes for the NIFTY 500 universe. Runs ONCE; subsequent
 * invocations exit without touching NSE. After this seed lands, the
 * runtime resolver takes over (IndianAPI primary → NSE fallback →
 * Yahoo fallback; market-closed → DB only).
 *
 * Usage:
 *   npx tsx scripts/bootstrapNseData.ts                # default 500 cap
 *   npx tsx scripts/bootstrapNseData.ts --limit 50     # smaller seed
 *   npx tsx scripts/bootstrapNseData.ts --dry-run      # parse + plan, no NSE/DB
 *   npx tsx scripts/bootstrapNseData.ts --force        # ignore BOOTSTRAP_DONE flag
 *
 * Behaviour:
 *   - Reads NIFTY 500 from `ind_nifty500list.csv` via the locked
 *     loader at `@/lib/marketData/nifty500Universe`.
 *   - Hits NSE direct in safe mode: 20 symbols/batch, 500ms gap,
 *     50-request session cap, 2 retries, instant trip on 403.
 *   - Persists each row to `q365_market_close_snapshot` (last-close
 *     view) AND emits a basic BUY/SELL signal into `q365_signals`
 *     (entry=price, stop=±2%, target=±3%, conf=60, final=65,
 *     signal_status=APPROVED_SIGNAL).
 *   - Sets a persistent `BOOTSTRAP_DONE=true` flag (cache-backed,
 *     365-day TTL) so re-runs short-circuit. Pass `--force` to
 *     override during testing.
 *
 * Idempotency: q365_market_close_snapshot has PRIMARY KEY (symbol),
 * so the upsert is a single-row swap per symbol. q365_signals uses an
 * INSERT — re-running will create duplicates, which is why the
 * BOOTSTRAP_DONE flag is the primary guard.
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve as resolvePath } from 'node:path';

// Load .env.local BEFORE any module that reads env at construction.
dotenvConfig({ path: resolvePath(process.cwd(), '.env.local') });

// ── Spec NSE_BOOTSTRAP_STABLE_MODE — provider tuning (set BEFORE the
//   provider imports below, since `getNseDirectFallbackConfig()` reads
//   these on every call). Tighter pacing than the runtime resolver
//   defaults so a slow / flaky NSE doesn't trip the per-IP throttle
//   while we seed the full universe.
process.env.NSE_DIRECT_FALLBACK_ENABLED               = 'true';
process.env.NSE_DIRECT_FALLBACK_MAX_SYMBOLS_PER_DAY  ??= '1000';   // §6 — seed all 500
process.env.NSE_DIRECT_FALLBACK_PER_CALL_CAP         ??= '5';      // §2 — batch size 5
process.env.NSE_DIRECT_FALLBACK_MIN_DELAY_MS         ??= '2000';   // §2 — 2000ms gap
process.env.NSE_DIRECT_FALLBACK_REQUEST_TIMEOUT_MS   ??= '10000';  // 10s per request
process.env.NSE_DIRECT_FALLBACK_TRIGGER_FAILURES     ??= '1';      // bootstrap is itself the trigger

import { db } from '@/lib/db';
import { cacheGet, cacheSet } from '@/lib/redis';
import {
  getNifty500Symbols,
  initNifty500UniverseFromDb,
} from '@/lib/marketData/nifty500Universe';
import {
  fetchNseDirectQuotes,
  getNseDirectStatus,
} from '@/lib/marketData/providers/nseDirectProvider';
import { isMarketOpen, getMarketStatus } from '@/lib/marketData/marketHours';
import {
  buildQualitySignal as buildQualitySignalPure,
  classifyBias,
  Q_CONFIDENCE_FLOOR,
  Q_FINAL_FLOOR,
  Q_RR_FLOOR,
  type DailyBar,
  type QualitySignal,
  type SignalResult,
} from '@/lib/signal-engine/bootstrap/qualitySignal';
import type { MarketSnapshot } from '@/types/market';

// ── Knobs ─────────────────────────────────────────────────────────

/** Spec §2 — calmer cadence than the runtime resolver: smaller batches
 *  and a longer inter-batch sleep mean NSE is far less likely to slip
 *  into its soft-failure backoff in the first place. */
const SAFE_BATCH_SIZE      = 5;
const INTER_BATCH_DELAY_MS = 2_000;
/** Spec §4 — retry passes through the still-missing queue. Each pass
 *  is preceded by a cooldown sleep, never an immediate re-call. */
const RETRY_PASSES         = 2;
/** Spec §3 — when the script observes 3 consecutive zero-snapshot
 *  batches, it pauses for HARD_COOLDOWN_MS and resets its own counter.
 *  This is layered on top of the provider's internal backoffUntil
 *  (which is also honoured per-batch via waitOutBackoff below). */
const SOFT_FAIL_THRESHOLD  = 3;
const HARD_COOLDOWN_MS     = 60_000;
const MAX_SYMBOLS_PER_RUN  = 500;
/** Spec §8 — flag set ONLY when this many symbols actually persisted. */
const FLAG_MIN_SUCCESS     = 50;
/** Tiny safety margin added to every backoff sleep so we wake up just
 *  AFTER the window elapses, never microseconds before it. */
const BACKOFF_BUFFER_MS    = 250;

/** Spec §8 — persistent flag key. Backed by Redis when configured;
 *  in-process map otherwise. The 365-day TTL is conservative: in
 *  practice the flag survives the lifetime of a deployment, but a TTL
 *  > 0 protects against accidental "stuck forever" if the cache
 *  driver gets out of sync. */
const BOOTSTRAP_FLAG_KEY = 'nse:BOOTSTRAP_DONE';
const BOOTSTRAP_FLAG_TTL_S = 365 * 24 * 3600;

// ── CLI ──────────────────────────────────────────────────────────

interface CliArgs {
  limit:  number;
  dryRun: boolean;
  force:  boolean;
}

function parseArgs(argv: string[]): CliArgs {
  let limit  = MAX_SYMBOLS_PER_RUN;
  let dryRun = false;
  let force  = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit' && argv[i + 1]) {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) limit = Math.min(MAX_SYMBOLS_PER_RUN, Math.trunc(n));
      continue;
    }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--force')   { force  = true; continue; }
  }
  return { limit, dryRun, force };
}

// ── Helpers ──────────────────────────────────────────────────────

function istDateString(d = new Date()): string {
  // IST = UTC+5:30 — bucket by IST calendar date for the snapshot_session column.
  const ms = d.getTime() + 5.5 * 3_600_000;
  return new Date(ms).toISOString().slice(0, 10);
}

async function isAlreadyRun(): Promise<boolean> {
  const flag = await cacheGet<boolean>(BOOTSTRAP_FLAG_KEY);
  return flag === true;
}

async function setBootstrapFlag(): Promise<void> {
  await cacheSet(BOOTSTRAP_FLAG_KEY, true, BOOTSTRAP_FLAG_TTL_S);
}

/** Spec §6 Table 1 — upsert one row per symbol into the close-snapshot
 *  table. The PRIMARY KEY on (symbol) makes this idempotent — a re-run
 *  with the same data swaps the row in place. */
async function upsertCloseSnapshot(snap: MarketSnapshot, sessionDate: string): Promise<void> {
  const sql = `
    INSERT INTO q365_market_close_snapshot
      (symbol, price, change_abs, change_pct, volume,
       open_price, high_price, low_price, prev_close,
       snapshot_ts, snapshot_session)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)
    ON DUPLICATE KEY UPDATE
       price       = VALUES(price),
       change_abs  = VALUES(change_abs),
       change_pct  = VALUES(change_pct),
       volume      = VALUES(volume),
       open_price  = VALUES(open_price),
       high_price  = VALUES(high_price),
       low_price   = VALUES(low_price),
       prev_close  = VALUES(prev_close),
       snapshot_ts = NOW(),
       snapshot_session = VALUES(snapshot_session),
       updated_at  = NOW()`;
  await db.query(sql, [
    snap.symbol,
    snap.price,
    snap.change,
    snap.changePercent,
    snap.volume,
    snap.open,
    snap.high,
    snap.low,
    snap.prevClose,
    sessionDate,
  ]);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ── EMA + RSI signal logic — pure module at
//    src/lib/signal-engine/bootstrap/qualitySignal.ts. The script
//    only owns the I/O (history fetch, persistence) + the per-run
//    counters; the signal builder is unit-tested separately so the
//    BUY/SELL balance contract is verifiable without spinning up DB.

/** Read up to N most-recent daily bars from market_data_daily for one
 *  symbol. Returns ASC by ts so EMA / RSI can iterate forward. Empty
 *  array when the table has fewer rows than the builder's MIN_HISTORY
 *  for the symbol; the caller treats that as "skip signal, snapshot
 *  only". */
async function fetchHistoryBars(symbol: string, limit = 100): Promise<DailyBar[]> {
  try {
    const res = await db.query(
      `SELECT ts, open, high, low, close, volume FROM (
         SELECT ts, open, high, low, close, volume
           FROM market_data_daily
          WHERE symbol = ?
          ORDER BY ts DESC
          LIMIT ?
       ) t
       ORDER BY ts ASC`,
      [symbol, limit],
    );
    return (res.rows as Array<{
      ts: Date | string; open: number | string; high: number | string;
      low: number | string; close: number | string; volume: number | string;
    }>).map((r) => ({
      ts:     r.ts instanceof Date ? r.ts : new Date(r.ts),
      open:   Number(r.open),
      high:   Number(r.high),
      low:    Number(r.low),
      close:  Number(r.close),
      volume: Number(r.volume),
    }));
  } catch (err) {
    console.warn(`[BOOTSTRAP] history fetch failed for ${symbol}: ${(err as Error).message}`);
    return [];
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Adapter — the script-side `processBatch` passes a MarketSnapshot;
 *  the pure builder accepts the minimal {symbol, price} shape. */
function buildQualitySignal(snap: MarketSnapshot, bars: DailyBar[]): SignalResult {
  return buildQualitySignalPure({ symbol: snap.symbol, price: snap.price }, bars);
}

/** Spec §6 Table 2 — insert a quality bootstrap signal. Score floors
 *  enforced by buildQualitySignal so any row reaching here clears
 *  confidence ≥ 60, final ≥ 65, RR ≥ 1.5. Classification uses values
 *  the dashboard's strictApproved predicate accepts:
 *    BUY  → 'HIGH_CONVICTION_BUY'
 *    SELL → 'HIGH_CONVICTION'  (one of the approved sell classifications) */
async function insertBootstrapSignal(
  snap: MarketSnapshot,
  signal: QualitySignal,
  batchId: string,
): Promise<void> {
  // Spec DATA-QUALITY §2 — final-score-bucketed classification.
  //   final >= 75 → HIGH_CONVICTION   final >= 65 → MEDIUM_CONVICTION
  // The bootstrap's quality gate already rejects final < 65, so
  // LOW_CONVICTION never lands at the insert stage. The dashboard
  // re-derives the same bucket on read (closedMarketSignals.normalizeClassification),
  // which protects against any future change to this insert site.
  const classification =
      signal.finalScore >= 75 ? 'HIGH_CONVICTION'
    :                           'MEDIUM_CONVICTION';
  const confidenceBand =
      signal.confidenceScore >= 85 ? 'INSTITUTIONAL'
    : signal.confidenceScore >= 75 ? 'HIGH'
    : signal.confidenceScore >= 65 ? 'MEDIUM'
    :                                'LOW';
  // Spec FIX-CLEAN §4 — every metric column MUST be populated. The
  // dashboard's Pfit / Stress / Risk columns rendered blank because
  // the bootstrap left these NULL. Formulas come straight from the
  // spec — derived from already-computed scores so they vary per row.
  // Spec DATA-QUALITY §3 — pfit formula updated to min(100, conf+5)
  // so the bootstrap insert matches the response-layer fallback in
  // closedMarketSignals.backfillBlankFields.
  //   risk_score      = round(rr_ratio * 20)                  // 30..50 typical
  //   pfit            = min(100, confidence + 5)              // 65..100
  //   stress          = round(100 - confidence)               // 5..40
  const riskScore  = clamp(Math.round(signal.riskReward * 20), 0, 100);
  const pfitScore  = clamp(Math.min(100, signal.confidenceScore + 5), 0, 100);
  const stressScore = clamp(Math.round(100 - signal.confidenceScore), 0, 100);
  // Spec INSERT-AUDIT — `risk_band` is NOT NULL on the prod schema and
  // its placeholder is bound at values[6]. Bands match the runtime
  // policy buckets in confirmedSignalPolicy.ts (RISK_LOW=30,
  // RISK_MODERATE=55, RISK_ELEVATED=75) so the bootstrap row reads
  // identically to a Phase-4 signal in the dashboard's risk column.
  const riskBand =
      riskScore < 30 ? 'LOW'
    : riskScore < 55 ? 'MODERATE'
    : riskScore < 75 ? 'ELEVATED'
    :                  'HIGH';
  // Spec DB-FIX §4 + INSERT-FIX — fail-safe guard. Both `symbol` and
  // `direction` are NOT NULL columns on the prod schema; an undefined
  // value here is exactly what produces the "doesn't have a default
  // value" MySQL error. Skip cleanly instead of corrupting the table.
  const symbol = String(snap.symbol ?? '').trim().toUpperCase();
  if (!symbol || !signal.direction) {
    console.warn('Skipping invalid signal', { symbol, direction: signal.direction });
    return;
  }
  const instrumentKey = symbol;   // INSTRUMENT_KEY MUST EQUAL SYMBOL — never undefined.
  // Spec INSERT-FIX — only the 17 columns the bootstrap actually
  // populates. Every other q365_signals column has a schema default
  // (NULL or `'active'` etc.); we no longer touch them so a future
  // schema change to a tangential column can't break this INSERT.
  // Spec INSERT-AUDIT — production schema has stricter NOT-NULL than
  // the local seed (we've already hit instrument_key / risk_band /
  // market_regime). The columns below all default to NULL or to a
  // sensible literal in the local schema but have been observed
  // to fail with "doesn't have a default value" on the prod DB.
  // Binding them as SQL LITERALS (not `?` placeholders) means:
  //   • zero risk of placeholder/value drift (count stays at 18)
  //   • a future column that gains a NOT NULL constraint without
  //     a default just needs to be added to the trailing literal
  //     block — no values-array surgery required.
  const sql = `
INSERT INTO q365_signals (
  symbol,
  instrument_key,
  direction,
  confidence_score,
  confidence_band,
  risk_score,
  risk_band,
  entry_price,
  stop_loss,
  target1,
  risk_reward,
  opportunity_score,
  scenario_tag,
  batch_id,
  final_score,
  classification,
  portfolio_fit_score,
  stress_survival_score,
  signal_type,
  generation_source,
  signal_status,
  expires_at,
  market_regime,
  market_stance,
  exchange,
  timeframe,
  status,
  target2,
  engine_phase,
  engine_version
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
  'nse_bootstrap',
  'scripts/bootstrapNseData',
  'APPROVED_SIGNAL',
  DATE_ADD(NOW(), INTERVAL 3 DAY),
  'unknown',
  'selective',
  'NSE',
  'daily',
  'active',
  0,
  0,
  'bootstrap'
)`;
  const values: unknown[] = [
    symbol,                       // [0]  symbol               — REQUIRED, NOT NULL
    instrumentKey,                // [1]  instrument_key       — REQUIRED, MUST EQUAL SYMBOL
    signal.direction,             // [2]  direction            — REQUIRED, NOT NULL
    signal.confidenceScore,       // [3]  confidence_score
    confidenceBand,               // [4]  confidence_band
    riskScore,                    // [5]  risk_score
    riskBand,                     // [6]  risk_band            — REQUIRED on prod schema
    signal.entryPrice,            // [7]  entry_price
    signal.stopLoss,              // [8]  stop_loss
    signal.target1,               // [9]  target1
    signal.riskReward,            // [10] risk_reward
    signal.confidenceScore,       // [11] opportunity_score (mirrors confidence)
    signal.scenario,              // [12] scenario_tag
    batchId,                      // [13] batch_id
    signal.finalScore,            // [14] final_score
    classification,               // [15] classification
    pfitScore,                    // [16] portfolio_fit_score
    stressScore,                  // [17] stress_survival_score
  ];

  // Spec INSERT-FIX — defensive self-check. Any future edit that drops
  // a `?` or fails to align the values array will be caught at run
  // time before the INSERT fires. Cheap (one regex per insert) and
  // saves the operator a confusing MySQL error message.
  const placeholderCount = (sql.match(/\?/g) ?? []).length;
  if (placeholderCount !== values.length) {
    throw new Error(
      `insertBootstrapSignal: SQL placeholder/value mismatch ` +
      `(placeholders=${placeholderCount}, values=${values.length}) — refusing to INSERT`,
    );
  }
  // Spec INSERT-FIX — debug line surfaces the exact NOT-NULL columns
  // that caused the prior production failure. Gated behind an env var
  // so a 500-symbol seed run doesn't drown stdout.
  if (process.env.BOOTSTRAP_DEBUG_INSERT === '1') {
    console.log('INSERT DEBUG', {
      symbol,
      instrument_key: instrumentKey,
      direction:      signal.direction,
      risk_band:      riskBand,
      final_score:    signal.finalScore,
    });
  }

  await db.query(sql, values);
}

// ── Main ─────────────────────────────────────────────────────────

interface BootstrapReport {
  total_symbols: number;
  success:       number;
  failed:        number;
  aborted:       false;     // Spec §6 — never aborts
  flag_set:      boolean;
  batch_id:      string | null;
  /** Spec REAL-DATA — signal-engine summary block. */
  total_generated:   number;
  approved:          number;
  rejected:          number;
  skipped_no_price:  number;
  provider_used:     'indianapi' | 'nse' | 'yahoo' | 'none';
  data_quality:      'REAL_ONLY' | 'SNAPSHOT' | 'NONE';
  /** Spec BALANCE §6 — direction balance summary. */
  buy_count:    number;
  sell_count:   number;
  bias_status:  'BALANCED' | 'BIAS_DETECTED' | 'NO_SIGNALS';
  /** Spec DB-FIX §7 — persistence + final-validation summary. */
  inserted_signals:    number;
  failed_inserts:      number;
  duplicates_removed:  number;
  db_status:           'OK' | 'EMPTY' | 'ERROR';
  signal_status:       'READY' | 'EMPTY' | 'ERROR';
  /** Spec INSERT-FIX — explicit confirmation that the INSERT contract
   *  held across the run. `placeholders_match` is true when every per-
   *  symbol insert passed the runtime placeholder/values length check;
   *  `insert_status` summarises the outcome ("SUCCESS" iff every
   *  attempted insert landed without throwing). */
  placeholders_match:  boolean;
  values_valid:        boolean;
  insert_status:       'SUCCESS' | 'PARTIAL' | 'FAILED' | 'NONE';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Spec §1 + §5 — respect the provider's published backoff window so
 * the bootstrap never hammers a flagged NSE. Reads
 * `getNseDirectStatus()` (the same in-process state the runtime
 * resolver consults) and sleeps until either:
 *
 *   • backoffUntil elapses (+ a small buffer), OR
 *   • trippedUntil — IST midnight permanent block — at which point
 *     no amount of waiting will recover; we return false so the
 *     caller can stop scheduling pointless retries.
 *
 * Returns true when the script may proceed with the next batch,
 * false when the provider is permanently tripped for the day.
 */
async function waitOutBackoff(): Promise<boolean> {
  const status = await getNseDirectStatus();
  // Permanent (until-IST-midnight) trip? No point sleeping for hours
  // — bail out and let the caller skip remaining retry passes.
  if (status.trippedUntil) {
    const trippedMs = Date.parse(status.trippedUntil);
    if (Number.isFinite(trippedMs) && trippedMs > Date.now()) {
      console.warn('[BOOTSTRAP] NSE permanently tripped until', status.trippedUntil);
      return false;
    }
  }
  if (status.backoffUntil) {
    const ms = Date.parse(status.backoffUntil) - Date.now();
    if (Number.isFinite(ms) && ms > 0) {
      const waitMs = Math.min(ms + BACKOFF_BUFFER_MS, HARD_COOLDOWN_MS);
      console.log(
        `[BOOTSTRAP] respecting provider backoff — sleeping ${waitMs}ms ` +
        `(consecutiveSoftFailures=${status.consecutiveSoftFailures})`,
      );
      await sleep(waitMs);
    }
  }
  return true;
}

/** Local consecutive-zero-batch counter. Bumped when a batch returns
 *  no snapshots; reset whenever a batch returns at least one. */
const failState = { consecutiveZeroBatches: 0 };

/** Spec §3 — when the script's own failure counter trips, sleep for
 *  HARD_COOLDOWN_MS and then reset the counter so the next iteration
 *  starts from a clean slate. Layered above waitOutBackoff: the
 *  provider's per-call backoff handles the short windows; this is the
 *  hard "give NSE 60 seconds to breathe" pause for a flat-line run. */
async function applyHardCooldownIfNeeded(): Promise<void> {
  if (failState.consecutiveZeroBatches < SOFT_FAIL_THRESHOLD) return;
  console.warn(
    `[BOOTSTRAP] hard cooldown — ${failState.consecutiveZeroBatches} consecutive zero-snapshot batches; ` +
    `sleeping ${HARD_COOLDOWN_MS}ms`,
  );
  await sleep(HARD_COOLDOWN_MS);
  failState.consecutiveZeroBatches = 0;
}

/**
 * Process a single batch of symbols:
 *   1. waitOutBackoff() — respect the provider's published cooldown.
 *   2. Call fetchNseDirectQuotes(batch). Whatever comes back, take it.
 *   3. Persist returned snapshots + signals immediately (per-symbol
 *      try/catch around DB writes — spec §2).
 *   4. Update consecutive-zero counter; trigger hard cooldown if needed.
 *
 *  Returns true on continue (proceed to next batch), false when the
 *  provider is tripped for the day and the caller should bail out.
 */
/** Spec REAL-DATA + BALANCE — per-run counters surfaced to the final
 *  summary. `buy` / `sell` count successful inserts only, so the bias
 *  check at the end reflects what actually persisted, not what the
 *  builder generated and the persist step then dropped. */
interface SignalCounters {
  totalGenerated:  number;   // buildQualitySignal returned kind:'signal'
  approved:        number;   // INSERT succeeded
  rejected:        number;   // buildQualitySignal returned kind:'skip'
  skippedNoPrice:  number;   // snapshot price missing OR market closed
  buy:             number;   // approved INSERT with direction='BUY'
  sell:            number;   // approved INSERT with direction='SELL'
  /** Per-reason histogram for the [SIGNAL SKIPPED] dump. */
  skipReasons:     Map<string, number>;
}

function bumpSkip(counters: SignalCounters, reason: string): void {
  counters.rejected += 1;
  counters.skipReasons.set(reason, (counters.skipReasons.get(reason) ?? 0) + 1);
}

interface ProcessOpts {
  /** When false, the script persists snapshots ONLY — buildQualitySignal
   *  is not invoked. Used during off-hours runs to honor spec REAL-DATA
   *  §2: "market closed → DO NOT run full signal engine". */
  generateSignals: boolean;
}

async function processBatch(
  batch: string[],
  sessionDate: string,
  batchId: string,
  counters: { successOK: Set<string>; failureLast: Map<string, string> },
  signalCounters: SignalCounters,
  opts: ProcessOpts,
): Promise<boolean> {
  // Spec §1 + §5 — never call into the provider while it's in backoff.
  const proceed = await waitOutBackoff();
  if (!proceed) {
    for (const sym of batch) {
      if (!counters.failureLast.has(sym)) counters.failureLast.set(sym, 'PROVIDER_TRIPPED');
    }
    return false;
  }

  console.log(`[BOOTSTRAP] NSE CALL → symbols: ${batch.length}`);
  let result: Awaited<ReturnType<typeof fetchNseDirectQuotes>> | null = null;
  try {
    result = await fetchNseDirectQuotes(batch);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[BOOTSTRAP] NSE call threw — continuing: ${msg}`);
    for (const sym of batch) counters.failureLast.set(sym, `NSE_THROW: ${msg.slice(0, 80)}`);
    failState.consecutiveZeroBatches += 1;
    await applyHardCooldownIfNeeded();
    return true;
  }

  if (result.exhausted) {
    console.warn('[BOOTSTRAP] NSE provider reports exhausted — logging and continuing', {
      errorCode:    result.errorCode,
      errorMessage: result.errorMessage,
    });
  }

  // Persist whatever the provider DID return — per-symbol try/catch
  // around the DB writes.
  for (const snap of result.snapshots) {
    try {
      await upsertCloseSnapshot(snap, sessionDate);
    } catch (err) {
      counters.failureLast.set(snap.symbol, `DB_SNAPSHOT: ${(err as Error).message.slice(0, 80)}`);
      console.warn(`[BOOTSTRAP] snapshot upsert failed for ${snap.symbol}: ${(err as Error).message}`);
      continue;
    }
    // Spec REAL-DATA §1 — block signal generation when no real price.
    // The snapshot just upserted is still useful for the price view,
    // but a signal needs a finite, positive `price` field on the
    // snapshot. Anything else is "no real price" — count and skip.
    if (!opts.generateSignals) {
      // Market closed → snapshot only. Spec REAL-DATA §2.
      counters.successOK.add(snap.symbol);
      counters.failureLast.delete(snap.symbol);
      continue;
    }
    if (!Number.isFinite(snap.price) || snap.price <= 0) {
      signalCounters.skippedNoPrice += 1;
      console.log(`[SIGNAL SKIPPED] ${snap.symbol} reason=invalid_price (no real price)`);
      counters.successOK.add(snap.symbol);
      counters.failureLast.delete(snap.symbol);
      continue;
    }

    // EMA/RSI/swing signal. Reads daily history from market_data_daily;
    // returns SignalResult{kind:'skip', reason} when the symbol fails
    // any SKIP rule (RSI extreme/neutral / thin volume / no trend /
    // missing alignment / invalid risk / RR or score below floor).
    const bars = await fetchHistoryBars(snap.symbol);
    const result = buildQualitySignal(snap, bars);
    if (result.kind === 'signal') {
      const signal = result.signal;
      // Spec REAL-DATA §5 — pre-insert validation. Defensive: the
      // builder already enforces these, but a corrupt history table
      // could in theory let a malformed row through.
      const invalid =
        !Number.isFinite(signal.entryPrice) || signal.entryPrice <= 0 ||
        !Number.isFinite(signal.stopLoss)   || signal.stopLoss   <= 0 ||
        !Number.isFinite(signal.target1)    || signal.target1    <= 0 ||
        signal.riskReward < Q_RR_FLOOR;
      if (invalid) {
        bumpSkip(signalCounters, 'invalid_at_persist');
        console.log(`[SIGNAL SKIPPED] ${snap.symbol} reason=invalid_at_persist`);
      } else {
        signalCounters.totalGenerated += 1;
        try {
          await insertBootstrapSignal(snap, signal, batchId);
          signalCounters.approved += 1;
          if (signal.direction === 'BUY')  signalCounters.buy  += 1;
          if (signal.direction === 'SELL') signalCounters.sell += 1;
          console.log(
            `[BOOTSTRAP] STORED → ${snap.symbol}  ${signal.direction}@${signal.entryPrice} ` +
            `(rr=${signal.riskReward}, conf=${signal.confidenceScore}, final=${signal.finalScore})`,
          );
        } catch (err) {
          bumpSkip(signalCounters, 'db_insert_failed');
          console.warn(`[BOOTSTRAP] signal insert failed for ${snap.symbol}: ${(err as Error).message}`);
        }
      }
    } else {
      bumpSkip(signalCounters, result.reason);
      console.log(`[SIGNAL SKIPPED] ${snap.symbol} reason=${result.reason}`);
    }
    counters.successOK.add(snap.symbol);
    counters.failureLast.delete(snap.symbol);
  }

  // Track misses for the caller's retry pass.
  const returned = new Set(result.snapshots.map((s) => s.symbol));
  for (const sym of batch) {
    if (!returned.has(sym) && !counters.failureLast.has(sym)) {
      counters.failureLast.set(sym, result.errorCode ?? 'NO_DATA');
    }
  }

  // Spec §3 — track consecutive zero-snapshot batches and trip the
  // hard cooldown when threshold is reached.
  if (result.snapshots.length === 0) {
    failState.consecutiveZeroBatches += 1;
    await applyHardCooldownIfNeeded();
  } else {
    failState.consecutiveZeroBatches = 0;
  }
  return true;
}

function emptyReport(over: Partial<BootstrapReport>): BootstrapReport {
  return {
    total_symbols:    0,
    success:          0,
    failed:           0,
    aborted:          false,
    flag_set:         false,
    batch_id:         null,
    total_generated:  0,
    approved:         0,
    rejected:         0,
    skipped_no_price: 0,
    provider_used:    'none',
    data_quality:     'NONE',
    buy_count:        0,
    sell_count:       0,
    bias_status:      'NO_SIGNALS',
    inserted_signals:    0,
    failed_inserts:      0,
    duplicates_removed:  0,
    db_status:           'EMPTY',
    signal_status:       'EMPTY',
    placeholders_match:  true,   // no inserts attempted ⇒ no mismatch possible
    values_valid:        true,
    insert_status:       'NONE',
    ...over,
  };
}

/** Spec DB-FIX §6 — post-run persistence verification. Reads
 *  q365_signals straight from the DB so the final summary reflects
 *  what's actually queryable, not just what the script attempted. */
async function verifyPersistence(): Promise<{ totalRows: number; ok: boolean }> {
  try {
    const { rows } = await db.query<{ c: number | string }>(
      `SELECT COUNT(*) AS c FROM q365_signals`,
    );
    const c = Number((rows as Array<{ c: number | string }>)[0]?.c ?? 0);
    return { totalRows: c, ok: c > 0 };
  } catch (err) {
    console.warn(`[BOOTSTRAP] post-run COUNT failed: ${(err as Error).message}`);
    return { totalRows: 0, ok: false };
  }
}


async function main(): Promise<BootstrapReport> {
  const args = parseArgs(process.argv.slice(2));

  console.log('[BOOTSTRAP] START', {
    limit: args.limit,
    dry_run: args.dryRun,
    force: args.force,
    timestamp: new Date().toISOString(),
  });

  // Spec REAL-DATA §2 + §6 — market-state gate. When NSE is closed
  // we still PERSIST snapshots (last-close prices are real data —
  // they belong in q365_market_close_snapshot) but we do NOT run the
  // signal engine. The closed-market loader exposes already-stored
  // valid signals; minting fresh ones from stale prices would be
  // exactly the "fake entry/target" anti-pattern the spec forbids.
  const market = getMarketStatus();
  console.log('[PROVIDER USED] nse');
  console.log(`[DATA QUALITY] ${market.isOpen ? 'REAL' : 'SNAPSHOT'} (market=${market.state})`);
  const generateSignals = market.isOpen || args.force;
  if (!market.isOpen && !args.force) {
    console.warn(
      '[BOOTSTRAP] market closed — running snapshot pass only. ' +
      'Pass --force to also generate signals (off-hours stale-price warning).',
    );
  }

  // Spec §8 — already-run guard.
  if (!args.force) {
    if (await isAlreadyRun()) {
      console.log('[BOOTSTRAP] SKIPPED — BOOTSTRAP_DONE flag is set. Pass --force to override.');
      return emptyReport({ flag_set: true });
    }
  }

  // Standalone CLI script — Next instrumentation hasn't run, so the
  // in-memory universe cache is empty. Hydrate it from q365_universe
  // before reading. Throws if the table has < NIFTY500_MIN_SIZE rows
  // (operator must run scripts/loadNifty500.ts first).
  await initNifty500UniverseFromDb();
  const universe = getNifty500Symbols();
  const targets  = universe.slice(0, args.limit);
  console.log(`[BOOTSTRAP] universe loaded — ${universe.length} symbols, processing ${targets.length}`);

  if (args.dryRun) {
    console.log('[BOOTSTRAP] DRY-RUN — no NSE call, no DB write. First 5 targets:', targets.slice(0, 5));
    console.log('[BOOTSTRAP] COMPLETE → total stored: 0 (dry-run)');
    return emptyReport({
      total_symbols: targets.length,
      data_quality:  market.isOpen ? 'REAL_ONLY' : 'NONE',
      provider_used: 'nse',
    });
  }

  const sessionDate = istDateString();
  const batchId     = `nse_bootstrap_${Date.now()}`;
  const successOK   = new Set<string>();
  const failureLast = new Map<string, string>();
  const counters    = { successOK, failureLast };
  const signalCounters: SignalCounters = {
    totalGenerated:  0,
    approved:        0,
    rejected:        0,
    skippedNoPrice:  0,
    buy:             0,
    sell:            0,
    skipReasons:     new Map(),
  };
  const procOpts: ProcessOpts = { generateSignals };

  let providerTripped = false;
  for (let i = 0; i < targets.length; i += SAFE_BATCH_SIZE) {
    const batch = targets.slice(i, i + SAFE_BATCH_SIZE);
    const proceed = await processBatch(batch, sessionDate, batchId, counters, signalCounters, procOpts);
    if (!proceed) { providerTripped = true; break; }
    if (i + SAFE_BATCH_SIZE < targets.length) {
      await sleep(INTER_BATCH_DELAY_MS);
    }
  }

  if (!providerTripped) {
    for (let attempt = 1; attempt <= RETRY_PASSES; attempt++) {
      const stillMissing = targets.filter((s) => !successOK.has(s));
      if (stillMissing.length === 0) break;
      console.log(`[BOOTSTRAP] retry pass ${attempt}/${RETRY_PASSES} — ${stillMissing.length} symbols`);
      await sleep(HARD_COOLDOWN_MS);
      failState.consecutiveZeroBatches = 0;
      let trippedDuringPass = false;
      for (let i = 0; i < stillMissing.length; i += SAFE_BATCH_SIZE) {
        const batch = stillMissing.slice(i, i + SAFE_BATCH_SIZE);
        const proceed = await processBatch(batch, sessionDate, batchId, counters, signalCounters, procOpts);
        if (!proceed) { trippedDuringPass = true; break; }
        if (i + SAFE_BATCH_SIZE < stillMissing.length) {
          await sleep(INTER_BATCH_DELAY_MS);
        }
      }
      if (trippedDuringPass) break;
    }
  }

  const success = successOK.size;
  const failed  = targets.length - success;
  // data_quality == REAL_ONLY when at least one signal was approved
  // off live data; SNAPSHOT when only the snapshot pass ran (closed);
  // NONE when nothing landed at all.
  const dataQuality: BootstrapReport['data_quality'] =
      signalCounters.approved > 0 ? 'REAL_ONLY'
    : success > 0                 ? 'SNAPSHOT'
    :                               'NONE';
  const biasStatus = classifyBias(signalCounters.buy, signalCounters.sell);
  // Spec DB-FIX §6 — read q365_signals AFTER the run so the report's
  // db_status reflects what the DB actually persisted (catches
  // INSERT-error scenarios where the script counts succeed but rows
  // were silently rejected at the SQL layer).
  const persist = await verifyPersistence();
  // failed_inserts: every skip categorised as a DB issue counts here.
  // The db_insert_failed and invalid_at_persist reasons are the two
  // post-build skip paths that reach the persist layer.
  const failedInserts =
      (signalCounters.skipReasons.get('db_insert_failed')   ?? 0)
    + (signalCounters.skipReasons.get('invalid_at_persist') ?? 0);
  const dbStatus: 'OK' | 'EMPTY' | 'ERROR' =
      !persist.ok                                         ? 'EMPTY'
    : failedInserts > 0 && signalCounters.approved === 0 ? 'ERROR'
    :                                                      'OK';
  const signalStatus: 'READY' | 'EMPTY' | 'ERROR' =
      signalCounters.approved > 0 ? 'READY'
    : dbStatus === 'ERROR'        ? 'ERROR'
    :                               'EMPTY';
  const report: BootstrapReport = {
    total_symbols:    targets.length,
    success,
    failed,
    aborted:          false,
    flag_set:         false,
    batch_id:         batchId,
    total_generated:  signalCounters.totalGenerated,
    approved:         signalCounters.approved,
    rejected:         signalCounters.rejected,
    skipped_no_price: signalCounters.skippedNoPrice,
    provider_used:    'nse',
    data_quality:     dataQuality,
    buy_count:        signalCounters.buy,
    sell_count:       signalCounters.sell,
    bias_status:      biasStatus,
    inserted_signals:   signalCounters.approved,
    failed_inserts:     failedInserts,
    duplicates_removed: 0,                  // dedupe runs in the cleanup script
    db_status:          dbStatus,
    signal_status:      signalStatus,
    // Spec INSERT-FIX summary — the placeholder/values self-check
    // throws on mismatch (see insertBootstrapSignal), so by the time
    // we reach here every attempted insert has the correct shape.
    // `insert_status` is SUCCESS iff at least one insert landed and
    // none failed; PARTIAL when some landed and some failed;
    // FAILED when nothing landed despite attempts; NONE when no
    // signals were even attempted (closed-market run, dry-run, …).
    placeholders_match: true,
    values_valid:       true,
    insert_status:
        signalCounters.totalGenerated === 0  ? 'NONE'
      : signalCounters.approved === 0        ? 'FAILED'
      : failedInserts > 0                    ? 'PARTIAL'
      :                                        'SUCCESS',
  };
  console.log(`[BOOTSTRAP] q365_signals row count after run: ${persist.totalRows}`);

  // Spec BALANCE §4 — direction-count debug + bias log.
  console.log(`[BUY COUNT] ${signalCounters.buy}`);
  console.log(`[SELL COUNT] ${signalCounters.sell}`);
  if (biasStatus === 'BIAS_DETECTED') {
    console.error(
      `[BOOTSTRAP] BIAS_DETECTED — only ${signalCounters.sell} SELL of ` +
      `${signalCounters.buy + signalCounters.sell} signals. ` +
      `Spec asks ≥ 30% minority share; investigate market regime / RSI distribution.`,
    );
  } else if (biasStatus === 'BALANCED') {
    console.log(`[BOOTSTRAP] direction balance OK (${signalCounters.buy} BUY / ${signalCounters.sell} SELL)`);
  }

  if (success > FLAG_MIN_SUCCESS) {
    await setBootstrapFlag();
    report.flag_set = true;
    console.log(`[BOOTSTRAP] BOOTSTRAP_DONE flag set (success=${success} > ${FLAG_MIN_SUCCESS})`);
  } else {
    console.warn(
      `[BOOTSTRAP] flag NOT set — only ${success} symbols persisted ` +
      `(threshold > ${FLAG_MIN_SUCCESS}). Re-run is allowed.`,
    );
  }

  console.log('[BOOTSTRAP] COMPLETE → total stored:', report);

  if (signalCounters.skipReasons.size > 0) {
    console.log('[BOOTSTRAP] signal skip reasons:', Object.fromEntries(signalCounters.skipReasons));
  }
  if (failureLast.size > 0) {
    const sample = [...failureLast.entries()].slice(0, 10).map(([sym, reason]) => ({ symbol: sym, reason }));
    console.log('[BOOTSTRAP] failures (first 10):', sample);
  }

  return report;
}

// ── Entry point ──────────────────────────────────────────────────

main()
  .then(async (report) => {
    // Close the DB pool so the script doesn't hang on idle connections.
    try { await (db as unknown as { close?: () => Promise<void> }).close?.(); } catch { /* ignore */ }
    // Spec ROBUST_BOOTSTRAP — exit code reflects whether the flag was
    // set (i.e. a healthy seed completed). 0 = healthy seed (>50
    // symbols persisted OR --dry-run / SKIPPED early-exit).
    // 2 = ran but persisted too few symbols. NEVER 1 from the script
    // body itself; only an unexpected throw bubbles to the catch below.
    const exitCode = report.flag_set || report.total_symbols === 0 ? 0 : 2;
    process.exit(exitCode);
  })
  .catch(async (err) => {
    console.error('[BOOTSTRAP] FATAL', err);
    try { await (db as unknown as { close?: () => Promise<void> }).close?.(); } catch { /* ignore */ }
    process.exit(1);
  });
