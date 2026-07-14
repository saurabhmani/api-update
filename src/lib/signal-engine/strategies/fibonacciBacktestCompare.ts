// ════════════════════════════════════════════════════════════════
//  Baseline vs Fibonacci Pullback 2.0 — OOS comparison helper
// ════════════════════════════════════════════════════════════════

export interface FibCompareRow {
  regime: string;
  baselineHit: boolean;
  v2Hit: boolean;
  pnlRBaseline?: number;
  pnlRV2?: number;
}

export interface FibCompareReport {
  sameFrozenN: number;
  baselinePrecision: number;
  v2Precision: number;
  regimes: Array<{
    regime: string;
    n: number;
    baselinePrecision: number;
    v2Precision: number;
  }>;
  /** True when ≥3 regimes present for policy reporting. */
  coversThreeRegimes: boolean;
  generatedAt: string;
}

/** Frozen OOS comparison — does not invent performance; aggregates provided outcomes. */
export function compareFibBaselineVsV2(
  rows: FibCompareRow[],
  generatedAt = new Date().toISOString(),
): FibCompareReport {
  const n = rows.length;
  const baselinePrecision = n === 0 ? 0 : rows.filter((r) => r.baselineHit).length / n;
  const v2Precision = n === 0 ? 0 : rows.filter((r) => r.v2Hit).length / n;

  const byReg = new Map<string, FibCompareRow[]>();
  for (const r of rows) {
    const list = byReg.get(r.regime) ?? [];
    list.push(r);
    byReg.set(r.regime, list);
  }

  const regimes = Array.from(byReg.entries()).map(([regime, list]) => ({
    regime,
    n: list.length,
    baselinePrecision: list.filter((x) => x.baselineHit).length / list.length,
    v2Precision: list.filter((x) => x.v2Hit).length / list.length,
  }));

  return {
    sameFrozenN: n,
    baselinePrecision: Math.round(baselinePrecision * 10000) / 10000,
    v2Precision: Math.round(v2Precision * 10000) / 10000,
    regimes,
    coversThreeRegimes: regimes.length >= 3,
    generatedAt,
  };
}
