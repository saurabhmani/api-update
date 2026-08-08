/**
 * Production promotion funnel audit (Jul 24 → today).
 *
 * Run ON THE PRODUCTION HOST against the production MySQL DB:
 *
 *   cd /var/www/api-update
 *   NODE_ENV=production npx tsx scripts/diagnosticsProdPromotionFunnel.ts
 *
 * Optional:
 *   FUNNEL_SINCE=2026-07-20 NODE_ENV=production npx tsx scripts/diagnosticsProdPromotionFunnel.ts
 *
 * Never prints secrets. Does not mutate data or lower thresholds.
 */

import { config as dotenvConfig } from 'dotenv';
import { resolveEnvFilePath } from '@/lib/envPath';
import { runStressTest } from '@/lib/signal-engine/risk/stressTestEngine';
import { MAIN_TABLE_CLASSIFICATIONS } from '@/lib/signal-engine/pipeline/phase12Routing';
import { STRATEGY_REGISTRY } from '@/lib/signal-engine/strategies/strategyRegistry';

const envFile = resolveEnvFilePath();
dotenvConfig({ path: envFile });
process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const SINCE = process.env.FUNNEL_SINCE || '2026-07-20';
const IST_DAY = (col: string) =>
  `DATE(CONVERT_TZ(${col}, '+00:00', '+05:30'))`;

function pct(n: number, d: number): string {
  if (!d) return '0.0%';
  return `${((100 * n) / d).toFixed(1)}%`;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function iso(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  const d = new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : String(v);
}

async function main(): Promise<void> {
  const { db } = await import('@/lib/db');

  console.log('=== PRODUCTION PROMOTION FUNNEL AUDIT ===');
  console.log(JSON.stringify({
    since: SINCE,
    envFile,
    nodeEnv: process.env.NODE_ENV,
    dbHost: process.env.MYSQL_HOST || 'localhost',
    dbName: process.env.MYSQL_DATABASE || 'unknown',
    tz: process.env.TZ,
    at: new Date().toISOString(),
  }, null, 2));

  // ── Identity / last promotions ───────────────────────────────
  const { rows: lastSnaps } = await db.query<Record<string, unknown>>(
    `SELECT id, symbol, direction, status, signal_id, confirmed_at, updated_at,
            valid_until, confidence_score, classification, market_regime,
            maturity_score, risk_reward, stress_survival_score,
            LEFT(COALESCE(CAST(factor_scores_json AS CHAR), ''), 200) AS factors_preview
       FROM q365_confirmed_signal_snapshots
      ORDER BY confirmed_at DESC
      LIMIT 20`,
  ).catch(async (err) => {
    console.warn('snapshot query soft-fail, trying minimal columns:', (err as Error).message);
    return db.query<Record<string, unknown>>(
      `SELECT id, symbol, direction, status, confirmed_at, updated_at, valid_until
         FROM q365_confirmed_signal_snapshots
        ORDER BY confirmed_at DESC
        LIMIT 20`,
    );
  });
  console.log('\n=== LAST 20 CONFIRMED SNAPSHOTS ===');
  console.log(JSON.stringify(lastSnaps, null, 2));

  const { rows: snapAgg } = await db.query<Record<string, unknown>>(
    `SELECT COUNT(*) AS total,
            SUM(status = 'ACTIVE' AND valid_until > NOW()) AS active,
            MAX(confirmed_at) AS max_confirmed,
            MIN(confirmed_at) AS min_confirmed
       FROM q365_confirmed_signal_snapshots`,
  );
  console.log('\n=== SNAPSHOT AGG ===');
  console.log(JSON.stringify(snapAgg, null, 2));

  // ── Daily classification funnel ──────────────────────────────
  const { rows: dailyClass } = await db.query<Record<string, unknown>>(
    `SELECT ${IST_DAY('generated_at')} AS day,
            COUNT(*) AS signals,
            SUM(classification IN ('INSTITUTIONAL_HIGH_CONVICTION','HIGH_CONVICTION','HIGH_CONVICTION_BUY')) AS hc,
            SUM(classification IN ('VALID_SIGNAL','VALID_BUY')) AS valid,
            SUM(classification IN ('DEVELOPING_SETUP','WATCHLIST','WATCHLIST_ONLY')) AS developing,
            SUM(classification = 'NO_TRADE' OR classification IS NULL OR classification = 'REJECT') AS no_trade,
            SUM(signal_status = 'APPROVED_SIGNAL') AS approved_status,
            SUM(COALESCE(live_valid,0) = 1) AS live_valid_true,
            SUM(COALESCE(stress_survival_score,0) >= 60) AS stress_ge_60,
            SUM(COALESCE(stress_survival_score,0) >= 50) AS stress_ge_50,
            ROUND(AVG(confidence_score),1) AS conf_avg,
            ROUND(MIN(confidence_score),1) AS conf_min,
            ROUND(MAX(confidence_score),1) AS conf_max,
            SUM(confidence_score >= 55) AS conf_ge_55,
            SUM(confidence_score >= 60) AS conf_ge_60,
            SUM(confidence_score >= 70) AS conf_ge_70,
            SUM(confidence_score >= 80) AS conf_ge_80,
            COUNT(DISTINCT market_regime) AS regime_n,
            MAX(market_regime) AS regime_sample
       FROM q365_signals
      WHERE generated_at >= ?
      GROUP BY ${IST_DAY('generated_at')}
      ORDER BY day`,
    [SINCE],
  );
  console.log('\n=== DAILY CLASSIFICATION / CONFIDENCE FUNNEL ===');
  console.log(JSON.stringify(dailyClass, null, 2));

  // Confidence percentiles per day (approx via ordered window)
  const { rows: confDist } = await db.query<Record<string, unknown>>(
    `SELECT day,
            ROUND(AVG(confidence_score),2) AS avg_conf,
            ROUND(MIN(confidence_score),2) AS min_conf,
            ROUND(MAX(confidence_score),2) AS max_conf,
            COUNT(*) AS n
       FROM (
         SELECT ${IST_DAY('generated_at')} AS day, confidence_score
           FROM q365_signals
          WHERE generated_at >= ?
            AND confidence_score IS NOT NULL
       ) t
      GROUP BY day
      ORDER BY day`,
    [SINCE],
  );
  console.log('\n=== DAILY CONFIDENCE SUMMARY ===');
  console.log(JSON.stringify(confDist, null, 2));

  // ── Rejection code aggregates since Jul 24 ───────────────────
  // rejection_codes_json may be JSON array string.
  const { rows: sampleReject } = await db.query<Record<string, unknown>>(
    `SELECT symbol, direction, classification, signal_status, confidence_score,
            stress_survival_score, live_valid, market_regime,
            rejection_codes_json, generated_at
       FROM q365_signals
      WHERE generated_at >= '2026-07-24'
        AND rejection_codes_json IS NOT NULL
        AND rejection_codes_json NOT IN ('', '[]', 'null')
      ORDER BY generated_at DESC
      LIMIT 5000`,
  );

  const codeStats = new Map<string, {
    count: number;
    symbols: Set<string>;
    days: Set<string>;
  }>();
  for (const r of sampleReject) {
    let codes: string[] = [];
    try {
      const raw = r.rejection_codes_json;
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(parsed)) codes = parsed.map(String);
      else if (parsed && typeof parsed === 'object') codes = Object.keys(parsed);
    } catch {
      continue;
    }
    const day = String(iso(r.generated_at) ?? '').slice(0, 10);
    const sym = String(r.symbol ?? '');
    for (const code of codes) {
      const cur = codeStats.get(code) ?? { count: 0, symbols: new Set(), days: new Set() };
      cur.count += 1;
      if (sym) cur.symbols.add(sym);
      if (day) cur.days.add(day);
      codeStats.set(code, cur);
    }
  }
  const codeRows = [...codeStats.entries()]
    .map(([code, v]) => ({
      code,
      count: v.count,
      pct_of_sampled_rows: pct(v.count, sampleReject.length),
      unique_symbols: v.symbols.size,
      trading_days: v.days.size,
      sample_symbols: [...v.symbols].slice(0, 12),
    }))
    .sort((a, b) => b.count - a.count);
  console.log('\n=== REJECTION CODE AGGREGATE (sampled recent rows with codes) ===');
  console.log(JSON.stringify({
    sampled_rows: sampleReject.length,
    codes: codeRows,
  }, null, 2));

  // ── Maturity funnel ──────────────────────────────────────────
  const { rows: maturityDaily } = await db.query<Record<string, unknown>>(
    `SELECT ${IST_DAY('t.last_evaluated_at')} AS day,
            COUNT(*) AS trackers_eval,
            SUM(t.stage = 'mature') AS mature,
            SUM(t.stage = 'developing') AS developing,
            SUM(t.stage = 'candidate') AS candidate,
            SUM(t.stage = 'promoted') AS promoted_stage,
            ROUND(AVG(t.maturity_score),1) AS avg_score,
            ROUND(AVG(t.validation_cycles_passed),1) AS avg_cycles
       FROM q365_signal_maturity_tracker t
      WHERE t.last_evaluated_at >= ?
      GROUP BY ${IST_DAY('t.last_evaluated_at')}
      ORDER BY day`,
    [SINCE],
  ).catch(async () => {
    return db.query<Record<string, unknown>>(
      `SELECT DATE(t.last_evaluated_at) AS day,
              COUNT(*) AS trackers_eval,
              SUM(t.stage = 'mature') AS mature
         FROM q365_signal_maturity_tracker t
        WHERE t.last_evaluated_at >= ?
        GROUP BY DATE(t.last_evaluated_at)
        ORDER BY day`,
      [SINCE],
    );
  });
  console.log('\n=== DAILY MATURITY TRACKER ===');
  console.log(JSON.stringify(maturityDaily, null, 2));

  // Join mature trackers → current signal classification
  const { rows: matureClass } = await db.query<Record<string, unknown>>(
    `SELECT COALESCE(s.classification, 'NULL') AS classification,
            COALESCE(s.signal_status, 'NULL') AS signal_status,
            COUNT(*) AS n,
            ROUND(AVG(s.confidence_score),1) AS avg_conf,
            ROUND(AVG(s.stress_survival_score),1) AS avg_stress,
            SUM(COALESCE(s.live_valid,0)=1) AS live_ok
       FROM q365_signal_maturity_tracker t
       LEFT JOIN q365_signals s
         ON s.symbol = t.symbol
        AND UPPER(s.direction) = UPPER(t.direction)
        AND s.id = (
              SELECT s2.id FROM q365_signals s2
               WHERE s2.symbol = t.symbol
                 AND UPPER(s2.direction) = UPPER(t.direction)
               ORDER BY s2.generated_at DESC
               LIMIT 1
            )
      WHERE t.stage = 'mature'
      GROUP BY COALESCE(s.classification, 'NULL'), COALESCE(s.signal_status, 'NULL')
      ORDER BY n DESC
      LIMIT 40`,
  );
  console.log('\n=== MATURE TRACKERS × LATEST SIGNAL CLASS ===');
  console.log(JSON.stringify(matureClass, null, 2));

  let promotableEntering = 0;
  let nonPromotableEntering = 0;
  for (const r of matureClass) {
    const cls = String(r.classification ?? '');
    const n = num(r.n);
    if (MAIN_TABLE_CLASSIFICATIONS.has(cls)) promotableEntering += n;
    else nonPromotableEntering += n;
  }
  console.log('\n=== MATURITY BOTTLENECK PROOF ===');
  console.log(JSON.stringify({
    mature_with_promotable_class: promotableEntering,
    mature_with_non_promotable_class: nonPromotableEntering,
    note: promotableEntering === 0
      ? 'Zero promotable classifications reach maturity — bottleneck is upstream classification, not maturity writer'
      : 'Some promotable classes reach maturity — inspect writer/RR/stress gates next',
  }, null, 2));

  // ── Daily promotions ─────────────────────────────────────────
  const { rows: dailyPromo } = await db.query<Record<string, unknown>>(
    `SELECT ${IST_DAY('confirmed_at')} AS day, COUNT(*) AS promoted
       FROM q365_confirmed_signal_snapshots
      WHERE confirmed_at >= ?
      GROUP BY ${IST_DAY('confirmed_at')}
      ORDER BY day`,
    [SINCE],
  );
  console.log('\n=== DAILY PROMOTIONS ===');
  console.log(JSON.stringify(dailyPromo, null, 2));

  // ── Regime by day from signals ───────────────────────────────
  const { rows: regimeDaily } = await db.query<Record<string, unknown>>(
    `SELECT ${IST_DAY('generated_at')} AS day,
            market_regime,
            COUNT(*) AS n
       FROM q365_signals
      WHERE generated_at >= ?
      GROUP BY ${IST_DAY('generated_at')}, market_regime
      ORDER BY day, n DESC`,
    [SINCE],
  );
  console.log('\n=== DAILY REGIME DISTRIBUTION (from q365_signals) ===');
  console.log(JSON.stringify(regimeDaily, null, 2));

  // ── Before vs after Jul 24 ────────────────────────────────────
  const { rows: beforeAfter } = await db.query<Record<string, unknown>>(
    `SELECT CASE
              WHEN generated_at <  '2026-07-24' THEN 'before_jul24'
              WHEN generated_at >= '2026-07-24' AND generated_at < '2026-07-25' THEN 'on_jul24'
              ELSE 'after_jul24'
            END AS bucket,
            COUNT(*) AS signals,
            SUM(classification IN ('INSTITUTIONAL_HIGH_CONVICTION','HIGH_CONVICTION','HIGH_CONVICTION_BUY','VALID_SIGNAL','VALID_BUY')) AS promotable_class,
            SUM(classification = 'NO_TRADE') AS no_trade,
            SUM(classification IN ('DEVELOPING_SETUP','WATCHLIST','WATCHLIST_ONLY')) AS developing,
            ROUND(AVG(confidence_score),1) AS avg_conf,
            SUM(confidence_score >= 60) AS conf_ge_60,
            SUM(confidence_score >= 70) AS conf_ge_70,
            ROUND(AVG(stress_survival_score),1) AS avg_stress,
            SUM(COALESCE(stress_survival_score,0) >= 60) AS stress_ge_60
       FROM q365_signals
      WHERE generated_at >= '2026-07-10'
      GROUP BY bucket
      ORDER BY FIELD(bucket,'before_jul24','on_jul24','after_jul24')`,
  );
  console.log('\n=== BEFORE / ON / AFTER JUL 24 ===');
  console.log(JSON.stringify(beforeAfter, null, 2));

  // ── Closest-to-promotion (almost qualified) ──────────────────
  const { rows: almost } = await db.query<Record<string, unknown>>(
    `SELECT s.symbol, s.direction, s.classification, s.signal_status,
            s.confidence_score, s.final_score, s.composite_final_score,
            s.risk_reward, s.stress_survival_score, s.live_valid,
            s.market_regime, s.generated_at, s.rejection_codes_json
       FROM q365_signals s
      WHERE s.generated_at >= '2026-07-24'
      ORDER BY
        (CASE
           WHEN s.classification IN ('INSTITUTIONAL_HIGH_CONVICTION','HIGH_CONVICTION','HIGH_CONVICTION_BUY','VALID_SIGNAL','VALID_BUY') THEN 100
           WHEN s.classification IN ('DEVELOPING_SETUP','WATCHLIST','WATCHLIST_ONLY') THEN 40
           ELSE 0
         END)
        + LEAST(COALESCE(s.confidence_score,0), 100) * 0.35
        + LEAST(COALESCE(s.stress_survival_score,0), 100) * 0.25
        + LEAST(COALESCE(s.final_score, s.composite_final_score, 0), 100) * 0.20
        + (CASE WHEN COALESCE(s.live_valid,0)=1 THEN 15 ELSE 0 END)
        DESC
      LIMIT 50`,
  );
  console.log('\n=== TOP 50 CLOSEST-TO-PROMOTION SINCE JUL 24 ===');
  console.log(JSON.stringify(almost, null, 2));

  // ── Universe / candles coverage (best-effort) ────────────────
  const { rows: uni } = await db.query<Record<string, unknown>>(
    `SELECT COUNT(*) AS universe_active FROM q365_universe WHERE is_active = 1`,
  ).catch(() => ({ rows: [{ universe_active: null }] }));
  console.log('\n=== UNIVERSE ===');
  console.log(JSON.stringify(uni, null, 2));

  // ── Strategy registry vs High Vol ────────────────────────────
  const hvAllowed: string[] = [];
  const hvBlocked: string[] = [];
  for (const [name, entry] of Object.entries(STRATEGY_REGISTRY)) {
    if (entry.allowedRegimes?.includes('High Volatility Risk')) hvAllowed.push(name);
    else hvBlocked.push(name);
  }
  console.log('\n=== STRATEGY REGISTRY vs High Volatility Risk ===');
  console.log(JSON.stringify({
    allowed_in_high_vol: hvAllowed,
    blocked_or_not_allowed_count: hvBlocked.length,
    blocked_sample: hvBlocked.slice(0, 25),
  }, null, 2));

  // ── Stress math proof (deterministic, no DB) ─────────────────
  const examples = [
    { label: 'BUY stop=3% atrPct_fraction=0.02', entry: 100, stop: 97, atr: 0.02, dir: 'BUY' as const },
    { label: 'BUY stop=5% atrPct_fraction=0.02', entry: 100, stop: 95, atr: 0.02, dir: 'BUY' as const },
    { label: 'BUY stop=6% atrPct_fraction=0.02', entry: 100, stop: 94, atr: 0.02, dir: 'BUY' as const },
    { label: 'BUY stop=3% atrPct_PERCENT_BUG=2.0', entry: 100, stop: 97, atr: 2.0, dir: 'BUY' as const },
    { label: 'SELL stop=3% atrPct=0.02', entry: 100, stop: 103, atr: 0.02, dir: 'SELL' as const },
  ];
  const stressProof = examples.map((e) => {
    const r = runStressTest({
      symbol: 'PROOF',
      direction: e.dir,
      entryPrice: e.entry,
      stopLoss: e.stop,
      positionSize: 10,
      atrPct: e.atr,
      liquidityScore: 70,
      sector: 'X',
      capital: 100_000,
    });
    const stopPct = Math.abs(e.entry - e.stop) / e.entry;
    return {
      label: e.label,
      stop_pct_of_entry: Number((stopPct * 100).toFixed(2)),
      gap_threshold_pct: Number((e.atr * 1.5 * 100).toFixed(2)),
      market3_threshold_pct: 3,
      market5_threshold_pct: 5,
      codes: r.stress_rejection_codes,
      survival: r.stress_survival_score,
      scenarios: r.scenarios.map((s) => ({
        scenario: s.scenario,
        stop_hit: s.stop_hit,
        loss_pct: s.loss_pct,
      })),
    };
  });
  console.log('\n=== STRESS ENGINE MATH PROOF ===');
  console.log(JSON.stringify({
    note: [
      'Phase-4 passes atrPct/100 (fraction). If percent slipped through, gap/vol codes explode.',
      'market_crash_breaches_stop fires when BUY stop distance ≤ 3% OR ≤ 5% of entry (beta=1).',
      'gap_breaches_stop fires when stop distance ≤ 1.5 × ATR.',
      'Therefore any BUY with stop risk ≤ 5% always gets market_crash_breaches_stop.',
    ],
    examples: stressProof,
  }, null, 2));

  // ── RR writer preference check (code presence) ───────────────
  console.log('\n=== RR WRITER NOTE ===');
  console.log(JSON.stringify({
    check: 'Confirm production bundle includes confirmedSnapshots preferring stored risk_reward',
    how: 'grep -n "risk_reward\\|stored" src/lib/signal-engine/repository/confirmedSnapshots.ts on VPS build',
  }, null, 2));

  // ── Promotions vs signals since Jul 24 totals ────────────────
  const { rows: totals } = await db.query<Record<string, unknown>>(
    `SELECT
       (SELECT COUNT(*) FROM q365_signals WHERE generated_at >= '2026-07-24') AS signals_since,
       (SELECT COUNT(*) FROM q365_signals WHERE generated_at >= '2026-07-24' AND classification IN ('HIGH_CONVICTION','INSTITUTIONAL_HIGH_CONVICTION','HIGH_CONVICTION_BUY','VALID_SIGNAL','VALID_BUY')) AS promotable_class_since,
       (SELECT COUNT(*) FROM q365_signals WHERE generated_at >= '2026-07-24' AND classification = 'NO_TRADE') AS no_trade_since,
       (SELECT COUNT(*) FROM q365_signals WHERE generated_at >= '2026-07-24' AND classification IN ('DEVELOPING_SETUP','WATCHLIST','WATCHLIST_ONLY')) AS developing_since,
       (SELECT COUNT(*) FROM q365_confirmed_signal_snapshots WHERE confirmed_at >= '2026-07-24') AS promoted_since,
       (SELECT COUNT(*) FROM q365_signal_maturity_tracker WHERE stage='mature') AS mature_trackers_now
    `,
  );
  console.log('\n=== TOTALS SINCE JUL 24 ===');
  console.log(JSON.stringify(totals, null, 2));

  console.log('\n=== AUDIT COMPLETE — paste this entire stdout back for final A/B/C/D verdict ===');
  process.exit(0);
}

main().catch((err) => {
  console.error('FATAL', err);
  process.exit(1);
});
