// ════════════════════════════════════════════════════════════════
//  Strategy Validation — history repository (Phase 4)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensureStrategyHubTables } from './strategyHubSchema';
import type { StrategyValidationHistoryRow, ValidationReport } from '../validation/types';

function parseJsonField<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw as T;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return null;
  }
}

export async function recordValidationHistory(entry: {
  strategyId: string;
  userId: number;
  target: StrategyValidationHistoryRow['validation_target'];
  overallStatus: StrategyValidationHistoryRow['overall_status'];
  validationScore: number;
  report: ValidationReport;
  effectiveConfig: Record<string, unknown> | null;
  configVersion: number;
  executionTimeMs: number;
  actor?: string | null;
}): Promise<number> {
  await ensureStrategyHubTables();
  const { insertId } = await db.query(
    `INSERT INTO strategy_hub_validation_history
       (strategy_id, user_id, validation_target, overall_status, validation_score,
        report_json, effective_config_json, config_version, execution_time_ms, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.strategyId,
      entry.userId,
      entry.target,
      entry.overallStatus,
      entry.validationScore,
      JSON.stringify(entry.report),
      entry.effectiveConfig ? JSON.stringify(entry.effectiveConfig) : null,
      entry.configVersion,
      entry.executionTimeMs,
      entry.actor ?? null,
    ],
  );
  return Number(insertId ?? 0);
}

export async function listValidationHistory(opts: {
  strategyId: string;
  limit?: number;
}): Promise<StrategyValidationHistoryRow[]> {
  await ensureStrategyHubTables();
  const limit = Math.max(1, Math.min(opts.limit ?? 30, 100));
  const { rows } = await db.query(
    `SELECT id, strategy_id, user_id, validation_target, overall_status,
            validation_score, report_json, effective_config_json, config_version,
            execution_time_ms, actor, created_at
       FROM strategy_hub_validation_history
      WHERE strategy_id = ?
      ORDER BY created_at DESC
      LIMIT ${limit}`,
    [opts.strategyId],
  );

  return (rows as Record<string, unknown>[]).map((r) => ({
    id:                   Number(r.id),
    strategy_id:          String(r.strategy_id),
    user_id:              Number(r.user_id),
    validation_target:    String(r.validation_target) as StrategyValidationHistoryRow['validation_target'],
    overall_status:       String(r.overall_status) as StrategyValidationHistoryRow['overall_status'],
    validation_score:     Number(r.validation_score),
    report_json:          parseJsonField<ValidationReport>(r.report_json) as ValidationReport,
    effective_config_json: parseJsonField<Record<string, unknown>>(r.effective_config_json),
    config_version:       Number(r.config_version ?? 0),
    execution_time_ms:    Number(r.execution_time_ms ?? 0),
    actor:                r.actor != null ? String(r.actor) : null,
    created_at:           String(r.created_at),
  }));
}

export async function loadValidationReport(
  strategyId: string,
  validationId: number,
): Promise<StrategyValidationHistoryRow | null> {
  await ensureStrategyHubTables();
  const { rows } = await db.query(
    `SELECT id, strategy_id, user_id, validation_target, overall_status,
            validation_score, report_json, effective_config_json, config_version,
            execution_time_ms, actor, created_at
       FROM strategy_hub_validation_history
      WHERE strategy_id = ? AND id = ?
      LIMIT 1`,
    [strategyId, validationId],
  );
  if (!rows.length) return null;
  const r = rows[0] as Record<string, unknown>;
  return {
    id:                   Number(r.id),
    strategy_id:          String(r.strategy_id),
    user_id:              Number(r.user_id),
    validation_target:    String(r.validation_target) as StrategyValidationHistoryRow['validation_target'],
    overall_status:       String(r.overall_status) as StrategyValidationHistoryRow['overall_status'],
    validation_score:     Number(r.validation_score),
    report_json:          parseJsonField<ValidationReport>(r.report_json) as ValidationReport,
    effective_config_json: parseJsonField<Record<string, unknown>>(r.effective_config_json),
    config_version:       Number(r.config_version ?? 0),
    execution_time_ms:    Number(r.execution_time_ms ?? 0),
    actor:                r.actor != null ? String(r.actor) : null,
    created_at:           String(r.created_at),
  };
}

export async function loadLatestValidation(
  strategyId: string,
): Promise<StrategyValidationHistoryRow | null> {
  const rows = await listValidationHistory({ strategyId, limit: 1 });
  return rows[0] ?? null;
}
