/**
 * Audit closed-market / tier-classifier approval routing.
 * Flags rows that would land in APPROVED but fail institutional gates.
 *
 * Usage: npx tsx scripts/auditApprovedSignals.ts
 */
import { loadClosedMarketSignals } from '../src/lib/signals/closedMarketSignals';
import {
  mainTableApproved,
  strictApproved,
  relaxedMainTableApproved,
} from '../src/lib/signals/confirmedSignalPolicy';
import {
  isExecutionReady,
  partitionByTier,
  selectHighPotentialFallback,
  type TieredRow,
} from '../src/lib/signals/signalTierClassifier';

async function main() {
  const bundle = await loadClosedMarketSignals({ limit: 50 });
  const rows = bundle.signals ?? [];

  console.log('=== APPROVAL AUDIT ===');
  console.log({
    quality: bundle.signalQuality,
    strictCount: bundle.strictCount,
    relaxedUsed: bundle.relaxedUsed,
    rowCount: rows.length,
  });

  const closedOpts = { closedMarket: true } as const;
  let mistakenApproved = 0;
  let genuineApproved = 0;

  for (const r of rows) {
    const sym = String((r as { symbol?: string }).symbol ?? '?');
    const main = mainTableApproved(r, closedOpts);
    const strict = strictApproved(r);
    const relaxed = relaxedMainTableApproved(r, closedOpts);
    const execReady = isExecutionReady(r as TieredRow);
    const tier = partitionByTier([r as TieredRow]).approved.length > 0 ? 'APPROVED' : 'other';

    const mistaken =
      tier === 'APPROVED' && (!main || (r as { is_conditional?: boolean }).is_conditional === true);
    if (mistaken) mistakenApproved++;
    if (tier === 'APPROVED' && main && !(r as { is_conditional?: boolean }).is_conditional) {
      genuineApproved++;
    }

    console.log({
      symbol: sym,
      tier,
      mainTableApproved: main,
      strictApproved: strict,
      relaxedMainTableApproved: relaxed,
      isExecutionReady: execReady,
      is_relaxed: (r as { is_relaxed?: boolean }).is_relaxed ?? false,
      is_conditional: (r as { is_conditional?: boolean }).is_conditional ?? false,
      mistaken: mistaken ? 'YES' : 'no',
    });
  }

  const part = partitionByTier(rows as TieredRow[]);
  const hiPot = selectHighPotentialFallback([
    ...part.developing,
    ...part.scannerCandidates,
  ]);

  console.log('\n=== PARTITION SUMMARY ===');
  console.log({
    approved: part.approved.length,
    developing: part.developing.length,
    highPotentialFallback: hiPot.length,
    mistakenApproved,
    genuineApproved,
  });

  if (mistakenApproved > 0) {
    console.error(`\nFAIL: ${mistakenApproved} row(s) would be falsely approved`);
    process.exit(1);
  }
  console.log('\nPASS: no false APPROVED promotions detected');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
