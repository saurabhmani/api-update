// Quant Platform — persistence (acceptance-spec table names)

import { db } from '@/lib/db';
import type {
  EnterpriseReport, EventRiskSummary, OptimizationResult,
  ResearchReport, SentimentSummary, StrategyRecommendation,
} from '../types';

let migrated = false;

export async function ensureQuantTables(): Promise<void> {
  if (migrated) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS research_reports (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        report_type VARCHAR(32) NOT NULL,
        title VARCHAR(255) NOT NULL,
        content_json JSON NOT NULL,
        symbols_json JSON,
        risk_warnings_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_research_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS strategy_recommendations (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        regime VARCHAR(64) NOT NULL,
        recommendations_json JSON NOT NULL,
        confidence DECIMAL(5,2),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_strat_rec_time (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS portfolio_allocations (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        portfolio_id INT,
        allocations_json JSON NOT NULL,
        metrics_json JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_port_alloc_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS sentiment_scores (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        symbol VARCHAR(32),
        overall_sentiment DECIMAL(6,3),
        bullish_count INT NOT NULL DEFAULT 0,
        bearish_count INT NOT NULL DEFAULT 0,
        neutral_count INT NOT NULL DEFAULT 0,
        manipulation_risk DECIMAL(6,3),
        payload_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sentiment_symbol (symbol, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS event_risk_scores (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        symbol VARCHAR(32) NOT NULL,
        overall_risk DECIMAL(5,2) NOT NULL,
        event_category VARCHAR(64),
        suppress_trade TINYINT(1) NOT NULL DEFAULT 0,
        news_event_risk DECIMAL(5,2),
        manipulation_score DECIMAL(5,2),
        reasons_json JSON,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_event_risk_symbol (symbol, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS q365_enterprise_reports (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        report_type VARCHAR(64) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'completed',
        payload_json JSON NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ent_report_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS api_clients (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        user_id INT NOT NULL,
        plan VARCHAR(32) NOT NULL DEFAULT 'free',
        active TINYINT(1) NOT NULL DEFAULT 1,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_api_clients_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        client_id BIGINT NOT NULL,
        key_hash VARCHAR(128) NOT NULL UNIQUE,
        key_prefix VARCHAR(16) NOT NULL,
        scopes_json JSON,
        last_used_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME,
        INDEX idx_api_keys_client (client_id),
        INDEX idx_api_keys_prefix (key_prefix)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    migrated = true;
  } catch { /* non-fatal */ }
}

export async function saveResearchReport(userId: number, report: ResearchReport): Promise<number> {
  await ensureQuantTables();
  const r = await db.query(
    `INSERT INTO research_reports (user_id, report_type, title, content_json, symbols_json, risk_warnings_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      userId, report.reportType, report.title,
      JSON.stringify(report), JSON.stringify(report.symbols),
      JSON.stringify(report.riskWarnings ?? []),
    ],
  );
  return Number(r.insertId ?? 0);
}

export async function saveRecommendations(
  userId: number | null, regime: string, recs: StrategyRecommendation[], confidence: number,
) {
  await ensureQuantTables();
  await db.query(
    `INSERT INTO strategy_recommendations (user_id, regime, recommendations_json, confidence) VALUES (?, ?, ?, ?)`,
    [userId, regime, JSON.stringify(recs), confidence],
  );
}

export async function saveOptimization(userId: number, portfolioId: number | null, result: OptimizationResult) {
  await ensureQuantTables();
  await db.query(
    `INSERT INTO portfolio_allocations (user_id, portfolio_id, allocations_json, metrics_json)
     VALUES (?, ?, ?, ?)`,
    [userId, portfolioId, JSON.stringify(result.allocations), JSON.stringify(result.metrics)],
  );
}

export async function saveSentimentScore(summary: SentimentSummary): Promise<void> {
  await ensureQuantTables();
  await db.query(
    `INSERT INTO sentiment_scores
       (symbol, overall_sentiment, bullish_count, bearish_count, neutral_count, manipulation_risk, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      summary.symbol ?? null,
      summary.overallSentiment,
      summary.bullishCount,
      summary.bearishCount,
      summary.neutralCount,
      summary.manipulationRisk,
      JSON.stringify(summary),
    ],
  );
}

export async function saveEventRiskScore(summary: EventRiskSummary): Promise<void> {
  await ensureQuantTables();
  await db.query(
    `INSERT INTO event_risk_scores
       (symbol, overall_risk, event_category, suppress_trade, news_event_risk, manipulation_score, reasons_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      summary.symbol,
      summary.overallRisk,
      summary.eventCategory,
      summary.suppressTrade ? 1 : 0,
      summary.newsEventRisk,
      summary.manipulationScore,
      JSON.stringify(summary.reasons),
    ],
  );
}

export async function saveEnterpriseReport(userId: number, report: EnterpriseReport): Promise<number> {
  await ensureQuantTables();
  const r = await db.query(
    `INSERT INTO q365_enterprise_reports (user_id, report_type, status, payload_json) VALUES (?, ?, ?, ?)`,
    [userId, report.reportType, report.status, JSON.stringify(report)],
  );
  return Number(r.insertId ?? 0);
}

export async function listResearchReports(userId: number, limit = 20) {
  await ensureQuantTables();
  try {
    const { rows } = await db.query(
      `SELECT id, report_type, title, content_json, symbols_json, risk_warnings_json, created_at
         FROM research_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
      [userId, limit],
    );
    return rows as any[];
  } catch { return []; }
}
