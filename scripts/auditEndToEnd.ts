/**
 * scripts/auditEndToEnd.ts
 *
 * Spec INSTITUTIONAL §M — full production-readiness audit. Runs
 * eight layers of checks against the live system, prints a per-layer
 * health table, and emits a final READY / WARNING / CRITICAL verdict.
 *
 *   1. Universe health
 *   2. Realtime candle health
 *   3. Provider health (IndianAPI + NSE)
 *   4. Phase 3 / Phase 4 coverage
 *   5. Approval + maturity pipeline
 *   6. Database persistence
 *   7. API + UI consistency (top 10 signals)
 *   8. Final production verdict
 *
 * Usage:
 *   npx tsx scripts/auditEndToEnd.ts
 *   npx tsx scripts/auditEndToEnd.ts --skip-pipeline   # skip the live Phase 4 invocation
 *   npx tsx scripts/auditEndToEnd.ts --skip-maturity   # skip the maturity worker
 *
 * Exit codes:
 *   0 — READY
 *   1 — WARNING
 *   2 — CRITICAL
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import {
  initOnce, isNifty500Initialized,
  NIFTY500_MIN_SIZE, NIFTY500_MAX_SIZE,
} from '../src/lib/marketData/nifty500Universe';
import { DEFAULT_PHASE1_CONFIG } from '../src/lib/signal-engine/constants/signalEngine.constants';
import { getMarketStatus } from '../src/lib/marketData/marketHours';
import { getApiUsage, INDIANAPI_PER_RUN_LIMIT } from '../src/providers/adapters/IndianAPIAdapter';
import { generatePhase4Signals } from '../src/lib/signal-engine';
import type { CandleProvider, Candle, PortfolioSnapshot } from '../src/lib/signal-engine';
import { runSignalMaturityWorker } from '../src/lib/cron/signalMaturity';
import { getLatestActiveSnapshotBySymbol, getActiveConfirmedSnapshots } from '../src/lib/signal-engine/repository/readConfirmedSnapshots';

// ── Output helpers ─────────────────────────────────────────────

type HealthBand = 'OK' | 'WARN' | 'CRIT';

interface LayerResult {
  name:   string;
  band:   HealthBand;
  detail: Record<string, any>;
  notes:  string[];
}

const RESULTS: LayerResult[] = [];

function logHeader(text: string): void {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ${text}`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

function bandIcon(b: HealthBand): string {
  return b === 'OK' ? '✓' : b === 'WARN' ? '⚠' : '✗';
}

function recordLayer(layer: LayerResult): void {
  RESULTS.push(layer);
  console.log(`\n  ${bandIcon(layer.band)} ${layer.name} — ${layer.band}`);
  for (const [k, v] of Object.entries(layer.detail)) {
    console.log(`     ${String(k).padEnd(34)} ${v}`);
  }
  for (const note of layer.notes) {
    console.log(`     • ${note}`);
  }
}

// ── Layer 1: Universe ──────────────────────────────────────────

async function auditUniverse(): Promise<void> {
  logHeader('LAYER 1 — UNIVERSE HEALTH');

  const pull = async (sql: string): Promise<number> => {
    try {
      const { rows } = await db.query<{ c: number }>(sql);
      return Number(rows[0]?.c ?? 0);
    } catch { return -1; }
  };

  const universeTotal  = await pull(`SELECT COUNT(*) AS c FROM q365_universe`);
  const universeActive = await pull(`SELECT COUNT(*) AS c FROM q365_universe WHERE is_active = 1`);

  let initialized = isNifty500Initialized();
  if (!initialized) {
    try { await initOnce(); initialized = true; } catch { /* ignore */ }
  }
  const finalSize = DEFAULT_PHASE1_CONFIG.universe.length;

  // Placeholder count from the constants — rough proxy: count
  // q365_universe rows whose symbol matches the placeholder regex.
  const placeholderRegex = /^(DUMMY|TEST_|TEMP_|PLACEHOLDER_|XX_)/;
  let placeholdersInDb = 0;
  try {
    const { rows } = await db.query<{ symbol: string }>(
      `SELECT symbol FROM q365_universe WHERE is_active = 1`,
    );
    placeholdersInDb = (rows as any[])
      .filter((r) => placeholderRegex.test(String(r.symbol).toUpperCase()))
      .length;
  } catch { /* ignore */ }

  const detail = {
    universe_total:        universeTotal,
    universe_active:       universeActive,
    final_universe_size:   finalSize,
    placeholders_removed:  placeholdersInDb === 0 ? 'yes' : `no (${placeholdersInDb} found)`,
    universe_initialized:  initialized,
    min_required:          NIFTY500_MIN_SIZE,
    max_allowed:           NIFTY500_MAX_SIZE,
  };
  const notes: string[] = [];
  let band: HealthBand = 'OK';
  if (!initialized) { band = 'CRIT'; notes.push('initOnce() did not complete — check [UNIVERSE_LOAD] logs'); }
  if (finalSize < NIFTY500_MIN_SIZE) { band = 'CRIT'; notes.push(`finalSize ${finalSize} < ${NIFTY500_MIN_SIZE} — re-seed via npx tsx scripts/loadNifty500.ts`); }
  if (universeActive < NIFTY500_MIN_SIZE) { band = 'WARN'; notes.push(`q365_universe(active)=${universeActive} below floor — auto-seed should fire on next boot`); }
  if (placeholdersInDb > 0) { band = band === 'CRIT' ? 'CRIT' : 'WARN'; notes.push(`${placeholdersInDb} placeholder symbols still active — clean up q365_universe`); }
  recordLayer({ name: 'UNIVERSE HEALTH', band, detail, notes });
}

// ── Layer 2: Realtime candles ──────────────────────────────────

async function auditRealtimeCandles(): Promise<void> {
  logHeader('LAYER 2 — REALTIME CANDLE HEALTH');
  const universe = DEFAULT_PHASE1_CONFIG.universe;
  if (universe.length === 0) {
    recordLayer({
      name: 'REALTIME CANDLE HEALTH', band: 'CRIT',
      detail: { reason: 'universe empty' }, notes: ['Universe not loaded — see Layer 1.'],
    });
    return;
  }
  const market = getMarketStatus();

  const placeholders = universe.map(() => '?').join(',');
  let coverage: any = null;
  try {
    const { rows } = await db.query<{
      sym: number; latest: any; oldest: any;
      fresh_5: number; fresh_10: number; fresh_30: number; fresh_60: number;
    }>(
      `SELECT COUNT(DISTINCT symbol) AS sym,
              MAX(ts) AS latest, MIN(ts) AS oldest,
              SUM(CASE WHEN updated_at >= DATE_SUB(NOW(), INTERVAL 5  MINUTE) THEN 1 ELSE 0 END) AS fresh_5,
              SUM(CASE WHEN updated_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE) THEN 1 ELSE 0 END) AS fresh_10,
              SUM(CASE WHEN updated_at >= DATE_SUB(NOW(), INTERVAL 30 MINUTE) THEN 1 ELSE 0 END) AS fresh_30,
              SUM(CASE WHEN updated_at >= DATE_SUB(NOW(), INTERVAL 60 MINUTE) THEN 1 ELSE 0 END) AS fresh_60
         FROM market_data_daily
        WHERE symbol IN (${placeholders})`,
      universe.map((s) => s.toUpperCase()),
    );
    coverage = rows[0] ?? null;
  } catch { /* ignore */ }

  const sym       = Number(coverage?.sym ?? 0);
  const latestTs  = coverage?.latest ?? null;
  const ageMin    = latestTs != null
    ? Math.round((Date.now() - new Date(latestTs).getTime()) / 60_000)
    : null;
  const fresh5    = Number(coverage?.fresh_5  ?? 0);
  const fresh10   = Number(coverage?.fresh_10 ?? 0);
  const fresh30   = Number(coverage?.fresh_30 ?? 0);
  const effectiveCoverage = Math.round((sym / universe.length) * 1000) / 10;

  const detail = {
    market_state:                  market.state,
    market_open:                   market.isOpen,
    universe_size:                 universe.length,
    distinct_symbols_with_bars:    sym,
    effective_coverage_percent:    `${effectiveCoverage}%`,
    latest_bar_ts:                 latestTs ?? '(none)',
    latest_bar_age_minutes:        ageMin ?? 'n/a',
    bars_within_5min:              `${fresh5}/${universe.length}`,
    bars_within_10min:             `${fresh10}/${universe.length}`,
    bars_within_30min:             `${fresh30}/${universe.length}`,
  };
  const notes: string[] = [];
  let band: HealthBand = 'OK';
  if (effectiveCoverage < 50) { band = 'CRIT'; notes.push('effective coverage < 50% — run candle ingestion (POST /api/run-signal-engine?force=true)'); }
  else if (effectiveCoverage < 95) { band = 'WARN'; notes.push(`coverage ${effectiveCoverage}% < 95% — wait for round-robin to complete (15min during market open)`); }
  if (market.isOpen) {
    if (ageMin != null && ageMin > 10) { band = 'CRIT'; notes.push(`live age ${ageMin}min > 10min — refresh scheduler stalled`); }
    else if (ageMin != null && ageMin > 5) { band = band === 'CRIT' ? 'CRIT' : 'WARN'; notes.push(`live age ${ageMin}min > 5min target — tighten LIVE_REFRESH_INTERVAL_OPEN_MS`); }
    if (fresh10 < universe.length * 0.5) { band = band === 'CRIT' ? 'CRIT' : 'WARN'; notes.push(`only ${fresh10}/${universe.length} bars within 10min — priority queue draining slowly`); }
  } else {
    if (ageMin != null && ageMin > 24 * 60) { band = band === 'CRIT' ? 'CRIT' : 'WARN'; notes.push(`closed-market age ${ageMin}min > 24h — cold-start overdue`); }
  }
  recordLayer({ name: 'REALTIME CANDLE HEALTH', band, detail, notes });
}

// ── Layer 3: Provider health ───────────────────────────────────

async function auditProvider(): Promise<void> {
  logHeader('LAYER 3 — PROVIDER HEALTH');
  const usage = getApiUsage();
  let indianApiSuccess = 0, indianApiFail = 0, nseSuccess = 0, nseFail = 0;
  let totalRequested = 0, totalReturned = 0;
  try {
    const { rows } = await db.query<{
      provider: string; status: string;
      reqs: number; rets: number;
    }>(
      `SELECT provider, status,
              SUM(symbols_requested) AS reqs,
              SUM(symbols_returned)  AS rets
         FROM q365_data_feed_health
        WHERE response_received_at > DATE_SUB(NOW(), INTERVAL 60 MINUTE)
        GROUP BY provider, status`,
    );
    for (const r of (rows as any[])) {
      const prov = String(r.provider ?? '').toLowerCase();
      const ok = String(r.status ?? '').toLowerCase() === 'success' || String(r.status).toLowerCase() === 'partial';
      const reqs = Number(r.reqs ?? 0);
      const rets = Number(r.rets ?? 0);
      totalRequested += reqs;
      totalReturned  += rets;
      if (prov.includes('indianapi'))   { if (ok) indianApiSuccess += reqs; else indianApiFail += reqs; }
      else if (prov.includes('nse'))    { if (ok) nseSuccess       += reqs; else nseFail       += reqs; }
    }
  } catch { /* table may not exist on fresh deploy */ }

  const totalIndian = indianApiSuccess + indianApiFail;
  const totalNse    = nseSuccess + nseFail;
  const totalAll    = totalIndian + totalNse;
  const providerCoverage = totalRequested > 0
    ? Math.round((totalReturned / totalRequested) * 1000) / 10
    : 0;
  // Throttle band — replicate the run-signal-engine band ladder.
  const dailyPct = usage.daily_percent;
  const band =
    dailyPct >= 95 ? 'critical' :
    dailyPct >= 80 ? 'throttle' :
    dailyPct >= 60 ? 'warn'     : 'normal';

  // Project monthly from last-60min daily-rate extrapolation.
  // A realistic projection is daily * 22 trading days.
  const projectedMonthly = usage.daily * 22;

  const detail = {
    indianapi_success:           indianApiSuccess,
    indianapi_failures:          indianApiFail,
    nse_fallback_hits:           totalNse,
    provider_coverage_percent:   `${providerCoverage}%`,
    throttle_band:               band,
    estimated_daily_usage:       `${usage.daily}/${usage.daily_limit} (${usage.daily_percent}%)`,
    estimated_monthly_usage:     `${usage.monthly}/${usage.monthly_limit} (${usage.monthly_percent}%)`,
    monthly_projection_22d:      projectedMonthly,
    per_run_limit:               INDIANAPI_PER_RUN_LIMIT,
    per_run_active:              usage.per_run_active,
    requested_60min:             totalRequested,
    fetched_60min:               totalReturned,
  };
  const notes: string[] = [];
  let healthBand: HealthBand = 'OK';
  if (usage.daily_exceeded || usage.monthly_exceeded) { healthBand = 'CRIT'; notes.push('budget exceeded — pipeline will refuse upstream calls'); }
  else if (band === 'critical') { healthBand = 'CRIT'; notes.push('daily usage > 95% — cap auto-shrinking, expect partial coverage'); }
  else if (band === 'throttle' || band === 'warn') { healthBand = 'WARN'; notes.push(`daily usage ${dailyPct}% — auto-throttle band=${band}`); }
  if (projectedMonthly > usage.monthly_limit) { healthBand = healthBand === 'CRIT' ? 'CRIT' : 'WARN'; notes.push(`projected monthly ${projectedMonthly} > limit ${usage.monthly_limit}`); }
  if (totalAll > 0 && totalNse / totalAll > 0.3) { healthBand = healthBand === 'CRIT' ? 'CRIT' : 'WARN'; notes.push(`NSE fallback hits ${Math.round(totalNse / totalAll * 100)}% of provider calls — IndianAPI unhealthy`); }
  if (totalIndian === 0 && totalNse === 0) {
    notes.push('no provider activity in last 60min (off-hours OR scheduler not running)');
    if (getMarketStatus().isOpen) { healthBand = 'WARN'; }
  }
  recordLayer({ name: 'PROVIDER HEALTH', band: healthBand, detail, notes });
}

// ── Layer 4: Phase 3 / Phase 4 coverage ────────────────────────

const STUB_PORTFOLIO: PortfolioSnapshot = {
  capital: 1_000_000, cashAvailable: 1_000_000,
  openPositions: [], pendingSignals: [],
};

const dbCandleProvider: CandleProvider = {
  async fetchDailyCandles(symbol: string): Promise<Candle[]> {
    try {
      const { rows } = await db.query<any>(
        `SELECT ts, open, high, low, close, volume
           FROM market_data_daily WHERE symbol = ?
           ORDER BY ts DESC LIMIT 250`,
        [symbol.toUpperCase()],
      );
      return ((rows as any[]) ?? [])
        .reverse()
        .map((r) => ({
          ts: r.ts instanceof Date ? r.ts.toISOString() : String(r.ts),
          open: Number(r.open), high: Number(r.high),
          low: Number(r.low),  close: Number(r.close),
          volume: Number(r.volume ?? 0),
        })) as Candle[];
    } catch { return []; }
  },
};

let phase4Result: any = null;

async function auditPhase34Coverage(skip: boolean): Promise<void> {
  logHeader('LAYER 4 — PHASE 3 / PHASE 4 COVERAGE');
  const universeSize = DEFAULT_PHASE1_CONFIG.universe.length;
  if (skip) {
    recordLayer({
      name: 'PHASE 3 / PHASE 4 COVERAGE', band: 'WARN',
      detail: { skipped: true, universe_size: universeSize },
      notes: ['Pipeline invocation skipped (--skip-pipeline). Run without flag for live data.'],
    });
    return;
  }
  console.log('  invoking generatePhase4Signals — watch [PHASE3_RECEIVED] / [PHASE3_COMPLETE] / [SCAN_FUNNEL]\n');
  const t0 = Date.now();
  try {
    phase4Result = await generatePhase4Signals(
      dbCandleProvider, STUB_PORTFOLIO,
      undefined, undefined, DEFAULT_PHASE1_CONFIG, undefined,
      { generationSource: 'script:auditEndToEnd' },
    );
  } catch (err: any) {
    recordLayer({
      name: 'PHASE 3 / PHASE 4 COVERAGE', band: 'CRIT',
      detail: { error: err?.message },
      notes: ['generatePhase4Signals threw — see stack trace above.'],
    });
    return;
  }
  const elapsedMs = Date.now() - t0;
  const scanned   = Number(phase4Result.meta.scanned ?? 0);
  const matched   = Number(phase4Result.signals.length ?? 0);
  const approved  = Number(phase4Result.meta.approved ?? 0);
  const deferred  = Number(phase4Result.meta.deferred ?? 0);
  const rejected  = Number(phase4Result.meta.rejected ?? 0);
  const coverage  = universeSize > 0 ? Math.round((scanned / universeSize) * 1000) / 10 : 0;

  const detail = {
    universe_size:           universeSize,
    received_by_phase3:      scanned,
    scanned:                 scanned,
    matched:                 matched,
    approved:                approved,
    deferred:                deferred,
    rejected:                rejected,
    coverage_percent:        `${coverage}%`,
    elapsed_ms:              elapsedMs,
  };
  const notes: string[] = [];
  let band: HealthBand = 'OK';
  if (coverage < 50)        { band = 'CRIT'; notes.push(`coverage ${coverage}% < 50% — universe truncated or candles missing`); }
  else if (coverage < 95)   { band = 'WARN'; notes.push(`coverage ${coverage}% < 95% target`); }
  if (matched === 0)        { band = 'CRIT'; notes.push('matched=0 — every Phase 3 candidate rejected; check [STRATEGY] Phase3 rejection summary'); }
  if (approved === 0 && matched > 0) { band = band === 'CRIT' ? 'CRIT' : 'WARN'; notes.push(`approved=0 from ${matched} matches — see [APPROVAL_GATE] for dominant gate`); }
  recordLayer({ name: 'PHASE 3 / PHASE 4 COVERAGE', band, detail, notes });
}

// ── Layer 5: Approval + maturity ───────────────────────────────

async function auditApprovalMaturity(skip: boolean): Promise<void> {
  logHeader('LAYER 5 — APPROVAL + MATURITY PIPELINE');

  const bands = new Map<string, number>();
  if (phase4Result) {
    for (const s of phase4Result.signals as any[]) {
      const cls = String(s.classification ?? 'UNKNOWN');
      bands.set(cls, (bands.get(cls) ?? 0) + 1);
    }
  }
  const get = (k: string) => bands.get(k) ?? 0;

  let maturity: any = null;
  if (!skip) {
    console.log('  invoking runSignalMaturityWorker — watch [DATA_QUALITY] / [FRESHNESS_GATE] / [PROMOTION_BLOCK] / [FINAL_APPROVAL]\n');
    try {
      maturity = await runSignalMaturityWorker();
    } catch (err: any) {
      recordLayer({
        name: 'APPROVAL + MATURITY PIPELINE', band: 'CRIT',
        detail: { error: err?.message },
        notes: ['runSignalMaturityWorker threw'],
      });
      return;
    }
  }

  // Probe live confirmed-snapshot count.
  let confirmedActive = -1;
  try {
    const { rows } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_confirmed_signal_snapshots
        WHERE status='ACTIVE' AND valid_until > NOW()`,
    );
    confirmedActive = Number(rows[0]?.c ?? 0);
  } catch { /* ignore */ }

  const detail = {
    approved:                phase4Result?.meta.approved ?? 'n/a',
    institutional_high:      get('INSTITUTIONAL_HIGH_CONVICTION'),
    high_conviction:         get('HIGH_CONVICTION'),
    valid_signal:            get('VALID_SIGNAL'),
    developing_setup:        get('DEVELOPING_SETUP'),
    watchlist_only:          get('WATCHLIST_ONLY'),
    no_trade:                get('NO_TRADE'),
    promoted_this_cycle:     maturity?.promoted ?? 'skipped',
    matured_no_promote:      maturity?.matured  ?? 'skipped',
    developing:              maturity?.developing ?? 'skipped',
    candidate:               maturity?.candidate ?? 'skipped',
    regime_blocked:          maturity?.regime_blocked ?? 'skipped',
    failed:                  maturity?.failed ?? 'skipped',
    confirmed_snapshots_active: confirmedActive,
  };
  const notes: string[] = [];
  // Track band explicitly via a cast — TS narrows away 'CRIT' after
  // each WARN-only assignment otherwise.
  const setBand = (current: HealthBand, next: HealthBand): HealthBand =>
    current === 'CRIT' ? 'CRIT' : (next === 'CRIT' ? 'CRIT' : (next === 'WARN' ? 'WARN' : current));
  let band: HealthBand = 'OK';
  const approved = Number(phase4Result?.meta.approved ?? 0);
  const promoted = Number(maturity?.promoted ?? 0);
  if (approved < 5)  { band = setBand(band, 'WARN'); notes.push(`approved ${approved} < 5 target`); }
  if (confirmedActive >= 0 && confirmedActive < 3) {
    band = setBand(band, 'WARN');
    notes.push(`active confirmed snapshots ${confirmedActive} < 3 target`);
  }
  if (maturity && maturity.scanned > 0 && promoted === 0) {
    band = setBand(band, 'WARN');
    notes.push(`maturity worker promoted 0 of ${maturity.scanned} trackers — see [PERSIST_FAILED] / [PROMOTION_BLOCK]`);
  }
  if ((get('HIGH_CONVICTION') + get('INSTITUTIONAL_HIGH_CONVICTION')) === 0 && (phase4Result?.signals.length ?? 0) > 50) {
    band = setBand(band, 'WARN');
    notes.push('zero HIGH_CONVICTION rows — check [PHASE4_FACTORS] for the dragging factor');
  }
  recordLayer({ name: 'APPROVAL + MATURITY PIPELINE', band, detail, notes });
}

// ── Layer 6: Database persistence ──────────────────────────────

async function auditPersistence(): Promise<void> {
  logHeader('LAYER 6 — DATABASE PERSISTENCE');

  const pull = async (sql: string): Promise<any> => {
    try {
      const { rows } = await db.query<any>(sql);
      return rows[0] ?? null;
    } catch { return null; }
  };

  const sigStats   = await pull(
    `SELECT COUNT(*) AS c, MAX(generated_at) AS latest
       FROM q365_signals
      WHERE generated_at > DATE_SUB(NOW(), INTERVAL 60 MINUTE)`,
  );
  const snapStats  = await pull(
    `SELECT COUNT(*) AS c, MAX(confirmed_at) AS latest
       FROM q365_confirmed_signal_snapshots
      WHERE confirmed_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
  );
  const batchStats = await pull(
    `SELECT batch_id, MAX(generated_at) AS latest
       FROM q365_signals
      WHERE batch_id IS NOT NULL
      ORDER BY latest DESC LIMIT 1`,
  );

  const detail = {
    q365_signals_last_hour:        sigStats?.c ?? 'n/a',
    latest_generated_at:           sigStats?.latest ?? '(none)',
    confirmed_snapshots_last_24h:  snapStats?.c ?? 'n/a',
    latest_snapshot_at:            snapStats?.latest ?? '(none)',
    latest_batch_id:               batchStats?.batch_id ?? '(none)',
  };
  const notes: string[] = [];
  let band: HealthBand = 'OK';
  const sigCount = Number(sigStats?.c ?? 0);
  if (sigCount === 0) {
    band = 'CRIT';
    notes.push('zero q365_signals in last hour — pipeline not persisting');
  } else if (sigCount < 10) {
    band = 'WARN';
    notes.push(`${sigCount} q365_signals in last hour — low throughput`);
  }
  const sigLatest = sigStats?.latest ? new Date(sigStats.latest).getTime() : 0;
  if (sigLatest > 0 && Date.now() - sigLatest > 30 * 60_000 && getMarketStatus().isOpen) {
    band = band === 'CRIT' ? 'CRIT' : 'WARN';
    notes.push('latest q365_signals row > 30min old during market hours');
  }
  recordLayer({ name: 'DATABASE PERSISTENCE', band, detail, notes });
}

// ── Layer 7: API + UI consistency ──────────────────────────────

async function auditConsistency(): Promise<void> {
  logHeader('LAYER 7 — API + UI CONSISTENCY (top 10 confirmed snapshots)');

  let activeSnapshots: any[] = [];
  try {
    activeSnapshots = await getActiveConfirmedSnapshots({ limit: 10 });
  } catch (err: any) {
    recordLayer({
      name: 'API + UI CONSISTENCY', band: 'WARN',
      detail: { error: err?.message },
      notes: ['Could not load active snapshots (table may be empty).'],
    });
    return;
  }
  const mismatched: string[] = [];
  const rejectedInDetail: string[] = [];
  const invalidatedLive: string[] = [];

  for (const row of activeSnapshots) {
    const sym = row.symbol ?? row.tradingsymbol;
    if (!sym) continue;
    try {
      const detail = await getLatestActiveSnapshotBySymbol(sym);
      if (!detail) {
        rejectedInDetail.push(sym);
        continue;
      }
      if (detail.direction !== row.direction) {
        mismatched.push(`${sym} (table=${row.direction} detail=${detail.direction})`);
      }
      if (detail.execution_allowed === false || row.execution_allowed === false) {
        invalidatedLive.push(sym);
      }
    } catch (err: any) {
      mismatched.push(`${sym} (err: ${err?.message})`);
    }
  }

  const passed = mismatched.length === 0 && rejectedInDetail.length === 0;
  const detail = {
    snapshots_checked:   activeSnapshots.length,
    mismatched_symbols:  mismatched.length === 0 ? 'none' : mismatched.join(', '),
    rejected_in_detail:  rejectedInDetail.length === 0 ? 'none' : rejectedInDetail.join(', '),
    invalidated_live:    invalidatedLive.length === 0 ? 'none' : invalidatedLive.join(', '),
    consistency_passed:  passed,
  };
  const notes: string[] = [];
  let band: HealthBand = passed ? 'OK' : 'WARN';
  if (activeSnapshots.length === 0) {
    band = 'WARN';
    notes.push('no active confirmed snapshots to consistency-check');
  }
  if (mismatched.length > 0) {
    band = 'CRIT';
    notes.push('main-table direction differs from detail-page row — stockDetailService may be reading the wrong layer');
  }
  recordLayer({ name: 'API + UI CONSISTENCY', band, detail, notes });
}

// ── Layer 8: Final verdict ─────────────────────────────────────

function finalVerdict(): { score: HealthBand; exit: number } {
  const counts = { OK: 0, WARN: 0, CRIT: 0 };
  for (const r of RESULTS) counts[r.band]++;
  let score: HealthBand = 'OK';
  if (counts.CRIT > 0) score = 'CRIT';
  else if (counts.WARN > 0) score = 'WARN';

  logHeader('LAYER 8 — FINAL PRODUCTION VERDICT');
  console.log('\n  HEALTH SCORE BY LAYER');
  console.log('  ──────────────────────────────────────────────────────────');
  for (const r of RESULTS) {
    console.log(`   ${bandIcon(r.band).padEnd(2)} ${r.name.padEnd(40)} ${r.band}`);
  }
  console.log('  ──────────────────────────────────────────────────────────');
  console.log(`   OK=${counts.OK} WARN=${counts.WARN} CRIT=${counts.CRIT}`);
  console.log('');

  const verdict =
    score === 'OK'   ? 'READY'    :
    score === 'WARN' ? 'WARNING'  : 'CRITICAL';
  console.log(`  ▶ FINAL VERDICT: ${verdict}`);
  console.log('');

  // Aggregate notes / recommendations
  console.log('  REMAINING BOTTLENECKS / TUNING RECOMMENDATIONS');
  console.log('  ──────────────────────────────────────────────────────────');
  let any = false;
  for (const r of RESULTS) {
    if (r.notes.length === 0) continue;
    any = true;
    console.log(`   [${r.name}]`);
    for (const note of r.notes) console.log(`     • ${note}`);
  }
  if (!any) console.log('   (none — system is healthy)');
  console.log('');

  // Production estimates derived from the per-layer numbers.
  const realtime = RESULTS.find((r) => r.name === 'REALTIME CANDLE HEALTH');
  const phase    = RESULTS.find((r) => r.name === 'PHASE 3 / PHASE 4 COVERAGE');
  const approval = RESULTS.find((r) => r.name === 'APPROVAL + MATURITY PIPELINE');
  console.log('  PRODUCTION ESTIMATES');
  console.log('  ──────────────────────────────────────────────────────────');
  console.log(`   estimated_realtime_freshness:        ${realtime?.detail?.latest_bar_age_minutes ?? 'n/a'} min`);
  console.log(`   expected_approved_signals_session:   ${approval?.detail?.approved ?? 'n/a'}`);
  console.log(`   expected_confirmed_snapshots_session:${approval?.detail?.confirmed_snapshots_active ?? 'n/a'}`);
  console.log(`   coverage_this_run:                   ${phase?.detail?.coverage_percent ?? 'n/a'}`);
  console.log('');

  return {
    score,
    exit: score === 'OK' ? 0 : score === 'WARN' ? 1 : 2,
  };
}

// ── Main ───────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const skipPipeline = argv.includes('--skip-pipeline');
  const skipMaturity = argv.includes('--skip-maturity');

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  END-TO-END INSTITUTIONAL ENGINE AUDIT');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await auditUniverse();
  await auditRealtimeCandles();
  await auditProvider();
  await auditPhase34Coverage(skipPipeline);
  await auditApprovalMaturity(skipMaturity);
  await auditPersistence();
  await auditConsistency();

  const { exit } = finalVerdict();
  process.exit(exit);
}

main().catch((err) => {
  console.error('end-to-end audit failed:', err);
  process.exit(2);
});
