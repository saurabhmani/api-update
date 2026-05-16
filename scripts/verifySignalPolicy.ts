/**
 * One-shot smoke test for the confirmed-signal policy contract.
 * Run with: npx tsx scripts/verifySignalPolicy.ts
 *
 * Exercises:
 *   - strictApproved (confidence/final/rr floors + classification + alive)
 *   - isBelowFloor demotion contract
 *   - confirmedSnapshotCmp DESC-by-final-then-confidence
 *   - applyConfirmedCap respects CONFIRMED_CAP_DEFAULT / HARD_MAX
 *
 * Pure spec proof. No DB, no network, no env mutation.
 */
import {
  strictApproved,
  applyConfirmedCap,
  confirmedSnapshotCmp,
  isBelowFloor,
  resolveConfirmedCap,
  STRICT_FINAL_FLOOR,
  STRICT_CONFIDENCE_FLOOR,
  STRICT_RR_FLOOR,
  CONFIRMED_CAP_DEFAULT,
  CONFIRMED_CAP_HARD_MAX,
} from '../src/lib/signals/confirmedSignalPolicy';

console.log('Floors:', {
  final: STRICT_FINAL_FLOOR,
  confidence: STRICT_CONFIDENCE_FLOOR,
  rr: STRICT_RR_FLOOR,
});
console.log('Cap:', {
  default: CONFIRMED_CAP_DEFAULT,
  hardMax: CONFIRMED_CAP_HARD_MAX,
  resolved: resolveConfirmedCap(),
});
console.log();

const cases = [
  { name: 'BUY pass',        row: { direction: 'BUY',  classification: 'HIGH_CONVICTION_BUY',           final_score: 80, confidence_score: 75, rr_ratio: 2.0 }, expect: true },
  { name: 'BUY low conf',    row: { direction: 'BUY',  classification: 'HIGH_CONVICTION_BUY',           final_score: 80, confidence_score: 65, rr_ratio: 2.0 }, expect: false },
  { name: 'BUY low rr',      row: { direction: 'BUY',  classification: 'HIGH_CONVICTION_BUY',           final_score: 80, confidence_score: 75, rr_ratio: 1.2 }, expect: false },
  { name: 'BUY low final',   row: { direction: 'BUY',  classification: 'HIGH_CONVICTION_BUY',           final_score: 70, confidence_score: 75, rr_ratio: 2.0 }, expect: false },
  { name: 'BUY invalidated', row: { direction: 'BUY',  classification: 'HIGH_CONVICTION_BUY',           final_score: 80, confidence_score: 75, rr_ratio: 2.0, invalidation_reason: 'live mismatch' }, expect: false },
  { name: 'SELL pass',       row: { direction: 'SELL', classification: 'INSTITUTIONAL_HIGH_CONVICTION', final_score: 78, confidence_score: 72, rr_ratio: 1.6 }, expect: true },
  { name: 'SELL bad cls',    row: { direction: 'SELL', classification: 'WEAK_SIGNAL',                   final_score: 78, confidence_score: 72, rr_ratio: 1.6 }, expect: false },
];

console.log('--- strictApproved cases ---');
let pass = 0, fail = 0;
for (const c of cases) {
  const got = strictApproved(c.row);
  const ok  = got === c.expect;
  if (ok) pass++; else fail++;
  console.log(`  ${ok ? 'OK' : 'FAIL'}  ${c.name.padEnd(20)} expected=${c.expect}  got=${got}  belowFloor=${isBelowFloor(c.row)}`);
}
console.log();

const many = Array.from({ length: 50 }, (_, i) => ({
  id: i,
  direction: 'BUY',
  classification: 'HIGH_CONVICTION_BUY',
  final_score:      75 + Math.random() * 20,
  confidence_score: 70 + Math.random() * 25,
  rr_ratio:         1.5 + Math.random() * 2,
}));
const sorted = many.filter(strictApproved).sort(confirmedSnapshotCmp);
const capped = applyConfirmedCap(sorted);
const monotonic = capped.every((r, i, a) =>
  i === 0 || (a[i - 1].final_score ?? 0) >= (r.final_score ?? 0));

console.log('--- sort + cap proof ---');
console.log(`  raw=${many.length}  approved=${sorted.length}  capped=${capped.length}`);
console.log(`  cap respected? ${capped.length <= resolveConfirmedCap()}`);
console.log(`  monotonic DESC by final_score? ${monotonic}`);
console.log();
console.log(`SUMMARY: ${pass}/${pass + fail} cases pass, monotonic=${monotonic}, cap_ok=${capped.length <= resolveConfirmedCap()}`);
process.exit(fail === 0 && monotonic && capped.length <= resolveConfirmedCap() ? 0 : 1);
