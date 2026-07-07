// AI Research Assistant — explainable, risk-aware, data-referenced

import { DISCLAIMERS } from '@/lib/constants/disclaimer';
import { getLatestRegime } from '@/lib/signal-engine/repository/readSignals';
import { computeMarketStance } from '@/services/marketStanceEngine';
import { computeScenario } from '@/services/scenarioEngine';
import { db } from '@/lib/db';
import type { ResearchReport, ResearchSection } from '../types';
import { saveResearchReport } from '../repository/quantRepository';

export async function explainMarketConditions(): Promise<ResearchSection[]> {
  const regime = await getLatestRegime().catch(() => 'unknown');
  const scenario = await computeScenario().catch(() => null);
  const stance = scenario
    ? await computeMarketStance(scenario).catch(() => null)
    : null;

  const sections: ResearchSection[] = [];
  const riskWarnings: string[] = [];

  sections.push({
    title: 'Market Regime',
    content: regime && regime !== 'unknown'
      ? `Current regime: ${regime}. Classification derived from benchmark trend and volatility.`
      : 'Regime data unavailable — benchmark feed may be stale.',
    confidence: regime && regime !== 'unknown' ? 0.75 : 0.3,
    dataSources: ['q365_signals.market_regime', 'market:regime cache'],
    riskWarnings: regime === 'unknown' ? ['Regime data stale — defer high-conviction trades'] : [],
  });

  if (stance) {
    const stanceRisks: string[] = [];
    if (stance.market_stance === 'defensive' || stance.market_stance === 'capital_preservation') {
      stanceRisks.push('Defensive stance active — reduce position sizing');
    }
    if (stance.rejection_rate > 40) {
      stanceRisks.push(`High signal rejection rate (${Math.round(stance.rejection_rate)}%) — quality filter engaged`);
    }
    sections.push({
      title: 'Market Stance',
      content: `${stance.market_stance}: ${stance.guidance_message ?? stance.rationale}`,
      confidence: stance.stance_confidence / 100,
      dataSources: ['marketStanceEngine', `scenario:${stance.scenario_tag}`],
      riskWarnings: stanceRisks,
    });
    riskWarnings.push(...stanceRisks);
  }

  if (scenario) {
    const scenarioRisks: string[] = [];
    if (scenario.blocked_strategies?.length > 0) {
      scenarioRisks.push(`${scenario.blocked_strategies.length} strategy families blocked in current scenario`);
    }
    if (scenario.volatility_mode === 'elevated' || scenario.volatility_mode === 'extreme') {
      scenarioRisks.push(`Volatility mode: ${scenario.volatility_mode} — widen stops and reduce leverage`);
    }
    sections.push({
      title: 'Scenario Classification',
      content: `Active scenario: ${scenario.scenario_tag}. ${scenario.market_stance_hint}`,
      confidence: scenario.scenario_confidence / 100,
      dataSources: ['scenarioEngine', 'q365_signals breadth/volatility inputs'],
      riskWarnings: scenarioRisks,
    });
    riskWarnings.push(...scenarioRisks);
  }

  return sections;
}

export async function explainSignal(symbol: string): Promise<ResearchSection[]> {
  const { rows } = await db.query(
    `SELECT symbol, direction, confidence_score, scenario_tag, signal_type, market_regime, risk_score,
            portfolio_fit_score, stress_survival_score, explanation_json, generated_at, last_rescored_at
       FROM q365_signals WHERE symbol = ? ORDER BY generated_at DESC LIMIT 1`,
    [symbol.toUpperCase()],
  );
  const sig = rows[0] as any;
  if (!sig) {
    return [{
      title: 'Signal',
      content: `No active signal found for ${symbol}.`,
      confidence: 0,
      dataSources: ['q365_signals'],
      riskWarnings: ['No signal data — cannot assess trade risk'],
    }];
  }

  const strategyLabel = sig.scenario_tag ?? sig.signal_type ?? 'unknown strategy';
  const asOf = sig.last_rescored_at ?? sig.generated_at ?? 'unknown';

  const riskWarnings: string[] = [];
  const riskScore = Number(sig.risk_score ?? 0);
  if (riskScore > 70) riskWarnings.push(`Elevated risk score: ${riskScore}/100`);
  if (Number(sig.stress_survival_score ?? 100) < 50) {
    riskWarnings.push(`Low stress survival score: ${sig.stress_survival_score}`);
  }
  if (Number(sig.confidence_score ?? 0) < 60) {
    riskWarnings.push(`Below-threshold confidence: ${sig.confidence_score}%`);
  }

  const sections: ResearchSection[] = [
    {
      title: 'Signal Overview',
      content: `${sig.symbol} — ${sig.direction} signal via ${strategyLabel}. Confidence: ${sig.confidence_score ?? 'N/A'}%.`,
      confidence: Number(sig.confidence_score ?? 50) / 100,
      dataSources: [`q365_signals (as of ${asOf})`],
      riskWarnings,
    },
    {
      title: 'Risk Profile',
      content: `Risk score: ${sig.risk_score ?? 'N/A'}. Portfolio fit: ${sig.portfolio_fit_score ?? 'N/A'}. Stress survival: ${sig.stress_survival_score ?? 'N/A'}.`,
      confidence: 0.7,
      dataSources: ['q365_signals risk fields', 'portfolio fit engine'],
      riskWarnings: riskScore > 60 ? [`Risk score ${riskScore} exceeds moderate threshold`] : [],
    },
  ];

  if (sig.market_regime) {
    sections.push({
      title: 'Regime Context',
      content: `Signal generated under ${sig.market_regime} regime conditions.`,
      confidence: 0.6,
      dataSources: ['q365_signals.market_regime', 'regimeRouter'],
    });
  }

  if (sig.explanation_json) {
    try {
      const expl = typeof sig.explanation_json === 'string'
        ? JSON.parse(sig.explanation_json) : sig.explanation_json;
      if (expl?.summary || expl?.reasons) {
        sections.push({
          title: 'Model Explanation',
          content: expl.summary ?? (Array.isArray(expl.reasons) ? expl.reasons.join('; ') : String(expl)),
          confidence: 0.65,
          dataSources: ['q365_signals.explanation_json'],
        });
      }
    } catch { /* optional */ }
  }

  return sections;
}

export async function explainBacktest(backtestId: string): Promise<ResearchSection[]> {
  try {
    const { rows } = await db.query(
      `SELECT id, strategy_id, status, total_trades, win_rate, sharpe_ratio, max_drawdown_pct, total_return_pct
         FROM backtest_runs WHERE id = ? OR CAST(id AS CHAR) = ? LIMIT 1`,
      [backtestId, backtestId],
    );
    const bt = rows[0] as any;
    if (!bt) {
      return [{
        title: 'Backtest',
        content: 'Backtest run not found.',
        confidence: 0,
        dataSources: ['backtest_runs'],
        riskWarnings: ['Backtest not found — cannot validate strategy'],
      }];
    }

    const riskWarnings: string[] = [];
    if ((bt.max_drawdown_pct ?? 0) > 20) {
      riskWarnings.push(`High max drawdown: ${bt.max_drawdown_pct}%`);
    }
    if ((bt.total_trades ?? 0) < 30) {
      riskWarnings.push(`Small sample size: only ${bt.total_trades} trades`);
    }

    return [
      {
        title: 'Backtest Summary',
        content: `Strategy ${bt.strategy_id}: ${bt.total_trades ?? 0} trades, win rate ${bt.win_rate ?? 'N/A'}%, return ${bt.total_return_pct ?? 'N/A'}%.`,
        confidence: 0.8,
        dataSources: [`backtest_runs #${bt.id}`],
        riskWarnings,
      },
      {
        title: 'Risk Metrics',
        content: `Sharpe: ${bt.sharpe_ratio ?? 'N/A'}. Max drawdown: ${bt.max_drawdown_pct ?? 'N/A'}%. Status: ${bt.status}.`,
        confidence: 0.75,
        dataSources: ['backtest_runs risk metrics'],
        riskWarnings: (bt.sharpe_ratio ?? 0) < 0 ? ['Negative Sharpe ratio — strategy underperforms risk-free'] : [],
      },
      {
        title: 'Interpretation',
        content: bt.win_rate > 50 && (bt.sharpe_ratio ?? 0) > 0.5
          ? 'Backtest shows positive risk-adjusted performance. Past results do not guarantee future outcomes.'
          : 'Backtest metrics suggest caution. Review regime alignment and sample size before deployment.',
        confidence: 0.65,
        dataSources: ['backtest_runs aggregated metrics'],
        riskWarnings: ['Past performance does not guarantee future results'],
      },
    ];
  } catch {
    return [{
      title: 'Backtest',
      content: 'Unable to load backtest data.',
      confidence: 0,
      riskWarnings: ['Data unavailable'],
    }];
  }
}

export async function generateResearchReport(
  userId: number,
  opts: { type: ResearchReport['reportType']; symbol?: string; backtestId?: string },
): Promise<ResearchReport> {
  const sections: ResearchSection[] = [];
  const symbols: string[] = [];
  const allRiskWarnings: string[] = [];

  const marketSections = await explainMarketConditions();
  sections.push(...marketSections);
  for (const s of marketSections) {
    if (s.riskWarnings?.length) allRiskWarnings.push(...s.riskWarnings);
  }

  if (opts.symbol) {
    symbols.push(opts.symbol.toUpperCase());
    const signalSections = await explainSignal(opts.symbol);
    sections.push(...signalSections);
    for (const s of signalSections) {
      if (s.riskWarnings?.length) allRiskWarnings.push(...s.riskWarnings);
    }
  }

  if (opts.backtestId) {
    const btSections = await explainBacktest(opts.backtestId);
    sections.push(...btSections);
    for (const s of btSections) {
      if (s.riskWarnings?.length) allRiskWarnings.push(...s.riskWarnings);
    }
  }

  if (opts.type === 'full' && !opts.symbol) {
    const { rows } = await db.query(
      `SELECT symbol FROM q365_signals WHERE direction IN ('BUY','SELL') ORDER BY confidence_score DESC LIMIT 5`,
    );
    for (const r of rows as any[]) {
      symbols.push(r.symbol);
      const sigSections = await explainSignal(r.symbol);
      sections.push(...sigSections);
      for (const s of sigSections) {
        if (s.riskWarnings?.length) allRiskWarnings.push(...s.riskWarnings);
      }
    }
  }

  const uniqueWarnings = [...new Set(allRiskWarnings)];

  const report: ResearchReport = {
    reportType: opts.type,
    title: opts.symbol
      ? `Research: ${opts.symbol.toUpperCase()}`
      : opts.backtestId
        ? `Backtest Analysis #${opts.backtestId}`
        : 'Market Research Report',
    generatedAt: new Date().toISOString(),
    sections,
    symbols,
    disclaimers: [DISCLAIMERS.STANDARD, DISCLAIMERS.SHORT],
    riskWarnings: uniqueWarnings,
  };

  await saveResearchReport(userId, report);
  return report;
}
