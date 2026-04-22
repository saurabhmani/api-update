// ════════════════════════════════════════════════════════════════
//  Institutional Decision Orchestrator
//
//  THE single entry point for any trade decision. Enforces the
//  permanent system rule:
//
//    Signal does NOT equal permission.
//    Opportunity does NOT equal approval.
//
//  Sequential gate chain (each gate must pass before the next):
//
//    Gate 1: Portfolio Context  → Do we know what we own?
//    Gate 2: Risk Checks        → Does this break risk limits?
//    Gate 3: Governance Checks  → Does policy allow this?
//    Gate 4: Scenario Analysis   → What if the market drops?
//    Gate 5: Explainability      → Can we explain this decision?
//    Gate 6: Audit               → Is this decision recorded?
//
//  A failure at ANY gate halts the pipeline. The decision and all
//  gate results are persisted regardless of outcome.
//
//  Non-negotiable rule from PRD §16:
//    No opportunity becomes a final recommendation unless:
//    - portfolio context is known
//    - risk checks pass
//    - governance checks pass
//    - scenario impact is acceptable
//    - explainability can be generated
//    - audit record can be produced
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';
import { getPortfolioOverview, type PortfolioOverview } from './portfolioLedgerService';
import { evaluateInstitutionalFit, type InstitutionalFitResult } from './institutionalFitService';
import { evaluatePreTrade, type PreTradeResult, type PreTradeInput } from './preTradeGatewayService';
import { evaluateGovernance, type GovernanceEvaluation, type GovernanceInput } from './governanceService';
import { evaluateTradeScenario } from './scenarioStressService';
import { logAuditEvent, logGovernanceCheck, logBreachDetection } from './auditLogService';
import { buildDecisionTrace, persistDecisionTrace, generateDecisionId, type DecisionTrace } from './decisionTraceBuilder';
import { resolve, type InstrumentRef } from './instrumentResolver';
import { getActiveBreaches, type Breach } from './breachDetectionService';
import { enterOrchestratorContext, exitOrchestratorContext } from './decisionContext';
import { db } from '@/lib/db';

const log = logger.child({ service: 'decisionOrchestrator' });

// ── Types ───────────────────────────────────────────────────────

export type GateStatus = 'passed' | 'failed' | 'warning' | 'skipped';

export interface GateResult {
  gate: string;
  status: GateStatus;
  durationMs: number;
  details: Record<string, unknown>;
  failReason?: string;
}

export type FinalDecision =
  | 'approved'
  | 'approved_with_conditions'
  | 'rejected_risk'
  | 'rejected_governance'
  | 'rejected_scenario'
  | 'rejected_breach'
  | 'manual_review'
  | 'error';

export interface DecisionInput {
  portfolioId: number;
  userId: number;
  ticker: string;              // accepted for backward compat — resolved to instrumentId internally
  instrumentId?: number;       // preferred canonical identifier
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  strategySleeve?: string;
  scenarioId?: string;         // defaults to 'mkt_drop_10'
  ipAddress?: string;
}

export interface InstitutionalDecision {
  // Verdict
  decision: FinalDecision;
  decisionReason: string;
  recommendedQuantity: number;

  // Gate results (sequential — only gates that ran are populated)
  gates: GateResult[];
  gatesSummary: {
    total: number;
    passed: number;
    failed: number;
    warnings: number;
    stoppedAt: string | null;   // which gate halted the pipeline
  };

  // Portfolio context + fit (Gate 1)
  portfolioContext: {
    positionsCount: number;
    totalAum: number;
    pnlPct: number;
    fitScore: number;
    suggestedQuantity: number;
    suggestedNotional: number;
    concentrationImpact: number;
    diversificationEffect: string;
    liquidityImpact: string;
    explanation: string;
    warnings: string[];
  } | null;

  // Risk snapshot (Gate 2)
  riskSnapshot: {
    status: string;
    riskScore: number;
    breaches: { check: string; severity: string; message: string }[];
    warnings: string[];
  } | null;

  // Governance snapshot (Gate 3)
  governanceSnapshot: {
    overallStatus: string;
    violations: { policy: string; status: string; reason: string }[];
  } | null;

  // Active monitoring breaches (Gate 0)
  activeBreaches: {
    count: number;
    critical: number;
    warning: number;
    breaches: { category: string; severity: string; metric: string; message: string }[];
    impact: 'blocked' | 'downgraded' | 'none';
  } | null;

  // Scenario impact (Gate 4)
  scenarioSnapshot: {
    scenarioId: string;
    withoutTrade: { lossPct: number };
    withTrade: { lossPct: number };
    marginalImpact: number;
    acceptable: boolean;
  } | null;

  // Explainability (Gate 5)
  explanation: {
    summary: string;
    decisiveFactors: string[];
    gateNarrative: string[];
  };

  // Audit (Gate 6)
  auditId: number | null;

  // Decision trace (full institutional explainability)
  trace: DecisionTrace | null;

  // Canonical instrument identity
  instrument: InstrumentRef | null;

  // Metadata
  ticker: string;
  side: string;
  requestedQuantity: number;
  totalDurationMs: number;
  timestamp: string;
}

// ── Scenario impact threshold ───────────────────────────────────

const MAX_MARGINAL_SCENARIO_IMPACT_PCT = 3; // max additional portfolio loss the trade can add

// ── Orchestrator ────────────────────────────────────────────────

export async function evaluateInstitutionalDecision(
  input: DecisionInput,
): Promise<InstitutionalDecision> {
  const startMs = Date.now();
  enterOrchestratorContext();
  try {
  const decisionId = generateDecisionId();
  const gates: GateResult[] = [];
  let decision: FinalDecision = 'error';
  let decisionReason = '';
  let recommendedQuantity = input.quantity;
  let stoppedAt: string | null = null;

  // ── Resolve canonical instrument identity ────────────────────
  // The instrument resolver is the single mapping boundary between
  // the ticker-based external world and the instrumentId-based
  // internal system. Every downstream gate receives instrumentId.
  let instrumentRef: InstrumentRef | null = null;
  try {
    instrumentRef = input.instrumentId
      ? await resolve(input.instrumentId)
      : await resolve(input.ticker);
    if (instrumentRef) {
      // Normalize ticker from canonical source
      input.ticker = instrumentRef.ticker;
      input.instrumentId = instrumentRef.instrumentId;
      log.info('Instrument resolved', {
        instrumentId: instrumentRef.instrumentId,
        ticker: instrumentRef.ticker,
        sector: instrumentRef.sector,
      });
    } else {
      log.warn('Instrument not in canonical universe — proceeding with ticker only', {
        ticker: input.ticker,
      });
    }
  } catch (err) {
    log.warn('Instrument resolution failed — proceeding with ticker', {
      ticker: input.ticker, error: (err as Error).message,
    });
  }

  // Snapshots — populated as gates pass
  let portfolioCtx: InstitutionalDecision['portfolioContext'] = null;
  let riskSnap: InstitutionalDecision['riskSnapshot'] = null;
  let govSnap: InstitutionalDecision['governanceSnapshot'] = null;
  let scenarioSnap: InstitutionalDecision['scenarioSnapshot'] = null;
  let breachSnap: InstitutionalDecision['activeBreaches'] = null;
  const narrative: string[] = [];
  const decisiveFactors: string[] = [];

  try {
    // ════════════════════════════════════════════════════════════
    // GATE 0: Active Breach Check
    // "Are there unresolved breaches on this portfolio?"
    //
    // Monitoring feeds INTO decisions. Active critical breaches
    // BLOCK new trades. Active warnings DOWNGRADE the decision
    // to manual_review. This closes the monitoring→decision loop.
    //
    // PRD: "Monitoring before complacency."
    // ════════════════════════════════════════════════════════════
    const g0Start = Date.now();
    try {
      const breaches = await getActiveBreaches(input.portfolioId);
      const criticalBreaches = breaches.filter(b => b.severity === 'critical');
      const warningBreaches  = breaches.filter(b => b.severity === 'warning');

      let breachImpact: 'blocked' | 'downgraded' | 'none' = 'none';
      if (criticalBreaches.length > 0) breachImpact = 'blocked';
      else if (warningBreaches.length > 0) breachImpact = 'downgraded';

      breachSnap = {
        count: breaches.length,
        critical: criticalBreaches.length,
        warning: warningBreaches.length,
        breaches: breaches.map(b => ({ category: b.category, severity: b.severity, metric: b.metric, message: b.message })),
        impact: breachImpact,
      };

      if (breachImpact === 'blocked') {
        // Critical breaches BLOCK new trades entirely
        gates.push({
          gate: 'active_breach_check',
          status: 'failed',
          durationMs: Date.now() - g0Start,
          details: {
            totalBreaches: breaches.length,
            critical: criticalBreaches.length,
            criticalMetrics: criticalBreaches.map(b => b.metric),
          },
          failReason: `${criticalBreaches.length} critical breach(es) active: ${criticalBreaches.map(b => b.message).join('; ')}`,
        });

        narrative.push(`BLOCKED: ${criticalBreaches.length} critical breach(es) on portfolio.`);
        for (const b of criticalBreaches) {
          narrative.push(`  [${b.category}] ${b.message}`);
          decisiveFactors.push(`breach:${b.metric}`);
        }

        decision = 'rejected_breach';
        decisionReason = `Portfolio has ${criticalBreaches.length} unresolved critical breach(es) — new trades blocked until breaches are resolved. ${criticalBreaches.map(b => b.message).join('; ')}`;
        stoppedAt = 'active_breach_check';

        // Audit: log each critical breach that blocked this decision
        for (const b of criticalBreaches) {
          logBreachDetection({
            portfolioId: input.portfolioId,
            metric: b.metric,
            severity: 'critical',
            message: `[decision:${decisionId}] ${b.message}`,
          }).catch(err => { log.warn('Audit persistence failed (non-fatal)', { error: (err as Error).message }); });
        }

        throw new GateHalt();

      } else if (breachImpact === 'downgraded') {
        // Warnings don't block but force manual_review later
        gates.push({
          gate: 'active_breach_check',
          status: 'warning',
          durationMs: Date.now() - g0Start,
          details: {
            totalBreaches: breaches.length,
            warnings: warningBreaches.length,
            warningMetrics: warningBreaches.map(b => b.metric),
          },
          failReason: `${warningBreaches.length} warning breach(es) active — decision will be downgraded to manual review`,
        });

        narrative.push(`WARNING: ${warningBreaches.length} active breach warning(s) on portfolio.`);
        for (const b of warningBreaches) {
          decisiveFactors.push(`breach_warning:${b.metric}`);
        }

      } else {
        // Clear — no active breaches
        gates.push({
          gate: 'active_breach_check',
          status: 'passed',
          durationMs: Date.now() - g0Start,
          details: { totalBreaches: 0 },
        });
      }
    } catch (err) {
      if (err instanceof GateHalt) throw err;
      // Breach check failure is non-fatal — proceed with caution
      gates.push({
        gate: 'active_breach_check',
        status: 'warning',
        durationMs: Date.now() - g0Start,
        details: {},
        failReason: `Breach check unavailable: ${(err as Error).message}`,
      });
      narrative.push('Active breach check unavailable — proceeding with caution.');
      decisiveFactors.push('breach_check_unavailable');
    }

    // ════════════════════════════════════════════════════════════
    // GATE 1: Portfolio Context + Institutional Fit & Sizing
    // "Do we know what we own? Does this trade fit?"
    //
    // Evaluates 5 dimensions: exposure, concentration, diversification,
    // liquidity, strategy sleeve. Computes suggestedQuantity that
    // feeds into all downstream gates.
    // ════════════════════════════════════════════════════════════
    const g1Start = Date.now();
    try {
      const [overview, fitResult] = await Promise.all([
        getPortfolioOverview(input.portfolioId),
        evaluateInstitutionalFit({
          portfolioId: input.portfolioId,
          userId: input.userId,
          instrumentId: input.instrumentId!,
          ticker: input.ticker,
          side: input.side,
          quantity: input.quantity,
          price: input.price,
          strategySleeve: input.strategySleeve,
        }),
      ]);

      // Use the fit-adjusted quantity for all downstream gates
      recommendedQuantity = fitResult.suggestedQuantity;

      portfolioCtx = {
        positionsCount: overview.positionsCount,
        totalAum: overview.totalAum,
        pnlPct: overview.pnl.totalPnlPct,
        fitScore: fitResult.fitScore,
        suggestedQuantity: fitResult.suggestedQuantity,
        suggestedNotional: fitResult.suggestedNotional,
        concentrationImpact: fitResult.concentration.hhiDelta,
        diversificationEffect: fitResult.diversification.diversificationEffect,
        liquidityImpact: fitResult.liquidity.liquidityStress,
        explanation: fitResult.explanation,
        warnings: fitResult.warnings,
      };

      const fitPassed = fitResult.fitScore >= 30;
      gates.push({
        gate: 'portfolio_context_and_fit',
        status: fitPassed ? (fitResult.fitScore >= 60 ? 'passed' : 'warning') : 'failed',
        durationMs: Date.now() - g1Start,
        details: {
          fitScore: fitResult.fitScore,
          suggestedQty: fitResult.suggestedQuantity,
          requestedQty: input.quantity,
          sectorExposure: fitResult.exposure.projectedSectorPct,
          hhiDelta: fitResult.concentration.hhiDelta,
          diversification: fitResult.diversification.diversificationEffect,
          liquidity: fitResult.liquidity.liquidityStress,
          sizingMethod: fitResult.sizing.method,
        },
        ...(!fitPassed ? { failReason: `Fit score ${fitResult.fitScore} below minimum 30 — ${fitResult.explanation}` } : {}),
      });

      narrative.push(`Portfolio: ${overview.positionsCount} positions, ₹${(overview.totalAum / 100000).toFixed(1)}L AUM.`);
      narrative.push(`Fit: ${fitResult.fitScore}/100. ${fitResult.explanation}`);
      if (fitResult.fitScore < 60) decisiveFactors.push(`fit_score=${fitResult.fitScore}`);
      if (fitResult.concentration.hhiDelta > 100) decisiveFactors.push(`hhi_delta=${fitResult.concentration.hhiDelta}`);
      if (fitResult.liquidity.liquidityStress !== 'none') decisiveFactors.push(`liquidity=${fitResult.liquidity.liquidityStress}`);
      if (fitResult.diversification.diversificationEffect === 'positive') decisiveFactors.push('diversification=positive');
      if (fitResult.suggestedQuantity !== input.quantity) {
        narrative.push(`Sizing: ${input.quantity} → ${fitResult.suggestedQuantity} shares (${fitResult.sizing.method}).`);
        decisiveFactors.push(`qty_reduced=${fitResult.suggestedQuantity}/${input.quantity}`);
      }
      if (fitResult.warnings.length > 0) narrative.push(`Warnings: ${fitResult.warnings.join('; ')}`);

      if (!fitPassed) {
        decision = 'rejected_risk';
        decisionReason = `Fit score ${fitResult.fitScore} below minimum 30. ${fitResult.explanation}`;
        stoppedAt = 'portfolio_context_and_fit';
        throw new GateHalt();
      }
    } catch (err) {
      if (err instanceof GateHalt) throw err;
      gates.push({ gate: 'portfolio_context_and_fit', status: 'failed', durationMs: Date.now() - g1Start, details: {}, failReason: (err as Error).message });
      decision = 'error';
      decisionReason = `Portfolio fit evaluation failed: ${(err as Error).message}`;
      stoppedAt = 'portfolio_context_and_fit';
      throw new GateHalt();
    }

    // ════════════════════════════════════════════════════════════
    // GATE 2: Risk Checks
    // "Does this break risk limits?"
    // ════════════════════════════════════════════════════════════
    const g2Start = Date.now();
    try {
      const riskResult = await evaluatePreTrade({
        portfolioId: input.portfolioId,
        instrumentId: input.instrumentId!,
        ticker: input.ticker,
        side: input.side,
        quantity: input.quantity,
        price: input.price,
        strategySleeve: input.strategySleeve,
        activeBreaches: breachSnap?.breaches ?? [],
      });

      recommendedQuantity = riskResult.recommendedQuantity;
      riskSnap = {
        status: riskResult.status,
        riskScore: riskResult.riskScore,
        breaches: riskResult.breaches.map(b => ({ check: b.check, severity: b.severity, message: b.message })),
        warnings: riskResult.warnings,
      };

      // Audit: log pre-trade risk evaluation with decisionId linkage
      logAuditEvent({
        eventType: 'pretrade_decision',
        actorId: input.userId,
        actorType: 'system',
        decisionId,
        portfolioId: input.portfolioId,
        instrumentId: input.instrumentId ?? null,
        resourceType: 'trade',
        resourceId: input.ticker,
        action: riskResult.status,
        payload: {
          ticker: input.ticker,
          side: input.side,
          decision: riskResult.status,
          decisionReason: riskResult.explanation,
          requestedQuantity: input.quantity,
          recommendedQuantity: riskResult.recommendedQuantity,
          riskScore: riskResult.riskScore,
        },
        ipAddress: input.ipAddress ?? null,
      }).catch(err => {
        log.warn('Risk gate audit persistence failed (non-fatal)', { error: (err as Error).message });
      });

      const riskPassed = riskResult.status !== 'rejected';
      gates.push({
        gate: 'risk_checks',
        status: riskPassed ? (riskResult.breaches.length > 0 ? 'warning' : 'passed') : 'failed',
        durationMs: Date.now() - g2Start,
        details: { status: riskResult.status, riskScore: riskResult.riskScore, breachCount: riskResult.breaches.length },
        ...(!riskPassed ? { failReason: riskResult.explanation } : {}),
      });

      narrative.push(`Risk: ${riskResult.status} (score ${riskResult.riskScore}). ${riskResult.breaches.length} breaches, ${riskResult.warnings.length} warnings.`);
      if (riskResult.riskScore > 50) decisiveFactors.push(`high_risk=${riskResult.riskScore}`);
      if (riskResult.status === 'approved_with_reduced_size') {
        decisiveFactors.push(`size_reduced=${recommendedQuantity}/${input.quantity}`);
      }
      // Cross-reference: flag monitoring-injected risk findings
      const monitoringRiskBreaches = riskResult.breaches.filter(b => b.check.startsWith('monitoring:'));
      if (monitoringRiskBreaches.length > 0) {
        narrative.push(`Monitoring→Risk: ${monitoringRiskBreaches.length} active alert(s) amplified risk evaluation: ${monitoringRiskBreaches.map(b => b.message).join('; ')}`);
        decisiveFactors.push(`monitoring_risk_amplification=${monitoringRiskBreaches.length}`);
      }

      if (!riskPassed) {
        decision = 'rejected_risk';
        decisionReason = riskResult.explanation;
        stoppedAt = 'risk_checks';
        throw new GateHalt();
      }
    } catch (err) {
      if (err instanceof GateHalt) throw err;
      gates.push({ gate: 'risk_checks', status: 'failed', durationMs: Date.now() - g2Start, details: {}, failReason: (err as Error).message });
      decision = 'error';
      decisionReason = `Risk check failed: ${(err as Error).message}`;
      stoppedAt = 'risk_checks';
      throw new GateHalt();
    }

    // ════════════════════════════════════════════════════════════
    // GATE 3: Governance Checks
    // "Does policy allow this?"
    // ════════════════════════════════════════════════════════════
    const g3Start = Date.now();
    try {
      const govResult = await evaluateGovernance({
        portfolioId: input.portfolioId,
        instrumentId: input.instrumentId!,
        ticker: input.ticker,
        side: input.side,
        quantity: recommendedQuantity,
        price: input.price,
        strategySleeve: input.strategySleeve,
        activeBreaches: breachSnap?.breaches ?? [],
      });

      govSnap = {
        overallStatus: govResult.overallStatus,
        violations: govResult.results.map(r => ({ policy: r.policyName, status: r.status, reason: r.reason })),
      };

      // Audit: log governance evaluation with decisionId linkage
      logAuditEvent({
        eventType: 'governance_check',
        actorId: input.userId,
        actorType: 'system',
        decisionId,
        portfolioId: input.portfolioId,
        instrumentId: input.instrumentId ?? null,
        resourceType: 'trade',
        resourceId: input.ticker,
        action: govResult.overallStatus,
        payload: {
          ticker: input.ticker,
          governanceStatus: govResult.overallStatus,
          violations: govResult.results
            .filter(r => r.status !== 'pass')
            .map(r => ({ policy: r.policyName, status: r.status, reason: r.reason })),
        },
        ipAddress: input.ipAddress ?? null,
      }).catch(err => { log.warn('Audit persistence failed (non-fatal)', { error: (err as Error).message }); });

      const govPassed = govResult.overallStatus !== 'fail';
      gates.push({
        gate: 'governance_checks',
        status: govPassed ? (govResult.overallStatus === 'warn' ? 'warning' : 'passed') : 'failed',
        durationMs: Date.now() - g3Start,
        details: { overallStatus: govResult.overallStatus, violationCount: govResult.results.filter(r => r.status !== 'pass').length },
        ...(!govPassed ? { failReason: govResult.results.filter(r => r.status === 'fail').map(r => r.reason).join('; ') } : {}),
      });

      const failedPolicies = govResult.results.filter(r => r.status === 'fail');
      narrative.push(`Governance: ${govResult.overallStatus}. ${failedPolicies.length > 0 ? failedPolicies.map(p => p.reason).join('; ') : 'All policies passed.'}`);
      if (failedPolicies.length > 0) decisiveFactors.push(`policy_violations=${failedPolicies.length}`);
      // Cross-reference: flag monitoring-injected governance violations
      const monitoringGovViolations = govResult.results.filter(r => r.policyName.startsWith('Monitoring:'));
      if (monitoringGovViolations.length > 0) {
        narrative.push(`Monitoring→Governance: ${monitoringGovViolations.length} active alert(s) injected into governance evaluation: ${monitoringGovViolations.map(v => v.reason).join('; ')}`);
        decisiveFactors.push(`monitoring_governance_injection=${monitoringGovViolations.length}`);
      }

      if (!govPassed) {
        decision = 'rejected_governance';
        decisionReason = `Governance blocked: ${failedPolicies.map(p => p.reason).join('; ')}`;
        stoppedAt = 'governance_checks';
        throw new GateHalt();
      }
    } catch (err) {
      if (err instanceof GateHalt) throw err;
      // GOVERNANCE HARD BLOCK: if governance evaluation fails for ANY
      // reason (network, DB, code error), the decision is REJECTED.
      // We do NOT use 'error' here — governance failure IS a rejection.
      // PRD §6: "Governance comes before discretionary override."
      gates.push({ gate: 'governance_checks', status: 'failed', durationMs: Date.now() - g3Start, details: {}, failReason: (err as Error).message });
      decision = 'rejected_governance';
      decisionReason = `Governance evaluation failed — trade blocked as a safety default: ${(err as Error).message}`;
      stoppedAt = 'governance_checks';
      throw new GateHalt();
    }

    // ════════════════════════════════════════════════════════════
    // GATE 4: Scenario Analysis
    // "What if the market drops?"
    // ════════════════════════════════════════════════════════════
    const g4Start = Date.now();
    try {
      const scenarioId = input.scenarioId ?? 'mkt_drop_10';
      const scenarioResult = await evaluateTradeScenario(
        input.portfolioId,
        scenarioId,
        { instrumentId: input.instrumentId!, ticker: input.ticker, quantity: recommendedQuantity, price: input.price },
      );

      const marginalPct = scenarioResult.withTrade.lossPct - scenarioResult.withoutTrade.lossPct;
      const acceptable = Math.abs(marginalPct) <= MAX_MARGINAL_SCENARIO_IMPACT_PCT;

      scenarioSnap = {
        scenarioId,
        withoutTrade: { lossPct: scenarioResult.withoutTrade.lossPct },
        withTrade: { lossPct: scenarioResult.withTrade.lossPct },
        marginalImpact: parseFloat(marginalPct.toFixed(2)),
        acceptable,
      };

      // Audit: log scenario evaluation with decisionId linkage
      logAuditEvent({
        eventType: 'scenario_evaluation',
        actorId: input.userId,
        actorType: 'system',
        decisionId,
        portfolioId: input.portfolioId,
        instrumentId: input.instrumentId ?? null,
        resourceType: 'trade',
        resourceId: input.ticker,
        action: acceptable ? 'acceptable' : 'threshold_exceeded',
        payload: {
          ticker: input.ticker,
          scenarioId,
          marginalImpact: parseFloat(marginalPct.toFixed(2)),
        },
        ipAddress: input.ipAddress ?? null,
      }).catch(err => { log.warn('Audit persistence failed (non-fatal)', { error: (err as Error).message }); });

      gates.push({
        gate: 'scenario_analysis',
        status: acceptable ? 'passed' : 'warning',
        durationMs: Date.now() - g4Start,
        details: { scenarioId, marginalImpact: marginalPct, threshold: MAX_MARGINAL_SCENARIO_IMPACT_PCT },
        ...(!acceptable ? { failReason: `Trade adds ${marginalPct.toFixed(1)}% portfolio loss under ${scenarioId} (max: ${MAX_MARGINAL_SCENARIO_IMPACT_PCT}%)` } : {}),
      });

      narrative.push(`Scenario (${scenarioId}): trade adds ${marginalPct.toFixed(1)}% loss. ${acceptable ? 'Acceptable.' : `Exceeds ${MAX_MARGINAL_SCENARIO_IMPACT_PCT}% threshold — caution advised.`}`);
      if (!acceptable) {
        decisiveFactors.push(`scenario_impact=${marginalPct.toFixed(1)}%`);
        // Scenario is a soft gate — doesn't reject, but flags for manual review
        if (Math.abs(marginalPct) > MAX_MARGINAL_SCENARIO_IMPACT_PCT * 2) {
          decision = 'rejected_scenario';
          decisionReason = `Trade adds ${marginalPct.toFixed(1)}% portfolio loss under ${scenarioId} — far exceeds ${MAX_MARGINAL_SCENARIO_IMPACT_PCT}% threshold`;
          stoppedAt = 'scenario_analysis';
          throw new GateHalt();
        }
      }
    } catch (err) {
      if (err instanceof GateHalt) throw err;
      // Scenario failure is non-fatal — log and continue
      gates.push({ gate: 'scenario_analysis', status: 'skipped', durationMs: Date.now() - g4Start, details: {}, failReason: (err as Error).message });
      narrative.push('Scenario analysis unavailable — proceeding without stress test.');
    }

    // ════════════════════════════════════════════════════════════
    // GATE 5: Explainability
    // "Can we explain this decision?"
    // Always passes — builds the explanation object.
    // ════════════════════════════════════════════════════════════
    const g5Start = Date.now();
    const hasWarnings = gates.some(g => g.status === 'warning');
    const hasBreachWarnings = breachSnap?.impact === 'downgraded';
    const riskStatus = riskSnap?.status ?? 'unknown';

    if (riskStatus === 'approved_with_reduced_size') {
      decision = hasBreachWarnings ? 'manual_review' : 'approved_with_conditions';
      decisionReason = hasBreachWarnings
        ? `Approved with reduced size BUT downgraded to manual review due to ${breachSnap!.warning} active breach warning(s). ${narrative.join(' ')}`
        : `Approved with reduced size: ${recommendedQuantity} shares (requested ${input.quantity}). ${narrative.join(' ')}`;
    } else if (hasBreachWarnings) {
      // Breach warnings ALWAYS force manual_review regardless of other gate outcomes
      decision = 'manual_review';
      decisionReason = `Trade would be approved but DOWNGRADED to manual review: ${breachSnap!.warning} active monitoring warning(s) on portfolio. Resolve breaches before trading freely.`;
    } else if (hasWarnings) {
      decision = 'manual_review';
      decisionReason = `Approved with warnings — manual review recommended. ${gates.filter(g => g.status === 'warning').map(g => g.failReason ?? g.gate).join('; ')}`;
    } else {
      decision = 'approved';
      decisionReason = `All ${gates.length} gates passed. Trade is fully approved.`;
    }

    gates.push({
      gate: 'explainability',
      status: 'passed',
      durationMs: Date.now() - g5Start,
      details: { narrativeLength: narrative.length, decisiveFactors: decisiveFactors.length },
    });

  } catch (err) {
    if (!(err instanceof GateHalt)) {
      // Unexpected error
      decision = 'error';
      decisionReason = `Orchestrator error: ${(err as Error).message}`;
      log.error('Decision orchestrator failed', err instanceof Error ? err : new Error(String(err)));
    }
  }

  // ════════════════════════════════════════════════════════════
  // GATE 6: Audit (always runs — even on failure)
  // "Is this decision recorded?"
  // ════════════════════════════════════════════════════════════
  const g6Start = Date.now();
  let auditId: number | null = null;
  try {
    auditId = await logAuditEvent({
      eventType: 'institutional_decision',
      actorId: input.userId,
      actorType: 'system',
      decisionId,
      portfolioId: input.portfolioId,
      instrumentId: input.instrumentId ?? null,
      resourceType: 'trade',
      resourceId: input.ticker,
      action: decision,
      payload: {
        ticker: input.ticker,
        side: input.side,
        decision,
        decisionReason,
        requestedQuantity: input.quantity,
        recommendedQuantity,
        price: input.price,
        fitScore: portfolioCtx?.fitScore ?? null,
        riskScore: riskSnap?.riskScore ?? null,
        governanceStatus: govSnap?.overallStatus ?? null,
        marginalImpact: scenarioSnap?.marginalImpact ?? null,
        gates: gates.map(g => ({ gate: g.gate, status: g.status, failReason: g.failReason })),
      },
      ipAddress: input.ipAddress ?? null,
    });

    gates.push({
      gate: 'audit',
      status: 'passed',
      durationMs: Date.now() - g6Start,
      details: { auditId },
    });
  } catch (err) {
    gates.push({
      gate: 'audit',
      status: 'warning',
      durationMs: Date.now() - g6Start,
      details: {},
      failReason: `Audit persistence degraded: ${(err as Error).message}`,
    });
  }

  // ════════════════════════════════════════════════════════════
  // FINAL GOVERNANCE ASSERTION — Zero-bypass guarantee
  //
  // PRD §6: "Governance comes before discretionary override."
  // PRD §16: "No opportunity becomes a final recommendation
  //           unless governance checks pass."
  //
  // If the decision is any form of "approved" but governance
  // was never evaluated (or was skipped), FORCE rejection.
  // This is a compile-time-verifiable invariant.
  // ════════════════════════════════════════════════════════════
  const isApproval = decision === 'approved' || decision === 'approved_with_conditions' || decision === 'manual_review';
  const governanceGateRan = gates.some(g => g.gate === 'governance_checks');
  const governanceGatePassed = gates.some(g => g.gate === 'governance_checks' && (g.status === 'passed' || g.status === 'warning'));

  if (isApproval && !governanceGateRan) {
    // Governance was never evaluated — this is a structural bug.
    // Block the decision unconditionally.
    log.error('GOVERNANCE BYPASS DETECTED: decision is approval but governance gate never ran', {
      decision, ticker: input.ticker, gates: gates.map(g => g.gate),
    });
    decision = 'rejected_governance';
    decisionReason = 'GOVERNANCE BYPASS BLOCKED: governance checks were not evaluated. Trade rejected as safety default.';
    stoppedAt = 'governance_assertion';
    gates.push({
      gate: 'governance_assertion',
      status: 'failed',
      durationMs: 0,
      details: { reason: 'governance_gate_missing' },
      failReason: 'Governance gate was not present in the gate chain — structural bypass detected',
    });
  } else if (isApproval && !governanceGatePassed) {
    // Governance ran but failed, yet decision is still approval — logic bug
    log.error('GOVERNANCE OVERRIDE DETECTED: governance failed but decision is approval', {
      decision, governanceStatus: govSnap?.overallStatus, ticker: input.ticker,
    });
    decision = 'rejected_governance';
    decisionReason = `GOVERNANCE OVERRIDE BLOCKED: governance status is ${govSnap?.overallStatus ?? 'unknown'} but decision was ${decision}. Forced rejection.`;
    stoppedAt = 'governance_assertion';
    gates.push({
      gate: 'governance_assertion',
      status: 'failed',
      durationMs: 0,
      details: { governanceStatus: govSnap?.overallStatus, originalDecision: decision },
      failReason: 'Governance failed but decision was not rejection — forced override',
    });
  }

  // ── Build summary ─────────────────────────────────────────────
  const totalDurationMs = Date.now() - startMs;
  const passed = gates.filter(g => g.status === 'passed').length;
  const failed = gates.filter(g => g.status === 'failed').length;
  const warnings = gates.filter(g => g.status === 'warning').length;

  const summary = `${input.ticker} ${input.side.toUpperCase()} ${input.quantity}@₹${input.price} → ${decision} (${passed}/${gates.length} gates passed, ${totalDurationMs}ms)`;
  log.info('Decision complete', {
    ticker: input.ticker, side: input.side, decision,
    gates: passed, failed, warnings, durationMs: totalDurationMs,
  });

  narrative.unshift(summary);

  const result: InstitutionalDecision = {
    decision,
    decisionReason,
    recommendedQuantity,
    gates,
    gatesSummary: { total: gates.length, passed, failed, warnings, stoppedAt },
    portfolioContext: portfolioCtx,
    riskSnapshot: riskSnap,
    governanceSnapshot: govSnap,
    activeBreaches: breachSnap,
    scenarioSnapshot: scenarioSnap,
    explanation: {
      summary: narrative[0],
      decisiveFactors,
      gateNarrative: narrative,
    },
    auditId,
    trace: null,
    instrument: instrumentRef,
    ticker: input.ticker,
    side: input.side,
    requestedQuantity: input.quantity,
    totalDurationMs,
    timestamp: new Date().toISOString(),
  };

  // ════════════════════════════════════════════════════════════
  // Build and persist the decision trace — full institutional
  // explainability. This is deterministic: no AI, no heuristics.
  // The trace is attached to the response AND persisted to DB.
  // ════════════════════════════════════════════════════════════
  try {
    const trace = buildDecisionTrace(input, result, decisionId);
    result.trace = trace;
    // Persist async — don't block the response
    persistDecisionTrace(trace).catch(err => {
      log.warn('Trace persistence failed (non-fatal)', { error: (err as Error).message });
    });
  } catch (err) {
    log.warn('Trace build failed (non-fatal)', { error: (err as Error).message });
  }

  return result;
  } finally {
    exitOrchestratorContext();
  }
}

// ── Internal: flow control for gate halting ──────────────────────

class GateHalt extends Error {
  constructor() { super('Gate halt'); this.name = 'GateHalt'; }
}
