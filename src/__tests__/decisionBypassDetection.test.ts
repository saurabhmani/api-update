// ════════════════════════════════════════════════════════════════
//  Decision Bypass Detection — Architectural Validation
//
//  PRD RULE: There is ONE decision entry point.
//  evaluateInstitutionalDecision() is the ONLY path.
//
//  This test statically analyzes the codebase to ensure:
//    1. No service calls evaluatePreTrade outside the orchestrator
//    2. No service calls evaluateGovernance outside the orchestrator
//    3. No code produces trade approval/rejection outside the orchestrator
//    4. The bypass guard is present in both gated services
//
//  Run: npx tsx src/__tests__/decisionBypassDetection.test.ts
// ════════════════════════════════════════════════════════════════

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const ORCHESTRATOR = 'services/decisionOrchestrator.ts';

// ── Files that are ALLOWED to call evaluatePreTrade/evaluateGovernance ──
const ALLOWED_CALLERS = new Set([
  'services/decisionOrchestrator.ts',       // THE single decision pipeline
  'services/preTradeGatewayService.ts',     // definition
  'services/governanceService.ts',          // definition
]);

// ── Collect all .ts files recursively ──────────────────────────
function collectFiles(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
      collectFiles(full, files);
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

// ── Test 1: No direct evaluatePreTrade calls outside orchestrator ──
function testNoPreTradeBypass(): { passed: boolean; violations: string[] } {
  const violations: string[] = [];
  const files = collectFiles(ROOT);

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (ALLOWED_CALLERS.has(rel)) continue;
    if (rel.includes('__tests__') || rel.includes('.test.')) continue;

    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match actual function calls, not imports, type references, or string literals
      if (line.includes('evaluatePreTrade(') && !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.includes('import') && !line.includes("'evaluatePreTrade'")) {
        violations.push(`${rel}:${i + 1} — calls evaluatePreTrade() directly`);
      }
    }
  }

  return { passed: violations.length === 0, violations };
}

// ── Test 2: No direct evaluateGovernance calls outside orchestrator ──
function testNoGovernanceBypass(): { passed: boolean; violations: string[] } {
  const violations: string[] = [];
  const files = collectFiles(ROOT);

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (ALLOWED_CALLERS.has(rel)) continue;
    if (rel.includes('__tests__') || rel.includes('.test.')) continue;

    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.includes('evaluateGovernance(') && !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.includes('import') && !line.includes("'evaluateGovernance'")) {
        violations.push(`${rel}:${i + 1} — calls evaluateGovernance() directly`);
      }
    }
  }

  return { passed: violations.length === 0, violations };
}

// ── Test 3: Bypass guard is present ──
function testBypassGuardPresent(): { passed: boolean; details: string[] } {
  const details: string[] = [];

  const preTradePath = path.join(ROOT, 'services', 'preTradeGatewayService.ts');
  const govPath = path.join(ROOT, 'services', 'governanceService.ts');

  const preTradeContent = fs.readFileSync(preTradePath, 'utf-8');
  const govContent = fs.readFileSync(govPath, 'utf-8');

  const preTradeHasGuard = preTradeContent.includes("assertOrchestratorContext('evaluatePreTrade')");
  const govHasGuard = govContent.includes("assertOrchestratorContext('evaluateGovernance')");

  if (!preTradeHasGuard) details.push('preTradeGatewayService.ts missing assertOrchestratorContext guard');
  if (!govHasGuard) details.push('governanceService.ts missing assertOrchestratorContext guard');

  return { passed: preTradeHasGuard && govHasGuard, details };
}

// ── Test 4: No duplicate decision logic (finalVerdict outside orchestrator) ──
function testNoDuplicateDecisionLogic(): { passed: boolean; violations: string[] } {
  const violations: string[] = [];
  const files = collectFiles(ROOT);

  // Patterns that indicate decision-making outside the orchestrator
  const decisionPatterns = [
    /finalVerdict\s*=\s*['"](?:actionable|restricted|rejected|review_required)['"]/,
    /decision\s*=\s*['"](?:approved|rejected_risk|rejected_governance)['"]/,
  ];

  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    if (rel === ORCHESTRATOR) continue;
    if (rel.includes('__tests__')) continue;
    if (rel.includes('.test.')) continue;

    const content = fs.readFileSync(file, 'utf-8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;

      for (const pat of decisionPatterns) {
        if (pat.test(line)) {
          // Allow switch/case mapping FROM orchestrator results (which is fine)
          // These patterns indicate the code is reading from decision.decision,
          // not making an independent decision.
          if (line.includes('case ') || line.includes('decision.decision') || line.includes("decision ===")) continue;
          // Allow assignments inside switch blocks that map orchestrator output
          // Look backwards for a switch statement on the orchestrator decision
          const contextBlock = lines.slice(Math.max(0, i - 20), i + 1).join('\n');
          if (contextBlock.includes('switch (decision.decision)') || contextBlock.includes('switch(decision.decision)')) continue;
          violations.push(`${rel}:${i + 1} — contains decision assignment: ${line.trim().substring(0, 80)}`);
        }
      }
    }
  }

  return { passed: violations.length === 0, violations };
}

// ── Run all tests ──────────────────────────────────────────────
function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Decision Bypass Detection — Architectural Audit');
  console.log('═══════════════════════════════════════════════════\n');

  let allPassed = true;

  // Test 1
  const t1 = testNoPreTradeBypass();
  console.log(`${t1.passed ? '✓' : '✗'} No direct evaluatePreTrade calls outside orchestrator`);
  if (!t1.passed) { allPassed = false; t1.violations.forEach(v => console.log(`    ${v}`)); }

  // Test 2
  const t2 = testNoGovernanceBypass();
  console.log(`${t2.passed ? '✓' : '✗'} No direct evaluateGovernance calls outside orchestrator`);
  if (!t2.passed) { allPassed = false; t2.violations.forEach(v => console.log(`    ${v}`)); }

  // Test 3
  const t3 = testBypassGuardPresent();
  console.log(`${t3.passed ? '✓' : '✗'} Bypass guards present in gated services`);
  if (!t3.passed) { allPassed = false; t3.details.forEach(d => console.log(`    ${d}`)); }

  // Test 4
  const t4 = testNoDuplicateDecisionLogic();
  console.log(`${t4.passed ? '✓' : '✗'} No duplicate decision logic outside orchestrator`);
  if (!t4.passed) { allPassed = false; t4.violations.forEach(v => console.log(`    ${v}`)); }

  console.log('\n' + (allPassed
    ? '══ ALL CHECKS PASSED ══  No decision bypasses detected.'
    : '══ VIOLATIONS FOUND ══  Fix the above before deploying.'));

  process.exit(allPassed ? 0 : 1);
}

main();
