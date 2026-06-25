// Canonical strategy builder tables — user_strategies, drafts, validation logs, conditions sync

import { db } from '@/lib/db';
import type { LabCondition, StrategyDefinition, ValidationResult } from '../types';

let migrated = false;

export async function ensureStrategyBuilderTables(): Promise<void> {
  if (migrated) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_strategies (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(100),
        name VARCHAR(255) NOT NULL,
        description TEXT,
        source VARCHAR(32) NOT NULL DEFAULT 'no_code',
        timeframe VARCHAR(16) NOT NULL DEFAULT 'swing',
        direction VARCHAR(8) NOT NULL DEFAULT 'long',
        definition_json JSON NOT NULL,
        dsl_text TEXT,
        status VARCHAR(32) NOT NULL DEFAULT 'draft',
        validated TINYINT(1) NOT NULL DEFAULT 0,
        backtest_passed TINYINT(1) NOT NULL DEFAULT 0,
        paper_deployed TINYINT(1) NOT NULL DEFAULT 0,
        last_backtest_id VARCHAR(64),
        version INT NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_user_strategies_user (user_id, updated_at),
        INDEX idx_user_strategies_status (status)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS strategy_drafts (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(100),
        name VARCHAR(255) NOT NULL DEFAULT 'Untitled Draft',
        source VARCHAR(32) NOT NULL DEFAULT 'no_code',
        definition_json JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_strategy_drafts_user (user_id, updated_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS strategy_validation_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        strategy_id VARCHAR(64) NOT NULL,
        user_id VARCHAR(100),
        valid TINYINT(1) NOT NULL,
        issues_json JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_validation_logs_strategy (strategy_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    migrated = true;
  } catch {
    migrated = true;
  }
}

function conditionValue(c: LabCondition): { numeric: number | null; text: string | null } {
  if (Array.isArray(c.value)) return { numeric: null, text: `${c.value[0]}-${c.value[1]}` };
  return { numeric: typeof c.value === 'number' ? c.value : null, text: null };
}

export async function syncStrategyConditions(strategyId: string, def: StrategyDefinition): Promise<void> {
  await ensureStrategyBuilderTables();
  try {
    await db.query(`DELETE FROM strategy_conditions WHERE strategy_id = ?`, [strategyId]);
    let order = 0;
    for (const c of def.entry.conditions) {
      const { numeric, text } = conditionValue(c);
      await db.query(
        `INSERT INTO strategy_conditions
           (strategy_id, condition_key, condition_label, condition_type, operator, value_numeric, value_text, sort_order)
         VALUES (?, ?, ?, 'entry', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE condition_label=VALUES(condition_label), operator=VALUES(operator),
           value_numeric=VALUES(value_numeric), value_text=VALUES(value_text), sort_order=VALUES(sort_order)`,
        [strategyId, `entry_${c.id}`, c.label ?? c.indicator, c.operator, numeric, text, order++],
      );
    }
    for (const c of def.exit.conditions) {
      const { numeric, text } = conditionValue(c);
      await db.query(
        `INSERT INTO strategy_conditions
           (strategy_id, condition_key, condition_label, condition_type, operator, value_numeric, value_text, sort_order)
         VALUES (?, ?, ?, 'exit', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE condition_label=VALUES(condition_label), operator=VALUES(operator),
           value_numeric=VALUES(value_numeric), value_text=VALUES(value_text), sort_order=VALUES(sort_order)`,
        [strategyId, `exit_${c.id}`, c.label ?? c.indicator, c.operator, numeric, text, order++],
      );
    }
  } catch { /* strategy_conditions may not exist in all envs */ }
}

export async function upsertUserStrategy(row: {
  id: string;
  userId: string | null;
  name: string;
  description: string | null;
  source: string;
  timeframe: string;
  direction: string;
  definition: StrategyDefinition;
  dsl: string;
  status: string;
  validated: boolean;
}): Promise<void> {
  await ensureStrategyBuilderTables();
  await db.query(
    `INSERT INTO user_strategies
       (id, user_id, name, description, source, timeframe, direction, definition_json, dsl_text, status, validated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name=VALUES(name), description=VALUES(description), definition_json=VALUES(definition_json),
       dsl_text=VALUES(dsl_text), status=VALUES(status), validated=VALUES(validated),
       version=version+1, updated_at=NOW()`,
    [
      row.id, row.userId, row.name, row.description, row.source, row.timeframe, row.direction,
      JSON.stringify(row.definition), row.dsl, row.status, row.validated ? 1 : 0,
    ],
  );

  try {
    await db.query(
      `INSERT INTO strategies (id, display_name, category, direction, risk_profile, timeframe, is_featured, is_active, paper_trading_ready, deployment_status, explanation)
       VALUES (?, ?, 'custom', ?, 'moderate', ?, FALSE, FALSE, FALSE, 'draft', ?)
       ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), explanation=VALUES(explanation), updated_at=NOW()`,
      [
        row.id,
        row.name,
        row.direction === 'short' ? 'SELL' : 'BUY',
        row.timeframe,
        row.description ?? `User-built ${row.source} strategy`,
      ],
    );
  } catch { /* strategies table optional */ }

  await syncStrategyConditions(row.id, row.definition);
}

export async function saveStrategyDraft(
  id: string,
  userId: string | null,
  name: string,
  source: string,
  definition: StrategyDefinition,
): Promise<void> {
  await ensureStrategyBuilderTables();
  await db.query(
    `INSERT INTO strategy_drafts (id, user_id, name, source, definition_json)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE name=VALUES(name), definition_json=VALUES(definition_json), updated_at=NOW()`,
    [id, userId, name, source, JSON.stringify(definition)],
  );
}

export async function logValidation(
  strategyId: string,
  userId: string | null,
  validation: ValidationResult,
): Promise<void> {
  await ensureStrategyBuilderTables();
  try {
    await db.query(
      `INSERT INTO strategy_validation_logs (strategy_id, user_id, valid, issues_json) VALUES (?, ?, ?, ?)`,
      [strategyId, userId, validation.valid ? 1 : 0, JSON.stringify(validation.issues)],
    );
  } catch { /* best effort */ }
}

export async function updateUserStrategyBacktest(id: string, backtestId: string, passed: boolean): Promise<void> {
  await ensureStrategyBuilderTables();
  await db.query(
    `UPDATE user_strategies SET last_backtest_id=?, backtest_passed=?, status=? WHERE id=?`,
    [backtestId, passed ? 1 : 0, passed ? 'backtested' : 'validated', id],
  );
}

export async function markUserStrategyDeployed(id: string): Promise<void> {
  await ensureStrategyBuilderTables();
  await db.query(
    `UPDATE user_strategies SET paper_deployed=1, status='paper_ready' WHERE id=?`,
    [id],
  );
  try {
    await db.query(
      `UPDATE strategies SET paper_trading_ready=TRUE, deployment_status='paper_ready' WHERE id=?`,
      [id],
    );
  } catch { /* optional */ }
}

export async function loadUserStrategy(id: string): Promise<Record<string, unknown> | null> {
  await ensureStrategyBuilderTables();
  const { rows } = await db.query(`SELECT * FROM user_strategies WHERE id = ? LIMIT 1`, [id]);
  return rows.length ? (rows[0] as Record<string, unknown>) : null;
}

export async function listUserStrategies(userId?: string | null): Promise<Record<string, unknown>[]> {
  await ensureStrategyBuilderTables();
  if (userId) {
    const { rows } = await db.query(
      `SELECT id, name, source, status, validated, backtest_passed, paper_deployed, created_at, updated_at
         FROM user_strategies WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100`,
      [userId],
    );
    return rows as Record<string, unknown>[];
  }
  const { rows } = await db.query(
    `SELECT id, name, source, status, validated, backtest_passed, paper_deployed, created_at, updated_at
       FROM user_strategies ORDER BY updated_at DESC LIMIT 100`,
  );
  return rows as Record<string, unknown>[];
}
