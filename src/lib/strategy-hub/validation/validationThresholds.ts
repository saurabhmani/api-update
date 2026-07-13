// ════════════════════════════════════════════════════════════════
//  Strategy Validation — thresholds (Phase 4)
// ════════════════════════════════════════════════════════════════

export const VALIDATION_THRESHOLDS = {
  paper: {
    minEvaluatedTrades: 20,
    minWinRate: 45,
    warnWinRate: 48,
    maxDrawdownPct: 35,
    warnDrawdownPct: 28,
    minProfitFactor: 1.0,
    warnProfitFactor: 1.1,
    minExpectancy: 0,
    minHealthScore: 40,
    minOverallScore: 60,
  },
  live: {
    minEvaluatedTrades: 50,
    minWinRate: 52,
    warnWinRate: 55,
    maxDrawdownPct: 25,
    warnDrawdownPct: 20,
    minProfitFactor: 1.2,
    warnProfitFactor: 1.35,
    minExpectancy: 0.15,
    minHealthScore: 55,
    minOverallScore: 75,
  },
} as const;

export type ValidationDeployTarget = 'paper' | 'live';
