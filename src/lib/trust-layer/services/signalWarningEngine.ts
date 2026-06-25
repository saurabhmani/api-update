// ════════════════════════════════════════════════════════════════
//  Signal Warning Engine — DB + explanation + feature engine
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getConfirmedSnapshotById } from '@/lib/signal-engine/repository/readConfirmedSnapshots';
import { buildWarnings } from '@/lib/signal-engine/explain/buildWarnings';
import type { SignalFeatures, StrategyName } from '@/lib/signal-engine/types/signalEngine.types';
import type { SignalWarningResult } from '../types';

function extractStringArray(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return [];
}

export async function resolveSignalWarnings(snapshotId: number): Promise<SignalWarningResult | null> {
  const snapshot = await getConfirmedSnapshotById(snapshotId);
  if (!snapshot) return null;

  const signalId = snapshot.source_signal_id ?? snapshot.id;
  const sources: SignalWarningResult['sources'] = [];
  const warnings: string[] = [];
  const institutionalWarnings: string[] = [];

  try {
    const { rows } = await db.query(
      `SELECT message FROM q365_signal_reasons
       WHERE signal_id = ? AND reason_type = 'warning'
       ORDER BY id ASC`,
      [signalId],
    );
    for (const row of rows as Array<{ message: string }>) {
      if (row.message?.trim()) {
        warnings.push(row.message.trim());
        sources.push('database');
      }
    }
  } catch { /* optional table */ }

  const explanation = snapshot.explanation as Record<string, unknown> | null;
  if (explanation) {
    const fromExplanation = [
      ...extractStringArray(explanation.warnings),
      ...extractStringArray(explanation.softWarnings),
      ...extractStringArray(explanation.institutionalWarnings),
    ];
    if (fromExplanation.length > 0) {
      warnings.push(...fromExplanation);
      sources.push('explanation');
    }
    institutionalWarnings.push(...extractStringArray(explanation.institutionalWarnings));
  }

  if (snapshot.rejection_codes?.length) {
    for (const code of snapshot.rejection_codes) {
      institutionalWarnings.push(`Rejection code: ${code}`);
    }
  }

  // Feature-snapshot engine warnings when available
  try {
    const { rows } = await db.query(
      `SELECT features_json FROM q365_signal_feature_snapshots WHERE signal_id = ? LIMIT 1`,
      [signalId],
    );
    if (rows.length) {
      const features = JSON.parse(String((rows[0] as { features_json: string }).features_json)) as SignalFeatures;
      const strategy = snapshot.strategy as StrategyName | undefined;
      const engineWarnings = buildWarnings(features, strategy);
      if (engineWarnings.length > 0) {
        warnings.push(...engineWarnings);
        sources.push('engine');
      }
    }
  } catch { /* no feature snapshot */ }

  return {
    signalId: snapshot.id,
    symbol: snapshot.symbol ?? snapshot.tradingsymbol,
    warnings: Array.from(new Set(warnings)),
    institutionalWarnings: Array.from(new Set(institutionalWarnings)),
    sources: Array.from(new Set(sources)),
  };
}
