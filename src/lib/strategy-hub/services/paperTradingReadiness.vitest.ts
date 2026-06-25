import { describe, it, expect } from 'vitest';
import { assessPaperTradingReadiness } from './paperTradingReadiness';

describe('paperTradingReadiness', () => {
  it('marks featured strategies as paper ready when all required checks pass', () => {
    const result = assessPaperTradingReadiness('bullish_breakout', {
      hasEvaluator: true,
      isActiveInRunner: true,
      profile: {
        strategy_id: 'bullish_breakout',
        deployment_status: 'paper_ready',
        paper_trading_enabled: true,
        risk_profile: 'moderate',
        metadata_json: null,
        version: '1.0.0',
        notes: null,
      },
    });
    expect(result.ready).toBe(true);
    expect(result.paperTradingEnabled).toBe(true);
    expect(result.deploymentStatus).toBe('paper_ready');
  });

  it('fails readiness when evaluator missing', () => {
    const result = assessPaperTradingReadiness('bullish_breakout', {
      hasEvaluator: false,
      isActiveInRunner: true,
    });
    expect(result.ready).toBe(false);
    expect(result.checks.find((c) => c.name.includes('Evaluator'))?.pass).toBe(false);
  });

  it('uses staging status when evaluator exists but not active', () => {
    const result = assessPaperTradingReadiness('multi_timeframe_alignment', {
      hasEvaluator: true,
      isActiveInRunner: false,
    });
    expect(result.deploymentStatus).toBe('staging');
  });
});
