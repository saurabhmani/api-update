// ════════════════════════════════════════════════════════════════
//  AI Boundary — Enforcement tests
//
//  PRD: AI must NEVER influence decision outcomes.
//
//  These tests exercise the aiBoundary module directly. They DO NOT
//  touch the DB. The purpose is to prove:
//    1. Valid AI output (summarize/explain/narrate) passes through.
//    2. Any forbidden decision field is stripped, not merged.
//    3. Invalid operations are rejected outright.
//    4. composeDecisionWithNarrative() keeps deterministic fields
//       untouched when AI output contradicts them.
//
//  Run: npx tsx src/__tests__/aiBoundary.test.ts
// ════════════════════════════════════════════════════════════════

import {
  sanitizeAIOutput,
  composeDecisionWithNarrative,
  AIBoundaryViolationError,
  type DeterministicDecision,
} from '../services/aiBoundary';

let passed = 0;
let failed = 0;
const pass = (name: string) => { passed++; console.log(`  ✓ ${name}`); };
const fail = (name: string, reason: string) => { failed++; console.log(`  ✗ ${name} — ${reason}`); };

function assert(name: string, cond: boolean, reason = '') {
  if (cond) pass(name); else fail(name, reason);
}
function assertThrows(name: string, fn: () => unknown, predicate: (e: unknown) => boolean) {
  try { fn(); fail(name, 'did not throw'); }
  catch (e) { assert(name, predicate(e), `wrong error: ${(e as Error).message}`); }
}

// ── Test 1: valid summarize passes untouched ─────────────────
console.log('\n── valid AI output passes through ──');
{
  const out = sanitizeAIOutput({
    operation: 'summarize',
    subject: 'Portfolio Risk',
    summary: 'Concentration is high in energy.',
    disclaimer: 'advisory only',
    generatedAt: '2026-04-16T00:00:00Z',
  });
  assert('operation preserved', out.operation === 'summarize');
  assert('summary preserved', out.summary === 'Concentration is high in energy.');
  assert('_boundary.passed = true', out._boundary.passed === true);
  assert('no fields stripped', out._boundary.strippedFields.length === 0);
}

// ── Test 2: AI tries to approve a trade → decision field stripped ──
console.log('\n── AI attempt to set decision=approved → stripped ──');
{
  const out = sanitizeAIOutput({
    operation: 'explain',
    subject: 'RELIANCE',
    summary: 'Strong momentum.',
    disclaimer: 'x',
    generatedAt: '2026-04-16T00:00:00Z',
    // ── forbidden ──────────────────────────────────────
    decision: 'approved',
    finalVerdict: 'actionable',
    recommendedQuantity: 9999,
    riskScore: 10,
  });
  assert('decision field absent', !('decision' in out));
  assert('finalVerdict absent',   !('finalVerdict' in out));
  assert('recommendedQuantity absent', !('recommendedQuantity' in out));
  assert('riskScore absent', !('riskScore' in out));
  assert('summary preserved',  out.summary === 'Strong momentum.');
  assert('_boundary.passed = false', out._boundary.passed === false);
  assert('stripped list has decision', out._boundary.strippedFields.includes('decision'));
  assert('stripped list has riskScore', out._boundary.strippedFields.includes('riskScore'));
}

// ── Test 3: nested attempt to override via a sub-object ─────
console.log('\n── nested forbidden fields also stripped ──');
{
  const out = sanitizeAIOutput({
    operation: 'narrate',
    subject: 'X',
    summary: 's',
    disclaimer: 'x',
    generatedAt: 'now',
    meta: { decision: 'approved', harmless: 'keep me' },
  });
  const meta = out.meta as Record<string, unknown>;
  assert('nested decision stripped', !('decision' in meta));
  assert('nested harmless preserved', meta.harmless === 'keep me');
  assert('stripped list notes nested path', out._boundary.strippedFields.includes('meta.decision'));
}

// ── Test 4: invalid operation → throws ──────────────────────
console.log('\n── invalid AI operation throws ──');
assertThrows(
  'operation=decide is rejected',
  () => sanitizeAIOutput({ operation: 'decide', subject: 'x', summary: 's', disclaimer: '', generatedAt: '' }),
  (e) => e instanceof AIBoundaryViolationError,
);
assertThrows(
  'missing operation is rejected',
  () => sanitizeAIOutput({ subject: 'x', summary: 's', disclaimer: '', generatedAt: '' }),
  (e) => e instanceof AIBoundaryViolationError,
);

// ── Test 5: strict mode throws on violation ─────────────────
console.log('\n── strict mode throws on any forbidden field ──');
assertThrows(
  'strict + decision = throw',
  () => sanitizeAIOutput({
    operation: 'summarize',
    subject: 'x', summary: 's', disclaimer: '', generatedAt: '',
    decision: 'rejected_risk',
  }, { strict: true }),
  (e) => e instanceof AIBoundaryViolationError
        && (e as AIBoundaryViolationError).strippedFields.includes('decision'),
);

// ── Test 6: composeDecisionWithNarrative — orchestrator wins ──
console.log('\n── orchestrator decision overrides any AI-produced field ──');
{
  const deterministic: DeterministicDecision = {
    decision: 'rejected_governance',
    decisionReason: 'Governance failed: sector cap',
    decisionId: 'DEC-20260416-0001',
    riskScore: 72,
    governanceStatus: 'fail',
    recommendedQuantity: 0,
  };
  const aiAttempt = {
    operation: 'explain',
    subject: 'RELIANCE',
    summary: 'AI thinks this is a buy',
    disclaimer: 'x',
    generatedAt: 'now',
    // These must NOT reach the composed output
    decision: 'approved',
    recommendedQuantity: 500,
    riskScore: 10,
    governanceStatus: 'pass',
  };
  const composed = composeDecisionWithNarrative(deterministic, aiAttempt);
  assert('decision stays rejected_governance',     composed.decision === 'rejected_governance');
  assert('recommendedQuantity stays 0',            composed.recommendedQuantity === 0);
  assert('riskScore stays 72',                     composed.riskScore === 72);
  assert('governanceStatus stays fail',            composed.governanceStatus === 'fail');
  assert('narrative.summary from AI preserved',    composed.narrative.summary === 'AI thinks this is a buy');
  assert('narrative flags the bypass',             composed.narrative._boundary.passed === false);
  assert('narrative drops AI decision field',      !('decision' in composed.narrative));
}

// ── Test 7: empty / adversarial inputs ──────────────────────
console.log('\n── adversarial inputs are rejected ──');
assertThrows(
  'null input',
  () => sanitizeAIOutput(null),
  (e) => e instanceof AIBoundaryViolationError,
);
assertThrows(
  'array input',
  () => sanitizeAIOutput([{ operation: 'summarize' }]),
  (e) => e instanceof AIBoundaryViolationError,
);

// ── Summary ───────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════');
console.log(`  ${passed} passed · ${failed} failed`);
console.log('═══════════════════════════════════════════════════');
process.exit(failed === 0 ? 0 : 1);
