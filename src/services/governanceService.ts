// ════════════════════════════════════════════════════════════════
//  Governance & Policy Engine — Phase 6
//
//  Mandate, restriction, and governance checks so attractive
//  trades can still be blocked by policy.
//
//  Decision outputs: pass | warn | fail
//  Governance pass + risk pass = approval.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getHoldings } from './portfolioLedgerService';
import { resolveById } from './instrumentResolver';
import { assertOrchestratorContext } from './decisionContext';

const log = logger.child({ service: 'governance' });

// ── Types ───────────────────────────────────────────────────────

export type PolicyStatus = 'pass' | 'warn' | 'fail';

export interface PolicyResult {
  policyName: string;
  status: PolicyStatus;
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  recommendedAction: string | null;
}

export interface GovernanceEvaluation {
  overallStatus: PolicyStatus;
  results: PolicyResult[];
  timestamp: string;
}

export interface GovernanceRule {
  id: number;
  name: string;
  ruleType: string;
  description: string;
  parameters: Record<string, any>;
  isActive: boolean;
}

export interface Restriction {
  id: number;
  ticker: string | null;
  sector: string | null;
  restrictionType: 'banned' | 'max_allocation' | 'sell_only' | 'excluded';
  reason: string;
  portfolioId: number | null;  // null = applies to all
  isActive: boolean;
}

// ── Rule Storage (DB-backed) ────────────────────────────────────

export async function getGovernanceRules(): Promise<GovernanceRule[]> {
  try {
    const { rows } = await db.query(
      'SELECT * FROM governance_rules WHERE is_active = 1 ORDER BY name',
    );
    return (rows as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      ruleType: r.rule_type,
      description: r.description ?? '',
      parameters: typeof r.parameters === 'string' ? JSON.parse(r.parameters) : (r.parameters ?? {}),
      isActive: !!r.is_active,
    }));
  } catch {
    // Table may not exist yet — return defaults
    return getDefaultRules();
  }
}

export async function getRestrictions(portfolioId?: number): Promise<Restriction[]> {
  try {
    const { rows } = await db.query(
      `SELECT * FROM governance_restrictions
       WHERE is_active = 1
         AND (portfolio_id IS NULL ${portfolioId ? 'OR portfolio_id = ?' : ''})
       ORDER BY ticker`,
      portfolioId ? [portfolioId] : [],
    );
    return (rows as any[]).map((r) => ({
      id: r.id,
      ticker: r.ticker,
      sector: r.sector,
      restrictionType: r.restriction_type,
      reason: r.reason ?? '',
      portfolioId: r.portfolio_id,
      isActive: !!r.is_active,
    }));
  } catch {
    return [];
  }
}

// ── Default Rules (embedded fallback) ───────────────────────────

function getDefaultRules(): GovernanceRule[] {
  return [
    { id: 1, name: 'Restricted Instruments', ruleType: 'restriction', description: 'Block trades in restricted/banned instruments', parameters: {}, isActive: true },
    { id: 2, name: 'Max Allocation Per Instrument', ruleType: 'max_allocation', description: 'No single instrument above 20% of AUM', parameters: { max_pct: 20 }, isActive: true },
    { id: 3, name: 'Max Sector Allocation', ruleType: 'max_sector', description: 'No single sector above 35% of AUM', parameters: { max_pct: 35 }, isActive: true },
    { id: 4, name: 'Strategy Eligibility', ruleType: 'strategy_eligibility', description: 'Only approved strategies can generate trades', parameters: { approved: ['swing', 'positional', 'momentum', 'breakout'] }, isActive: true },
    { id: 5, name: 'Turnover Threshold', ruleType: 'turnover', description: 'Max 5 trades per day per portfolio', parameters: { max_daily_trades: 5 }, isActive: true },
    { id: 6, name: 'Client Exclusions', ruleType: 'client_exclusion', description: 'Account-specific instrument exclusions', parameters: {}, isActive: true },
  ];
}

// ── Policy Engine ───────────────────────────────────────────────

async function checkRestrictions(
  ticker: string,
  sector: string | null,
  portfolioId: number,
): Promise<PolicyResult | null> {
  const restrictions = await getRestrictions(portfolioId);

  // Check ticker-level ban
  const tickerBan = restrictions.find(
    (r) => r.ticker === ticker && (r.restrictionType === 'banned' || r.restrictionType === 'sell_only'),
  );
  if (tickerBan) {
    return {
      policyName: 'Restricted Instruments',
      status: 'fail',
      reason: `${ticker} is ${tickerBan.restrictionType}: ${tickerBan.reason}`,
      severity: 'critical',
      recommendedAction: tickerBan.restrictionType === 'sell_only' ? 'Only sell orders allowed' : 'Cannot trade this instrument',
    };
  }

  // Check sector-level restriction
  if (sector) {
    const sectorBan = restrictions.find(
      (r) => r.sector === sector && r.restrictionType === 'excluded',
    );
    if (sectorBan) {
      return {
        policyName: 'Sector Exclusion',
        status: 'fail',
        reason: `Sector "${sector}" is excluded: ${sectorBan.reason}`,
        severity: 'high',
        recommendedAction: 'Cannot trade instruments in this sector',
      };
    }
  }

  return null;
}

async function checkMaxAllocation(
  ticker: string,
  quantity: number,
  price: number,
  portfolioId: number,
  rules: GovernanceRule[],
): Promise<PolicyResult | null> {
  const rule = rules.find((r) => r.ruleType === 'max_allocation');
  if (!rule) return null;
  const maxPct = rule.parameters.max_pct ?? 20;

  const holdings = await getHoldings(portfolioId);
  const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  if (totalValue === 0) return null;

  const existing = holdings.find((h) => h.ticker === ticker);
  const existingVal = existing?.marketValue ?? 0;
  const tradeVal = quantity * price;
  const projectedPct = ((existingVal + tradeVal) / (totalValue + tradeVal)) * 100;

  if (projectedPct > maxPct) {
    return {
      policyName: 'Max Allocation Per Instrument',
      status: projectedPct > maxPct * 1.2 ? 'fail' : 'warn',
      reason: `${ticker} would be ${projectedPct.toFixed(1)}% of portfolio (limit: ${maxPct}%)`,
      severity: projectedPct > maxPct * 1.2 ? 'high' : 'medium',
      recommendedAction: `Reduce quantity to stay within ${maxPct}% allocation limit`,
    };
  }
  return null;
}

async function checkSectorAllocation(
  sector: string | null,
  quantity: number,
  price: number,
  portfolioId: number,
  rules: GovernanceRule[],
): Promise<PolicyResult | null> {
  if (!sector) return null;
  const rule = rules.find((r) => r.ruleType === 'max_sector');
  if (!rule) return null;
  const maxPct = rule.parameters.max_pct ?? 35;

  const holdings = await getHoldings(portfolioId);
  const totalValue = holdings.reduce((s, h) => s + h.marketValue, 0);
  if (totalValue === 0) return null;

  const sectorValue = holdings
    .filter((h) => h.sector === sector)
    .reduce((s, h) => s + h.marketValue, 0);
  const tradeVal = quantity * price;
  const projectedPct = ((sectorValue + tradeVal) / (totalValue + tradeVal)) * 100;

  if (projectedPct > maxPct) {
    return {
      policyName: 'Max Sector Allocation',
      status: 'warn',
      reason: `${sector} sector would reach ${projectedPct.toFixed(1)}% (limit: ${maxPct}%)`,
      severity: 'medium',
      recommendedAction: `Diversify: sector "${sector}" is approaching concentration limit`,
    };
  }
  return null;
}

async function checkStrategyEligibility(
  strategySleeve: string | undefined,
  rules: GovernanceRule[],
): Promise<PolicyResult | null> {
  if (!strategySleeve) return null;
  const rule = rules.find((r) => r.ruleType === 'strategy_eligibility');
  if (!rule) return null;

  const approved: string[] = rule.parameters.approved ?? [];
  if (approved.length && !approved.includes(strategySleeve.toLowerCase())) {
    return {
      policyName: 'Strategy Eligibility',
      status: 'fail',
      reason: `Strategy "${strategySleeve}" is not in approved list: ${approved.join(', ')}`,
      severity: 'high',
      recommendedAction: 'Use an approved strategy type',
    };
  }
  return null;
}

async function checkTurnover(
  portfolioId: number,
  rules: GovernanceRule[],
): Promise<PolicyResult | null> {
  const rule = rules.find((r) => r.ruleType === 'turnover');
  if (!rule) return null;
  const maxDaily = rule.parameters.max_daily_trades ?? 5;

  const { rows } = await db.query(
    `SELECT COUNT(*) AS cnt FROM transactions
     WHERE portfolio_id = ? AND DATE(executed_at) = CURDATE()`,
    [portfolioId],
  );
  const todayCount = Number((rows[0] as any)?.cnt ?? 0);

  if (todayCount >= maxDaily) {
    return {
      policyName: 'Turnover Threshold',
      status: 'warn',
      reason: `${todayCount} trades today (limit: ${maxDaily})`,
      severity: 'medium',
      recommendedAction: 'Daily trade limit reached — defer non-urgent trades',
    };
  }
  return null;
}

// ── Governance Evaluation Service ───────────────────────────────

export interface MonitoringBreachContext {
  category: string;
  severity: string;
  metric: string;
  message: string;
}

export interface GovernanceInput {
  portfolioId: number;
  instrumentId: number;            // canonical identity — REQUIRED
  ticker?: string;                 // display hint only — resolved internally if omitted
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  strategySleeve?: string;
  activeBreaches?: MonitoringBreachContext[];
}

export async function evaluateGovernance(input: GovernanceInput): Promise<GovernanceEvaluation> {
  // ── BYPASS GUARD: must be called from within orchestrator ────
  assertOrchestratorContext('evaluateGovernance');

  const { portfolioId, instrumentId, side, quantity, price, strategySleeve } = input;

  // Resolve canonical identity — instrumentId is the primary key
  const instRef = await resolveById(instrumentId);
  const ticker = instRef?.ticker ?? input.ticker ?? '';
  const sector = instRef?.sector ?? null;

  const rules = await getGovernanceRules();
  const results: PolicyResult[] = [];

  // Only run buy-side checks for buy orders
  if (side === 'buy') {
    const restriction = await checkRestrictions(ticker, sector, portfolioId);
    if (restriction) results.push(restriction);

    const allocation = await checkMaxAllocation(ticker, quantity, price, portfolioId, rules);
    if (allocation) results.push(allocation);

    const sectorAlloc = await checkSectorAllocation(sector, quantity, price, portfolioId, rules);
    if (sectorAlloc) results.push(sectorAlloc);

    const strategy = await checkStrategyEligibility(strategySleeve, rules);
    if (strategy) results.push(strategy);

    const turnover = await checkTurnover(portfolioId, rules);
    if (turnover) results.push(turnover);
  } else {
    // Sell-side: only check restrictions
    const restriction = await checkRestrictions(ticker, sector, portfolioId);
    if (restriction && restriction.reason.includes('banned')) {
      // Banned instruments can't even be sold in some cases
      results.push(restriction);
    }
    // Turnover still applies
    const turnover = await checkTurnover(portfolioId, rules);
    if (turnover) results.push(turnover);
  }

  // ── Inject monitoring-detected governance breaches ───────────
  // Active monitoring alerts are NOT passive — governance_warning breaches
  // from monitoring feed directly into governance evaluation. This closes
  // the monitoring→governance feedback loop.
  const monitoringBreaches = input.activeBreaches ?? [];
  const govBreaches = monitoringBreaches.filter(b => b.category === 'governance_warning');
  for (const mb of govBreaches) {
    // Check if this specific instrument is the one being traded
    const isRelevantToThisTrade = mb.metric.includes(ticker) || mb.message.includes(ticker);
    results.push({
      policyName: `Monitoring: ${mb.metric}`,
      status: isRelevantToThisTrade ? 'fail' : 'warn',
      reason: `[monitoring] ${mb.message}`,
      severity: mb.severity === 'critical' ? 'critical' : 'high',
      recommendedAction: isRelevantToThisTrade
        ? 'Resolve active governance breach before trading this instrument'
        : 'Active governance breach on portfolio — review required',
    });
  }

  // If no checks triggered, add an explicit pass
  if (results.length === 0) {
    results.push({
      policyName: 'All Governance Checks',
      status: 'pass',
      reason: 'No governance violations detected',
      severity: 'low',
      recommendedAction: null,
    });
  }

  const hasFail = results.some((r) => r.status === 'fail');
  const hasWarn = results.some((r) => r.status === 'warn');
  const overallStatus: PolicyStatus = hasFail ? 'fail' : hasWarn ? 'warn' : 'pass';

  log.info('Governance evaluation', {
    portfolioId, ticker, side, quantity, overallStatus,
    failCount: results.filter((r) => r.status === 'fail').length,
  });

  return {
    overallStatus,
    results,
    timestamp: new Date().toISOString(),
  };
}
