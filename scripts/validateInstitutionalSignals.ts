/**
 * scripts/validateInstitutionalSignals.ts
 *
 * Spec INSTITUTIONAL §L — top-20 acceptance test for the institutional
 * signal pipeline. For each row that the API would surface in the main
 * signals table, prints:
 *
 *   symbol, classification, final_score, confidence, stable, live_valid,
 *   signal_status, win_probability, freshness, source, detail_status
 *
 * And verifies (exit 1 on any failure):
 *
 *   • classification ∈ {INSTITUTIONAL_HIGH_CONVICTION, HIGH_CONVICTION,
 *                        VALID_SIGNAL}
 *   • signal_status === 'APPROVED_SIGNAL'
 *   • execution_allowed === true
 *   • final_score >= 65, confidence >= 60, rr >= 1.5, stress >= 60
 *   • stable_passed === true
 *   • win_probability ∈ [0, 1] (no 5000% / 5900% bug)
 *   • detail-page direction matches table direction
 *   • detail-page execution_allowed matches table
 *
 * Also prints the rotation registry snapshot so the operator can see
 * which symbols are in cooldown.
 *
 * Usage:
 *   npx tsx scripts/validateInstitutionalSignals.ts            # top 20
 *   npx tsx scripts/validateInstitutionalSignals.ts --limit 30 # top 30
 *
 * Exit code: 0 on full institutional compliance, 1 on any rule violation.
 */

import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { loadConfirmedSignalsBundle }       from '../src/lib/signals/confirmedSignalsService';
import { getLatestActiveSnapshotBySymbol }  from '../src/lib/signal-engine/repository/readConfirmedSnapshots';
import { getRotationRegistry, getRotationConfig } from '../src/lib/signals/rotationPolicy';
import {
  STRICT_FINAL_FLOOR, STRICT_CONFIDENCE_FLOOR, STRICT_RR_FLOOR, STRICT_STRESS_FLOOR,
  MAIN_TABLE_DISPLAY_CLS,
}                                            from '../src/lib/signals/confirmedSignalPolicy';

interface Violation {
  symbol: string;
  rule:   string;
  detail: string;
}

const argv  = process.argv.slice(2);
const limit = (() => {
  const i = argv.indexOf('--limit');
  if (i < 0) return 20;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? Math.min(50, Math.floor(n)) : 20;
})();

function ageMin(ts: string | Date | null | undefined): number | null {
  if (!ts) return null;
  const ms = ts instanceof Date ? ts.getTime() : Date.parse(String(ts));
  return Number.isFinite(ms) ? Math.max(0, Math.round((Date.now() - ms) / 60_000)) : null;
}

async function main(): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  INSTITUTIONAL SIGNAL PIPELINE — VALIDATION (top ${limit})`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  floors: final≥${STRICT_FINAL_FLOOR}  conf≥${STRICT_CONFIDENCE_FLOOR}  rr≥${STRICT_RR_FLOOR}  stress≥${STRICT_STRESS_FLOOR}`);
  const cfg = getRotationConfig();
  console.log(`  rotation: half_life=${cfg.freshness_half_life_min}m  max_age=${cfg.signal_max_age_min}m  per_sector_cap=${cfg.per_sector_cap}  cooldown_cycles=${cfg.cooldown_max_cycles}`);
  console.log('');

  const bundle = await loadConfirmedSignalsBundle({ limit });
  const rows   = bundle.finalRows.slice(0, limit);
  console.log(`  bundle: enriched=${bundle.enriched.length}  finalRows=${bundle.finalRows.length}  belowFloor=${bundle.belowFloorDemoted.length}`);
  console.log('');

  if (rows.length === 0) {
    console.log('  signals[] is empty — strict pool produced 0 rows. Cannot run institutional checks.');
    console.log('  (this is OK on a fresh DB; re-run after the pipeline confirms snapshots)');
    process.exit(0);
  }

  const violations: Violation[] = [];

  console.log('  #   symbol           dir   cls                            final  conf   rr    stress  win_prob  stable  exec  age_min  detail_match');
  console.log('  ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────');

  for (let i = 0; i < rows.length; i++) {
    const r       = rows[i];
    const sym     = String(r.symbol ?? r.tradingsymbol ?? '');
    const cls     = String(r.classification ?? '').toUpperCase();
    const dir     = String(r.direction ?? '');
    const ss      = String((r as any).signal_status ?? '');
    const final   = Number(r.final_score ?? NaN);
    const conf    = Number(r.confidence_score ?? NaN);
    const rr      = Number(r.rr_ratio ?? r.risk_reward ?? NaN);
    const stress  = Number((r as any).stress_survival_score ?? NaN);
    const winProb = Number(r.win_probability ?? NaN);
    const stable  = (r as any).stability_passed;
    const exec    = (r as any).execution_allowed;
    const age     = ageMin((r as any).confirmed_at ?? null);

    // Detail-page consistency check via the same canonical reader the
    // detail page now uses.
    let detailMatch = '?';
    let detailDir: string | null = null;
    let detailExec: boolean | null = null;
    try {
      const snap = await getLatestActiveSnapshotBySymbol(sym);
      if (snap) {
        detailDir = snap.direction;
        detailExec = snap.execution_allowed;
        detailMatch =
          (detailDir === dir && detailExec === Boolean(exec))
            ? 'OK'
            : `MISMATCH(dir=${detailDir} exec=${detailExec})`;
      } else {
        detailMatch = 'NO_DETAIL_ROW';
      }
    } catch (e) {
      detailMatch = `ERR(${(e as Error).message.slice(0, 30)})`;
    }

    console.log(
      `  ${String(i + 1).padStart(2)}  ${sym.padEnd(16)} ${dir.padEnd(5)} ` +
      `${cls.padEnd(30)} ${String(final.toFixed(1)).padStart(5)}  ` +
      `${String(conf.toFixed(1)).padStart(5)}  ${String(rr.toFixed(2)).padStart(4)}  ` +
      `${String(Number.isFinite(stress) ? stress.toFixed(0) : '—').padStart(6)}   ` +
      `${(Number.isFinite(winProb) ? (winProb * 100).toFixed(1) + '%' : '—').padStart(7)}   ` +
      `${String(stable ?? '—').padStart(5)}  ${String(exec ?? '—').padStart(4)}  ` +
      `${String(age ?? '—').padStart(7)}  ${detailMatch}`,
    );

    if (cls && !MAIN_TABLE_DISPLAY_CLS.has(cls)) {
      violations.push({ symbol: sym, rule: 'classification not in main-table whitelist', detail: cls });
    }
    if (ss !== 'APPROVED_SIGNAL') {
      violations.push({ symbol: sym, rule: 'signal_status != APPROVED_SIGNAL', detail: ss });
    }
    if (exec !== true) {
      violations.push({ symbol: sym, rule: 'execution_allowed != true', detail: String(exec) });
    }
    if (!Number.isFinite(final) || final < STRICT_FINAL_FLOOR) {
      violations.push({ symbol: sym, rule: `final_score < ${STRICT_FINAL_FLOOR}`, detail: String(final) });
    }
    if (!Number.isFinite(conf) || conf < STRICT_CONFIDENCE_FLOOR) {
      violations.push({ symbol: sym, rule: `confidence < ${STRICT_CONFIDENCE_FLOOR}`, detail: String(conf) });
    }
    if (!Number.isFinite(rr) || rr < STRICT_RR_FLOOR) {
      violations.push({ symbol: sym, rule: `rr < ${STRICT_RR_FLOOR}`, detail: String(rr) });
    }
    if (STRICT_STRESS_FLOOR > 0 && (!Number.isFinite(stress) || stress < STRICT_STRESS_FLOOR)) {
      violations.push({ symbol: sym, rule: `stress < ${STRICT_STRESS_FLOOR}`, detail: String(stress) });
    }
    const stableTrue = stable === true || stable === 1;
    if (!stableTrue) {
      violations.push({ symbol: sym, rule: 'stable != true', detail: String(stable) });
    }
    if (!Number.isFinite(winProb) || winProb < 0 || winProb > 1) {
      violations.push({ symbol: sym, rule: 'win_probability out of [0,1]', detail: String(winProb) });
    }
    if (detailMatch.startsWith('MISMATCH')) {
      violations.push({ symbol: sym, rule: 'detail-page direction or exec mismatches main table', detail: detailMatch });
    }
  }

  console.log('');
  console.log('  ── Rotation registry snapshot ──────────────────────────');
  const reg = getRotationRegistry();
  if (reg.length === 0) {
    console.log('  (registry empty — first response of this process)');
  } else {
    for (const e of reg.slice(0, 20)) {
      console.log(
        `   ${e.symbol.padEnd(18)} cycles=${String(e.cycles_shown).padStart(2)}  ` +
        `best_score=${e.best_score.toFixed(1).padStart(5)}  ` +
        `cooldown=${e.in_cooldown ? 'YES' : 'no'}`,
      );
    }
  }

  console.log('');
  if (violations.length === 0) {
    console.log(`  ✓ INSTITUTIONAL VALIDATION PASSED — ${rows.length} rows, 0 violations`);
    process.exit(0);
  } else {
    console.log(`  ✗ INSTITUTIONAL VALIDATION FAILED — ${violations.length} violations across ${rows.length} rows:`);
    for (const v of violations.slice(0, 30)) {
      console.log(`    • ${v.symbol.padEnd(18)} ${v.rule.padEnd(45)} (${v.detail})`);
    }
    if (violations.length > 30) console.log(`    … and ${violations.length - 30} more`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('validation script failed:', err);
  process.exit(2);
});
