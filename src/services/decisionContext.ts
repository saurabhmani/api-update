// ════════════════════════════════════════════════════════════════
//  Decision Pipeline Context — Bypass Prevention Guard
//
//  PRD Rule: There is ONE decision entry point.
//
//  This module tracks whether a risk or governance evaluation is
//  being called from within the decision orchestrator (legitimate)
//  or from outside it (bypass violation).
//
//  Usage:
//    Orchestrator sets: enterOrchestratorContext() / exitOrchestratorContext()
//    Services check:    assertOrchestratorContext('evaluatePreTrade')
//
//  If a service detects a bypass, it logs a warning and tags the
//  result so downstream systems know the decision was not made
//  through the full institutional gate chain.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';

const log = logger.child({ service: 'decisionContext' });

// In-process flag tracking whether the orchestrator is the active caller.
// Uses a counter (not boolean) to handle nested/concurrent calls correctly.
let _orchestratorDepth = 0;

/** Called by the orchestrator at the start of evaluateInstitutionalDecision */
export function enterOrchestratorContext(): void {
  _orchestratorDepth++;
}

/** Called by the orchestrator at the end of evaluateInstitutionalDecision */
export function exitOrchestratorContext(): void {
  _orchestratorDepth = Math.max(0, _orchestratorDepth - 1);
}

/** Returns true if we're currently inside the orchestrator's execution */
export function isInsideOrchestrator(): boolean {
  return _orchestratorDepth > 0;
}

/**
 * Assert that the current call is inside the orchestrator.
 * If not, log a bypass warning. Does NOT throw — the service still
 * runs but the violation is recorded for audit.
 *
 * Returns true if inside orchestrator, false if bypass detected.
 */
export function assertOrchestratorContext(serviceName: string): boolean {
  if (_orchestratorDepth > 0) return true;

  log.error('DECISION BYPASS DETECTED', {
    service: serviceName,
    message: `${serviceName} called outside decisionOrchestrator — this is an institutional violation. ` +
             `All trade decisions MUST go through evaluateInstitutionalDecision().`,
    stack: new Error().stack,
  });

  return false;
}
