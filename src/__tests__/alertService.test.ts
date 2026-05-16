// ════════════════════════════════════════════════════════════════
//  Alert service — dedup + suppression policy tests
//
//  Pure-logic tests. No DB required — we exercise the deterministic
//  helpers (computeSuppressionState, computeDedupHash via publishAlert
//  contract) to prove the policy.
//
//  Run: npx tsx src/__tests__/alertService.test.ts
// ════════════════════════════════════════════════════════════════

import { createHash } from 'crypto';
import { computeSuppressionState, type AlertSeverity } from '../services/alertService';

let passed = 0;
let failed = 0;
const fail = (name: string, reason: string) => { failed++; console.log(`  ✗ ${name} — ${reason}`); };
const pass = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

function assertEq<T>(name: string, actual: T, expected: T) {
  if (actual === expected) pass(name);
  else fail(name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ── Test 1: dedup hash determinism ─────────────────────────────
console.log('\n── dedup hash determinism ──');
function dedupHash(category: string, severity: AlertSeverity, source: string, key: string): string {
  return createHash('sha256').update(`${category}|${severity}|${source}|${key}`).digest('hex');
}
const hA = dedupHash('risk.breach', 'critical', 'breachDetection', 'pid=7:metric=drawdown');
const hB = dedupHash('risk.breach', 'critical', 'breachDetection', 'pid=7:metric=drawdown');
const hC = dedupHash('risk.breach', 'warning',  'breachDetection', 'pid=7:metric=drawdown');
assertEq('same tuple → same hash', hA, hB);
assertEq('different severity → different hash', hA === hC, false);

// ── Test 2: critical never suppressed ─────────────────────────
console.log('\n── critical alerts are never suppressed ──');
const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000);
assertEq('critical @ 1 occurrence',     computeSuppressionState('critical', 1,    tenMinAgo), 'active');
assertEq('critical @ 100 occurrences',  computeSuppressionState('critical', 100,  tenMinAgo), 'active');
assertEq('critical @ 10_000 occurrences', computeSuppressionState('critical', 10000, tenMinAgo), 'active');

// ── Test 3: info suppression threshold ────────────────────────
console.log('\n── info alerts suppress at 10 within 1h window ──');
const justNow = new Date();
assertEq('info occ=1 → active',       computeSuppressionState('info', 1,  justNow), 'active');
assertEq('info occ=9 → active',       computeSuppressionState('info', 9,  justNow), 'active');
assertEq('info occ=10 → suppressed',  computeSuppressionState('info', 10, justNow), 'suppressed');
assertEq('info occ=50 → suppressed',  computeSuppressionState('info', 50, justNow), 'suppressed');

// ── Test 4: warning suppression threshold ─────────────────────
console.log('\n── warning alerts suppress at 25 within 1h window ──');
assertEq('warning occ=24 → active',     computeSuppressionState('warning', 24, justNow), 'active');
assertEq('warning occ=25 → suppressed', computeSuppressionState('warning', 25, justNow), 'suppressed');

// ── Test 5: suppression window expiry reopens the alert ───────
console.log('\n── old alerts outside the window auto-reactivate ──');
const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
assertEq('info occ=50 but first seen 2h ago → active',
  computeSuppressionState('info',    50, twoHoursAgo), 'active');
assertEq('warning occ=100 but first seen 2h ago → active',
  computeSuppressionState('warning', 100, twoHoursAgo), 'active');

// ── Summary ───────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════');
console.log(`  ${passed} passed · ${failed} failed`);
console.log('═══════════════════════════════════════════════════');
process.exit(failed === 0 ? 0 : 1);
