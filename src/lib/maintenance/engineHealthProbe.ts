import { db } from '@/lib/db';
import { getLatestCompletedTradingDay } from '@/lib/marketData/marketHours';
import { readMaintenanceHealth } from './jobRunRepository';

export interface DirectEngineHealthPayload {
  generatedAt: string;
  lastPipelineRunAt: string | null;
  lastConfirmedSignalAt: string | null;
  approvedSignals: unknown[];
  counters: Record<string, number>;
  freshness: Record<string, unknown>;
  dailyReportPreview: Record<string, unknown> | null;
  manipulationRiskMeta: Record<string, unknown>;
  maintenanceRuns: unknown[];
}

/** Lightweight indexed probes only. This must never invoke an engine. */
export async function probeSignalEngineHealthDirect(): Promise<DirectEngineHealthPayload> {
  const [signalResult, geometryResult, manipulationResult, reportResult, maintenanceRuns] = await Promise.all([
    db.query<any>(
      `SELECT id, symbol, direction, confidence_score, risk_score, entry_price, stop_loss,
              target1, risk_reward, status, generated_at,
              COALESCE(composite_final_score, final_score) AS final_score,
              COALESCE(phase4_factor_scores_json, factor_scores_json) AS factor_scores
         FROM q365_signals WHERE status='active' ORDER BY generated_at DESC LIMIT 20`,
    ),
    db.query<any>(
      `SELECT COUNT(*) AS active_count,
              SUM(CASE WHEN entry_price<=0 OR stop_loss<=0 OR target1<=0 OR risk_reward<=0 THEN 1 ELSE 0 END) AS missing_geometry,
              MAX(generated_at) AS latest
         FROM q365_signals WHERE status='active'`,
    ),
    db.query<any>(
      `SELECT MAX(snapshot_date) AS latest_date, MAX(created_at) AS latest_at,
              COUNT(DISTINCT symbol) AS covered,
              (SELECT COUNT(*) FROM q365_manipulation_snapshots
                WHERE snapshot_date >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) AS global_count
         FROM q365_manipulation_snapshots
        WHERE snapshot_date=(SELECT MAX(snapshot_date) FROM q365_manipulation_snapshots)`,
    ).catch(() => ({ rows: [{ probe_error: true }] })),
    db.query<any>(
      `SELECT report_date, report_status, data_status, generated_at
         FROM q365_daily_signal_reports ORDER BY report_date DESC LIMIT 1`,
    ).catch(() => ({ rows: [] })),
    readMaintenanceHealth(24).catch(() => []),
  ]);
  const geometry = geometryResult.rows[0] ?? {};
  const manipulation = manipulationResult.rows[0] ?? {};
  const report = reportResult.rows[0];
  const latest = geometry.latest ? new Date(geometry.latest).toISOString() : null;
  const latestManipulationDate = manipulation.latest_date
    ? String(manipulation.latest_date).slice(0, 10)
    : null;
  const latestManipulationAt = manipulation.latest_at
    ? new Date(manipulation.latest_at).toISOString()
    : null;
  const manipulationConfigured = manipulation.probe_error !== true;
  const manipulationCovered = Number(manipulation.covered ?? 0);
  const latestCompletedTradingDay = getLatestCompletedTradingDay();
  const approvedSignals = signalResult.rows.map((row: any) => {
    let factorScores = row.factor_scores ?? null;
    if (typeof factorScores === 'string') {
      try { factorScores = JSON.parse(factorScores); } catch { factorScores = null; }
    }
    return ({
    ...row, factor_scores: factorScores,
    final_score: row.final_score == null ? null : Number(row.final_score),
    confidence: Number(row.confidence_score ?? 0),
    riskScore: Number(row.risk_score ?? 0),
    entry: Number(row.entry_price ?? 0),
    stopLoss: Number(row.stop_loss ?? 0),
    target: Number(row.target1 ?? 0),
    riskReward: Number(row.risk_reward ?? 0),
    generatedAt: row.generated_at ? new Date(row.generated_at).toISOString() : null,
  }); });
  const buyCount = signalResult.rows.filter((row: any) => String(row.direction).toUpperCase() === 'BUY').length;
  const sellCount = signalResult.rows.filter((row: any) => String(row.direction).toUpperCase() === 'SELL').length;
  return {
    generatedAt: new Date().toISOString(),
    lastPipelineRunAt: latest,
    lastConfirmedSignalAt: latest,
    approvedSignals,
    counters: { approvedTotal: Number(geometry.active_count ?? 0), approvedBuy: buyCount, approvedSell: sellCount,
      highPotentialTotal: 0, watchlistTotal: 0, rejectedTotal: 0, candidateTotal: 0 },
    freshness: { last_pipeline_run: latest, signal_latest_generated: latest,
      total_persisted: Number(geometry.active_count ?? 0), missing_risk_geometry: Number(geometry.missing_geometry ?? 0) },
    dailyReportPreview: report ? { reportDate: String(report.report_date).slice(0, 10),
      reportStatus: report.report_status, dataStatus: report.data_status, generatedAt: report.generated_at } : null,
    manipulationRiskMeta: {
      configured: manipulationConfigured,
      symbolCount: Number(geometry.active_count ?? 0),
      snapshotCount: manipulationCovered,
      freshestSnapshotAt: latestManipulationAt,
      stale: latestManipulationDate == null || latestManipulationDate < latestCompletedTradingDay,
      globalSnapshotCount: Number(manipulation.global_count ?? 0),
      globalLatestScanAt: latestManipulationAt,
    },
    maintenanceRuns,
  };
}
