/// <reference types="node" />
// ════════════════════════════════════════════════════════════════
//  Signal Engine — MySQL Migration (Centralized Pipeline)
//
//  Tables:
//    q365_signals                — all generated signals
//    q365_signal_reasons         — reasons & warnings per signal
//    q365_signal_feature_snapshots — feature snapshots for audit
// ════════════════════════════════════════════════════════════════

import { db } from '../db';

const TABLES = [
  // ── Main signals table ─────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signals (
    id                BIGINT AUTO_INCREMENT PRIMARY KEY,
    instrument_key    VARCHAR(100)  NOT NULL,
    symbol            VARCHAR(50)   NOT NULL,
    exchange          VARCHAR(10)   NOT NULL DEFAULT 'NSE',
    direction         VARCHAR(10)   NOT NULL,
    timeframe         VARCHAR(20)   NOT NULL DEFAULT 'swing',
    signal_type       VARCHAR(50)   NOT NULL,

    confidence_score  INT           NOT NULL,
    confidence_band   VARCHAR(30)   NOT NULL,
    risk_score        INT           NOT NULL,
    risk_band         VARCHAR(30)   NOT NULL,
    opportunity_score INT           NOT NULL DEFAULT 0,
    portfolio_fit_score INT         DEFAULT NULL,
    regime_alignment  INT           DEFAULT NULL,

    entry_price       DECIMAL(12,2) NOT NULL,
    stop_loss         DECIMAL(12,2) NOT NULL,
    target1           DECIMAL(12,2) NOT NULL,
    target2           DECIMAL(12,2) DEFAULT NULL,
    risk_reward       DECIMAL(5,1)  NOT NULL DEFAULT 0.0,

    market_regime     VARCHAR(30)   NOT NULL,
    market_stance     VARCHAR(30)   DEFAULT 'selective',
    scenario_tag      VARCHAR(50)   DEFAULT NULL,

    factor_scores_json JSON         DEFAULT NULL,
    ltp               DECIMAL(12,2) DEFAULT NULL,
    pct_change        DECIMAL(8,2)  DEFAULT NULL,

    status            VARCHAR(20)   NOT NULL DEFAULT 'active',
    batch_id          VARCHAR(50)   DEFAULT NULL,
    generated_at      DATETIME      NOT NULL,
    created_at        DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_q365sig_symbol (symbol),
    INDEX idx_q365sig_direction (direction),
    INDEX idx_q365sig_status (status),
    INDEX idx_q365sig_generated (generated_at DESC),
    INDEX idx_q365sig_confidence (confidence_score DESC),
    INDEX idx_q365sig_batch (batch_id),
    INDEX idx_q365sig_opportunity (opportunity_score DESC)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Reasons & Warnings ─────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_reasons (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id   BIGINT        NOT NULL,
    reason_type VARCHAR(20)   NOT NULL,
    message     TEXT          NOT NULL,
    factor_key  VARCHAR(50)   DEFAULT NULL,
    contribution DECIMAL(5,3) DEFAULT NULL,
    created_at  DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_reasons_signal (signal_id),
    CONSTRAINT fk_reasons_signal FOREIGN KEY (signal_id)
      REFERENCES q365_signals(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Feature Snapshots (audit / backtest) ───────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_feature_snapshots (
    id            BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id     BIGINT NOT NULL,
    features_json JSON   NOT NULL,
    created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_snapshots_signal (signal_id),
    CONSTRAINT fk_snapshots_signal FOREIGN KEY (signal_id)
      REFERENCES q365_signals(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Phase 3: Trade Plans ──────────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_trade_plans (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id       BIGINT         NOT NULL,
    entry_type      VARCHAR(40)    NOT NULL,
    entry_zone_low  DECIMAL(12,2)  NOT NULL,
    entry_zone_high DECIMAL(12,2)  NOT NULL,
    stop_loss       DECIMAL(12,2)  NOT NULL,
    initial_risk_per_unit DECIMAL(12,4) NOT NULL,
    target1         DECIMAL(12,2)  NOT NULL,
    target2         DECIMAL(12,2)  NOT NULL,
    target3         DECIMAL(12,2)  NOT NULL,
    rr_target1      DECIMAL(6,2)   NOT NULL,
    rr_target2      DECIMAL(6,2)   NOT NULL,
    rr_target3      DECIMAL(6,2)   NOT NULL,
    created_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_tp_signal (signal_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Phase 3: Position Sizing ──────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_position_sizing (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id       BIGINT         NOT NULL,
    capital_model   VARCHAR(30)    NOT NULL,
    portfolio_capital DECIMAL(14,2) NOT NULL,
    risk_budget_pct DECIMAL(6,4)   NOT NULL,
    risk_budget_amount DECIMAL(12,2) NOT NULL,
    initial_risk_per_unit DECIMAL(12,4) NOT NULL,
    position_size_units INT        NOT NULL,
    gross_position_value DECIMAL(14,2) NOT NULL,
    validation_status VARCHAR(20)  NOT NULL,
    warnings_json   JSON           DEFAULT NULL,
    created_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_ps_signal (signal_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Phase 3: Portfolio Fit ────────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_portfolio_fit (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id       BIGINT         NOT NULL,
    fit_score       INT            NOT NULL,
    sector_exposure_impact VARCHAR(20) NOT NULL,
    direction_impact VARCHAR(20)   NOT NULL,
    capital_availability VARCHAR(20) NOT NULL,
    correlation_cluster VARCHAR(50) DEFAULT NULL,
    correlation_penalty DECIMAL(5,2) DEFAULT 0,
    portfolio_decision VARCHAR(30)  NOT NULL,
    penalties_json  JSON           DEFAULT NULL,
    created_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_pf_signal (signal_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Phase 3: Execution Readiness ──────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_execution_readiness (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id       BIGINT         NOT NULL,
    status          VARCHAR(40)    NOT NULL,
    action_tag      VARCHAR(30)    NOT NULL,
    priority_rank   INT            DEFAULT NULL,
    approval_decision VARCHAR(20)  NOT NULL,
    reasons_json    JSON           DEFAULT NULL,
    created_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_er_signal (signal_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Phase 3: Signal Lifecycle ─────────────────────────────
  `CREATE TABLE IF NOT EXISTS q365_signal_lifecycle (
    id              BIGINT AUTO_INCREMENT PRIMARY KEY,
    signal_id       BIGINT         NOT NULL,
    state           VARCHAR(20)    NOT NULL,
    reason          VARCHAR(255)   NOT NULL,
    changed_at      DATETIME       NOT NULL,
    created_at      DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_lc_signal (signal_id),
    INDEX idx_lc_state (state)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Signal maturity tracker ───────────────────────────────
  // Pre-confirmation staging. Every fresh detection from the live
  // scanner upserts a row here keyed by (symbol, direction). Each
  // re-detection increments validation_cycles_passed and updates
  // stability state. The maturity worker (60s cadence) walks this
  // table and promotes rows whose maturity_score, cycles, and age
  // all clear the configured thresholds — at which point a row
  // gets inserted into q365_confirmed_signal_snapshots and the
  // tracker stage flips to 'promoted'. When the lifecycle worker
  // transitions the resulting snapshot to a terminal status, the
  // tracker is reset to 'terminated' so a fresh maturity cycle
  // can begin on the next detection.
  //
  // Stage enum (string column, not MySQL ENUM, for forward-compat):
  //   candidate    — score < 70 (watchlist only, never promoted)
  //   developing   — 70-84
  //   mature       — >= 85, but cycles or age may not yet be met
  //   promoted     — confirmed snapshot exists; tracker is dormant
  //   terminated   — promoted snapshot transitioned to terminal status
  `CREATE TABLE IF NOT EXISTS q365_signal_maturity_tracker (
    id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
    symbol                   VARCHAR(50)    NOT NULL,
    direction                VARCHAR(10)    NOT NULL,

    first_detected_at        DATETIME       NOT NULL,
    last_seen_at             DATETIME       NOT NULL,
    last_evaluated_at        DATETIME       NULL,

    validation_cycles_passed INT            NOT NULL DEFAULT 1,
    maturity_score           DECIMAL(5,2)   NOT NULL DEFAULT 0,
    stage                    VARCHAR(20)    NOT NULL DEFAULT 'candidate',
    stable                   TINYINT(1)     NOT NULL DEFAULT 0,
    conviction_level         VARCHAR(20)    NOT NULL DEFAULT 'MEDIUM',

    last_signal_id           BIGINT         NULL,
    promoted_snapshot_id     BIGINT         NULL,

    /** Rolling history of (cycle_no, ts, entry, stop, target,
     *  confidence, final_score, decay_state). Capped at MAX_HISTORY
     *  by the writer to keep the row size bounded. */
    stability_history_json   JSON           NULL,
    /** Latest factor breakdown so the UI can show the maturity
     *  decomposition without a join. */
    maturity_factors_json    JSON           NULL,

    created_at               DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at               DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    UNIQUE KEY uq_smt_symbol_dir (symbol, direction),
    INDEX idx_smt_stage (stage),
    INDEX idx_smt_last_evaluated (last_evaluated_at),
    INDEX idx_smt_promoted_snapshot (promoted_snapshot_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // ── Confirmed intraday signal snapshots (immutable) ───────
  // Two-layer split. q365_signals is the live scanner table —
  // it can mutate every batch. This table is the locked,
  // gate-validated, frozen snapshot the frontend reads.
  //
  // Insertion gate (writer): all rejection gates pass, live
  // validation passes, signal_status = APPROVED_SIGNAL,
  // expected_edge_percent > 0, rr acceptable, conf/score floor
  // satisfied. Once written, only `status`, `status_changed_at`
  // and `invalidation_reason` may change. Entry/stop/target/
  // confidence/score/explanation are frozen.
  //
  // Status enum: ACTIVE, TARGET_HIT, STOP_LOSS_HIT, INVALIDATED,
  // EXPIRED. Initial status is always ACTIVE — there is no
  // PENDING state by design (rows only exist post-confirmation).
  //
  // Validity window: 90 minutes default, configurable 60–120
  // via CONFIRMED_SNAPSHOT_VALIDITY_MINUTES. After valid_until
  // passes, the lifecycle worker flips status → EXPIRED.
  `CREATE TABLE IF NOT EXISTS q365_confirmed_signal_snapshots (
    id                       BIGINT AUTO_INCREMENT PRIMARY KEY,
    source_signal_id         BIGINT         NULL,
    symbol                   VARCHAR(50)    NOT NULL,
    exchange                 VARCHAR(10)    NOT NULL DEFAULT 'NSE',
    direction                VARCHAR(10)    NOT NULL,
    strategy                 VARCHAR(60)    NULL,

    entry_price              DECIMAL(12,2)  NOT NULL,
    stop_loss                DECIMAL(12,2)  NOT NULL,
    target1                  DECIMAL(12,2)  NOT NULL,
    target2                  DECIMAL(12,2)  NULL,

    profit_percent           DECIMAL(8,4)   NOT NULL,
    loss_percent             DECIMAL(8,4)   NOT NULL,
    expected_edge_percent    DECIMAL(8,4)   NOT NULL,
    win_probability          DECIMAL(6,3)   NOT NULL,
    rr_ratio                 DECIMAL(6,2)   NOT NULL,

    confidence_score         INT            NOT NULL,
    final_score              DECIMAL(6,2)   NULL,
    classification           VARCHAR(40)    NULL,

    factor_scores_json       JSON           NULL,
    explanation_json         JSON           NULL,
    gate_details_json        JSON           NULL,

    stress_survival_score    DECIMAL(5,2)   NULL,
    live_valid               TINYINT(1)     NULL,
    rejection_codes_json     JSON           NULL,

    status                   VARCHAR(20)    NOT NULL DEFAULT 'ACTIVE',
    confirmed_at             DATETIME       NOT NULL,
    valid_until              DATETIME       NOT NULL,
    status_changed_at        DATETIME       NOT NULL,
    invalidation_reason      VARCHAR(60)    NULL,

    /** Maturity layer — set at promotion, frozen with the rest of
     *  the snapshot. The tracker computes these and the maturity
     *  worker hands them in when calling the writer. */
    maturity_score                    DECIMAL(5,2)   NULL,
    validation_cycles_passed          INT            NULL,
    signal_age_minutes_at_promotion   INT            NULL,
    conviction_level                  VARCHAR(20)    NULL,
    stability_passed                  TINYINT(1)     NULL,
    maturity_factors_json             JSON           NULL,

    created_at               DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at               DATETIME       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_csnap_status_validity (status, valid_until),
    INDEX idx_csnap_symbol_dir_status (symbol, direction, status),
    INDEX idx_csnap_source_signal (source_signal_id),
    INDEX idx_csnap_confirmed (confirmed_at DESC),
    INDEX idx_csnap_symbol (symbol)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

export async function migrateSignalEngine(): Promise<void> {
  console.log('[SignalEngine] Running migration...');

  for (const ddl of TABLES) {
    await db.query(ddl);
  }

  // ── Live-snapshot columns (idempotent ALTERs) ───────────────
  // Present in this file's inline CREATE TABLE above (lines 43-44),
  // but the slim q365_signals DDL in ensureAllSchemas.ts omits them.
  // When ensureAllSchemas runs first on a clean DB, the table exists
  // without ltp/pct_change and the inline CREATE here becomes a
  // no-op (`IF NOT EXISTS`). Idempotent ensureColumn closes the gap.
  await ensureColumn('q365_signals', 'ltp',        "DECIMAL(12,2) NULL");
  await ensureColumn('q365_signals', 'pct_change', "DECIMAL(8,2)  NULL");

  // ── yahoo_symbol — Phase-9 spec field ─────────────────────── // @deprecated marker
  // Stores the Yahoo-mapped form (e.g. RELIANCE.NS, M%26M.NS). // @deprecated marker
  // Useful for re-fetching the same instrument from Yahoo without // @deprecated marker
  // re-applying the symbol-rename overrides every time.
  await ensureColumn('q365_signals', 'yahoo_symbol', 'VARCHAR(60) NULL'); // @deprecated marker

  // ── Column-type drift fix ───────────────────────────────────
  // ensureAllSchemas.ts's slim DDL declares engine_phase as INT, but
  // every writer (saveSignals + scanner) emits string labels like
  // 'scanner-v1' or '4' (Phase-4). Without this MODIFY the INSERT
  // fails with "Incorrect integer value". Idempotent — running it
  // when the column is already VARCHAR(10) is a no-op.
  await ensureColumnType('q365_signals', 'engine_phase', 'VARCHAR(10) NULL');

  // ── Provenance columns (idempotent ALTERs) ──────────────────
  // Added during the Phase 1 cutover so every persisted signal
  // records which engine path produced it. Columns are nullable
  // to stay backward-compatible with historical rows.
  await ensureColumn('q365_signals', 'engine_phase',       "VARCHAR(10) NULL");
  await ensureColumn('q365_signals', 'engine_version',     "VARCHAR(30) NULL");
  await ensureColumn('q365_signals', 'generation_source',  "VARCHAR(40) NULL");
  await ensureColumn('q365_signals', 'code_build',         "VARCHAR(60) NULL");

  // ── Enrichment columns (idempotent ALTERs) ──────────────────
  // Added so the feedback loop and backtest analytics can bucket
  // performance by sector and volatility regime without resorting
  // to 'unknown'/null placeholders. Both columns are nullable for
  // backward-compat with historical rows; new rows are populated
  // by saveSignals.ts from getSector() and features.volatility.atrPct.
  await ensureColumn('q365_signals', 'sector',           "VARCHAR(50) NULL");
  await ensureColumn('q365_signals', 'volatility_state', "VARCHAR(20) NULL");

  // ── Dynamic-ranking columns ─────────────────────────────────
  // Written at INSERT by saveSignals (seeded as "fresh") and
  // continuously updated by rescoreActiveSignals (cron, every
  // 5m intraday). The read path orders by final_score DESC and
  // filters on invalidation_reason/decay_state so stale signals
  // are automatically pushed off the dashboard.
  // Product-facing tri-state classification, persisted alongside
  // the existing lifecycle `status` column. Populated by saveSignals
  // from the rejection engine's classifySignalStatus() output. NULL
  // on historical rows — readSignals derives a value on the fly for
  // backward-compat. Values: APPROVED_SIGNAL, DEVELOPING_SETUP, NO_TRADE.
  await ensureColumn('q365_signals', 'signal_status',       "VARCHAR(30) NULL");
  await ensureIndex ('q365_signals', 'idx_q365sig_signal_status', '(signal_status)');

  await ensureColumn('q365_signals', 'final_score',         "DECIMAL(6,2) NOT NULL DEFAULT 0");
  await ensureColumn('q365_signals', 'freshness_score',     "DECIMAL(5,2) NOT NULL DEFAULT 100");
  await ensureColumn('q365_signals', 'decay_state',         "VARCHAR(30)  NOT NULL DEFAULT 'fresh'");
  await ensureColumn('q365_signals', 'age_bars',            "INT          NOT NULL DEFAULT 0");
  await ensureColumn('q365_signals', 'overextension_pct',   "DECIMAL(8,4) NOT NULL DEFAULT 0");
  await ensureColumn('q365_signals', 'invalidation_reason', "VARCHAR(60)  NULL");
  await ensureColumn('q365_signals', 'invalidated_at',      "DATETIME     NULL");
  await ensureColumn('q365_signals', 'last_rescored_at',    "DATETIME     NULL");
  await ensureColumn('q365_signals', 'expires_at',          "DATETIME     NULL");

  await ensureIndex('q365_signals', 'idx_q365sig_final_score',  '(final_score DESC)');
  await ensureIndex('q365_signals', 'idx_q365sig_rescore',      '(last_rescored_at)');
  await ensureIndex('q365_signals', 'idx_q365sig_invalidation', '(invalidation_reason)');

  // Compound index for the route's hot path. Every poll runs:
  //   WHERE batch_id = ? AND status IN (...) AND classification = ...
  //   ORDER BY final_score DESC, opportunity_score DESC, generated_at DESC
  // Without a compound index MySQL falls back to the single-column
  // batch_id index then sorts in memory, which under load produces the
  // "query exceeded 10000ms" + "Queue limit reached" cascade. Leading
  // with batch_id keeps each batch's rows physically contiguous so the
  // sort can stream off the index without a filesort.
  await ensureIndex(
    'q365_signals',
    'idx_q365sig_batch_score_class',
    '(batch_id, final_score DESC, confidence_score DESC, classification)',
  );

  // ── Phase-4 scoring columns (calculateFinalScore + 6-band) ────
  // Additive — does NOT replace `final_score` (which holds the
  // dynamic ranker's freshness-aware score that Phase-1 filters on).
  //   composite_final_score      — Phase-2 calculateFinalScore output
  //                                 (0-100, structural quality, no decay)
  //   classification             — 6-band Phase-2 result:
  //                                 INSTITUTIONAL_HIGH_CONVICTION |
  //                                 HIGH_CONVICTION | VALID_SIGNAL |
  //                                 DEVELOPING_SETUP | WATCHLIST_ONLY |
  //                                 NO_TRADE
  //   phase4_factor_scores_json  — per-factor breakdown for explainability
  // Nullable so historical rows are preserved untouched; saveSignals
  // populates them on every new INSERT post-Phase-4.
  await ensureColumn('q365_signals', 'composite_final_score',     "DECIMAL(6,2) NULL");
  await ensureColumn('q365_signals', 'classification',            "VARCHAR(40) NULL");
  await ensureColumn('q365_signals', 'phase4_factor_scores_json', "JSON NULL");
  await ensureIndex ('q365_signals', 'idx_q365sig_classification', '(classification)');

  // ── Phase-11 unified row block ──────────────────────────────
  // Materialises the 16 fields the API/UI now treats as canonical
  // for every signal row. Each is nullable so historical rows
  // pre-Phase-11 stay readable; the saveSignals path will populate
  // them on every new INSERT once the corresponding upstream phase
  // (7 / 8 / 9 / 10) is wired into the writer.
  //
  //   stress_survival_score      Phase-7 stress test (0-100, < 60 fragile)
  //   recommended_quantity       Phase-9 sizer output, in shares
  //   recommended_capital        Phase-9 sizer output, in capital ccy
  //   live_valid                 Phase-8 live-validation gate (boolean → tinyint)
  //   rejection_codes_json       Phase-5 union of every blocking gate's codes
  //   rejection_reasons_json     Phase-5 parallel reasons[] for the codes
  //   live_validation_reasons_json  Phase-8 validation_reasons[]
  //   explanation_json           Phase-10 7-section explanation block
  //
  // Indexed: stress_survival_score (filterable in main-table query),
  // live_valid (hard reject filter), recommended_quantity (sized vs
  // unsized rows can be split for the UI).
  await ensureColumn('q365_signals', 'stress_survival_score',         "DECIMAL(5,2) NULL");
  await ensureColumn('q365_signals', 'recommended_quantity',          "INT NULL");
  await ensureColumn('q365_signals', 'recommended_capital',           "DECIMAL(14,2) NULL");
  await ensureColumn('q365_signals', 'live_valid',                    "TINYINT(1) NULL");
  await ensureColumn('q365_signals', 'rejection_codes_json',          "JSON NULL");
  await ensureColumn('q365_signals', 'rejection_reasons_json',        "JSON NULL");
  await ensureColumn('q365_signals', 'live_validation_reasons_json',  "JSON NULL");
  await ensureColumn('q365_signals', 'explanation_json',              "JSON NULL");
  await ensureIndex ('q365_signals', 'idx_q365sig_stress_survival',   '(stress_survival_score)');
  await ensureIndex ('q365_signals', 'idx_q365sig_live_valid',        '(live_valid)');

  // ── Confirmed snapshot table — idempotent column adds ────────
  // Forward-migrate older deployments where the table existed
  // before some columns were added. Each ensureColumn is a no-op
  // when the column is already present.
  await ensureColumn('q365_confirmed_signal_snapshots', 'gate_details_json',  'JSON NULL');
  await ensureColumn('q365_confirmed_signal_snapshots', 'rejection_codes_json', 'JSON NULL');
  await ensureColumn('q365_confirmed_signal_snapshots', 'invalidation_reason', 'VARCHAR(60) NULL');
  await ensureColumn('q365_confirmed_signal_snapshots', 'maturity_score',                  'DECIMAL(5,2) NULL');
  await ensureColumn('q365_confirmed_signal_snapshots', 'validation_cycles_passed',        'INT NULL');
  await ensureColumn('q365_confirmed_signal_snapshots', 'signal_age_minutes_at_promotion', 'INT NULL');
  await ensureColumn('q365_confirmed_signal_snapshots', 'conviction_level',                'VARCHAR(20) NULL');
  await ensureColumn('q365_confirmed_signal_snapshots', 'stability_passed',                'TINYINT(1) NULL');
  await ensureColumn('q365_confirmed_signal_snapshots', 'maturity_factors_json',           'JSON NULL');
  await ensureIndex ('q365_confirmed_signal_snapshots', 'idx_csnap_status_validity',  '(status, valid_until)');
  await ensureIndex ('q365_confirmed_signal_snapshots', 'idx_csnap_symbol_dir_status', '(symbol, direction, status)');

  // ── Maturity tracker — idempotent column adds ────────────────
  await ensureColumn('q365_signal_maturity_tracker', 'last_evaluated_at',      'DATETIME NULL');
  await ensureColumn('q365_signal_maturity_tracker', 'maturity_factors_json',  'JSON NULL');
  await ensureColumn('q365_signal_maturity_tracker', 'conviction_level',       "VARCHAR(20) NOT NULL DEFAULT 'MEDIUM'");
  await ensureColumn('q365_signal_maturity_tracker', 'promoted_snapshot_id',   'BIGINT NULL');
  await ensureIndex ('q365_signal_maturity_tracker', 'idx_smt_stage',          '(stage)');
  await ensureIndex ('q365_signal_maturity_tracker', 'idx_smt_last_evaluated', '(last_evaluated_at)');

  console.log('[SignalEngine] Migration complete — 10 tables (incl. q365_signal_maturity_tracker + q365_confirmed_signal_snapshots) + maturity layer');
}

/** Add an index to a table only if it's missing. Safe to call repeatedly. */
async function ensureIndex(table: string, indexName: string, columns: string): Promise<void> {
  const { rows } = await db.query<{ INDEX_NAME: string }>(
    `SELECT INDEX_NAME FROM INFORMATION_SCHEMA.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [table, indexName],
  );
  if (rows.length === 0) {
    await db.query(`CREATE INDEX ${indexName} ON ${table} ${columns}`);
    console.log(`[SignalEngine] Added index ${table}.${indexName}`);
  }
}

/**
 * Change a column's type unconditionally via ALTER TABLE MODIFY. Use this
 * to repair schema drift where two migration paths created the same
 * column with different types. Safe to run when the column is already
 * the target type — MySQL just rewrites no metadata.
 *
 * Existing data is preserved with implicit conversion (INT → VARCHAR
 * stringifies, VARCHAR → VARCHAR with same/larger length is lossless).
 */
async function ensureColumnType(table: string, column: string, definition: string): Promise<void> {
  // Only act if the column exists; if it's missing entirely the caller
  // should use ensureColumn instead.
  const { rows } = await db.query<{ COLUMN_NAME: string; COLUMN_TYPE: string }>(
    `SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if (rows.length === 0) {
    // Column doesn't exist yet — emit a friendly warning and skip; the
    // caller is expected to also have an ensureColumn for the same name.
    console.warn(
      `[SignalEngine] ensureColumnType skipped: ${table}.${column} doesn't exist yet`,
    );
    return;
  }
  try {
    await db.query(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${definition}`);
    console.log(`[SignalEngine] Modified type ${table}.${column} → ${definition}`);
  } catch (err) {
    console.warn(
      `[SignalEngine] ensureColumnType ${table}.${column} failed:`,
      (err as Error).message,
    );
  }
}

/** Add a column to a table only if it's missing. Safe to call repeatedly. */
async function ensureColumn(table: string, column: string, definition: string): Promise<void> {
  const { rows } = await db.query<{ COLUMN_NAME: string }>(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  if (rows.length === 0) {
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    console.log(`[SignalEngine] Added column ${table}.${column}`);
  }
}

// Allow direct execution: npx tsx src/lib/db/migrateSignalEngine.ts
//
// When invoked as a script we must load .env.local ourselves —
// Next.js does this automatically in the app runtime, PM2+scheduler
// does it via dotenv in workers/scheduler.ts, but neither path is
// active here. Mirror the scheduler's approach so the migration
// can be run as a standalone one-liner on a fresh clone.
if (require.main === module) {
  const path = require('path');
  if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config({
      path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local'),
    });
  }

  migrateSignalEngine()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
