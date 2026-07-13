import { describe, expect, it } from 'vitest';
import { compareOpportunityRows, type OpportunityRankingRow } from '@/lib/rankings/opportunityLeaderboard';

function row(partial: Partial<OpportunityRankingRow> & { symbol: string }): OpportunityRankingRow {
  return {
    id: 1,
    name: null,
    exchange: 'NSE',
    sector: null,
    direction: 'BUY',
    strategy: null,
    timeframe: 'intraday',
    classification: null,
    conviction_band: 'actionable',
    conviction_level: null,
    opportunity_rank: 70,
    score: 70,
    final_score: 70,
    confidence_score: 70,
    risk_score: 30,
    risk_reward: 2,
    portfolio_fit_score: 65,
    stress_survival_score: null,
    expected_edge_percent: null,
    maturity_score: null,
    entry_price: 100,
    stop_loss: 95,
    target1: 110,
    market_stance: null,
    regime: null,
    ltp: 100,
    pct_change: 0,
    livePrice: null,
    livePChange: null,
    liveSource: null,
    signal_type: 'BUY',
    signal_status: 'APPROVED_SIGNAL',
    source: 'phase3_approved',
    approved: true,
    execution_allowed: true,
    rank_position: 1,
    rank_explanation: '',
    rank_factors: [],
    confirmed_at: null,
    generated_at: null,
    signal_age_min: null,
    validation_cycles: null,
    stability_passed: null,
    ...partial,
  };
}

describe('compareOpportunityRows', () => {
  it('sorts by opportunity_rank desc first', () => {
    const rows = [
      row({ symbol: 'LOW', opportunity_rank: 50 }),
      row({ symbol: 'HIGH', opportunity_rank: 90 }),
    ];
    rows.sort(compareOpportunityRows);
    expect(rows.map((r) => r.symbol)).toEqual(['HIGH', 'LOW']);
  });

  it('breaks ties on conviction band', () => {
    const rows = [
      row({ symbol: 'WATCH', opportunity_rank: 70, conviction_band: 'watchlist', confidence_score: 90 }),
      row({ symbol: 'HIGH', opportunity_rank: 70, conviction_band: 'high_conviction', confidence_score: 60 }),
    ];
    rows.sort(compareOpportunityRows);
    expect(rows.map((r) => r.symbol)).toEqual(['HIGH', 'WATCH']);
  });
});
