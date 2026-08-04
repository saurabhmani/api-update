// ════════════════════════════════════════════════════════════════
//  Trust Signal Board — confirmed snapshots → board rows
// ════════════════════════════════════════════════════════════════

import { getStrategyMeta } from '@strategy-engine';
import { enrichWithLiveLtp } from '@/lib/signals/confirmedSignalsService';
import { loadSnapshotsForBoard, type SignalBoardFilters } from '../repository/signalSnapshots';
import { loadMarketRegimeSnapshot } from './benchmarkCandles';
import { applyRegimeConfidenceModifier } from './regimeConfidence';
import { resolveSignalReasons } from './signalReasonEngine';
import { resolveSignalWarnings } from './signalWarningEngine';
import type { TrustSignalBoardRow } from '../types';

const CLOSED = new Set(['TARGET_HIT', 'STOP_LOSS_HIT', 'EXPIRED', 'INVALIDATED']);

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export type { SignalBoardFilters };

export async function loadTrustSignalBoard(
  filters: SignalBoardFilters = {},
): Promise<TrustSignalBoardRow[]> {
  const regime = await loadMarketRegimeSnapshot();
  const snapshots = await loadSnapshotsForBoard(filters);
  const enriched = await enrichWithLiveLtp(snapshots);

  const rows: TrustSignalBoardRow[] = [];
  for (const snap of enriched) {
    const reasonsResult = await resolveSignalReasons(snap.id);
    const warningsResult = await resolveSignalWarnings(snap.id);
    const meta = snap.strategy ? getStrategyMeta(snap.strategy as never) : null;

    const target1 = num(snap.target1);
    const target2 = snap.target2 != null ? num(snap.target2) : null;
    const targets = [target1, ...(target2 != null ? [target2] : [])].filter((t) => t > 0);

    const baseConfidence = num(snap.confidence_score ?? snap.confidence);
    const regimeAdj = applyRegimeConfidenceModifier(baseConfidence, snap.direction, regime);

    const isClosed = CLOSED.has(snap.status);

    rows.push({
      id: snap.id,
      symbol: snap.tradingsymbol ?? snap.symbol,
      direction: snap.direction,
      strategy: snap.strategy,
      strategyDisplay: meta?.strategyName ?? snap.strategy,
      entry: num(snap.entry_price),
      stopLoss: num(snap.stop_loss),
      targets,
      tradePlan: {
        entry: num(snap.entry_price),
        stopLoss: num(snap.stop_loss),
        target1,
        target2,
        riskReward: num(snap.risk_reward ?? snap.rr_ratio),
        profitPercent: num(snap.profit_percent),
        lossPercent: num(snap.loss_percent),
        expectedEdgePercent: num(snap.expected_edge_percent),
        validUntil: snap.valid_until != null ? String(snap.valid_until) : null,
      },
      confidence: regimeAdj.adjustedConfidence,
      baseConfidence: regimeAdj.baseConfidence,
      regimeModifier: regimeAdj.modifier,
      regimeAdjustmentReason: regimeAdj.reason,
      riskReward: num(snap.risk_reward ?? snap.rr_ratio),
      reasons: reasonsResult?.reasons.slice(0, 8) ?? [],
      warnings: warningsResult?.warnings.slice(0, 8) ?? [],
      reasonSources: reasonsResult?.sources ?? [],
      warningSources: warningsResult?.sources ?? [],
      institutionalWarnings: warningsResult?.institutionalWarnings.slice(0, 4) ?? [],
      status: snap.status,
      lifecycle: isClosed ? 'closed' : 'active',
      confirmedAt: snap.confirmed_at ?? null,
      livePrice: snap.livePrice ?? null,
    });
  }

  return rows;
}
