// ════════════════════════════════════════════════════════════════
//  Signal Reason Engine — DB + explanation + registry
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getConfirmedSnapshotById } from '@/lib/signal-engine/repository/readConfirmedSnapshots';
import { getStrategyMeta } from '@/lib/signal-engine/strategies/strategyRegistry';
import { normalizeSignalReasons } from '@/lib/signals/normalizeReasons';
import type { SignalReasonResult } from '../types';

function extractStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export async function resolveSignalReasons(snapshotId: number): Promise<SignalReasonResult | null> {
  const snapshot = await getConfirmedSnapshotById(snapshotId);
  if (!snapshot) return null;

  const signalId = snapshot.source_signal_id ?? snapshot.id;
  const sources: SignalReasonResult['sources'] = [];
  const reasons: string[] = [];
  const confirmationReasons: string[] = [];

  // Database reasons
  try {
    const { rows } = await db.query(
      `SELECT message FROM q365_signal_reasons
       WHERE signal_id = ? AND reason_type = 'reason'
       ORDER BY id ASC`,
      [signalId],
    );
    for (const row of rows as Array<{ message: string }>) {
      if (row.message?.trim()) {
        reasons.push(row.message.trim());
        sources.push('database');
      }
    }
  } catch { /* table may be empty */ }

  // Explanation block on snapshot
  const explanation = snapshot.explanation as Record<string, unknown> | null;
  if (explanation) {
    const fromExplanation = [
      ...extractStringArray(explanation.reasons),
      ...extractStringArray(explanation.confirmationReasons),
      ...extractStringArray(explanation.summary),
    ];
    if (fromExplanation.length > 0) {
      reasons.push(...fromExplanation);
      sources.push('explanation');
    }
  }

  // Strategy registry template
  if (snapshot.strategy) {
    const meta = getStrategyMeta(snapshot.strategy as never);
    if (meta?.explanation) {
      reasons.push(meta.explanation);
      sources.push('registry');
    }
  }

  const normalized = normalizeSignalReasons({
    confirmationReasons: reasons,
    reason: snapshot.strategy ? `${snapshot.strategy} setup` : undefined,
  });

  return {
    signalId: snapshot.id,
    symbol: snapshot.symbol ?? snapshot.tradingsymbol,
    reasons: Array.from(new Set([...normalized.confirmationReasons, ...reasons])),
    confirmationReasons: normalized.confirmationReasons,
    sources: Array.from(new Set(sources)),
  };
}
