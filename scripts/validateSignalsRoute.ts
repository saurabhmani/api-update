/**
 * scripts/validateSignalsRoute.ts
 *
 * End-to-end /signals route simulation. Exercises the same code path as
 * GET /api/signals?action=all but in-process (no HTTP, no session auth)
 * so we can validate the BUY/SELL balance + applyLiveSanity buffered
 * behaviour against the real DB without spinning up Next.js.
 *
 * Run: npx tsx scripts/validateSignalsRoute.ts
 */
import path from 'path';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });

import { db } from '../src/lib/db';
import { getActiveSignals } from '../src/lib/signal-engine/repository/readSignals';
import { applyLiveSanity } from '../src/lib/signal-engine/live/validateAgainstLive';
import { partitionForUi } from '../src/lib/signal-engine/pipeline/phase12Routing';

function pad(n: any, w = 4) { return String(n).padStart(w); }
function bar(label: string) {
  console.log('\n' + '═'.repeat(72));
  console.log(label);
  console.log('═'.repeat(72));
}

interface Counts { buy: number; sell: number }
function countDir(rows: any[]): Counts {
  let buy = 0, sell = 0;
  for (const r of rows) {
    const d = String(r.direction ?? '').toUpperCase();
    if (d === 'BUY')  buy++;
    if (d === 'SELL') sell++;
  }
  return { buy, sell };
}

async function main() {
  bar('SIGNALS ROUTE END-TO-END VALIDATION');

  // ── 1. DB snapshot ───────────────────────────────────────────────
  bar('1. DB snapshot — total approved/fresh by direction');
  const dbCounts = await db.query<any>(`
    SELECT direction, COUNT(*) c, MIN(generated_at) earliest, MAX(generated_at) latest
    FROM q365_signals
    WHERE signal_status = 'APPROVED_SIGNAL' AND decay_state = 'fresh'
    GROUP BY direction ORDER BY direction`);
  for (const r of dbCounts.rows as any[]) {
    console.log(`  ${r.direction}: ${pad(r.c)} (range ${r.earliest} → ${r.latest})`);
  }

  // ── 2. getActiveSignals — exercises new per-direction window SQL ─
  bar('2. getActiveSignals(100) — post-fix per-direction SQL');
  const limit = 100;
  const t0 = Date.now();
  const rows = await getActiveSignals(limit);
  const elapsed = Date.now() - t0;
  const stage1 = countDir(rows);
  console.log(`  fetched ${rows.length} rows in ${elapsed}ms`);
  console.log(`  BUY:  ${pad(stage1.buy)}`);
  console.log(`  SELL: ${pad(stage1.sell)}`);

  // ── 3. Static gate (mirror of route's strictHardExclude) ─────────
  bar('3. Static hard gate (classification/conf/risk/RR/final/stress)');
  const passesStatic = (r: any): boolean => {
    if (r.live_invalidated === true) return false;
    const decay = String(r.decay_state ?? '').toLowerCase();
    if (decay === 'expired' || decay === 'stale') return false;
    const band = String(r.conviction_band ?? '').toLowerCase();
    if (band === 'avoid' || band === 'reject') return false;
    if (String(r.signal_status ?? '') !== 'APPROVED_SIGNAL') return false;
    if (Number(r.confidence_score ?? r.confidence ?? 0) < 60) return false;
    if (Number(r.risk_score ?? 100) > 70) return false;
    if (Number(r.risk_reward ?? 0) < 1.5) return false;
    if (r.final_score != null && Number(r.final_score) < 65) return false;
    return true;
  };
  const afterStatic = rows.filter(passesStatic);
  const stage2 = countDir(afterStatic);
  console.log(`  BUY:  ${pad(stage2.buy)}`);
  console.log(`  SELL: ${pad(stage2.sell)}`);

  // ── 4. applyLiveSanity (buffered, simulated live prices) ─────────
  // Real Yahoo enrichment is skipped here — we simulate three scenarios:
  //   (a) no live tick (YAHOO_PRICE_UNAVAILABLE → retained)
  //   (b) live = entry (no adverse move → retained)
  //   (c) live just past stop (within buffer → BUFFER_PROTECTED)
  bar('4a. applyLiveSanity — scenario A: livePrice null (YAHOO_PRICE_UNAVAILABLE)');
  const scenarioA = afterStatic.map((r: any) => ({ ...r, livePrice: null }));
  const reportA = applyLiveSanity(scenarioA as any[]);
  const sceneAKept = scenarioA.filter((r: any) => !r.live_invalidated);
  console.log(`  before: BUY ${stage2.buy}  SELL ${stage2.sell}`);
  console.log(`  after:  BUY ${reportA.afterBuy}  SELL ${reportA.afterSell}`);
  console.log(`  invalidated: ${reportA.invalidated}`);
  console.log(`  buffer_protected: ${reportA.bufferProtected}`);
  console.log(`  drift_downgraded: ${reportA.downgraded}`);
  console.log(`  prices_stale:     ${reportA.pricesStale}`);
  console.log(`  reasons: ${JSON.stringify(reportA.reasons)}`);

  bar('4b. applyLiveSanity — scenario B: livePrice = entry (no adverse move)');
  const scenarioB = afterStatic.map((r: any) => ({ ...r, livePrice: Number(r.entry_price) }));
  const reportB = applyLiveSanity(scenarioB as any[]);
  console.log(`  before: BUY ${stage2.buy}  SELL ${stage2.sell}`);
  console.log(`  after:  BUY ${reportB.afterBuy}  SELL ${reportB.afterSell}`);
  console.log(`  invalidated: ${reportB.invalidated}`);
  console.log(`  buffer_protected: ${reportB.bufferProtected}`);
  console.log(`  drift_downgraded: ${reportB.downgraded}`);
  console.log(`  reasons: ${JSON.stringify(reportB.reasons)}`);

  bar('4c. applyLiveSanity — scenario C: livePrice just past stop (within buffer)');
  // BUY: livePrice = stop_loss * 0.999 (0.1% below stop — inside ~1% buffer)
  // SELL: livePrice = stop_loss * 1.001 (0.1% above stop — inside ~1% buffer)
  const scenarioC = afterStatic.map((r: any) => {
    const dir = String(r.direction ?? '').toUpperCase();
    const stop = Number(r.stop_loss);
    return {
      ...r,
      livePrice: dir === 'BUY' ? stop * 0.999 : stop * 1.001,
    };
  });
  const reportC = applyLiveSanity(scenarioC as any[]);
  console.log(`  before: BUY ${stage2.buy}  SELL ${stage2.sell}`);
  console.log(`  after:  BUY ${reportC.afterBuy}  SELL ${reportC.afterSell}`);
  console.log(`  invalidated:      ${reportC.invalidated}`);
  console.log(`  buffer_protected: ${reportC.bufferProtected}`);
  console.log(`  drift_downgraded: ${reportC.downgraded}`);
  console.log(`  reasons: ${JSON.stringify(reportC.reasons)}`);
  if (reportC.examples.length > 0) {
    console.log('  examples (top 3):');
    for (const e of reportC.examples.slice(0, 3)) {
      console.log(`    ${e.symbol} ${e.direction} entry=${e.entry} stop=${e.stop_loss} live=${e.livePrice} buffer=${e.buffer} reason=${e.reason}`);
    }
  }

  bar('4d. applyLiveSanity — scenario D: livePrice 5% past stop (outside buffer → kill)');
  const scenarioD = afterStatic.map((r: any) => {
    const dir = String(r.direction ?? '').toUpperCase();
    const stop = Number(r.stop_loss);
    return {
      ...r,
      livePrice: dir === 'BUY' ? stop * 0.95 : stop * 1.05,
    };
  });
  const reportD = applyLiveSanity(scenarioD as any[]);
  console.log(`  before: BUY ${stage2.buy}  SELL ${stage2.sell}`);
  console.log(`  after:  BUY ${reportD.afterBuy}  SELL ${reportD.afterSell}`);
  console.log(`  invalidated:      ${reportD.invalidated}  ← these are correct kills`);
  console.log(`  buffer_protected: ${reportD.bufferProtected}`);
  console.log(`  drift_downgraded: ${reportD.downgraded}`);
  console.log(`  reasons: ${JSON.stringify(reportD.reasons)}`);

  // ── 5. Phase-12 partition ────────────────────────────────────────
  bar('5. Phase-12 partition (main_table vs emerging vs rejected)');
  const partition = partitionForUi(afterStatic as any[]);
  const mainCounts = countDir(partition.mainTable);
  const emergeCounts = countDir(partition.emergingOpportunities);
  console.log(`  main_table:  ${pad(partition.mainTable.length)}  (BUY ${mainCounts.buy}, SELL ${mainCounts.sell})`);
  console.log(`  emerging:    ${pad(partition.emergingOpportunities.length)}  (BUY ${emergeCounts.buy}, SELL ${emergeCounts.sell})`);
  console.log(`  rejected:    ${pad(partition.rejected.length)}`);
  if (partition.rejected.length > 0) {
    console.log('  first 3 reject reasons:');
    for (const x of partition.rejected.slice(0, 3)) {
      console.log(`    - ${x.reasons.join(' / ')}`);
    }
  }

  // ── 6. Final verdict ─────────────────────────────────────────────
  bar('FINAL VERDICT');
  const finalBuy  = mainCounts.buy;
  const finalSell = mainCounts.sell;
  console.log(`  Final main-table BUY:  ${finalBuy}`);
  console.log(`  Final main-table SELL: ${finalSell}`);

  const verdict =
    finalBuy >= 5 && finalSell >= 1 ? 'FIXED'      :
    finalBuy >= 2 && finalSell === 0 ? 'PARTIAL — SELL still empty' :
    'NOT FIXED';
  console.log(`  VERDICT: ${verdict}`);
  console.log('');

  // Distinct symbols in latest batch (informational)
  const batchInfo = await db.query<any>(`
    SELECT batch_id, generation_source,
           COUNT(*) signals_persisted,
           COUNT(DISTINCT symbol) distinct_symbols,
           SUM(direction='BUY') buys, SUM(direction='SELL') sells,
           MAX(generated_at) ts
    FROM q365_signals
    GROUP BY batch_id, generation_source
    ORDER BY ts DESC LIMIT 5`);
  console.log('Latest 5 batches:');
  console.log(`  batch_id                       source                          rows  syms  BUY  SELL  generated_at`);
  for (const r of batchInfo.rows as any[]) {
    console.log(
      `  ${String(r.batch_id ?? 'NULL').padEnd(30)} ` +
      `${String(r.generation_source ?? '').padEnd(32)} ` +
      `${pad(r.signals_persisted)} ${pad(r.distinct_symbols)}  ${pad(r.buys, 3)}  ${pad(r.sells, 3)}  ${r.ts}`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('VALIDATION FAILED:');
  console.error(err);
  process.exit(1);
});
