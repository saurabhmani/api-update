/**
 * scripts/reportOneCycle.ts
 *
 * One-shot reporter for a single scanner+maturity cycle. Runs the
 * maturity worker (which calls insertConfirmedSnapshotIfEligible
 * per-tracker), captures the per-reason insert rejection breakdown
 * the production worker doesn't expose, then queries final state of
 * q365_signals / q365_signal_maturity_tracker / q365_confirmed_signal_snapshots
 * and prints the metrics the operator asked for.
 *
 * Run AFTER `npx tsx scripts/generateOneBatch.ts` has finished
 * populating q365_signals + the tracker.
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';

interface RejectionTally {
  not_approved:     number;
  live_invalid:     number;
  low_rr:           number;
  low_confidence:   number;
  low_final_score:  number;
  no_edge:          number;
  duplicate_active: number;
  invalid_prices:   number;
  db_error:         number;
}

async function instrumentedMaturityWalk(): Promise<{
  trackers_walked:  number;
  promoted:         number;
  matured:          number;
  developing:       number;
  candidate:        number;
  regime_blocked:   number;
  failed:           number;
  insert_rejections: RejectionTally;
}> {
  const { scoreMaturity, isPromotable, promotionRulesForStrategy } =
    await import('../src/lib/signal-engine/maturity/maturityScorer');
  const { getActiveTrackers, updateMaturityState, markPromoted } =
    await import('../src/lib/signal-engine/repository/maturityTracker');
  const { insertConfirmedSnapshotIfEligible } =
    await import('../src/lib/signal-engine/repository/confirmedSnapshots');

  const trackers = await getActiveTrackers();
  const out = {
    trackers_walked:  trackers.length,
    promoted:         0,
    matured:          0,
    developing:       0,
    candidate:        0,
    regime_blocked:   0,
    failed:           0,
    insert_rejections: {
      not_approved: 0, live_invalid: 0, low_rr: 0, low_confidence: 0,
      low_final_score: 0, no_edge: 0, duplicate_active: 0,
      invalid_prices: 0, db_error: 0,
    } as RejectionTally,
  };

  for (const t of trackers) {
    try {
      const cur = await db.query<any>(
        `SELECT id, symbol, direction,
                entry_price, stop_loss, target1, target2,
                confidence_score, final_score, decay_state, classification,
                factor_scores_json, market_regime, market_stance,
                pct_change, scenario_tag, signal_status,
                live_valid, rejection_codes_json, rejection_reasons_json,
                stress_survival_score, explanation_json,
                risk_score, risk_reward, confidence_band
           FROM q365_signals
          WHERE symbol = ? AND direction = ?
            AND status IN ('active','watchlist','flagged')
            AND (invalidation_reason IS NULL
                 OR invalidation_reason NOT IN (
                   'stop_loss_broken','stop_loss_broken_confirmed',
                   'target_reached','target_already_reached',
                   'engine_disagree','live_rejected'))
            AND (expires_at IS NULL OR expires_at > NOW())
            AND decay_state <> 'expired'
          ORDER BY generated_at DESC LIMIT 1`,
        [t.symbol.toUpperCase(), t.direction],
      );
      const current: any = (cur.rows as any[])[0];
      if (!current) continue;

      const factorScores = (() => {
        const v = current.factor_scores_json;
        if (!v) return null;
        if (typeof v === 'object' && !Array.isArray(v)) return v as Record<string, number>;
        if (typeof v === 'string') { try { return JSON.parse(v); } catch { return null; } }
        return null;
      })();

      const result = scoreMaturity({
        symbol:    t.symbol,
        direction: t.direction,
        current: {
          entry_price:    Number(current.entry_price),
          stop_loss:      Number(current.stop_loss),
          target1:        Number(current.target1),
          confidence:     Number(current.confidence_score),
          final_score:    current.final_score != null ? Number(current.final_score) : null,
          decay_state:    current.decay_state,
          classification: current.classification,
          factor_scores:  factorScores,
          market_regime:  current.market_regime,
          pct_change:     current.pct_change != null ? Number(current.pct_change) : null,
          news_shock:     null,
        },
        tracker: {
          first_detected_at: t.first_detected_at,
          last_seen_at:      t.last_seen_at,
          cycles:            t.validation_cycles_passed,
          history:           t.history,
        },
      });

      await updateMaturityState(t.id, {
        score:           result.score,
        stage:           result.stage,
        stable:          result.stable,
        convictionLevel: result.convictionLevel,
        factors:         result.factors,
      });

      const rules = promotionRulesForStrategy(current.scenario_tag);
      if (!isPromotable(result, t.validation_cycles_passed, rules)) {
        if (result.stage === 'mature')         out.matured++;
        else if (result.stage === 'developing') out.developing++;
        else                                    out.candidate++;
        continue;
      }

      // hard regime gate
      const regimeFactor = result.factors.find((f) => f.name === 'regime_alignment');
      if (regimeFactor && regimeFactor.raw < 0.5) {
        out.regime_blocked++;
        continue;
      }

      const insert = await insertConfirmedSnapshotIfEligible({
        source_signal_id: current.id,
        symbol:           t.symbol,
        exchange:         'NSE',
        direction:        t.direction,
        strategy:         current.scenario_tag ?? null,
        entry_price:      Number(current.entry_price),
        stop_loss:        Number(current.stop_loss),
        target1:          Number(current.target1),
        target2:          current.target2 != null ? Number(current.target2) : null,
        confidence_score: Number(current.confidence_score),
        final_score:      current.final_score != null ? Number(current.final_score) : null,
        classification:   current.classification,
        signal_status:    current.signal_status ?? 'APPROVED_SIGNAL',
        live_valid:       current.live_valid == null ? null : Number(current.live_valid) === 1,
        factor_scores:    factorScores,
        explanation:      current.explanation_json ?? null,
        gate_details:     null,
        rejection_codes:  [],
        stress_survival_score: current.stress_survival_score != null ? Number(current.stress_survival_score) : null,
        maturity_score:                  result.score,
        validation_cycles_passed:        t.validation_cycles_passed,
        signal_age_minutes_at_promotion: result.signalAgeMinutes,
        conviction_level:                result.convictionLevel,
        stability_passed:                result.stable,
        maturity_factors:                result.factors,
      });

      if (insert.inserted && insert.snapshot_id) {
        await markPromoted(t.id, insert.snapshot_id);
        out.promoted++;
      } else {
        if (insert.reason && insert.reason in out.insert_rejections) {
          (out.insert_rejections as any)[insert.reason]++;
        }
        out.matured++;
      }
    } catch {
      out.failed++;
    }
  }
  return out;
}

(async () => {
  const startMs = Date.now();

  // --- 1. Live-scanner state -----------------------------------
  const sigStats = await db.query<any>(`
    SELECT COUNT(*)                                                            AS total_rows,
           SUM(CASE WHEN status='active'                  THEN 1 ELSE 0 END)   AS active_rows,
           SUM(CASE WHEN signal_status='APPROVED_SIGNAL'  THEN 1 ELSE 0 END)   AS approved,
           SUM(CASE WHEN signal_status='DEVELOPING_SETUP' THEN 1 ELSE 0 END)   AS developing,
           UNIX_TIMESTAMP(MAX(generated_at))                                    AS latest_ts
      FROM q365_signals
  `);
  const sigRow = (sigStats.rows[0] as any) ?? {};

  // Distinct symbols in latest batch (proxy for "scanned this cycle")
  const latestBatchRes = await db.query<any>(`
    SELECT batch_id, COUNT(DISTINCT symbol) AS scanned_symbols
      FROM q365_signals
     WHERE batch_id IS NOT NULL
       AND batch_id = (SELECT batch_id FROM q365_signals
                        WHERE batch_id IS NOT NULL
                        ORDER BY generated_at DESC LIMIT 1)
     GROUP BY batch_id
  `);
  const latestBatch = (latestBatchRes.rows[0] as any) ?? {};

  // --- 2. Maturity tracker state -------------------------------
  const trackerStats = await db.query<any>(`
    SELECT stage, COUNT(*) AS c, AVG(maturity_score) AS avg_score
      FROM q365_signal_maturity_tracker
     GROUP BY stage
  `);

  // --- 3. Run an instrumented maturity walk --------------------
  console.log('[REPORT] running instrumented maturity walk...');
  const walk = await instrumentedMaturityWalk();

  // --- 4. Confirmed snapshot state -----------------------------
  const snapStats = await db.query<any>(`
    SELECT status, COUNT(*) AS c
      FROM q365_confirmed_signal_snapshots
     GROUP BY status
  `);
  const activeSnapsRes = await db.query<any>(`
    SELECT id, symbol, direction, strategy,
           entry_price, stop_loss, target1, target2,
           confidence_score, final_score,
           rr_ratio, expected_edge_percent, win_probability,
           maturity_score, validation_cycles_passed,
           signal_age_minutes_at_promotion,
           valid_until, confirmed_at
      FROM q365_confirmed_signal_snapshots
     WHERE status = 'ACTIVE' AND valid_until > NOW()
     ORDER BY confirmed_at DESC
     LIMIT 5
  `);

  // --- 5. Tracker counts by stage (post-walk, current state) --
  const trackerCountsAfter = await db.query<any>(`
    SELECT stage, COUNT(*) AS c FROM q365_signal_maturity_tracker GROUP BY stage
  `);

  // --- Print -----------------------------------------------------
  console.log('');
  console.log('='.repeat(72));
  console.log('  ONE-CYCLE SCANNER + MATURITY REPORT');
  console.log('='.repeat(72));
  console.log('');
  console.log('1. Total scanned stocks (latest batch):  ' + Number(latestBatch.scanned_symbols ?? 0));
  console.log('   batch_id:                              ' + (latestBatch.batch_id ?? 'n/a'));
  console.log('   total q365_signals rows (lifetime):    ' + Number(sigRow.total_rows ?? 0));
  console.log('   active rows:                           ' + Number(sigRow.active_rows ?? 0));
  console.log('   APPROVED_SIGNAL rows:                  ' + Number(sigRow.approved ?? 0));
  console.log('   DEVELOPING_SETUP rows:                 ' + Number(sigRow.developing ?? 0));
  console.log('   latest detection:                      ' + (sigRow.latest_ts ? new Date(Number(sigRow.latest_ts) * 1000).toISOString() : 'never'));
  console.log('');
  console.log('2. Candidates detected (saveSignals tally is in batch1 log).');
  console.log('   See `tally saved=N rejected=M` line in /tmp/q365-batch1.log.');
  console.log('');
  console.log('3. Maturity trackers created:');
  for (const r of trackerStats.rows as any[]) {
    console.log(`     ${String(r.stage).padEnd(12)} ${String(Number(r.c)).padStart(4)}   avg_score=${r.avg_score != null ? Number(r.avg_score).toFixed(1) : '-'}`);
  }
  const trackerTotal = (trackerStats.rows as any[]).reduce((s, r) => s + Number(r.c ?? 0), 0);
  console.log(`     ${'TOTAL'.padEnd(12)} ${String(trackerTotal).padStart(4)}`);
  console.log('');
  console.log('4. Matured signals PROMOTED (this walk):  ' + walk.promoted);
  console.log('   Walk-stage breakdown:');
  console.log('     trackers_walked:  ' + walk.trackers_walked);
  console.log('     promoted:         ' + walk.promoted);
  console.log('     matured (≥85, no promo): ' + walk.matured);
  console.log('     developing:       ' + walk.developing);
  console.log('     candidate:        ' + walk.candidate);
  console.log('     regime_blocked:   ' + walk.regime_blocked);
  console.log('     failed:           ' + walk.failed);
  console.log('');
  console.log('   Tracker stage AFTER this walk:');
  for (const r of trackerCountsAfter.rows as any[]) {
    console.log(`     ${String(r.stage).padEnd(12)} ${String(Number(r.c)).padStart(4)}`);
  }
  console.log('');
  console.log('5–8. Insert-time rejection breakdown (writer floors):');
  console.log('     low_confidence  (conf < 75):     ' + walk.insert_rejections.low_confidence);
  console.log('     low_final_score (final < 70):    ' + walk.insert_rejections.low_final_score);
  console.log('     low_rr          (RR  < 2.0):     ' + walk.insert_rejections.low_rr);
  console.log('     no_edge         (edge ≤ 2.0pp):  ' + walk.insert_rejections.no_edge);
  console.log('     not_approved    (signal_status): ' + walk.insert_rejections.not_approved);
  console.log('     live_invalid:                    ' + walk.insert_rejections.live_invalid);
  console.log('     duplicate_active:                ' + walk.insert_rejections.duplicate_active);
  console.log('     invalid_prices:                  ' + walk.insert_rejections.invalid_prices);
  console.log('     db_error:                        ' + walk.insert_rejections.db_error);
  console.log('     regime_blocked  (pre-writer):    ' + walk.regime_blocked);
  console.log('');
  console.log('9. Confirmed snapshots by status:');
  const snapByStatus: Record<string, number> = {};
  for (const r of snapStats.rows as any[]) snapByStatus[String(r.status)] = Number(r.c);
  for (const k of ['ACTIVE','TARGET_HIT','STOP_LOSS_HIT','INVALIDATED','EXPIRED']) {
    console.log(`     ${k.padEnd(15)} ${snapByStatus[k] ?? 0}`);
  }
  console.log(`   ACTIVE confirmed snapshots shown on UI: ${snapByStatus['ACTIVE'] ?? 0}`);
  console.log('');
  console.log('Sample ACTIVE confirmed snapshots (up to 3):');
  console.log('  ' + ['symbol','dir','strat','mat','age','cyc','conf','final','RR','edge%','valid_until'].join(' | '));
  for (const r of (activeSnapsRes.rows as any[]).slice(0, 3)) {
    const strat = String(r.strategy ?? '').slice(0, 20);
    const validUntil = r.valid_until instanceof Date ? r.valid_until.toISOString() : String(r.valid_until);
    console.log('  ' + [
      String(r.symbol).padEnd(10),
      String(r.direction).padEnd(4),
      strat.padEnd(20),
      String(Number(r.maturity_score ?? 0).toFixed(0)).padStart(3),
      String(Number(r.signal_age_minutes_at_promotion ?? 0)).padStart(4) + 'm',
      String(Number(r.validation_cycles_passed ?? 0)).padStart(3),
      String(Number(r.confidence_score ?? 0)).padStart(4),
      String(Number(r.final_score ?? 0).toFixed(0)).padStart(5),
      String(Number(r.rr_ratio ?? 0).toFixed(1)).padStart(4),
      String(Number(r.expected_edge_percent ?? 0).toFixed(2)).padStart(5),
      validUntil,
    ].join(' | '));
  }
  if ((activeSnapsRes.rows as any[]).length === 0) {
    console.log('  (no ACTIVE confirmed snapshots — see #4 walk breakdown for why)');
  }
  console.log('');
  console.log('Report time: ' + ((Date.now() - startMs) / 1000).toFixed(1) + 's');
  process.exit(0);
})().catch((err) => {
  console.error('[REPORT] failed:', err);
  process.exit(1);
});
