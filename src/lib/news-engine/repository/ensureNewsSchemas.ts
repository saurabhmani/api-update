// ════════════════════════════════════════════════════════════════
//  Idempotent schema ensure for the news-engine layer.
//
//  Called once per process by any code path that needs the
//  news intelligence tables to exist (ingestion pipeline,
//  API routes, scheduler, etc).
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';

let _ensured = false;

export async function ensureNewsSchemas(): Promise<void> {
  if (_ensured) return;

  const ddl = [
    // ── Core news events table ─────────────────────────────────
    // One row per unique news item. Dedup via UNIQUE(dedup_hash).
    // All downstream processing reads from this table — raw text
    // never leaks into scoring or signal layers.
    `CREATE TABLE IF NOT EXISTS q365_news_events (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      source_id VARCHAR(20) NOT NULL,
      external_id VARCHAR(200) NOT NULL,
      dedup_hash VARCHAR(64) NOT NULL,
      title VARCHAR(500) NOT NULL,
      body TEXT,
      url VARCHAR(1000) NOT NULL,
      category VARCHAR(40) NOT NULL DEFAULT 'general',
      sentiment VARCHAR(30) NOT NULL DEFAULT 'neutral',
      sentiment_score DECIMAL(4,3) NOT NULL DEFAULT 0.000,
      published_at DATETIME NOT NULL,
      fetched_at DATETIME NOT NULL,
      symbols_json JSON,
      sectors_json JSON,
      macro_factors_json JSON,
      commodities_json JSON,
      is_processed TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uq_dedup (dedup_hash),
      INDEX idx_ne_source (source_id),
      INDEX idx_ne_published (published_at),
      INDEX idx_ne_category (category),
      INDEX idx_ne_sentiment (sentiment),
      INDEX idx_ne_processed (is_processed),
      INDEX idx_ne_external (source_id, external_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // ── Entity links ───────────────────────────────────────────
    // Many-to-many relationship: each news event can link to
    // multiple entities (symbols, sectors, macro factors, commodities).
    // One row per (event, entity_type, entity_value) triple.
    `CREATE TABLE IF NOT EXISTS q365_news_entity_links (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      news_event_id BIGINT NOT NULL,
      entity_type VARCHAR(20) NOT NULL,
      entity_value VARCHAR(100) NOT NULL,
      confidence SMALLINT NOT NULL DEFAULT 50,
      match_method VARCHAR(20) NOT NULL DEFAULT 'keyword',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_link (news_event_id, entity_type, entity_value),
      INDEX idx_nel_event (news_event_id),
      INDEX idx_nel_entity (entity_type, entity_value),
      INDEX idx_nel_symbol (entity_value)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // ── News score cards ─────────────────────────────────────
    // One row per (news_event, symbol) pair. Stores the full
    // multi-dimensional score card computed by Phase 2 scoring.
    // Composite fields (symbol_impact, event_risk, manipulation_boost)
    // are denormalized for fast queries — dimension JSON is the
    // audit trail.
    `CREATE TABLE IF NOT EXISTS q365_news_scores (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      news_event_id BIGINT NOT NULL,
      symbol VARCHAR(50) NOT NULL,
      trust_score SMALLINT NOT NULL DEFAULT 0,
      trust_tier VARCHAR(20) NOT NULL DEFAULT 'unknown',
      sentiment_score SMALLINT NOT NULL DEFAULT 0,
      sentiment_magnitude SMALLINT NOT NULL DEFAULT 0,
      sentiment_direction VARCHAR(10) NOT NULL DEFAULT 'neutral',
      importance_score SMALLINT NOT NULL DEFAULT 0,
      novelty_score SMALLINT NOT NULL DEFAULT 0,
      novelty_is_breaking TINYINT(1) NOT NULL DEFAULT 0,
      freshness_score SMALLINT NOT NULL DEFAULT 0,
      freshness_band VARCHAR(20) NOT NULL DEFAULT 'stale',
      directness_score SMALLINT NOT NULL DEFAULT 0,
      directness_match VARCHAR(30) NOT NULL DEFAULT 'none',
      manipulation_score SMALLINT NOT NULL DEFAULT 0,
      manipulation_flags_json JSON,
      symbol_impact_score SMALLINT NOT NULL DEFAULT 0,
      event_risk_score SMALLINT NOT NULL DEFAULT 0,
      manipulation_risk_boost SMALLINT NOT NULL DEFAULT 0,
      dimensions_json JSON,
      scored_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_score (news_event_id, symbol),
      INDEX idx_ns_symbol (symbol),
      INDEX idx_ns_impact (symbol_impact_score DESC),
      INDEX idx_ns_risk (event_risk_score DESC),
      INDEX idx_ns_event (news_event_id),
      INDEX idx_ns_scored (scored_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // ── Signal ↔ News linkage ──────────────────────────────────
    // Many-to-many: which news events influenced which signals.
    // Populated during Phase 4 signal generation, after
    // enrichSignalWithNews() resolves the modifier.
    `CREATE TABLE IF NOT EXISTS q365_signal_news_linkage (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      signal_id BIGINT NOT NULL,
      news_event_id BIGINT NOT NULL,
      symbol VARCHAR(50) NOT NULL,
      impact_contribution SMALLINT NOT NULL DEFAULT 0,
      trust_at_linkage SMALLINT NOT NULL DEFAULT 50,
      sentiment_at_linkage SMALLINT NOT NULL DEFAULT 0,
      modifier_applied SMALLINT NOT NULL DEFAULT 0,
      linkage_type VARCHAR(30) NOT NULL DEFAULT 'direct_symbol',
      linkage_confidence SMALLINT NOT NULL DEFAULT 50,
      signal_generated_at DATETIME,
      news_event_published_at DATETIME,
      scoring_version VARCHAR(20) NOT NULL DEFAULT 'v1',
      linked_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_sig_news (signal_id, news_event_id),
      INDEX idx_snl_signal (signal_id),
      INDEX idx_snl_news (news_event_id),
      INDEX idx_snl_symbol (symbol),
      INDEX idx_snl_linked (linked_at),
      INDEX idx_snl_type (linkage_type)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // ── News calibration (by category) ───────────────────────
    // Aggregated outcome statistics per news category.
    // Recomputed daily by the learning scheduler.
    `CREATE TABLE IF NOT EXISTS q365_news_calibration (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      dimension VARCHAR(20) NOT NULL,
      dimension_value VARCHAR(50) NOT NULL,
      sample_size INT NOT NULL DEFAULT 0,
      win_rate DECIMAL(5,4) DEFAULT 0,
      avg_pnl_r DECIMAL(8,4) DEFAULT 0,
      avg_mfe DECIMAL(8,4) DEFAULT 0,
      avg_mae DECIMAL(8,4) DEFAULT 0,
      target1_hit_rate DECIMAL(5,4) DEFAULT 0,
      target2_hit_rate DECIMAL(5,4) DEFAULT 0,
      stop_rate DECIMAL(5,4) DEFAULT 0,
      sentiment_accuracy DECIMAL(5,4) DEFAULT 0,
      calibrated_trust SMALLINT DEFAULT 50,
      calibration_state VARCHAR(30) NOT NULL DEFAULT 'insufficient_data',
      computed_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_nc_dim (dimension, dimension_value),
      INDEX idx_nc_computed (computed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // ── News adaptive recommendations ────────────────────────
    // Bounded suggestions for modifier/trust adjustments.
    // All auditable — no auto rule rewrite.
    `CREATE TABLE IF NOT EXISTS q365_news_adaptive_recommendations (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      dimension VARCHAR(20) NOT NULL,
      dimension_value VARCHAR(50) NOT NULL,
      current_modifier SMALLINT NOT NULL DEFAULT 0,
      recommended_modifier SMALLINT NOT NULL DEFAULT 0,
      trust_adjustment SMALLINT NOT NULL DEFAULT 0,
      reason TEXT,
      sample_size INT NOT NULL DEFAULT 0,
      evidence_strength VARCHAR(20) NOT NULL DEFAULT 'weak',
      computed_at DATETIME NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_nar_dim (dimension, dimension_value),
      INDEX idx_nar_computed (computed_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

    // ── Ingestion audit log ────────────────────────────────────
    // One row per pipeline run. Tracks counts, errors, timing
    // for observability and debugging.
    `CREATE TABLE IF NOT EXISTS q365_news_ingestion_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      run_at DATETIME NOT NULL,
      total_fetched INT NOT NULL DEFAULT 0,
      duplicates_skipped INT NOT NULL DEFAULT 0,
      new_events INT NOT NULL DEFAULT 0,
      errors_json JSON,
      source_breakdown_json JSON,
      duration_ms INT NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ];

  for (const sql of ddl) {
    await db.query(sql);
  }

  _ensured = true;
  console.log('[ensureNewsSchemas] News intelligence tables ensured.');
}
