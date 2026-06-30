/**
 * Read-only audit: which DB rows could pass the approval gate chain today?
 * Usage: npx tsx scripts/checkApprovalEligibility.ts
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import {
  strictApprovedAudit,
  eliteApproved,
  STRICT_CONFIDENCE_FLOOR,
  STRICT_FINAL_FLOOR,
  STRICT_RR_FLOOR,
  STRICT_STRESS_FLOOR,
  ELITE_CONFIDENCE_FLOOR,
  ELITE_FINAL_FLOOR,
  ELITE_RR_FLOOR,
  ELITE_STRESS_FLOOR,
  type EliteCandidateRow,
} from '../src/lib/signals/confirmedSignalPolicy';
import { getActiveSnapshotReaderDiagnostics } from '../src/lib/signal-engine/repository/readConfirmedSnapshots';
import { loadConfirmedSignalsBundle } from '../src/lib/signals/confirmedSignalsService';

const ELITE_CLS = new Set([
  'INSTITUTIONAL_HIGH_CONVICTION',
  'HIGH_CONVICTION',
  'VALID_SIGNAL',
  'HIGH_CONVICTION_BUY',
  'VALID_BUY',
]);

function mapRow(r: Record<string, unknown>): EliteCandidateRow & { symbol?: string } {
  return {
    symbol:                r.symbol != null ? String(r.symbol) : undefined,
    direction:             r.direction != null ? String(r.direction) : undefined,
    classification:        r.classification != null ? String(r.classification) : undefined,
    signal_status:         r.signal_status != null ? String(r.signal_status) : undefined,
    confidence_score:      Number(r.confidence_score),
    final_score:           Number(r.composite_final_score ?? r.final_score),
    risk_reward:           Number(r.risk_reward),
    rr_ratio:              Number(r.risk_reward),
    stress_survival_score: r.stress_survival_score != null ? Number(r.stress_survival_score) : null,
    execution_allowed:     true,
    live_valid:            r.live_valid === 1 || r.live_valid === true,
  };
}

async function main(): Promise<void> {
  const floors = {
    strict: { conf: STRICT_CONFIDENCE_FLOOR, final: STRICT_FINAL_FLOOR, rr: STRICT_RR_FLOOR, stress: STRICT_STRESS_FLOOR },
    elite:  { conf: ELITE_CONFIDENCE_FLOOR, final: ELITE_FINAL_FLOOR, rr: ELITE_RR_FLOOR, stress: ELITE_STRESS_FLOOR },
  };

  const [counts, readerDiag, bundle, sigRes, instClsCount, scoreQualified, clsDist, ssDist, matureRes] =
    await Promise.all([
      db.query<{ live_signals: number; active_snapshots: number; active_trackers: number; promoted_trackers: number }>(`
        SELECT
          (SELECT COUNT(*) FROM q365_signals WHERE status IN ('active','watchlist','flagged')) AS live_signals,
          (SELECT COUNT(*) FROM q365_confirmed_signal_snapshots WHERE status='ACTIVE' AND valid_until > NOW()) AS active_snapshots,
          (SELECT COUNT(*) FROM q365_signal_maturity_tracker WHERE stage IN ('candidate','developing','mature')) AS active_trackers,
          (SELECT COUNT(*) FROM q365_signal_maturity_tracker WHERE stage='promoted') AS promoted_trackers
      `),
      getActiveSnapshotReaderDiagnostics(),
      loadConfirmedSignalsBundle({ limit: 100 }),
      db.query<Record<string, unknown>>(`
        SELECT id, symbol, direction, signal_status, classification,
               confidence_score, final_score, composite_final_score,
               risk_reward, stress_survival_score,
               live_valid, invalidation_reason, decay_state
          FROM q365_signals
         WHERE status IN ('active','watchlist','flagged')
           AND (invalidation_reason IS NULL OR invalidation_reason = '')
         ORDER BY COALESCE(composite_final_score, final_score, confidence_score) DESC
         LIMIT 500
      `),
      db.query<{ c: number }>(`
        SELECT COUNT(*) AS c FROM q365_signals
         WHERE status IN ('active','watchlist','flagged')
           AND UPPER(classification) IN (
             'INSTITUTIONAL_HIGH_CONVICTION','HIGH_CONVICTION','VALID_SIGNAL',
             'HIGH_CONVICTION_BUY','VALID_BUY'
           )
      `),
      db.query<{ c: number }>(`
        SELECT COUNT(*) AS c FROM q365_signals
         WHERE status IN ('active','watchlist','flagged')
           AND confidence_score >= ?
           AND COALESCE(composite_final_score, final_score) >= ?
           AND risk_reward >= ?
      `, [ELITE_CONFIDENCE_FLOOR, ELITE_FINAL_FLOOR, ELITE_RR_FLOOR]),
      db.query<{ cls: string; c: number }>(`
        SELECT UPPER(classification) AS cls, COUNT(*) AS c
          FROM q365_signals WHERE status IN ('active','watchlist','flagged')
         GROUP BY UPPER(classification) ORDER BY c DESC LIMIT 10
      `),
      db.query<{ ss: string; c: number }>(`
        SELECT UPPER(signal_status) AS ss, COUNT(*) AS c
          FROM q365_signals WHERE status IN ('active','watchlist','flagged')
         GROUP BY UPPER(signal_status) ORDER BY c DESC
      `),
      db.query<Record<string, unknown>>(`
        SELECT t.symbol, t.direction, t.stage, t.maturity_score, t.validation_cycles_passed, t.stable,
               s.classification, s.signal_status, s.confidence_score,
               s.composite_final_score, s.final_score, s.risk_reward, s.stress_survival_score, s.live_valid
          FROM q365_signal_maturity_tracker t
          JOIN q365_signals s ON s.id = t.last_signal_id
         WHERE t.stage = 'mature'
         ORDER BY t.maturity_score DESC
         LIMIT 50
      `),
    ]);

  const signals = sigRes.rows;
  const strictPass: ReturnType<typeof mapRow>[] = [];
  const elitePass: ReturnType<typeof mapRow>[] = [];
  const eliteFailHist: Record<string, number> = {};
  const strictFailHist: Record<string, number> = {};

  for (const raw of signals) {
    const r = mapRow(raw);
    const sAudit = strictApprovedAudit(r);
    const eAudit = eliteApproved(r, true);
    if (sAudit.passed) strictPass.push(r);
    else {
      const head = (sAudit.failed[0] ?? 'unknown').split('=')[0];
      strictFailHist[head] = (strictFailHist[head] ?? 0) + 1;
    }
    if (eAudit.passed) elitePass.push(r);
    else {
      const head = (eAudit.failed[0] ?? 'unknown').split('=')[0];
      eliteFailHist[head] = (eliteFailHist[head] ?? 0) + 1;
    }
  }

  const top20 = signals.slice(0, 20).map((raw) => {
    const r = mapRow(raw);
    const s = strictApprovedAudit(r);
    const e = eliteApproved(r, true);
    return {
      symbol: r.symbol, direction: r.direction,
      cls: r.classification, signal_status: r.signal_status,
      conf: r.confidence_score, final: r.final_score, rr: r.risk_reward,
      stress: r.stress_survival_score,
      strict: s.passed ? 'PASS' : s.failed[0],
      elite:  e.passed ? 'PASS' : e.failed[0],
    };
  });

  const matureAnalysis = matureRes.rows.map((raw) => {
    const r = mapRow(raw);
    const cls = String(r.classification ?? '').toUpperCase();
    const e = eliteApproved({ ...r, signal_status: r.signal_status ?? 'DEVELOPING_SETUP' }, true);
    return {
      symbol: r.symbol, dir: r.direction,
      maturity: raw.maturity_score, cycles: raw.validation_cycles_passed,
      cls, signal_status: r.signal_status,
      conf: r.confidence_score, final: r.final_score, rr: r.risk_reward,
      elite: e.passed ? 'PASS' : e.failed[0],
      promotable_cls: ELITE_CLS.has(cls),
    };
  });

  const promotableMature = matureAnalysis.filter((m) => m.elite === 'PASS' && m.promotable_cls);

  const verdict =
    bundle.finalRows.length > 0
      ? `YES — ${bundle.finalRows.length} row(s) would ship as APPROVED today`
      : elitePass.length > 0
        ? `PARTIAL — ${elitePass.length} q365_signals row(s) pass elite gate but none are confirmed snapshots yet`
        : 'NO — zero live signals pass the elite gate today';

  console.log(JSON.stringify({
    verdict,
    floors,
    counts: counts.rows[0],
    readerDiag,
    bundle: {
      finalRows: bundle.finalRows.length,
      enriched: bundle.enriched.length,
      bottleneck: bundle.approvalBottleneck,
    },
    gate_results: {
      sampled_live_signals: signals.length,
      strict_pass: strictPass.length,
      elite_pass: elitePass.length,
      institutional_classification_rows: Number(instClsCount.rows[0]?.c ?? 0),
      rows_meeting_elite_score_floors_only: Number(scoreQualified.rows[0]?.c ?? 0),
      mature_trackers_sampled: matureRes.rows.length,
      mature_elite_plus_institutional_cls: promotableMature.length,
    },
    classification_distribution: clsDist.rows,
    signal_status_distribution: ssDist.rows,
    elite_fail_top: Object.entries(eliteFailHist).sort((a, b) => b[1] - a[1]).slice(0, 8),
    strict_fail_top: Object.entries(strictFailHist).sort((a, b) => b[1] - a[1]).slice(0, 8),
    top_20_by_final_score: top20,
    elite_pass_rows: elitePass.slice(0, 15).map((r) => ({
      symbol: r.symbol, dir: r.direction, cls: r.classification,
      conf: r.confidence_score, final: r.final_score, rr: r.risk_reward,
      signal_status: r.signal_status,
    })),
    mature_promotable: promotableMature.slice(0, 10),
    mature_top_blocked: matureAnalysis.filter((m) => m.elite !== 'PASS').slice(0, 10),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
