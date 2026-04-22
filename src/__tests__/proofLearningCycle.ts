// ════════════════════════════════════════════════════════════════
//  Learning Cycle Proof Dump
//
//  Produces real-data evidence that the self-learning loop is alive:
//    1. Recent signals (last 2 days) with IDs, strategy, confidence
//    2. Their outcomes (entry/target/stop, MFE, MAE)
//    3. Confidence calibration — today vs previous snapshot (before/after)
//    4. Strategy performance snapshot rollups
//    5. Adaptive recommendations generated from the above
//    6. Learning job run audit log
//
//  Run:  npx tsx src/__tests__/proofLearningCycle.ts
//
//  Nothing is fabricated — if the DB has no data, that is what the
//  output will say.
// ════════════════════════════════════════════════════════════════

import './loadEnv';
import { db } from '../lib/db';

function hr(title: string) {
  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' ' + title);
  console.log('═══════════════════════════════════════════════════════');
}

function fmt(v: any): string {
  if (v === null || v === undefined) return '·';
  if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19);
  if (typeof v === 'number') return String(v);
  return String(v);
}

function table(rows: any[], cols: string[]) {
  if (rows.length === 0) {
    console.log('  (no rows)');
    return;
  }
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => fmt(r[c]).length)));
  const line = (cells: string[]) =>
    '  ' + cells.map((c, i) => c.padEnd(widths[i])).join('  ');
  console.log(line(cols));
  console.log(line(widths.map((w) => '─'.repeat(w))));
  for (const r of rows) console.log(line(cols.map((c) => fmt(r[c]))));
}

async function tableExists(name: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n FROM information_schema.tables
      WHERE table_schema = DATABASE() AND table_name = ?`,
    [name],
  );
  return Number((rows[0] as any).n) > 0;
}

(async () => {
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Database:  ${process.env.MYSQL_DATABASE ?? '(from DATABASE_URL)'}`);

  // ──────────────────────────────────────────────────────────────
  // 1. Recent signals (last 2 days)
  // ──────────────────────────────────────────────────────────────
  hr('1. RECENT SIGNALS (last 2 days)');
  const signalsTable = (await tableExists('q365_signals')) ? 'q365_signals' : 'signals';
  console.log(`  source: ${signalsTable}`);
  const { rows: sigRows } = await db.query(
    `SELECT s.id, s.symbol, sb.strategy_name, s.direction, s.confidence_score,
            s.market_regime AS regime, s.scenario_tag, s.sector,
            s.volatility_state, s.generated_at
       FROM \`${signalsTable}\` s
       LEFT JOIN q365_strategy_breakdowns sb
         ON sb.signal_id = s.id
      WHERE s.generated_at >= DATE_SUB(NOW(), INTERVAL 2 DAY)
      ORDER BY s.generated_at DESC
      LIMIT 10`,
  );
  table(sigRows as any[], [
    'id', 'symbol', 'strategy_name', 'direction',
    'confidence_score', 'regime', 'scenario_tag', 'generated_at',
  ]);
  const signalIds = (sigRows as any[]).map((r) => r.id);

  // ──────────────────────────────────────────────────────────────
  // 2. Outcomes for those signals
  // ──────────────────────────────────────────────────────────────
  hr('2. SIGNAL OUTCOMES (linked to signals above)');
  if (signalIds.length === 0) {
    console.log('  (no recent signals → no outcomes to show)');
  } else {
    const placeholders = signalIds.map(() => '?').join(',');
    const { rows: outRows } = await db.query(
      `SELECT id, signal_id, entry_triggered, bars_to_entry,
              target1_hit, target2_hit, target3_hit, stop_hit,
              max_fav_excursion_pct, max_adv_excursion_pct,
              return_bar5_pct, return_bar10_pct,
              outcome_label, evaluated_at
         FROM q365_signal_outcomes
        WHERE signal_id IN (${placeholders})
        ORDER BY evaluated_at DESC`,
      signalIds,
    );
    table(outRows as any[], [
      'id', 'signal_id', 'entry_triggered', 'bars_to_entry',
      'target1_hit', 'stop_hit',
      'max_fav_excursion_pct', 'max_adv_excursion_pct',
      'outcome_label', 'evaluated_at',
    ]);
  }

  // Broader outcome stats today
  console.log('\n  Outcome label distribution (all-time vs today):');
  const { rows: outAll } = await db.query(
    `SELECT outcome_label,
            COUNT(*) AS total,
            SUM(DATE(evaluated_at) = CURDATE()) AS today
       FROM q365_signal_outcomes
      GROUP BY outcome_label
      ORDER BY total DESC`,
  );
  table(outAll as any[], ['outcome_label', 'total', 'today']);

  // ──────────────────────────────────────────────────────────────
  // 3. Confidence calibration — BEFORE vs AFTER
  // ──────────────────────────────────────────────────────────────
  hr('3. CONFIDENCE CALIBRATION — BEFORE vs AFTER');
  const { rows: calDates } = await db.query(
    `SELECT DISTINCT DATE(computed_at) AS d
       FROM q365_confidence_calibration
      ORDER BY d DESC
      LIMIT 2`,
  );
  const dates = (calDates as any[]).map((r) => r.d);
  if (dates.length === 0) {
    console.log('  (calibration table empty — job never ran)');
  } else {
    console.log(`  latest calibration date:   ${fmt(dates[0])}`);
    console.log(`  previous calibration date: ${dates[1] ? fmt(dates[1]) : '(only one snapshot)'}`);

    const { rows: latest } = await db.query(
      `SELECT bucket, strategy_name, regime, sample_size,
              target1_hit_rate, avg_mfe, calibration_state, computed_at
         FROM q365_confidence_calibration
        WHERE DATE(computed_at) = ?
        ORDER BY bucket, strategy_name, regime
        LIMIT 20`,
      [dates[0]],
    );
    console.log('\n  AFTER (latest snapshot):');
    table(latest as any[], [
      'bucket', 'strategy_name', 'regime', 'sample_size',
      'target1_hit_rate', 'avg_mfe', 'calibration_state', 'computed_at',
    ]);

    if (dates[1]) {
      const { rows: prev } = await db.query(
        `SELECT bucket, strategy_name, regime, sample_size,
                target1_hit_rate, avg_mfe, calibration_state
           FROM q365_confidence_calibration
          WHERE DATE(computed_at) = ?
          ORDER BY bucket, strategy_name, regime
          LIMIT 20`,
        [dates[1]],
      );
      console.log('\n  BEFORE (previous snapshot):');
      table(prev as any[], [
        'bucket', 'strategy_name', 'regime', 'sample_size',
        'target1_hit_rate', 'avg_mfe', 'calibration_state',
      ]);

      // Delta on matching (bucket,strategy,regime) keys
      const key = (r: any) => `${r.bucket}|${r.strategy_name}|${r.regime}`;
      const prevMap = new Map((prev as any[]).map((r) => [key(r), r]));
      const deltas: any[] = [];
      for (const r of latest as any[]) {
        const p = prevMap.get(key(r));
        if (!p) continue;
        deltas.push({
          key:                key(r),
          'Δhit_rate':        (Number(r.target1_hit_rate) - Number(p.target1_hit_rate)).toFixed(4),
          'Δavg_mfe':         (Number(r.avg_mfe) - Number(p.avg_mfe)).toFixed(4),
          'Δsample':          Number(r.sample_size) - Number(p.sample_size),
          before_state:       p.calibration_state,
          after_state:        r.calibration_state,
        });
      }
      console.log('\n  DELTA (after − before, matched keys only):');
      table(deltas, ['key', 'Δhit_rate', 'Δavg_mfe', 'Δsample', 'before_state', 'after_state']);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // 4. Strategy performance snapshots
  // ──────────────────────────────────────────────────────────────
  hr('4. STRATEGY PERFORMANCE (latest snapshot per strategy)');
  const { rows: perfRows } = await db.query(
    `SELECT sps.strategy_name, sps.regime, sps.volatility_state, sps.sector,
            sps.sample_size, sps.win_rate, sps.target1_hit_rate,
            sps.avg_mfe, sps.avg_mae, sps.environment_fit, sps.computed_at
       FROM q365_strategy_performance_snapshots sps
      WHERE sps.computed_at = (
        SELECT MAX(computed_at) FROM q365_strategy_performance_snapshots
      )
      ORDER BY sps.sample_size DESC, sps.win_rate DESC
      LIMIT 20`,
  );
  table(perfRows as any[], [
    'strategy_name', 'regime', 'volatility_state', 'sector',
    'sample_size', 'win_rate', 'target1_hit_rate',
    'avg_mfe', 'avg_mae', 'environment_fit',
  ]);
  if ((perfRows as any[]).length > 0) {
    console.log(`  (computed_at: ${fmt((perfRows as any[])[0].computed_at)})`);
  }

  console.log('\n  Aggregated by strategy (from latest snapshot):');
  const { rows: aggRows } = await db.query(
    `SELECT strategy_name,
            SUM(sample_size)                       AS total_sample,
            ROUND(AVG(win_rate), 4)                AS avg_win_rate,
            ROUND(AVG(target1_hit_rate), 4)        AS avg_t1_hit,
            ROUND(AVG(avg_mfe), 4)                 AS avg_mfe,
            ROUND(AVG(avg_mae), 4)                 AS avg_mae
       FROM q365_strategy_performance_snapshots
      WHERE computed_at = (SELECT MAX(computed_at) FROM q365_strategy_performance_snapshots)
      GROUP BY strategy_name
      ORDER BY total_sample DESC`,
  );
  table(aggRows as any[], [
    'strategy_name', 'total_sample', 'avg_win_rate',
    'avg_t1_hit', 'avg_mfe', 'avg_mae',
  ]);

  // ──────────────────────────────────────────────────────────────
  // 5. Adaptive recommendations
  // ──────────────────────────────────────────────────────────────
  hr('5. ADAPTIVE RECOMMENDATIONS (latest snapshot)');
  const { rows: recRows } = await db.query(
    `SELECT strategy_name, regime, volatility_state, sector,
            environment_fit, recommended_modifier, sample_size,
            evidence_strength, reason, computed_at
       FROM q365_adaptive_recommendations
      WHERE computed_at = (SELECT MAX(computed_at) FROM q365_adaptive_recommendations)
      ORDER BY ABS(recommended_modifier) DESC, sample_size DESC
      LIMIT 20`,
  );
  table(recRows as any[], [
    'strategy_name', 'regime', 'volatility_state', 'sector',
    'environment_fit', 'recommended_modifier', 'sample_size',
    'evidence_strength',
  ]);
  if ((recRows as any[]).length > 0) {
    console.log(`\n  Example reasoning (first row):`);
    console.log(`  ${fmt((recRows as any[])[0].reason)}`);
    console.log(`  computed_at: ${fmt((recRows as any[])[0].computed_at)}`);
  }

  // ──────────────────────────────────────────────────────────────
  // 6. Learning job run audit
  // ──────────────────────────────────────────────────────────────
  hr('6. LEARNING JOB RUN AUDIT (q365_learning_job_runs)');
  if (!(await tableExists('q365_learning_job_runs'))) {
    console.log('  table missing — scheduler has never bootstrapped');
  } else {
    const { rows: jobRows } = await db.query(
      `SELECT id, job_name, status, duration_ms,
              JSON_UNQUOTE(counts_json) AS counts, error_msg, run_at
         FROM q365_learning_job_runs
        ORDER BY run_at DESC
        LIMIT 15`,
    );
    table(jobRows as any[], [
      'id', 'job_name', 'status', 'duration_ms', 'counts', 'run_at',
    ]);

    const { rows: todayCount } = await db.query(
      `SELECT COUNT(DISTINCT job_name) AS jobs_today
         FROM q365_learning_job_runs
        WHERE DATE(run_at) = CURDATE() AND status = 'success'`,
    );
    const n = Number((todayCount[0] as any).jobs_today);
    console.log(`\n  distinct completed jobs today: ${n}/5`);
    console.log(`  verdict: ${n >= 5 ? 'FULL CYCLE TODAY' : n > 0 ? `PARTIAL (${n}/5)` : 'NO RUN TODAY'}`);
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log(' END OF PROOF DUMP');
  console.log('═══════════════════════════════════════════════════════');
  process.exit(0);
})().catch((e) => {
  console.error('\nPROOF DUMP FAILED:', e);
  process.exit(1);
});
