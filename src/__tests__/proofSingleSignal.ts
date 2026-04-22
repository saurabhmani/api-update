// ════════════════════════════════════════════════════════════════
//  Single-Signal Proof Dump
//
//  Picks ONE signal (by arg or latest) and prints every linked
//  artifact end-to-end. Every section joins on the same signal_id
//  so the reader can see the full pipeline for a single row.
//
//  Usage:
//    npx tsx src/__tests__/proofSingleSignal.ts              # latest
//    npx tsx src/__tests__/proofSingleSignal.ts 12345        # by id
//
//  Nothing is fabricated. Missing sections print "NO ROW".
// ════════════════════════════════════════════════════════════════

import './loadEnv';
import { db } from '../lib/db';

function hr(title: string) {
  console.log('\n─── ' + title + ' ' + '─'.repeat(Math.max(0, 60 - title.length)));
}

function kv(obj: Record<string, any>) {
  const width = Math.max(...Object.keys(obj).map((k) => k.length));
  for (const [k, v] of Object.entries(obj)) {
    const val = v === null || v === undefined ? '·'
      : v instanceof Date ? v.toISOString().replace('T', ' ').slice(0, 19)
      : typeof v === 'object' ? JSON.stringify(v)
      : String(v);
    console.log(`  ${k.padEnd(width)} : ${val}`);
  }
}

async function one<T = any>(sql: string, params: any[]): Promise<T | null> {
  const { rows } = await db.query(sql, params);
  return ((rows as any[])[0] as T) ?? null;
}

async function many<T = any>(sql: string, params: any[]): Promise<T[]> {
  const { rows } = await db.query(sql, params);
  return rows as T[];
}

(async () => {
  const arg = process.argv[2];
  let signalId: number;

  if (arg) {
    signalId = Number(arg);
    if (!Number.isFinite(signalId)) {
      console.error(`invalid signal_id: ${arg}`);
      process.exit(1);
    }
  } else {
    const latest = await one<{ id: number }>(
      `SELECT id FROM q365_signals ORDER BY generated_at DESC LIMIT 1`,
      [],
    );
    if (!latest) {
      console.error('q365_signals is empty — nothing to prove.');
      process.exit(1);
    }
    signalId = Number(latest.id);
  }

  console.log('══════════════════════════════════════════════════════════');
  console.log(` SINGLE SIGNAL PROOF — signal_id = ${signalId}`);
  console.log(` generated at ${new Date().toISOString()}`);
  console.log('══════════════════════════════════════════════════════════');

  // 1. Core
  hr('1. SIGNAL CORE (q365_signals)');
  const core = await one(
    `SELECT s.id, s.batch_id, s.symbol, s.direction, sb.strategy_name,
            s.scenario_tag, s.market_regime AS regime, s.volatility_state, s.sector,
            s.confidence_score, s.opportunity_score, s.risk_score,
            s.market_stance, s.confidence_band AS conviction_band,
            s.engine_phase, s.engine_version, s.generation_source, s.code_build,
            s.status, s.generated_at
       FROM q365_signals s
       LEFT JOIN q365_strategy_breakdowns sb ON sb.signal_id = s.id
      WHERE s.id = ?
      LIMIT 1`,
    [signalId],
  );
  if (!core) {
    console.log('  NO ROW — signal does not exist. Aborting.');
    process.exit(1);
  }
  kv(core);

  // 2. Reasons
  hr('2. REASONS (q365_signal_reasons)');
  const reasons = await many(
    `SELECT id, reason_type, factor_key, contribution, message, created_at
       FROM q365_signal_reasons
      WHERE signal_id = ?
      ORDER BY id ASC`,
    [signalId],
  );
  if (reasons.length === 0) console.log('  NO ROWS');
  else for (const r of reasons) {
    console.log(
      `  [${r.id}] ${r.reason_type}` +
      (r.factor_key ? ` (${r.factor_key}, contrib=${r.contribution})` : '') +
      `  → ${r.message}`,
    );
  }

  // 3. Feature snapshot
  hr('3. FEATURE SNAPSHOT (q365_signal_feature_snapshots)');
  const snap = await one<{ id: number; features_json: any; created_at: Date }>(
    `SELECT id, features_json, created_at
       FROM q365_signal_feature_snapshots
      WHERE signal_id = ?
      ORDER BY id DESC LIMIT 1`,
    [signalId],
  );
  if (!snap) {
    console.log('  NO ROW');
  } else {
    console.log(`  snapshot_id: ${snap.id}  created_at: ${snap.created_at}`);
    const feat = typeof snap.features_json === 'string'
      ? JSON.parse(snap.features_json)
      : snap.features_json;
    // Flatten a few top-level groups for readable proof
    for (const group of ['momentum', 'trend', 'volume', 'volatility', 'structure']) {
      if (feat && feat[group]) {
        console.log(`  ${group}: ${JSON.stringify(feat[group])}`);
      }
    }
  }

  // 4. Trade plan
  hr('4. TRADE PLAN (q365_signal_trade_plans)');
  const plan = await one(
    `SELECT id, entry_type, entry_zone_low, entry_zone_high,
            stop_loss, initial_risk_per_unit,
            target1, target2, target3,
            rr_target1, rr_target2, rr_target3, created_at
       FROM q365_signal_trade_plans
      WHERE signal_id = ?
      ORDER BY id DESC LIMIT 1`,
    [signalId],
  );
  if (!plan) console.log('  NO ROW');
  else kv(plan);

  // 5. Position sizing
  hr('5. POSITION SIZING (q365_signal_position_sizing)');
  const sizing = await one(
    `SELECT id, capital_model, portfolio_capital,
            risk_budget_pct, risk_budget_amount,
            initial_risk_per_unit, position_size_units,
            gross_position_value, validation_status,
            warnings_json, created_at
       FROM q365_signal_position_sizing
      WHERE signal_id = ?
      ORDER BY id DESC LIMIT 1`,
    [signalId],
  );
  if (!sizing) console.log('  NO ROW');
  else kv(sizing);

  // 6. Portfolio fit
  hr('6. PORTFOLIO FIT (q365_signal_portfolio_fit)');
  const fit = await one(
    `SELECT id, fit_score, sector_exposure_impact, direction_impact,
            capital_availability, correlation_cluster, correlation_penalty,
            portfolio_decision, penalties_json, created_at
       FROM q365_signal_portfolio_fit
      WHERE signal_id = ?
      ORDER BY id DESC LIMIT 1`,
    [signalId],
  );
  if (!fit) console.log('  NO ROW');
  else kv(fit);

  // 7. Lifecycle
  hr('7. LIFECYCLE (q365_signal_lifecycle)');
  const lifecycle = await many(
    `SELECT id, state, reason, changed_at
       FROM q365_signal_lifecycle
      WHERE signal_id = ?
      ORDER BY changed_at ASC, id ASC`,
    [signalId],
  );
  if (lifecycle.length === 0) console.log('  NO ROWS');
  else for (const l of lifecycle) {
    console.log(`  ${(l.changed_at instanceof Date ? l.changed_at.toISOString() : l.changed_at)}  → ${l.state.padEnd(12)}  ${l.reason}`);
  }

  // Outcome (if graded) — closes the lifecycle loop
  hr('7a. OUTCOME (q365_signal_outcomes)');
  const outcome = await one(
    `SELECT id, entry_triggered, bars_to_entry,
            target1_hit, target2_hit, target3_hit, stop_hit,
            max_fav_excursion_pct, max_adv_excursion_pct,
            return_bar5_pct, return_bar10_pct,
            outcome_label, evaluated_at
       FROM q365_signal_outcomes
      WHERE signal_id = ?
      ORDER BY id DESC LIMIT 1`,
    [signalId],
  );
  if (!outcome) console.log('  NO ROW (signal not yet graded — normal if < 10 bars since generation)');
  else kv(outcome);

  // 8. Explanation
  hr('8. EXPLANATION (q365_signal_explanations)');
  const expl = await one<{ id: number; explanation_json: any; context_json: any; created_at: Date }>(
    `SELECT id, explanation_json, context_json, created_at
       FROM q365_signal_explanations
      WHERE signal_id = ?
      LIMIT 1`,
    [signalId],
  );
  if (!expl) console.log('  NO ROW');
  else {
    console.log(`  explanation_id: ${expl.id}  created_at: ${expl.created_at}`);
    const e = typeof expl.explanation_json === 'string' ? JSON.parse(expl.explanation_json) : expl.explanation_json;
    const c = typeof expl.context_json === 'string' ? JSON.parse(expl.context_json) : expl.context_json;
    console.log('  explanation_json:');
    console.log('    ' + JSON.stringify(e, null, 2).split('\n').join('\n    '));
    console.log('  context_json:');
    console.log('    ' + JSON.stringify(c, null, 2).split('\n').join('\n    '));
  }

  // 9. Decision memory
  hr('9. DECISION MEMORY (q365_decision_memory)');
  const memory = await many(
    `SELECT id, stage, message, payload_json, created_at
       FROM q365_decision_memory
      WHERE signal_id = ?
      ORDER BY created_at ASC, id ASC`,
    [signalId],
  );
  if (memory.length === 0) console.log('  NO ROWS');
  else for (const m of memory) {
    console.log(`  [${m.id}] ${m.created_at}  stage=${m.stage}`);
    if (m.message) console.log(`       message: ${m.message}`);
    if (m.payload_json) {
      const p = typeof m.payload_json === 'string' ? m.payload_json : JSON.stringify(m.payload_json);
      console.log(`       payload: ${p.slice(0, 400)}${p.length > 400 ? ' …[truncated]' : ''}`);
    }
  }

  // Linkage summary
  hr('LINKAGE SUMMARY');
  const sections: Array<[string, any]> = [
    ['q365_signals',                   core],
    ['q365_signal_reasons',            reasons.length > 0 ? reasons : null],
    ['q365_signal_feature_snapshots',  snap],
    ['q365_signal_trade_plans',        plan],
    ['q365_signal_position_sizing',    sizing],
    ['q365_signal_portfolio_fit',      fit],
    ['q365_signal_lifecycle',          lifecycle.length > 0 ? lifecycle : null],
    ['q365_signal_outcomes',           outcome],
    ['q365_signal_explanations',       expl],
    ['q365_decision_memory',           memory.length > 0 ? memory : null],
  ];
  const present = sections.filter(([, v]) => v !== null).length;
  for (const [name, v] of sections) {
    console.log(`  ${v !== null ? '✓' : '✗'} ${name}`);
  }
  console.log(`\n  coverage: ${present}/${sections.length} tables linked via signal_id=${signalId}`);

  process.exit(0);
})().catch((e) => {
  console.error('\nPROOF FAILED:', e);
  process.exit(1);
});
