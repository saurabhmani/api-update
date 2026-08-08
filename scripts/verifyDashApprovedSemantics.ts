/**
 * Validates Approved display semantics without HTTP auth.
 * Run: npx tsx scripts/verifyDashApprovedSemantics.ts
 */
function displayApproved(summary: {
  approvedTotal: number | null;
  countsAvailable?: boolean;
} | null | undefined): string | number {
  const approvedTotalNum =
    typeof summary?.approvedTotal === 'number' && Number.isFinite(summary.approvedTotal)
      ? summary.approvedTotal
      : null;
  const approvedCountsOk = summary?.countsAvailable !== false && approvedTotalNum != null;
  return approvedCountsOk ? approvedTotalNum! : '—';
}

const cases = [
  { name: 'real zero', summary: { approvedTotal: 0, countsAvailable: true }, expect: 0 },
  { name: 'real five', summary: { approvedTotal: 5, countsAvailable: true }, expect: 5 },
  { name: 'query failed', summary: { approvedTotal: null, countsAvailable: false }, expect: '—' },
  { name: 'falsy trap 0||dash', summary: { approvedTotal: 0, countsAvailable: true }, expect: 0 },
  { name: 'missing summary', summary: null, expect: '—' },
];

let failed = 0;
for (const c of cases) {
  const got = displayApproved(c.summary as any);
  const ok = got === c.expect;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${c.name}: got=${JSON.stringify(got)} expect=${JSON.stringify(c.expect)}`);
}
// Prove the classic bug
const buggy = (0 as number | null) ? (0 as number) : '—';
console.log(`classic truthy bug 0 ? 0 : '—'; → ${JSON.stringify(buggy)} (must be em-dash if buggy)`);
process.exit(failed ? 1 : 0);
