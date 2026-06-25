// Strategy Lab — DB tables + persistence

import { db } from '@/lib/db';
import type { LabStatus, StrategyDefinition, ValidationResult } from '../types';

let migrated = false;

export async function ensureStrategyLabTables(): Promise<void> {
  if (migrated) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS strategy_lab_definitions (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        source VARCHAR(32) NOT NULL DEFAULT 'no_code',
        timeframe VARCHAR(16) NOT NULL DEFAULT 'swing',
        direction VARCHAR(8) NOT NULL DEFAULT 'long',
        definition_json JSON NOT NULL,
        dsl_text TEXT,
        status VARCHAR(32) NOT NULL DEFAULT 'draft',
        validated TINYINT(1) NOT NULL DEFAULT 0,
        validation_json JSON,
        last_backtest_id VARCHAR(64),
        backtest_passed TINYINT(1) NOT NULL DEFAULT 0,
        paper_deployed TINYINT(1) NOT NULL DEFAULT 0,
        created_by VARCHAR(100),
        version INT NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_lab_status (status),
        INDEX idx_lab_validated (validated)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS strategy_lab_audit (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        strategy_id VARCHAR(64) NOT NULL,
        action VARCHAR(64) NOT NULL,
        actor VARCHAR(100),
        details_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_lab_audit_strategy (strategy_id, created_at DESC)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS strategy_lab_deployments (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        strategy_id VARCHAR(64) NOT NULL,
        deployment_type VARCHAR(32) NOT NULL DEFAULT 'paper',
        status VARCHAR(32) NOT NULL DEFAULT 'pending',
        gates_json JSON,
        approved_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_lab_deploy_strategy (strategy_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    migrated = true;
  } catch {
    migrated = true;
  }
}

export async function insertAudit(
  strategyId: string,
  action: string,
  actor: string | null,
  details: Record<string, unknown> | null,
): Promise<void> {
  await ensureStrategyLabTables();
  try {
    await db.query(
      `INSERT INTO strategy_lab_audit (strategy_id, action, actor, details_json) VALUES (?, ?, ?, ?)`,
      [strategyId, action, actor, details ? JSON.stringify(details) : null],
    );
  } catch { /* best effort */ }
}

export async function saveLabDefinition(row: {
  id: string;
  name: string;
  description: string | null;
  source: string;
  timeframe: string;
  direction: string;
  definition: StrategyDefinition;
  dsl: string;
  status: LabStatus;
  validated: boolean;
  validation: ValidationResult | null;
  createdBy: string | null;
}): Promise<void> {
  await ensureStrategyLabTables();
  await db.query(
    `INSERT INTO strategy_lab_definitions
       (id, name, description, source, timeframe, direction, definition_json, dsl_text,
        status, validated, validation_json, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name=VALUES(name), description=VALUES(description), definition_json=VALUES(definition_json),
       dsl_text=VALUES(dsl_text), status=VALUES(status), validated=VALUES(validated),
       validation_json=VALUES(validation_json), version=version+1, updated_at=NOW()`,
    [
      row.id, row.name, row.description, row.source, row.timeframe, row.direction,
      JSON.stringify(row.definition), row.dsl, row.status,
      row.validated ? 1 : 0, row.validation ? JSON.stringify(row.validation) : null,
      row.createdBy,
    ],
  );
}

export async function loadLabDefinition(id: string): Promise<Record<string, unknown> | null> {
  await ensureStrategyLabTables();
  const { rows } = await db.query(`SELECT * FROM strategy_lab_definitions WHERE id = ? LIMIT 1`, [id]);
  return rows.length ? (rows[0] as Record<string, unknown>) : null;
}

export async function listLabDefinitions(): Promise<Record<string, unknown>[]> {
  await ensureStrategyLabTables();
  const { rows } = await db.query(
    `SELECT id, name, source, status, validated, backtest_passed, paper_deployed, created_at, updated_at
       FROM strategy_lab_definitions ORDER BY updated_at DESC LIMIT 100`,
  );
  return rows as Record<string, unknown>[];
}

export async function updateLabBacktest(id: string, backtestId: string, passed: boolean): Promise<void> {
  await ensureStrategyLabTables();
  await db.query(
    `UPDATE strategy_lab_definitions SET last_backtest_id=?, backtest_passed=?, status=? WHERE id=?`,
    [backtestId, passed ? 1 : 0, passed ? 'backtested' : 'validated', id],
  );
}

export async function markPaperDeployed(id: string): Promise<void> {
  await ensureStrategyLabTables();
  await db.query(
    `UPDATE strategy_lab_definitions SET paper_deployed=1, status='paper_ready' WHERE id=?`,
    [id],
  );
}

export async function loadAuditTrail(strategyId: string): Promise<Record<string, unknown>[]> {
  await ensureStrategyLabTables();
  const { rows } = await db.query(
    `SELECT id, action, actor, details_json, created_at FROM strategy_lab_audit WHERE strategy_id=? ORDER BY created_at DESC LIMIT 50`,
    [strategyId],
  );
  return rows as Record<string, unknown>[];
}
