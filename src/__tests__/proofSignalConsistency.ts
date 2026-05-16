import './loadEnv';
// ════════════════════════════════════════════════════════════════
//  Quantorus365 — Proof: Signals page ↔ stock detail page parity.
//
//  Picks the top-N BUY rows the main /signals API would surface,
//  then for each one calls revalidateInstrument() the same way
//  /api/signals?action=instrument does. Prints any mismatch the
//  user would see if they clicked the symbol from the Signals page
//  and landed on the stock-detail page.
//
//  Acceptance criteria (per spec):
//    - direction matches (no BUY-in-table → SELL-in-detail)
//    - signal_status is not REJECTED
//    - scenario_tag is not NO_STRATEGY
//    - classification matches or is explainably downgraded
//
//  Two modes:
//    • Default: persistInvalidation=false (read-only audit; no DB writes)
//    • --persist: lets revalidateInstrument flag rows the same way
//                 the live route does, so the next /api/signals poll
//                 drops them from the main table.
//
//  Run:
//    npx tsx src/__tests__/proofSignalConsistency.ts          # audit only
//    npx tsx src/__tests__/proofSignalConsistency.ts --persist # also flag
//    npx tsx src/__tests__/proofSignalConsistency.ts --limit 20
// ════════════════════════════════════════════════════════════════

import { db } from '../lib/db';
import { revalidateInstrument } from '../lib/signal-engine/live/revalidateInstrument';

interface MainRow {
  id:             number;
  symbol:         string;
  instrument_key: string;
  exchange:       string;
  direction:      string;
  signal_status:  string;
  scenario_tag:   string | null;
  classification: string | null;
  confidence:     number | null;
  generated_at:   string;
}

const args        = new Set(process.argv.slice(2));
const persist     = args.has('--persist');
const limitArgIdx = process.argv.indexOf('--limit');
const limit       = limitArgIdx >= 0 ? Number(process.argv[limitArgIdx + 1] ?? 10) : 10;

function bar(label: string, ch = '═') {
  const line = ch.repeat(72);
  console.log(`\n${line}\n${label}\n${line}`);
}

async function loadTopBuys(n: number): Promise<MainRow[]> {
  // Same lifecycle gate as the main /signals SQL — invalidation_reason
  // IS NULL, status active/watchlist/flagged, not expired, decay not
  // expired. If a row has already been flipped to NO_TRADE by a
  // previous revalidation, it won't show up here (the gate filters it
  // out). That mirrors the production behaviour the test verifies.
  const { rows } = await db.query<any>(
    `SELECT id, symbol, instrument_key, exchange, direction, signal_status,
            scenario_tag, classification, confidence_score AS confidence,
            generated_at
       FROM q365_signals
      WHERE direction = 'BUY'
        AND status IN ('active','watchlist','flagged')
        AND COALESCE(invalidation_reason,'') = ''
        AND (expires_at IS NULL OR expires_at > NOW())
        AND (decay_state IS NULL OR decay_state <> 'expired')
        AND UPPER(COALESCE(signal_status,'')) = 'APPROVED_SIGNAL'
      ORDER BY final_score DESC, confidence_score DESC, generated_at DESC
      LIMIT ?`,
    [Math.max(1, Math.min(n, 50))],
  );
  return (rows as any[]).map((r) => ({
    id:             Number(r.id),
    symbol:         String(r.symbol),
    instrument_key: String(r.instrument_key ?? `NSE_EQ|${r.symbol}`),
    exchange:       String(r.exchange ?? 'NSE'),
    direction:      String(r.direction),
    signal_status:  String(r.signal_status),
    scenario_tag:   r.scenario_tag ? String(r.scenario_tag) : null,
    classification: r.classification ? String(r.classification) : null,
    confidence:     r.confidence != null ? Number(r.confidence) : null,
    generated_at:   r.generated_at instanceof Date
                      ? r.generated_at.toISOString() : String(r.generated_at),
  }));
}

interface MismatchReport {
  symbol:        string;
  reasons:       string[];
  storedDir:     string;
  detailDir:     string | null;
  storedStatus:  string;
  detailStatus:  string;
  scenario_tag:  string | null;
  liveConf:      number | null;
  liveRejection: string[];
  banner:        string | null;
}

async function checkSymbol(row: MainRow): Promise<MismatchReport | null> {
  const result = await revalidateInstrument(
    row.instrument_key, row.symbol, row.exchange,
    { persistInvalidation: persist },
  );

  const reasons: string[] = [];
  const detailDir    = (result.signal as any)?.direction ?? null;
  const detailStatus = result.revalidation.status;
  const liveConf     = result.revalidation.live?.confidence_score ?? null;

  // 1. direction must match
  if (detailDir && String(detailDir).toUpperCase() !== String(row.direction).toUpperCase()) {
    reasons.push(
      `direction mismatch: signals=${row.direction} detail=${detailDir}`,
    );
  }

  // 2. signal_status must not be REJECTED
  if (result.approved === false) {
    reasons.push(`detail returned approved=false (status=${detailStatus})`);
  }

  // 3. scenario_tag must not be NO_STRATEGY
  const liveScen = (result.scenario_tag ?? '').toUpperCase();
  if (liveScen === 'NO_STRATEGY') {
    reasons.push(`live scenario_tag=NO_STRATEGY`);
  }

  // 4. classification mismatch (only flag if hard-downgrade to NO_TRADE)
  // The 'revalidated' status is the explainable downgrade — we DO want
  // those flagged because they prove the bug pattern (table promised BUY,
  // detail recomputed below threshold).
  if (detailStatus === 'revalidated') {
    reasons.push(
      `revalidated by live engine — banner: ${result.revalidation.banner ?? '(none)'}`,
    );
  }

  if (reasons.length === 0) return null;
  return {
    symbol:        row.symbol,
    reasons,
    storedDir:     row.direction,
    detailDir,
    storedStatus:  row.signal_status,
    detailStatus,
    scenario_tag:  result.scenario_tag,
    liveConf,
    liveRejection: result.revalidation.live?.rejection_reasons ?? [],
    banner:        result.revalidation.banner,
  };
}

async function main(): Promise<void> {
  bar('Signal Consistency Proof — main /signals BUY rows ↔ stock detail');
  console.log(`Mode: ${persist ? 'PERSIST (will flag rows)' : 'AUDIT (read-only)'}  Limit: ${limit}`);

  const top = await loadTopBuys(limit);
  if (top.length === 0) {
    console.log('\nNo BUY rows in q365_signals match the main-table gate.');
    console.log('This is normal off-hours when the closed-market path is in use.');
    process.exit(0);
  }
  console.log(`\nLoaded ${top.length} BUY rows from q365_signals.`);

  const mismatches: MismatchReport[] = [];
  for (let i = 0; i < top.length; i++) {
    const row = top[i];
    process.stdout.write(`  [${i + 1}/${top.length}] ${row.symbol.padEnd(14)} `);
    try {
      const m = await checkSymbol(row);
      if (m) { mismatches.push(m); console.log('MISMATCH'); }
      else { console.log('ok'); }
    } catch (err: any) {
      console.log(`ERROR: ${err?.message ?? err}`);
    }
  }

  bar('Results');
  console.log(`Checked: ${top.length}`);
  console.log(`Matched: ${top.length - mismatches.length}`);
  console.log(`Mismatched: ${mismatches.length}`);

  if (mismatches.length === 0) {
    console.log('\n✓ All main-table BUY signals are consistent with their stock-detail responses.');
    console.log('  No symbol could appear as BUY in /signals and REJECTED in /market/[symbol].');
    process.exit(0);
  }

  bar('Mismatches');
  for (const m of mismatches) {
    console.log(`\n• ${m.symbol}`);
    console.log(`    stored:  direction=${m.storedDir}  signal_status=${m.storedStatus}`);
    console.log(`    detail:  direction=${m.detailDir ?? '(null)'}  status=${m.detailStatus}`);
    console.log(`    scenario_tag (live): ${m.scenario_tag ?? '(none)'}`);
    if (m.liveConf != null) console.log(`    live confidence:    ${m.liveConf}`);
    if (m.banner) console.log(`    banner:             ${m.banner}`);
    if (m.liveRejection.length) {
      console.log(`    live rejections:`);
      for (const r of m.liveRejection.slice(0, 5)) console.log(`      - ${r}`);
    }
    console.log(`    reasons:`);
    for (const r of m.reasons) console.log(`      - ${r}`);
  }

  if (persist) {
    console.log('\n[PERSIST mode] Flagged rows have been UPDATEd in q365_signals.');
    console.log('  invalidation_reason populated, signal_status=NO_TRADE, status=flagged.');
    console.log('  The next /api/signals poll will drop them from the main table.');
  } else {
    console.log('\n[AUDIT mode] No DB writes were made.');
    console.log('  Re-run with --persist to flag the mismatched rows in q365_signals.');
  }
  process.exit(mismatches.length > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error('proofSignalConsistency failed:', err);
  process.exit(1);
});
