// ════════════════════════════════════════════════════════════════
//  Strategy Breakdown & Conflict Persistence — Phase 2
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { StrategyBreakdown, ConflictResolution } from '../types/signalEngine.types';

/**
 * Save strategy breakdowns for a signal (how each strategy scored).
 *
 * Idempotent on (signal_id, strategy_name). Re-running Phase 2 for the
 * same signal overwrites the scores rather than accumulating duplicate
 * rows — this is what enforces the "no duplicates" invariant the Phase
 * 2 transparency spec requires.
 */
export async function saveStrategyBreakdowns(
  signalId: number | string,
  breakdowns: StrategyBreakdown[],
): Promise<void> {
  if (breakdowns.length === 0) return;

  const values = breakdowns.map((b) => [
    signalId,
    b.strategyName,
    b.matched ? 1 : 0,
    b.confidenceScore,
    b.riskScore,
    b.regimeFit,
    b.rsAlignment,
    b.sectorFit,
    b.structuralQuality,
    b.rejectionReason || null,
  ]);

  const placeholders = values.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');

  await db.query(
    `INSERT INTO q365_strategy_breakdowns
      (signal_id, strategy_name, matched, confidence_score, risk_score,
       regime_fit, rs_alignment, sector_fit, structural_quality, rejection_reason)
     VALUES ${placeholders}
     ON DUPLICATE KEY UPDATE
       matched            = VALUES(matched),
       confidence_score   = VALUES(confidence_score),
       risk_score         = VALUES(risk_score),
       regime_fit         = VALUES(regime_fit),
       rs_alignment       = VALUES(rs_alignment),
       sector_fit         = VALUES(sector_fit),
       structural_quality = VALUES(structural_quality),
       rejection_reason   = VALUES(rejection_reason)`,
    values.flat(),
  );
}

/**
 * Save conflict resolution audit trail.
 *
 * Also computes a top-level `decision_reason` — a one-line summary of
 * why the winner beat the closest competitor. The per-loser reasons
 * live in losing_strategies_json; this column exists so analytics can
 * GROUP BY decision_reason without JSON parsing.
 */
export async function saveConflictResolution(
  resolution: ConflictResolution,
  signalId?: number | string,
): Promise<void> {
  if (resolution.losingStrategies.length === 0) return;

  // Top-ranked loser drives the headline decision_reason. Its
  // suppressionReason is already the richest explanation we have
  // (direction/confidence/risk/composite), so reusing it keeps a
  // single source of truth and avoids reinventing text downstream.
  const topLoser = resolution.losingStrategies[0];
  const decisionReason = resolution.hadDirectionConflict
    ? `Direction conflict resolved in favor of ${resolution.winningStrategy}`
    : topLoser?.suppressionReason ??
      `${resolution.winningStrategy} scored ${resolution.winningScore} vs ${resolution.losingStrategies.length} alternatives`;

  await db.query(
    `INSERT INTO q365_signal_conflicts
      (symbol, winning_signal_id, winning_strategy, winning_score,
       losing_strategies_json, had_direction_conflict, decision_reason, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      resolution.symbol,
      signalId || null,
      resolution.winningStrategy,
      resolution.winningScore,
      JSON.stringify(resolution.losingStrategies),
      resolution.hadDirectionConflict ? 1 : 0,
      decisionReason,
      resolution.resolvedAt,
    ],
  );
}

/**
 * Migration: Create Phase 2 persistence tables.
 */
export async function migratePhase2Tables(): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_strategy_breakdowns (
      id INT AUTO_INCREMENT PRIMARY KEY,
      signal_id INT NOT NULL,
      strategy_name VARCHAR(50) NOT NULL,
      matched TINYINT(1) DEFAULT 0,
      confidence_score DECIMAL(5,2) DEFAULT 0,
      risk_score DECIMAL(5,2) DEFAULT 0,
      regime_fit DECIMAL(5,2) DEFAULT 0,
      rs_alignment DECIMAL(5,2) DEFAULT 0,
      sector_fit DECIMAL(5,2) DEFAULT 0,
      structural_quality DECIMAL(5,2) DEFAULT 0,
      rejection_reason VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_breakdown (signal_id, strategy_name),
      INDEX idx_strategy (strategy_name)
    )
  `);
  // Idempotent upgrade for pre-existing tables that were created with
  // only a non-unique INDEX on signal_id. Adding the composite UNIQUE
  // enforces "one row per (signal, strategy)" and enables the upsert
  // path in saveStrategyBreakdowns.
  try {
    await db.query(`ALTER TABLE q365_strategy_breakdowns DROP INDEX idx_signal_id`);
  } catch { /* index absent — fine */ }
  try {
    await db.query(
      `ALTER TABLE q365_strategy_breakdowns
         ADD UNIQUE KEY uniq_breakdown (signal_id, strategy_name)`,
    );
  } catch { /* unique already present — fine */ }

  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_signal_conflicts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      symbol VARCHAR(30) NOT NULL,
      winning_signal_id INT,
      winning_strategy VARCHAR(50) NOT NULL,
      winning_score DECIMAL(5,2) DEFAULT 0,
      losing_strategies_json JSON,
      had_direction_conflict TINYINT(1) DEFAULT 0,
      decision_reason VARCHAR(255),
      resolved_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_symbol (symbol),
      INDEX idx_resolved (resolved_at)
    )
  `);

  // Idempotent ALTER for pre-existing tables that were created before
  // the decision_reason column was added. Safe on every boot.
  const { rows } = await db.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'q365_signal_conflicts'
        AND COLUMN_NAME = 'decision_reason'`,
  );
  if (rows.length === 0) {
    await db.query(
      `ALTER TABLE q365_signal_conflicts ADD COLUMN decision_reason VARCHAR(255) NULL`,
    ).catch(() => {});
  }

  // ── q365_strategy_conflicts VIEW ────────────────────────────
  //
  // The Phase 2 strategy transparency spec asks for a table called
  // q365_strategy_conflicts with columns {id, signal_id, strategy_name,
  // score, rejection_reason, created_at} to surface "all evaluated
  // strategies that were NOT selected" for each winning signal.
  //
  // The data is already captured: q365_strategy_breakdowns persists
  // every candidate strategy per winning signal, with matched=0 and
  // rejection_reason set for the losers. Rather than create a second
  // mutable table and split the write path, we expose a VIEW over the
  // existing table that projects the spec's exact column names.
  //
  // CREATE OR REPLACE is idempotent on every boot. The view is
  // read-only; writes continue through saveStrategyBreakdowns.
  await db.query(
    `CREATE OR REPLACE VIEW q365_strategy_conflicts AS
       SELECT
         id,
         signal_id,
         strategy_name,
         confidence_score AS score,
         rejection_reason,
         created_at
       FROM q365_strategy_breakdowns
       WHERE matched = 0 OR rejection_reason IS NOT NULL`,
  ).catch((err) => {
    console.warn('[signal-engine] q365_strategy_conflicts view creation failed:', err?.message);
  });
}
