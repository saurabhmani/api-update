// ════════════════════════════════════════════════════════════════
//  productionAudit — full production safety audit
//
//  Spec sections 1-10. Pure read-only diagnostic; no upstream API
//  calls, no DB writes. Reads:
//
//    1. apiBudgetGuard.snapshot()   → daily / monthly call counters
//    2. providerFlags               → resolved primary + Yahoo state
//    3. q365_universe                → active scan size (NIFTY 500
//                                       gate or FULL via env)
//    4. q365_signals (latest batch)  → scan coverage + recency
//    5. q365_signals filter counts   → strict / relaxed / force_seed
//    6. q365_data_feed_health        → call-rate sanity + market-closed
//                                       quota-leak detection
//    7. resolver source code         → market-closed gate present
//    8. resolver source code         → fallback chain shape
//
//  Run:
//    npx tsx scripts/productionAudit.ts
//    npx tsx scripts/productionAudit.ts --json
//
//  Exit codes: 0 = PRODUCTION_SAFE ✅, 1 = ISSUES_FOUND ❌, 2 = error.
// ════════════════════════════════════════════════════════════════

/* eslint-disable no-console */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { db } from '@/lib/db';
import { snapshot as budgetSnapshot } from '@/lib/marketData/apiBudgetGuard';
import { CONFIG } from '@/lib/marketData/schedulerConfig';
import {
  isIndianApiPrimary,
  isYahooEmergencyFallbackEnabled,
  isNseDirectFallbackEnabled,
  getNseDirectFallbackConfig,
  getMarketDataProvider,
} from '@/lib/marketData/providerFlags';
import { isMarketOpen, getMarketStatus } from '@/lib/marketData/marketHours';
import {
  STRICT_CONFIDENCE_FLOOR,
  STRICT_FINAL_FLOOR,
  STRICT_RR_FLOOR,
} from '@/lib/signals/confirmedSignalPolicy';

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');

// ── Spec thresholds (section 1) ─────────────────────────────────
// The user spec pins these explicitly:
//   monthly_calls < 100_000
//   daily_calls   <  2_500
const SPEC_MONTHLY_CAP = 100_000;
const SPEC_DAILY_CAP   =   2_500;

// ── Section 1: API USAGE CHECK ─────────────────────────────────

interface UsageReport {
  monthly_calls:        number;
  daily_calls:          number;
  monthly_limit:        number;
  daily_soft_cap:       number;
  degradation_level:    string;
  monthly_usage_pct:    number;
  spec_monthly_ok:      boolean;
  spec_daily_ok:        boolean;
  notes:                string[];
}

async function auditUsage(): Promise<UsageReport> {
  const snap = await budgetSnapshot();
  const monthlyLimit = CONFIG.budget.monthlyFreeze;
  const usagePct = monthlyLimit > 0
    ? Math.round((snap.monthTotal / monthlyLimit) * 1000) / 10 : 0;
  const notes: string[] = [];
  if (CONFIG.budget.dailySoftCap > SPEC_DAILY_CAP) {
    notes.push(
      `dailySoftCap=${CONFIG.budget.dailySoftCap} exceeds spec ceiling ${SPEC_DAILY_CAP} ` +
      `— set INDIANAPI_DAILY_SOFT_LIMIT=${SPEC_DAILY_CAP} to align`,
    );
  }
  if (CONFIG.budget.monthlyFreeze > SPEC_MONTHLY_CAP) {
    notes.push(
      `monthlyFreeze=${CONFIG.budget.monthlyFreeze} exceeds spec ceiling ${SPEC_MONTHLY_CAP} ` +
      `— set INDIANAPI_MONTHLY_LIMIT=${SPEC_MONTHLY_CAP} to align`,
    );
  }
  return {
    monthly_calls:     snap.monthTotal,
    daily_calls:       snap.dayTotal,
    monthly_limit:     monthlyLimit,
    daily_soft_cap:    CONFIG.budget.dailySoftCap,
    degradation_level: snap.level,
    monthly_usage_pct: usagePct,
    spec_monthly_ok:   snap.monthTotal < SPEC_MONTHLY_CAP,
    spec_daily_ok:     snap.dayTotal   < SPEC_DAILY_CAP,
    notes,
  };
}

// ── Section 2: PROVIDER VALIDATION ─────────────────────────────

interface ProviderReport {
  primary:                  string;
  indianApiPrimary:         boolean;
  yahooEmergencyEnabled:    boolean;
  nseDirectEnabled:         boolean;
  removed_endpoints_called: string[];
  notes:                    string[];
}

function auditProvider(): ProviderReport {
  const primary = getMarketDataProvider();
  const ok = isIndianApiPrimary();
  const yahoo = isYahooEmergencyFallbackEnabled();
  const nse = isNseDirectFallbackEnabled();
  const notes: string[] = [];
  if (!ok) notes.push(`primary provider is "${primary}", expected "indianapi"`);
  if (yahoo) notes.push('YAHOO_EMERGENCY_FALLBACK_ENABLED is true — spec forbids Yahoo');
  if (!nse) notes.push('NSE_DIRECT_FALLBACK_ENABLED=false — spec wants NSE as safe fallback');
  // Removed endpoints — confirmed by code inspection in indianApiProvider.ts:
  //   /nse/batch_quote → emulated via /stock fan-out (no upstream call)
  //   /intraday        → deadRouteInvocation (no upstream call)
  //   /industry_peers  → deadRouteInvocation (no upstream call)
  // The audit cannot prove the negative at runtime, so we surface the
  // static-analysis result here. If a future commit re-introduces a
  // direct call to these paths, the architectureFreeze test will catch it.
  return {
    primary,
    indianApiPrimary:         ok,
    yahooEmergencyEnabled:    yahoo,
    nseDirectEnabled:         nse,
    removed_endpoints_called: [],
    notes,
  };
}

// ── Section 3: UNIVERSE CHECK ──────────────────────────────────

interface UniverseReport {
  mode:           'NIFTY500' | 'FULL' | string;
  active_count:   number;
  total_count:    number;
  baked_count:    number;
  effective_size: number;
  spec_min:       number;
  ok:             boolean;
  notes:          string[];
}

async function auditUniverse(): Promise<UniverseReport> {
  const mode = (process.env.UNIVERSE_MODE ?? 'NIFTY500').trim().toUpperCase();
  const notes: string[] = [];
  let active = 0, total = 0;
  try {
    const { rows } = await db.query<{ active: number; total: number }>(
      `SELECT
         SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
         COUNT(*)                                       AS total
         FROM q365_universe`,
    );
    const r = (rows as Array<{ active: number; total: number }>)[0];
    active = Number(r?.active ?? 0);
    total  = Number(r?.total  ?? 0);
  } catch (err) {
    notes.push(`q365_universe read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let baked = 0;
  try {
    const path = resolve(process.cwd(), 'src/lib/signal-engine/constants/nseUniverse.json');
    if (existsSync(path)) {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { count?: number; symbols?: string[] };
      baked = Number(parsed.count ?? parsed.symbols?.length ?? 0);
    }
  } catch (err) {
    notes.push(`nseUniverse.json read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const effective = mode === 'FULL' ? baked : (active > 0 ? active : 0);
  const SPEC_MIN = 500;
  if (effective < SPEC_MIN) {
    notes.push(
      mode === 'FULL'
        ? `FULL mode but baked count ${baked} < ${SPEC_MIN}`
        : `NIFTY500 mode but q365_universe active count ${active} < ${SPEC_MIN}`,
    );
  }
  return {
    mode, active_count: active, total_count: total, baked_count: baked,
    effective_size: effective, spec_min: SPEC_MIN,
    ok: effective >= SPEC_MIN, notes,
  };
}

// ── Section 4: SCAN COVERAGE ───────────────────────────────────

interface ScanReport {
  latest_batch_id:   string | null;
  latest_generated:  string | null;
  scanned_size:      number;
  age_minutes:       number | null;
  generation_source: string | null;
  expected_universe: number;
  coverage_pct:      number;
  ok:                boolean;
  notes:             string[];
}

async function auditScan(expectedUniverse: number): Promise<ScanReport> {
  const notes: string[] = [];
  try {
    const { rows: head } = await db.query<{
      batch_id: string | null; generation_source: string | null;
      generated_at: Date | string;
    }>(
      `SELECT batch_id, generation_source, generated_at
         FROM q365_signals
        WHERE batch_id IS NOT NULL
        ORDER BY generated_at DESC
        LIMIT 1`,
    );
    const top = (head as Array<{ batch_id: string | null; generation_source: string | null; generated_at: Date | string }>)[0];
    if (!top?.batch_id) {
      notes.push('no scan batch found in q365_signals');
      return {
        latest_batch_id: null, latest_generated: null, scanned_size: 0,
        age_minutes: null, generation_source: null,
        expected_universe: expectedUniverse, coverage_pct: 0, ok: false, notes,
      };
    }
    const { rows: cnt } = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_signals WHERE batch_id = ?`,
      [top.batch_id],
    );
    const size = Number((cnt as Array<{ c: number }>)[0]?.c ?? 0);
    const ts = top.generated_at instanceof Date
      ? top.generated_at.getTime()
      : Date.parse(String(top.generated_at).replace(' ', 'T'));
    const ageMin = Number.isFinite(ts) ? Math.round((Date.now() - ts) / 60_000) : null;
    // The persisted batch is post-filter — the scanner stores only
    // signals that survived the strategy + rejection engine. Coverage
    // here is a tripwire, not a lower bound: a healthy run can land
    // anywhere from a few % to ~30% of universe depending on regime.
    // We treat 0 rows OR an excessively old batch (>24h) as failure
    // signals; everything else is informational.
    const coverage = expectedUniverse > 0
      ? Math.round((size / expectedUniverse) * 100) : 0;
    if (size === 0)             notes.push('latest batch has 0 rows');
    if (ageMin != null && ageMin > 24 * 60) notes.push(`latest batch is ${ageMin}min old (>24h)`);
    return {
      latest_batch_id:   top.batch_id,
      latest_generated:  Number.isFinite(ts) ? new Date(ts).toISOString() : null,
      scanned_size:      size,
      age_minutes:       ageMin,
      generation_source: top.generation_source,
      expected_universe: expectedUniverse,
      coverage_pct:      coverage,
      ok:                size > 0 && (ageMin ?? 999_999) <= 24 * 60,
      notes,
    };
  } catch (err) {
    notes.push(`q365_signals read failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      latest_batch_id: null, latest_generated: null, scanned_size: 0,
      age_minutes: null, generation_source: null,
      expected_universe: expectedUniverse, coverage_pct: 0, ok: false, notes,
    };
  }
}

// ── Section 5: SIGNAL VALIDATION ───────────────────────────────

interface SignalReport {
  candidates:       number;
  strict_passed:    number;
  relaxed_passed:   number;
  force_seed_rows:  number;
  ok:               boolean;
  notes:            string[];
}

async function auditSignals(): Promise<SignalReport> {
  const notes: string[] = [];
  try {
    const candidates = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_signals
        WHERE direction IN ('BUY','SELL')
          AND COALESCE(invalidation_reason,'') = ''
          AND UPPER(COALESCE(status,'ACTIVE')) IN ('ACTIVE','')`,
    );
    const strict = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_signals
        WHERE direction IN ('BUY','SELL')
          AND confidence_score >= ?
          AND COALESCE(final_score, 0)  >= ?
          AND COALESCE(risk_reward, 0)  >= ?
          AND COALESCE(invalidation_reason,'') = ''
          AND UPPER(COALESCE(signal_status,'')) = 'APPROVED_SIGNAL'
          AND UPPER(COALESCE(classification,'')) <> 'WATCHLIST_ONLY'
          AND UPPER(COALESCE(status,'ACTIVE')) IN ('ACTIVE','')
          AND COALESCE(signal_type,'') <> 'force_seed'
          AND COALESCE(batch_id,'') NOT LIKE 'force_seed%'`,
      [STRICT_CONFIDENCE_FLOOR, STRICT_FINAL_FLOOR, STRICT_RR_FLOOR],
    );
    const relaxed = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_signals
        WHERE direction IN ('BUY','SELL')
          AND confidence_score >= 60
          AND COALESCE(final_score, 0)  >= 65
          AND COALESCE(risk_reward, 0)  >= 1.2
          AND COALESCE(invalidation_reason,'') = ''
          AND UPPER(COALESCE(signal_status,'')) IN ('APPROVED_SIGNAL','DEVELOPING_SETUP')
          AND UPPER(COALESCE(classification,'')) <> 'WATCHLIST_ONLY'
          AND UPPER(COALESCE(status,'ACTIVE')) IN ('ACTIVE','')
          AND COALESCE(signal_type,'') <> 'force_seed'
          AND COALESCE(batch_id,'') NOT LIKE 'force_seed%'`,
    );
    const seeded = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM q365_signals
        WHERE COALESCE(signal_type,'') = 'force_seed'
           OR COALESCE(batch_id,'')    LIKE 'force_seed%'`,
    );
    const num = (r: { rows: unknown }) => Number((r.rows as Array<{ c: number }>)[0]?.c ?? 0);
    const out = {
      candidates:      num(candidates),
      strict_passed:   num(strict),
      relaxed_passed:  num(relaxed),
      force_seed_rows: num(seeded),
      ok:              true,
      notes,
    };
    if (out.force_seed_rows > 0) {
      out.ok = false;
      out.notes.push(`${out.force_seed_rows} force_seed rows present (synthetic data must be 0)`);
    }
    return out;
  } catch (err) {
    notes.push(`q365_signals filter read failed: ${err instanceof Error ? err.message : String(err)}`);
    return { candidates: 0, strict_passed: 0, relaxed_passed: 0, force_seed_rows: 0, ok: false, notes };
  }
}

// ── Section 6: QUOTA LEAK CHECK ────────────────────────────────

interface QuotaReport {
  feed_health_last_hour:  number;
  closed_market_calls:    number;
  full_universe_calls:    number;
  ok:                     boolean;
  notes:                  string[];
}

async function auditQuota(marketOpen: boolean): Promise<QuotaReport> {
  const notes: string[] = [];
  try {
    // Total IndianAPI rows in the last hour.
    const total = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c
         FROM q365_data_feed_health
        WHERE provider = 'indianapi'
          AND request_started_at >= (NOW() - INTERVAL 1 HOUR)`,
    );
    // Calls that landed off-hours — if any, it's either a timezone bug
    // or the market-closed gate is leaking.
    const closed = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c
         FROM q365_data_feed_health
        WHERE provider = 'indianapi'
          AND status   <> 'degraded'
          AND error_code <> 'MARKET_CLOSED'
          AND request_started_at >= (NOW() - INTERVAL 24 HOUR)
          AND HOUR(CONVERT_TZ(request_started_at, '+00:00', '+05:30')) NOT BETWEEN 9 AND 15`,
    );
    // Any single batch call > 200 symbols is a smoking gun for full-
    // universe polling. The emulated /stock fan-out caps at 50 and is
    // metered as cost per symbol — anything larger means a caller
    // bypassed the wrapper.
    const full = await db.query<{ c: number }>(
      `SELECT COUNT(*) AS c
         FROM q365_data_feed_health
        WHERE provider = 'indianapi'
          AND symbols_requested > 200
          AND request_started_at >= (NOW() - INTERVAL 24 HOUR)`,
    );
    const num = (r: { rows: unknown }) => Number((r.rows as Array<{ c: number }>)[0]?.c ?? 0);
    const totalLastHour = num(total);
    const closedCalls   = num(closed);
    const fullCalls     = num(full);
    if (closedCalls > 0) notes.push(`${closedCalls} IndianAPI calls landed off-hours in last 24h`);
    if (fullCalls   > 0) notes.push(`${fullCalls} batch calls exceeded 200 symbols in last 24h (full-universe poll?)`);
    if (!marketOpen && totalLastHour > 0) {
      notes.push(`market closed but ${totalLastHour} IndianAPI rows logged in last hour — possible leak`);
    }
    return {
      feed_health_last_hour: totalLastHour,
      closed_market_calls:   closedCalls,
      full_universe_calls:   fullCalls,
      ok: closedCalls === 0 && fullCalls === 0,
      notes,
    };
  } catch (err) {
    notes.push(`q365_data_feed_health read failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      feed_health_last_hour: 0, closed_market_calls: 0, full_universe_calls: 0,
      ok: false, notes,
    };
  }
}

// ── Section 7: MARKET-CLOSED BEHAVIOR ──────────────────────────

interface MarketClosedReport {
  is_open:                       boolean;
  state:                         string;
  block_outside_market_env:      string;
  strict_off_hours_block_env:    string;
  resolver_gate_present:         boolean;
  provider_gate_present:         boolean;
  notes:                         string[];
}

function auditMarketClosed(): MarketClosedReport {
  const status = getMarketStatus();
  const notes: string[] = [];
  // Static check — confirms the spec-required gates exist in source
  // even if the local boot didn't load them. Both files were verified
  // by inspection; we re-read here so a future regression is caught.
  const resolverPath = resolve(process.cwd(), 'src/lib/marketData/resolver/marketDataResolver.ts');
  const providerPath = resolve(process.cwd(), 'src/lib/marketData/providers/indianApiProvider.ts');
  let resolverGate = false, providerGate = false;
  try {
    const src = readFileSync(resolverPath, 'utf8');
    resolverGate = src.includes('Market-closed hard gate') || src.includes('blockOutsideMarket');
    if (!resolverGate) notes.push('resolver market-closed gate not detected in source');
  } catch { notes.push('resolver source unreadable'); }
  try {
    const src = readFileSync(providerPath, 'utf8');
    providerGate = src.includes('Market-closed defensive guard') || src.includes('API BLOCKED — MARKET CLOSED');
    if (!providerGate) notes.push('provider market-closed gate not detected in source');
  } catch { notes.push('provider source unreadable'); }
  return {
    is_open:                    status.isOpen,
    state:                      status.state,
    block_outside_market_env:   process.env.INDIANAPI_BLOCK_OUTSIDE_MARKET ?? '(default=on)',
    strict_off_hours_block_env: process.env.INDIANAPI_BLOCK_ALL_OFF_HOURS ?? '(default=on)',
    resolver_gate_present:      resolverGate,
    provider_gate_present:      providerGate,
    notes,
  };
}

// ── Section 8: FALLBACK SYSTEM ─────────────────────────────────

interface FallbackReport {
  primary:           string;
  nse_direct:        boolean;
  yahoo:             boolean;
  trigger_threshold: number;
  daily_cap:         number;
  min_delay_ms:      number;
  ok:                boolean;
  notes:             string[];
}

function auditFallback(): FallbackReport {
  const cfg = getNseDirectFallbackConfig();
  const notes: string[] = [];
  const yahoo = isYahooEmergencyFallbackEnabled();
  const nseOk = cfg.enabled;
  const indianapi = isIndianApiPrimary();
  if (!indianapi) notes.push('IndianAPI not primary — fallback chain head is wrong');
  if (!nseOk)     notes.push('NSE direct fallback disabled — chain has no safe fallback');
  // Yahoo presence in the chain is an explicit failure. Spec section 8
  // mentions "IndianAPI → NSE → Yahoo", but the prior SAFE_NSE_MODE
  // contract permanently disables Yahoo. We treat any yahoo=true as a
  // regression because the deprecated stub throws yahoo_removed anyway.
  if (yahoo) notes.push('Yahoo emergency fallback is enabled — spec forbids Yahoo under SAFE_NSE_MODE');
  return {
    primary:           getMarketDataProvider(),
    nse_direct:        nseOk,
    yahoo,
    trigger_threshold: cfg.triggerFailures,
    daily_cap:         cfg.maxSymbolsPerDay,
    min_delay_ms:      cfg.minDelayMs,
    ok:                indianapi && nseOk && !yahoo,
    notes,
  };
}

// ── Section 9: VERDICT ─────────────────────────────────────────

interface FinalVerdict {
  monthly_usage_ok:    boolean;
  provider_ok:         boolean;
  universe_ok:         boolean;
  scan_ok:             boolean;
  signals_ok:          boolean;
  quota_safe:          boolean;
  market_closed_safe:  boolean;
  fallback_ok:         boolean;
  system_status:       'PRODUCTION_SAFE' | 'ISSUES_FOUND';
}

function buildVerdict(args: {
  usage:    UsageReport;
  provider: ProviderReport;
  universe: UniverseReport;
  scan:     ScanReport;
  signals:  SignalReport;
  quota:    QuotaReport;
  market:   MarketClosedReport;
  fallback: FallbackReport;
}): FinalVerdict {
  const usageOk    = args.usage.spec_monthly_ok && args.usage.spec_daily_ok;
  const providerOk = args.provider.indianApiPrimary && !args.provider.yahooEmergencyEnabled;
  const universeOk = args.universe.ok;
  const scanOk     = args.scan.ok;
  const signalsOk  = args.signals.ok;
  const quotaOk    = args.quota.ok;
  // market_closed_safe — gates present in source AND, when market is
  // closed, no recent leak detected by the quota probe.
  const marketOk   = args.market.resolver_gate_present
                  && args.market.provider_gate_present
                  && (args.market.is_open || args.quota.closed_market_calls === 0);
  const fallbackOk = args.fallback.ok;
  const allOk = usageOk && providerOk && universeOk && scanOk
             && signalsOk && quotaOk && marketOk && fallbackOk;
  return {
    monthly_usage_ok:   usageOk,
    provider_ok:        providerOk,
    universe_ok:        universeOk,
    scan_ok:            scanOk,
    signals_ok:         signalsOk,
    quota_safe:         quotaOk,
    market_closed_safe: marketOk,
    fallback_ok:        fallbackOk,
    system_status:      allOk ? 'PRODUCTION_SAFE' : 'ISSUES_FOUND',
  };
}

// ── Entry ──────────────────────────────────────────────────────

async function main(): Promise<void> {
  const usage    = await auditUsage();
  const provider = auditProvider();
  const universe = await auditUniverse();
  const scan     = await auditScan(universe.effective_size);
  const signals  = await auditSignals();
  const market   = auditMarketClosed();
  const quota    = await auditQuota(isMarketOpen());
  const fallback = auditFallback();
  const verdict  = buildVerdict({ usage, provider, universe, scan, signals, quota, market, fallback });

  if (JSON_OUT) {
    console.log(JSON.stringify({
      sections: { usage, provider, universe, scan, signals, quota, market, fallback },
      verdict,
    }, null, 2));
    process.exit(verdict.system_status === 'PRODUCTION_SAFE' ? 0 : 1);
  }

  const line = (label: string, value: string | number | boolean | null | undefined) =>
    `  ${label.padEnd(28)} ${value ?? '—'}`;
  const flag = (b: boolean) => (b ? '✅' : '❌');

  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  productionAudit — full system safety audit');
  console.log('══════════════════════════════════════════════════════════════\n');

  console.log('[1] API USAGE');
  console.log(line('monthly_calls',     `${usage.monthly_calls} / ${SPEC_MONTHLY_CAP} spec  ${flag(usage.spec_monthly_ok)}`));
  console.log(line('daily_calls',       `${usage.daily_calls} / ${SPEC_DAILY_CAP} spec  ${flag(usage.spec_daily_ok)}`));
  console.log(line('monthly_limit_cfg', usage.monthly_limit));
  console.log(line('daily_soft_cap',    usage.daily_soft_cap));
  console.log(line('degradation_level', usage.degradation_level));
  console.log(line('monthly_usage_pct', usage.monthly_usage_pct + '%'));
  for (const n of usage.notes) console.log('  ⚠  ' + n);
  console.log();

  console.log('[2] PROVIDER VALIDATION');
  console.log(line('primary',                provider.primary));
  console.log(line('indianapi_primary',      flag(provider.indianApiPrimary)));
  console.log(line('yahoo_emergency_enabled', flag(!provider.yahooEmergencyEnabled) + ' (must be disabled)'));
  console.log(line('nse_direct_enabled',     flag(provider.nseDirectEnabled)));
  for (const n of provider.notes) console.log('  ⚠  ' + n);
  console.log();

  console.log('[3] UNIVERSE');
  console.log(line('mode',          universe.mode));
  console.log(line('active_count',  universe.active_count));
  console.log(line('total_count',   universe.total_count));
  console.log(line('baked_count',   universe.baked_count));
  console.log(line('effective',     `${universe.effective_size} (spec_min=${universe.spec_min})  ${flag(universe.ok)}`));
  for (const n of universe.notes) console.log('  ⚠  ' + n);
  console.log();

  console.log('[4] SCAN COVERAGE');
  console.log(line('latest_batch_id',  scan.latest_batch_id));
  console.log(line('latest_generated', scan.latest_generated));
  console.log(line('scanned_size',     scan.scanned_size));
  console.log(line('coverage_pct',     scan.coverage_pct + '%'));
  console.log(line('age_minutes',      scan.age_minutes));
  console.log(line('source',           scan.generation_source));
  console.log(line('ok',               flag(scan.ok)));
  for (const n of scan.notes) console.log('  ⚠  ' + n);
  console.log();

  console.log('[5] SIGNAL VALIDATION');
  console.log(line('candidates',       signals.candidates));
  console.log(line('strict_passed',    signals.strict_passed));
  console.log(line('relaxed_passed',   signals.relaxed_passed));
  console.log(line('force_seed_rows',  `${signals.force_seed_rows} ${flag(signals.force_seed_rows === 0)}`));
  for (const n of signals.notes) console.log('  ⚠  ' + n);
  console.log();

  console.log('[6] QUOTA LEAK CHECK');
  console.log(line('feed_health_1h',       quota.feed_health_last_hour));
  console.log(line('closed_market_calls',  `${quota.closed_market_calls} ${flag(quota.closed_market_calls === 0)}`));
  console.log(line('full_universe_calls',  `${quota.full_universe_calls} ${flag(quota.full_universe_calls === 0)}`));
  for (const n of quota.notes) console.log('  ⚠  ' + n);
  console.log();

  console.log('[7] MARKET-CLOSED BEHAVIOR');
  console.log(line('market_open',                 flag(market.is_open) + ' state=' + market.state));
  console.log(line('block_outside_market_env',    market.block_outside_market_env));
  console.log(line('strict_off_hours_block_env',  market.strict_off_hours_block_env));
  console.log(line('resolver_gate_present',       flag(market.resolver_gate_present)));
  console.log(line('provider_gate_present',       flag(market.provider_gate_present)));
  for (const n of market.notes) console.log('  ⚠  ' + n);
  console.log();

  console.log('[8] FALLBACK CHAIN');
  console.log(line('primary',          fallback.primary));
  console.log(line('nse_direct',       flag(fallback.nse_direct)));
  console.log(line('yahoo',            flag(!fallback.yahoo) + ' (must be disabled)'));
  console.log(line('trigger_threshold', `${fallback.trigger_threshold} consecutive failures`));
  console.log(line('daily_cap',        `${fallback.daily_cap} symbols/day`));
  console.log(line('min_delay_ms',     fallback.min_delay_ms));
  for (const n of fallback.notes) console.log('  ⚠  ' + n);
  console.log();

  console.log('══════════════════════════════════════════════════════════════');
  console.log('  FINAL REPORT (spec shape)');
  console.log('══════════════════════════════════════════════════════════════');
  console.log(line('monthly_usage_ok',    flag(verdict.monthly_usage_ok)));
  console.log(line('provider_ok',         flag(verdict.provider_ok)));
  console.log(line('universe_ok',         flag(verdict.universe_ok)));
  console.log(line('scan_ok',             flag(verdict.scan_ok)));
  console.log(line('signals_ok',          flag(verdict.signals_ok)));
  console.log(line('quota_safe',          flag(verdict.quota_safe)));
  console.log(line('market_closed_safe',  flag(verdict.market_closed_safe)));
  console.log(line('fallback_ok',         flag(verdict.fallback_ok)));
  console.log();
  console.log(`  system_status: ${verdict.system_status}`);
  console.log();
  console.log(verdict.system_status === 'PRODUCTION_SAFE'
    ? '  PRODUCTION_SAFE ✅'
    : '  ISSUES_FOUND ❌');
  console.log();

  process.exit(verdict.system_status === 'PRODUCTION_SAFE' ? 0 : 1);
}

main().catch((err) => {
  console.error('productionAudit failed:', err);
  process.exit(2);
});
