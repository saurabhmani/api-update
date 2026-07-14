// ════════════════════════════════════════════════════════════════
//  Multi-timeframe explanation lines — Product A Phase 4
// ════════════════════════════════════════════════════════════════

import type { MultiTimeframeAlignmentResult, MtfExplainContract } from '../multitimeframe/multiTimeframeAlignment';

/** Operator-facing lines matching the canonical explain contract. */
export function buildMtfExplainLines(alignment: MultiTimeframeAlignmentResult): string[] {
  const e = alignment.explain;
  return [
    `Daily: ${e.daily.verdict} — ${e.daily.evidence}`,
    `4H: ${e.fourHour.verdict} — ${e.fourHour.evidence}`,
    `1H: ${e.oneHour.role} — ${e.oneHour.evidence}`,
    `Overall alignment: ${e.overall.state} (score ${e.overall.score >= 0 ? '+' : ''}${e.overall.score})`,
  ];
}

export function formatMtfExplainContract(contract: MtfExplainContract): string {
  return [
    `Daily: ${contract.daily.verdict} — ${contract.daily.evidence}`,
    `4H: ${contract.fourHour.verdict} — ${contract.fourHour.evidence}`,
    `1H: ${contract.oneHour.role} — ${contract.oneHour.evidence}`,
    `Overall: ${contract.overall.state} (${contract.overall.score >= 0 ? '+' : ''}${contract.overall.score})`,
  ].join('\n');
}
