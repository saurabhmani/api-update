import './loadEnv';
import { db } from '../lib/db';
import { runManipulationScan } from '../lib/workers/manipulationScanner';

(async () => {
  const countRows = async (sql: string, params: any[] = []) => {
    const { rows } = await db.query(sql, params);
    return Number((rows[0] as any).c ?? (rows[0] as any).C ?? 0);
  };

  console.log('═══════════ BEFORE ═══════════');
  const before = {
    snapshots: await countRows(`SELECT COUNT(*) AS c FROM q365_manipulation_snapshots`),
    events:    await countRows(`SELECT COUNT(*) AS c FROM q365_manipulation_events`),
    detectors: await countRows(`SELECT COUNT(*) AS c FROM q365_manipulation_detector_results`),
    penalties: await countRows(`SELECT COUNT(*) AS c FROM q365_manipulation_penalties`),
  };
  console.log(before);

  const r1 = await runManipulationScan();

  console.log('═══════════ AFTER ═══════════');
  const after = {
    snapshots: await countRows(`SELECT COUNT(*) AS c FROM q365_manipulation_snapshots`),
    events:    await countRows(`SELECT COUNT(*) AS c FROM q365_manipulation_events`),
    detectors: await countRows(`SELECT COUNT(*) AS c FROM q365_manipulation_detector_results`),
    penalties: await countRows(`SELECT COUNT(*) AS c FROM q365_manipulation_penalties`),
  };
  console.log(after);
  console.log('delta:', {
    snapshots: after.snapshots - before.snapshots,
    events:    after.events    - before.events,
    detectors: after.detectors - before.detectors,
    penalties: after.penalties - before.penalties,
  });

  // Idempotency: re-run and confirm counts don't grow unboundedly.
  // (Snapshots upsert → count stable; detector_results also wiped and
  //  rewritten per snapshot → count stable; events wiped and rewritten
  //  → count stable; penalties skip already-linked signal+snapshot → stable.)
  console.log('\n═══════════ RE-RUN (idempotency) ═══════════');
  const r2 = await runManipulationScan();
  const after2 = {
    snapshots: await countRows(`SELECT COUNT(*) AS c FROM q365_manipulation_snapshots`),
    events:    await countRows(`SELECT COUNT(*) AS c FROM q365_manipulation_events`),
    detectors: await countRows(`SELECT COUNT(*) AS c FROM q365_manipulation_detector_results`),
    penalties: await countRows(`SELECT COUNT(*) AS c FROM q365_manipulation_penalties`),
  };
  console.log(after2);
  const sameTables = ['snapshots', 'events', 'detectors', 'penalties'] as const;
  for (const t of sameTables) {
    const eq = after2[t] === after[t];
    console.log(`  ${t.padEnd(10)} ${after[t]} → ${after2[t]} ${eq ? '(✓ stable)' : `(grew by ${after2[t] - after[t]})`}`);
  }

  // Sample rows across all four tables to prove linkage.
  console.log('\n═══════════ SAMPLE ROWS ═══════════');
  const { rows: sampleSnaps } = await db.query(
    `SELECT id, symbol, snapshot_date, manipulation_score, suspicion_band
       FROM q365_manipulation_snapshots
       ORDER BY manipulation_score DESC, snapshot_date DESC
       LIMIT 3`,
  );
  console.log('top snapshots:');
  for (const r of sampleSnaps as any[]) console.log(' ', r);

  if (sampleSnaps.length > 0) {
    const topId = (sampleSnaps[0] as any).id;
    const topSymbol = (sampleSnaps[0] as any).symbol;
    const topDate = (sampleSnaps[0] as any).snapshot_date;

    const { rows: ev } = await db.query(
      `SELECT event_type, severity, score FROM q365_manipulation_events
        WHERE symbol = ? AND event_date = ? ORDER BY score DESC LIMIT 5`,
      [topSymbol, topDate],
    );
    console.log(`\nevents for ${topSymbol} / ${topDate}: ${ev.length}`);
    for (const r of ev as any[]) console.log(' ', r);

    const { rows: det } = await db.query(
      `SELECT detector_name, triggered, score FROM q365_manipulation_detector_results
        WHERE snapshot_id = ? ORDER BY score DESC LIMIT 5`,
      [topId],
    );
    console.log(`\ndetector results for snapshot_id=${topId}: ${det.length}`);
    for (const r of det as any[]) console.log(' ', r);

    const { rows: pen } = await db.query(
      `SELECT signal_id, confidence_penalty, risk_penalty, rejection_flag, reason
         FROM q365_manipulation_penalties
        WHERE snapshot_id = ? LIMIT 3`,
      [topId],
    );
    console.log(`\npenalties linked to snapshot_id=${topId}: ${pen.length}`);
    for (const r of pen as any[]) console.log(' ', r);
  }

  // Final linkage audit — every event references a symbol+date that exists
  // in snapshots, every detector row references an existing snapshot_id,
  // every penalty references a real signal_id + snapshot_id.
  console.log('\n═══════════ LINKAGE AUDIT ═══════════');
  const orphanEvents = await countRows(
    `SELECT COUNT(*) AS c
       FROM q365_manipulation_events e
       LEFT JOIN q365_manipulation_snapshots s
         ON s.symbol = e.symbol AND s.snapshot_date = e.event_date
      WHERE s.id IS NULL`,
  );
  console.log(`  orphan events:    ${orphanEvents} ${orphanEvents === 0 ? '(✓)' : '(✗)'}`);
  const orphanDetectors = await countRows(
    `SELECT COUNT(*) AS c
       FROM q365_manipulation_detector_results d
       LEFT JOIN q365_manipulation_snapshots s ON s.id = d.snapshot_id
      WHERE s.id IS NULL`,
  );
  console.log(`  orphan detectors: ${orphanDetectors} ${orphanDetectors === 0 ? '(✓)' : '(✗)'}`);
  const orphanPenalties = await countRows(
    `SELECT COUNT(*) AS c
       FROM q365_manipulation_penalties p
       LEFT JOIN q365_manipulation_snapshots s ON s.id = p.snapshot_id
      WHERE s.id IS NULL`,
  );
  console.log(`  orphan penalties: ${orphanPenalties} ${orphanPenalties === 0 ? '(✓)' : '(✗)'}`);

  // ═══════════ PENALTY PATH PROBE ═══════════
  // Natural data didn't produce a penalty row because no high-band
  // snapshot landed on a symbol with recent signals. Exercise the
  // write path explicitly: use an existing high-band snapshot, pair
  // it with a synthetic test signal, re-run the scanner's penalty
  // backfill, verify a penalty row lands, then clean up. This proves
  // the penalty code path works end-to-end; organic penalties will
  // land automatically the moment market data triggers an elevated
  // snapshot on a symbol with active signals.
  console.log('\n═══════════ PENALTY PATH PROBE ═══════════');
  const { rows: highSnaps } = await db.query(
    `SELECT id, symbol, snapshot_date, manipulation_score, suspicion_band
       FROM q365_manipulation_snapshots
      WHERE suspicion_band IN ('elevated','high','severe')
      ORDER BY manipulation_score DESC LIMIT 1`,
  );
  if (highSnaps.length === 0) {
    console.log('  no elevated+ snapshot available — skipping probe');
  } else {
    const s = highSnaps[0] as any;
    const snapshotId = s.id;
    const probeSymbol = s.symbol;
    console.log(`  using snapshot_id=${snapshotId} (${probeSymbol}, band=${s.suspicion_band})`);

    // Insert a temporary test signal for the symbol.
    const { rows: ins } = await db.query(
      `INSERT INTO q365_signals
        (instrument_key, symbol, exchange, direction, timeframe, signal_type,
         confidence_score, confidence_band, risk_score, risk_band,
         entry_price, stop_loss, target1, risk_reward,
         market_regime, status, generated_at, batch_id)
       VALUES (?, ?, 'NSE', 'BUY', 'swing', 'TREND_CONTINUATION',
               75, 'actionable', 30, 'Medium',
               100, 95, 110, 2.0,
               'NEUTRAL', 'active', NOW(), ?)
       RETURNING id`,
      [`NSE_EQ|${probeSymbol}`, probeSymbol, 'probe_' + Date.now()],
    ).catch(() => ({ rows: [] }));
    let probeSignalId = (ins[0] as any)?.id;
    if (!probeSignalId) {
      // Some MySQL drivers don't return RETURNING — fallback to LAST_INSERT_ID.
      const { rows: last } = await db.query(`SELECT LAST_INSERT_ID() AS id`);
      probeSignalId = Number((last[0] as any).id ?? (last[0] as any).ID);
    }
    console.log(`  inserted probe signal_id=${probeSignalId}`);

    // Re-run the scanner. Because the probe signal now exists and has
    // NOT been linked to any penalty row, the backfill step will pick
    // it up, apply the band's policy via decideActions, and write a
    // penalty row. This is exactly the same code path a real signal
    // would follow.
    const r3 = await runManipulationScan({ limit: 20 });
    console.log(`  penalties written this run: ${r3.penaltiesWritten}`);

    // Verify the penalty row linked to probe signal + real snapshot.
    const { rows: probePen } = await db.query(
      `SELECT signal_id, snapshot_id, confidence_penalty, risk_penalty, rejection_flag, reason
         FROM q365_manipulation_penalties
        WHERE snapshot_id = ?
          AND CAST(signal_id AS UNSIGNED) = ?`,
      [snapshotId, probeSignalId],
    );
    console.log(`  penalty row present: ${probePen.length > 0 ? '✓' : '✗'}`);
    for (const r of probePen as any[]) console.log('   ', r);

    // Verify the penalty table is no longer empty.
    const afterPenalties = await countRows(`SELECT COUNT(*) AS c FROM q365_manipulation_penalties`);
    console.log(`  total penalties in table: ${afterPenalties}`);

    // Clean up: delete the probe signal + its penalty row.
    await db.query(
      `DELETE FROM q365_manipulation_penalties WHERE CAST(signal_id AS UNSIGNED) = ?`,
      [probeSignalId],
    );
    await db.query(`DELETE FROM q365_signals WHERE id = ?`, [probeSignalId]);
    console.log(`  cleaned up probe signal + penalty row`);
  }

  process.exit(0);
})().catch((e) => { console.error('FATAL:', e); process.exit(1); });
