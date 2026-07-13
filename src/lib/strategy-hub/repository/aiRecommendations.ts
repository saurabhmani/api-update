// ════════════════════════════════════════════════════════════════
//  Strategy Hub — AI recommendation history (Phase 7)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { AiRecommendation, AiRecommendationHistoryRow, AiRecommendationStatus } from '../ai/types';
import { ensureStrategyHubTables } from './strategyHubSchema';

function parseJsonField<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

export async function upsertAiRecommendations(
  strategyId: string,
  recommendations: AiRecommendation[],
): Promise<void> {
  await ensureStrategyHubTables();
  if (!recommendations.length) return;

  for (const rec of recommendations) {
    await db.query(
      `INSERT INTO strategy_hub_ai_recommendations
         (strategy_id, rec_key, category, action, reason, evidence_json,
          expected_impact, confidence_level, apply_mode, target_mode, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
       ON DUPLICATE KEY UPDATE
         category = VALUES(category),
         action = VALUES(action),
         reason = VALUES(reason),
         evidence_json = VALUES(evidence_json),
         expected_impact = VALUES(expected_impact),
         confidence_level = VALUES(confidence_level),
         apply_mode = VALUES(apply_mode),
         target_mode = VALUES(target_mode),
         status = IF(status = 'applied', 'applied', 'active'),
         updated_at = CURRENT_TIMESTAMP`,
      [
        strategyId,
        rec.key,
        rec.category,
        rec.action,
        rec.reason,
        JSON.stringify(rec.evidence),
        rec.expectedImpact,
        rec.confidenceLevel,
        rec.applyMode,
        rec.targetMode ?? null,
      ],
    );
  }
}

export async function listAiRecommendationHistory(opts: {
  strategyId?: string;
  status?: AiRecommendationStatus;
  limit?: number;
}): Promise<AiRecommendationHistoryRow[]> {
  await ensureStrategyHubTables();
  const limit = Math.min(opts.limit ?? 50, 200);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (opts.strategyId) {
    clauses.push('strategy_id = ?');
    params.push(opts.strategyId);
  }
  if (opts.status) {
    clauses.push('status = ?');
    params.push(opts.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await db.query<Record<string, unknown>>(
    `SELECT * FROM strategy_hub_ai_recommendations ${where} ORDER BY created_at DESC LIMIT ${limit}`,
    params,
  );
  return (rows ?? []).map((r) => ({
    id: Number(r.id),
    strategy_id: String(r.strategy_id),
    rec_key: String(r.rec_key),
    category: String(r.category),
    action: String(r.action),
    reason: String(r.reason),
    evidence_json: parseJsonField<string[]>(r.evidence_json),
    expected_impact: String(r.expected_impact ?? ''),
    confidence_level: String(r.confidence_level),
    apply_mode: String(r.apply_mode ?? 'advisory'),
    target_mode: r.target_mode != null ? String(r.target_mode) : null,
    status: String(r.status) as AiRecommendationStatus,
    applied_by: r.applied_by != null ? String(r.applied_by) : null,
    applied_at: r.applied_at ? new Date(String(r.applied_at)).toISOString() : null,
    created_at: new Date(String(r.created_at)).toISOString(),
  }));
}

export async function updateAiRecommendationStatus(opts: {
  strategyId: string;
  recKey: string;
  status: AiRecommendationStatus;
  appliedBy?: string | null;
}): Promise<boolean> {
  await ensureStrategyHubTables();
  const appliedAt = opts.status === 'applied' ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;
  const { affectedRows } = await db.query(
    `UPDATE strategy_hub_ai_recommendations
        SET status = ?, applied_by = ?, applied_at = ?
      WHERE strategy_id = ? AND rec_key = ?`,
    [
      opts.status,
      opts.appliedBy ?? null,
      appliedAt,
      opts.strategyId,
      opts.recKey,
    ],
  );
  return Number(affectedRows ?? 0) > 0;
}

export function mapHistoryRowToRecommendation(row: AiRecommendationHistoryRow, strategyName: string): AiRecommendation {
  return {
    key: row.rec_key,
    strategyId: row.strategy_id,
    strategyName,
    category: row.category as AiRecommendation['category'],
    action: row.action,
    reason: row.reason,
    evidence: row.evidence_json ?? [],
    expectedImpact: row.expected_impact,
    confidenceLevel: row.confidence_level as AiRecommendation['confidenceLevel'],
    historicalBasis: `Recorded ${row.created_at}`,
    applyMode: row.apply_mode as AiRecommendation['applyMode'],
    targetMode: row.target_mode ?? undefined,
  };
}
