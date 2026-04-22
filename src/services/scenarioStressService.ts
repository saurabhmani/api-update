// ════════════════════════════════════════════════════════════════
//  Scenario Engine — Phase 5
//
//  Portfolio and trade stress testing under adverse conditions.
//  Answers: "What breaks this portfolio?"
//
//  Scenario types:
//    market_drop, sector_shock, volatility_spike, rate_shock,
//    instrument_shock, historical_template
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';
import { getHoldings, type HoldingRow } from './portfolioLedgerService';
import { resolveById } from './instrumentResolver';

const log = logger.child({ service: 'scenarioStress' });

// ── Types ───────────────────────────────────────────────────────

export type ScenarioType =
  | 'market_drop'
  | 'sector_shock'
  | 'volatility_spike'
  | 'rate_shock'
  | 'instrument_shock'
  | 'historical_template';

export interface ScenarioDefinition {
  id: string;
  name: string;
  type: ScenarioType;
  description: string;
  parameters: Record<string, number>;
}

export interface HoldingImpact {
  ticker: string;
  currentValue: number;
  projectedValue: number;
  projectedLoss: number;
  projectedLossPct: number;
}

export interface ScenarioResult {
  scenario: ScenarioDefinition;
  projectedPortfolioLoss: number;
  projectedPortfolioLossPct: number;
  holdingImpacts: HoldingImpact[];
  worstContributors: HoldingImpact[];
  severity: 'low' | 'moderate' | 'high' | 'severe';
  actionHint: string;
}

// ── Scenario Library ────────────────────────────────────────────

const SCENARIO_LIBRARY: ScenarioDefinition[] = [
  {
    id: 'mkt_drop_5',
    name: 'Market Drop 5%',
    type: 'market_drop',
    description: 'Broad market decline of 5% — mild correction',
    parameters: { drop_pct: 5, beta_multiplier: 1.0 },
  },
  {
    id: 'mkt_drop_10',
    name: 'Market Drop 10%',
    type: 'market_drop',
    description: 'Significant market correction of 10%',
    parameters: { drop_pct: 10, beta_multiplier: 1.0 },
  },
  {
    id: 'mkt_drop_20',
    name: 'Market Crash 20%',
    type: 'market_drop',
    description: 'Severe market crash — 20% drawdown scenario',
    parameters: { drop_pct: 20, beta_multiplier: 1.2 },
  },
  {
    id: 'sector_it_crash',
    name: 'IT Sector Crash',
    type: 'sector_shock',
    description: 'IT/Technology sector drops 15%, others 3%',
    parameters: { target_sector: 0, sector_drop: 15, others_drop: 3 },
  },
  {
    id: 'sector_bank_crash',
    name: 'Banking Sector Crash',
    type: 'sector_shock',
    description: 'Financial/Banking sector drops 15%, others 3%',
    parameters: { target_sector: 0, sector_drop: 15, others_drop: 3 },
  },
  {
    id: 'vol_spike',
    name: 'Volatility Spike',
    type: 'volatility_spike',
    description: 'VIX doubles — high-beta stocks drop 12%, low-beta 4%',
    parameters: { high_beta_drop: 12, low_beta_drop: 4, beta_threshold: 1.2 },
  },
  {
    id: 'rate_hike',
    name: 'Rate Hike Shock',
    type: 'rate_shock',
    description: 'Interest rate increase: banks benefit +2%, growth/IT drops 8%',
    parameters: { rate_sensitive_drop: 8, bank_benefit: 2 },
  },
  {
    id: 'hist_2020_crash',
    name: 'COVID-19 March 2020',
    type: 'historical_template',
    description: 'Replicate Mar 2020 conditions: 35% broad decline',
    parameters: { drop_pct: 35, beta_multiplier: 1.3 },
  },
  {
    id: 'hist_2008_crisis',
    name: 'GFC 2008 Template',
    type: 'historical_template',
    description: 'Replicate 2008 financial crisis: 50% drawdown',
    parameters: { drop_pct: 50, beta_multiplier: 1.5 },
  },
];

// Sector classification helpers
const IT_SECTORS = ['Information Technology', 'IT', 'Technology'];
const BANK_SECTORS = ['Financial Services', 'Banking', 'BFSI'];
const RATE_SENSITIVE = ['Information Technology', 'IT', 'Consumer Goods', 'FMCG'];
const RATE_BENEFIT = ['Financial Services', 'Banking'];

export function getScenarioLibrary(): ScenarioDefinition[] {
  return SCENARIO_LIBRARY;
}

// ── Scenario Runner ─────────────────────────────────────────────

function applyScenario(
  holdings: HoldingRow[],
  scenario: ScenarioDefinition,
  targetSector?: string,
): HoldingImpact[] {
  return holdings.map((h) => {
    let dropPct = 0;
    const sector = h.sector ?? 'Other';

    switch (scenario.type) {
      case 'market_drop':
      case 'historical_template': {
        const beta = 1.0; // future: lookup instrument beta
        dropPct = scenario.parameters.drop_pct * (scenario.parameters.beta_multiplier ?? 1) * beta;
        break;
      }
      case 'sector_shock': {
        const target = targetSector ?? 'Information Technology';
        const isTarget = IT_SECTORS.includes(sector) || BANK_SECTORS.includes(sector) || sector === target;
        dropPct = isTarget ? scenario.parameters.sector_drop : scenario.parameters.others_drop;
        break;
      }
      case 'volatility_spike': {
        const isHighBeta = true; // placeholder for beta lookup
        dropPct = isHighBeta ? scenario.parameters.high_beta_drop : scenario.parameters.low_beta_drop;
        break;
      }
      case 'rate_shock': {
        if (RATE_BENEFIT.includes(sector)) {
          dropPct = -(scenario.parameters.bank_benefit); // negative = benefit
        } else if (RATE_SENSITIVE.includes(sector)) {
          dropPct = scenario.parameters.rate_sensitive_drop;
        } else {
          dropPct = 2; // mild impact
        }
        break;
      }
      case 'instrument_shock': {
        const target = targetSector ?? '';
        dropPct = h.ticker === target
          ? scenario.parameters.drop_pct
          : scenario.parameters.others_drop ?? 0;
        break;
      }
    }

    const projectedLoss = h.marketValue * (dropPct / 100);
    const projectedValue = h.marketValue - projectedLoss;

    return {
      ticker: h.ticker,
      currentValue: h.marketValue,
      projectedValue: parseFloat(projectedValue.toFixed(2)),
      projectedLoss: parseFloat(projectedLoss.toFixed(2)),
      projectedLossPct: parseFloat((-dropPct).toFixed(2)),
    };
  });
}

export async function runScenario(
  portfolioId: number,
  scenarioId: string,
  customParams?: { targetSector?: string; dropPct?: number },
): Promise<ScenarioResult> {
  let scenario = SCENARIO_LIBRARY.find((s) => s.id === scenarioId);

  if (!scenario) {
    // Allow custom instrument shock
    scenario = {
      id: 'custom',
      name: 'Custom Scenario',
      type: 'instrument_shock',
      description: 'User-defined shock scenario',
      parameters: {
        drop_pct: customParams?.dropPct ?? 10,
        others_drop: 2,
      },
    };
  }

  const holdings = await getHoldings(portfolioId);
  if (!holdings.length) {
    return {
      scenario,
      projectedPortfolioLoss: 0,
      projectedPortfolioLossPct: 0,
      holdingImpacts: [],
      worstContributors: [],
      severity: 'low',
      actionHint: 'No positions to evaluate.',
    };
  }

  const targetSector = customParams?.targetSector;
  const impacts = applyScenario(holdings, scenario, targetSector);

  const totalCurrentValue = impacts.reduce((s, i) => s + i.currentValue, 0);
  const totalProjectedLoss = impacts.reduce((s, i) => s + i.projectedLoss, 0);
  const lossPct = totalCurrentValue > 0 ? (totalProjectedLoss / totalCurrentValue) * 100 : 0;

  const worstContributors = [...impacts]
    .sort((a, b) => b.projectedLoss - a.projectedLoss)
    .slice(0, 5);

  const absPct = Math.abs(lossPct);
  const sev: ScenarioResult['severity'] =
    absPct >= 20 ? 'severe' :
    absPct >= 10 ? 'high' :
    absPct >= 5 ? 'moderate' : 'low';

  const actionHint =
    sev === 'severe' ? 'Significant portfolio risk. Consider hedging or reducing exposure in worst contributors.' :
    sev === 'high' ? 'Elevated risk. Review largest loss contributors and tighten stop-losses.' :
    sev === 'moderate' ? 'Manageable impact. Monitor and review concentration in affected sectors.' :
    'Portfolio is resilient under this scenario.';

  return {
    scenario,
    projectedPortfolioLoss: parseFloat(totalProjectedLoss.toFixed(2)),
    projectedPortfolioLossPct: parseFloat(lossPct.toFixed(2)),
    holdingImpacts: impacts,
    worstContributors,
    severity: sev,
    actionHint,
  };
}

// ── Trade-level Scenario Evaluation ─────────────────────────────

export async function evaluateTradeScenario(
  portfolioId: number,
  scenarioId: string,
  trade: { instrumentId: number; ticker?: string; quantity: number; price: number },
): Promise<{
  withoutTrade: { loss: number; lossPct: number };
  withTrade: { loss: number; lossPct: number };
  marginalImpact: number;
}> {
  const scenario = SCENARIO_LIBRARY.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario: ${scenarioId}`);

  const holdings = await getHoldings(portfolioId);
  const impactsWithout = applyScenario(holdings, scenario);
  const lossWithout = impactsWithout.reduce((s, i) => s + i.projectedLoss, 0);
  const totalWithout = impactsWithout.reduce((s, i) => s + i.currentValue, 0);

  // Resolve canonical identity — instrumentId is the primary key
  const tradeValue = trade.quantity * trade.price;
  const instRef = await resolveById(trade.instrumentId);
  const ticker = instRef?.ticker ?? trade.ticker ?? '';
  const sector = instRef?.sector ?? 'Other';

  const simulatedHoldings: HoldingRow[] = [
    ...holdings,
    {
      ticker,
      instrumentId: trade.instrumentId,
      quantity: trade.quantity,
      avgCost: trade.price,
      marketPrice: trade.price,
      marketValue: tradeValue,
      investedValue: tradeValue,
      weight: 0,
      unrealizedPnl: 0,
      unrealizedPnlPct: 0,
      sector,
    },
  ];

  const impactsWith = applyScenario(simulatedHoldings, scenario);
  const lossWith = impactsWith.reduce((s, i) => s + i.projectedLoss, 0);
  const totalWith = impactsWith.reduce((s, i) => s + i.currentValue, 0);

  return {
    withoutTrade: {
      loss: parseFloat(lossWithout.toFixed(2)),
      lossPct: totalWithout > 0 ? parseFloat(((lossWithout / totalWithout) * 100).toFixed(2)) : 0,
    },
    withTrade: {
      loss: parseFloat(lossWith.toFixed(2)),
      lossPct: totalWith > 0 ? parseFloat(((lossWith / totalWith) * 100).toFixed(2)) : 0,
    },
    marginalImpact: parseFloat((lossWith - lossWithout).toFixed(2)),
  };
}
