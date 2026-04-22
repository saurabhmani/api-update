// ════════════════════════════════════════════════════════════════
//  Manipulation Engine — Schema Migration (3 tables)
//
//  Idempotent: safe to call on every process boot. The tables are
//  intentionally namespaced `q365_manipulation_*` to avoid clashing
//  with the legacy `manipulation_alerts` table used by the older
//  manipulation-detection subsystem.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';

let _migrated = false;

export async function ensureManipulationEngineTables(): Promise<void> {
  if (_migrated) return;
  await migrateManipulationEngineTables();
  _migrated = true;
}

export async function migrateManipulationEngineTables(): Promise<void> {
  // 1. Event log — one row per triggered detector per symbol per day.
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_manipulation_events (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      symbol        VARCHAR(50)   NOT NULL,
      event_date    DATE          NOT NULL,
      event_type    VARCHAR(60)   NOT NULL,
      severity      VARCHAR(10)   NOT NULL,
      confidence    DECIMAL(4,3)  NOT NULL,
      score         DECIMAL(6,2)  NOT NULL,
      evidence_json JSON          NULL,
      created_at    DATETIME      DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_qme_symbol  (symbol),
      INDEX idx_qme_date    (event_date),
      INDEX idx_qme_type    (event_type),
      INDEX idx_qme_sym_dt  (symbol, event_date)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 2. Daily per-symbol snapshot with aggregate score + feature payload.
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_manipulation_snapshots (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      symbol              VARCHAR(50)   NOT NULL,
      snapshot_date       DATE          NOT NULL,
      manipulation_score  DECIMAL(6,2)  NOT NULL,
      suspicion_band      VARCHAR(20)   NOT NULL,
      feature_json        JSON          NULL,
      triggered_events_json JSON        NULL,
      explanation         VARCHAR(500)  NULL,
      created_at          DATETIME      DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_qms (symbol, snapshot_date),
      INDEX idx_qms_symbol (symbol),
      INDEX idx_qms_date   (snapshot_date),
      INDEX idx_qms_band   (suspicion_band)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 3. Link table — signal engine records which signals were touched by
  //    which snapshot (and what penalty/warning was applied if any).
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_signal_manipulation_links (
      id                      INT AUTO_INCREMENT PRIMARY KEY,
      signal_id               VARCHAR(64)   NOT NULL,
      symbol                  VARCHAR(50)   NOT NULL,
      manipulation_snapshot_id INT          NOT NULL,
      penalty_applied         DECIMAL(5,2)  DEFAULT 0,
      warning_added           VARCHAR(500)  NULL,
      created_at              DATETIME      DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_qsml_signal (signal_id),
      INDEX idx_qsml_symbol (symbol),
      INDEX idx_qsml_snap   (manipulation_snapshot_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── Phase 2 tables ────────────────────────────────────────────

  // 4. Per-detector results: one row per detector per snapshot. Allows
  //    surveillance UI to show the full breakdown without re-parsing
  //    the snapshot's triggered_events_json.
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_manipulation_detector_results (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      snapshot_id   INT           NOT NULL,
      detector_name VARCHAR(60)   NOT NULL,
      triggered     TINYINT(1)    NOT NULL,
      severity      VARCHAR(10)   NOT NULL,
      score         DECIMAL(6,2)  NOT NULL,
      evidence_json JSON          NULL,
      created_at    DATETIME      DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_qmdr_snap (snapshot_id),
      INDEX idx_qmdr_name (detector_name),
      INDEX idx_qmdr_trig (triggered)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 5. Penalty log: one row per signal that was penalized or rejected
  //    because of a manipulation snapshot. Critical for audit trail.
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_manipulation_penalties (
      id                  INT AUTO_INCREMENT PRIMARY KEY,
      signal_id           VARCHAR(64)   NOT NULL,
      snapshot_id         INT           NOT NULL,
      confidence_penalty  DECIMAL(5,2)  NOT NULL DEFAULT 0,
      risk_penalty        DECIMAL(5,2)  NOT NULL DEFAULT 0,
      rejection_flag      TINYINT(1)    NOT NULL DEFAULT 0,
      reason              VARCHAR(500)  NULL,
      created_at          DATETIME      DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_qmp_signal (signal_id),
      INDEX idx_qmp_snap   (snapshot_id),
      INDEX idx_qmp_reject (rejection_flag)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── Phase 3 tables ────────────────────────────────────────────

  // 6. Watchlist (current state). One row per (symbol, watchlist_type).
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_manipulation_watchlists (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      symbol          VARCHAR(50)   NOT NULL,
      watchlist_type  VARCHAR(40)   NOT NULL,
      score_at_add    DECIMAL(6,2)  NOT NULL,
      band_at_add     VARCHAR(20)   NOT NULL,
      reason          VARCHAR(500)  NULL,
      added_at        DATETIME      DEFAULT CURRENT_TIMESTAMP,
      cooling_off_until DATE        NULL,
      UNIQUE KEY uq_qmw (symbol, watchlist_type),
      INDEX idx_qmw_type (watchlist_type),
      INDEX idx_qmw_added (added_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 7. Watchlist change history (immutable audit log).
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_manipulation_watchlist_history (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      symbol          VARCHAR(50)   NOT NULL,
      watchlist_type  VARCHAR(40)   NOT NULL,
      change_type     VARCHAR(20)   NOT NULL,
      score           DECIMAL(6,2)  NULL,
      band            VARCHAR(20)   NULL,
      reason          VARCHAR(500)  NULL,
      changed_at      DATETIME      DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_qmwh_symbol (symbol),
      INDEX idx_qmwh_type   (watchlist_type),
      INDEX idx_qmwh_change (change_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // 8. Calibration snapshots: bucketed performance vs suspicion score.
  await db.query(`
    CREATE TABLE IF NOT EXISTS q365_manipulation_calibration_snapshots (
      id              INT AUTO_INCREMENT PRIMARY KEY,
      run_id          VARCHAR(64)   NULL,
      snapshot_date   DATE          NOT NULL,
      bucket_band     VARCHAR(20)   NOT NULL,
      sample_size     INT           NOT NULL,
      win_rate        DECIMAL(5,2)  NULL,
      avg_pnl_pct     DECIMAL(7,3)  NULL,
      false_breakout_rate DECIMAL(5,2) NULL,
      created_at      DATETIME      DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_qmcs_run  (run_id),
      INDEX idx_qmcs_date (snapshot_date),
      INDEX idx_qmcs_band (bucket_band)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // ── Idempotent ALTER: event triage status ─────────────────
  //
  // Added during the manipulation split-brain cleanup so the /api/manipulation
  // PATCH endpoint (previously backed by the old manipulation_alerts table)
  // can mutate engine event rows. Default 'new' matches the legacy AlertStatus
  // initial value, so pre-existing rows surface as actionable, not resolved.
  const { rows: cols } = await db.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'q365_manipulation_events'
        AND COLUMN_NAME = 'status'`,
  );
  if (cols.length === 0) {
    await db.query(
      `ALTER TABLE q365_manipulation_events
         ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'new',
         ADD INDEX idx_qme_status (status)`,
    ).catch((err) => {
      console.warn('[manipulation-engine] status column ALTER failed:', err?.message);
    });
  }
}
