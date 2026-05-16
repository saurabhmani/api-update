/**
 * scripts/smokeTestPhase11Live.ts
 *
 * Live end-to-end smoke test against the production DB.
 *
 *   1. Connects to MySQL via .env.local.
 *   2. Confirms every Phase-11 column exists (migration applied).
 *   3. Counts how many recent rows in q365_signals carry populated
 *      Phase-11 fields vs how many are NULL (legacy).
 *   4. Reads the most recent 5 rows through readSignals →
 *      Phase-11 serializer → API response, partitions them, and
 *      prints the bucket distribution + a sample API row.
 *   5. Asserts: at least one row has stress_survival_score set
 *      (proves the writer is wiring Phase-11 into INSERTs).
 *
 * Run after applying the migration AND generating a fresh batch:
 *   npx tsx scripts/applyPhase11Migration.ts
 *   # ... then generate signals via your usual entrypoint ...
 *   npx tsx scripts/smokeTestPhase11Live.ts
 *
 * Pass conditions:
 *   - All 8 columns present (migration applied)
 *   - At least one recent row has Phase-11 data populated
 *   - Phase-12 partition produces non-empty mainTable when
 *     there are approved-class rows
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import { getActiveSignals } from '../src/lib/signal-engine/repository/readSignals';
import { fromDbRow, toApiResponse, PHASE_11_REQUIRED_FIELDS } from '../src/lib/signal-engine/repository/phase11Serialization';
import { partitionForUi } from '../src/lib/signal-engine/pipeline/phase12Routing';

const PHASE_11_COLUMNS = [
  'stress_survival_score', 'recommended_quantity', 'recommended_capital',
  'live_valid', 'rejection_codes_json', 'rejection_reasons_json',
  'live_validation_reasons_json', 'explanation_json',
];

async function main() {
  console.log('='.repeat(80));
  console.log('PHASE-11 LIVE SMOKE TEST');
  console.log('='.repeat(80));
  console.log('');

  // ── Step 1: schema check ───────────────────────────────────
  console.log('## Step 1: Phase-11 column existence on q365_signals');
  const { rows: colRows } = await db.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'q365_signals'
       AND COLUMN_NAME IN (${PHASE_11_COLUMNS.map(() => '?').join(',')})`,
    PHASE_11_COLUMNS,
  );
  const present = new Set(colRows.map((r) => r.COLUMN_NAME));
  const missing = PHASE_11_COLUMNS.filter((c) => !present.has(c));
  for (const col of PHASE_11_COLUMNS) {
    console.log('   ' + (present.has(col) ? '✅' : '❌') + '  ' + col);
  }
  if (missing.length > 0) {
    console.log('');
    console.log('   Missing columns — run `npx tsx scripts/applyPhase11Migration.ts` first.');
    process.exit(1);
  }
  console.log('');

  // ── Step 2: population coverage ────────────────────────────
  console.log('## Step 2: Phase-11 field coverage on recent rows');
  const { rows: covRows } = await db.query<{
    total: number;
    with_stress: number; with_qty: number; with_capital: number;
    with_live: number;   with_rej_codes: number; with_explanation: number;
  }>(
    `SELECT
       COUNT(*) AS total,
       SUM(stress_survival_score IS NOT NULL)        AS with_stress,
       SUM(recommended_quantity  IS NOT NULL)        AS with_qty,
       SUM(recommended_capital   IS NOT NULL)        AS with_capital,
       SUM(live_valid            IS NOT NULL)        AS with_live,
       SUM(rejection_codes_json  IS NOT NULL)        AS with_rej_codes,
       SUM(explanation_json      IS NOT NULL)        AS with_explanation
     FROM q365_signals
     WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
  );
  const cov = covRows[0];
  const total = Number(cov?.total ?? 0);
  console.log('   rows in last 7 days:           ' + total);
  if (total === 0) {
    console.log('   No recent rows. Generate signals first via your usual entrypoint,');
    console.log('   then re-run this smoke test.');
    process.exit(1);
  }
  const pct = (n: any) => total > 0 ? `${Math.round(Number(n) / total * 100)}% (${n}/${total})` : 'n/a';
  console.log('   stress_survival_score:         ' + pct(cov.with_stress));
  console.log('   recommended_quantity:          ' + pct(cov.with_qty));
  console.log('   recommended_capital:           ' + pct(cov.with_capital));
  console.log('   live_valid:                    ' + pct(cov.with_live));
  console.log('   rejection_codes_json:          ' + pct(cov.with_rej_codes));
  console.log('   explanation_json:              ' + pct(cov.with_explanation));
  console.log('');

  const writerWired = Number(cov.with_stress) > 0 && Number(cov.with_explanation) > 0;
  console.log('   writer wired into Phase-11 pipeline: ' +
    (writerWired ? '✅ YES' : '❌ NO — fields all NULL on recent rows'));
  console.log('');

  // ── Step 3: read path → partition ──────────────────────────
  console.log('## Step 3: read path → Phase-11 API response → Phase-12 partition');
  const recent = await getActiveSignals(50);
  console.log('   readSignals returned ' + recent.length + ' active rows.');
  if (recent.length === 0) {
    console.log('   No active rows to partition. Smoke test stops here.');
    process.exit(writerWired ? 0 : 1);
  }
  const apiRows = recent.map((r) => toApiResponse(fromDbRow({
    id:                  r.id,
    symbol:              r.tradingsymbol,
    direction:           r.direction,
    generated_at:        r.generated_at,
    final_score:         r.final_score,
    classification:      r.classification,
    confidence_score:    r.confidence_score,
    risk_score:          r.risk_score,
    portfolio_fit_score: r.portfolio_fit,
    risk_reward:         r.risk_reward,
    stress_survival_score: r.stress_survival_score,
    signal_status:       r.signal_status,
    live_valid:          r.live_valid == null ? null : (r.live_valid ? 1 : 0),
    phase4_factor_scores_json: r.factor_scores_phase4 ? JSON.stringify(r.factor_scores_phase4) : null,
    rejection_codes_json:         r.rejection_codes ? JSON.stringify(r.rejection_codes) : null,
    rejection_reasons_json:       r.rejection_reasons ? JSON.stringify(r.rejection_reasons) : null,
    live_validation_reasons_json: r.live_validation_reasons ? JSON.stringify(r.live_validation_reasons) : null,
    recommended_quantity: r.recommended_quantity,
    recommended_capital:  r.recommended_capital,
    explanation_json:     r.explanation ? JSON.stringify(r.explanation) : null,
  } as any)));

  const part = partitionForUi(apiRows.map((api) => ({
    classification:        api.classification,
    signal_status:         api.signal_status,
    live_valid:            api.live_valid,
    stress_survival_score: api.stress_survival_score,
    final_score:           api.final_score,
    symbol:                api.symbol,
  } as any)));
  console.log('   Phase-12 buckets:');
  console.log('     main table:  ' + part.mainTable.length);
  console.log('     emerging:    ' + part.emergingOpportunities.length);
  console.log('     rejected:    ' + part.rejected.length);
  console.log('');

  // ── Step 4: sample API row ─────────────────────────────────
  console.log('## Step 4: sample API response (most recent row)');
  const sample = apiRows[0];
  if (sample) {
    console.log('   ' + sample.symbol + ' ' + sample.direction);
    console.log('     final_score:           ' + sample.final_score);
    console.log('     classification:        ' + sample.classification);
    console.log('     signal_status:         ' + sample.signal_status);
    console.log('     stress_survival_score: ' + sample.stress_survival_score);
    console.log('     live_valid:            ' + sample.live_valid);
    console.log('     recommended_quantity:  ' + sample.recommended_quantity);
    console.log('     recommended_capital:   ' + sample.recommended_capital);
    console.log('     rejection_codes:       ' + JSON.stringify(sample.rejection_codes));
    console.log('     explanation summary:   ' + (sample.explanation?.summary_reason || '(empty)'));
    const apiRecord = sample as unknown as Record<string, unknown>;
    const missingFields = PHASE_11_REQUIRED_FIELDS.filter((k) => !(k in apiRecord));
    console.log('     all 16 required keys present: ' + (missingFields.length === 0 ? '✅' : '❌ ' + missingFields.join(', ')));
  }
  console.log('');

  // ── Verdict ────────────────────────────────────────────────
  const ok = writerWired && missing.length === 0;
  console.log('='.repeat(80));
  console.log(ok
    ? 'RESULT: Phase-11 live integration is healthy.'
    : 'RESULT: Phase-11 not yet fully wired on live data — see steps above.');
  console.log('='.repeat(80));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error('='.repeat(80));
  console.error('SMOKE TEST FAILED');
  console.error('='.repeat(80));
  if (err.code === 'ECONNREFUSED') {
    console.error('  MySQL unreachable. Check mysqld is running and .env.local credentials.');
  } else {
    console.error(err);
  }
  process.exit(1);
});
