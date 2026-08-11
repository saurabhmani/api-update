import { db } from '@/lib/db';
import { getMarketStatus } from '@/lib/marketData/marketHours';
import { runDailyEodIngestion } from '@/lib/marketData/eod/eodIngestionPipeline';
import { ensureUniverseReady } from '@/lib/startup/ensureUniverseReady';
import { runEveningScanJob, runLateRescoreJob } from '@/lib/workers/dailyScanSchedule';
import { runDailyManipulationScan } from '@/lib/manipulation-engine/pipeline/runDailyScan';
import { runCandleBackfillJob } from '@/lib/marketData/candleBackfillJob';
import { evaluateSignalOutcomes, runLearningJobs } from '@/lib/workers/learningScheduler';
import { buildDailySignalReport, type DailyReportInput } from '@/lib/signals/dailySignalReport';
import { getHistoricalMarketMovers } from '@/lib/signals/historicalMarketData';
import type { MaintenanceStage } from './types';

async function candleCoverage(tradingDate: string) {
  const { rows } = await db.query<any>(
    `SELECT COUNT(*) AS bars, COUNT(DISTINCT instrument_key) AS symbols
       FROM candles WHERE candle_type='eod' AND interval_unit='1day' AND DATE(ts)=?`,
    [tradingDate],
  );
  const { rows: universeRows } = await db.query<any>(
    `SELECT COUNT(*) AS expected FROM q365_universe WHERE is_active=1`,
  ).catch(() => ({ rows: [{ expected: 0 }] }));
  return { bars: Number(rows[0]?.bars ?? 0), symbols: Number(rows[0]?.symbols ?? 0),
    expected: Number(universeRows[0]?.expected ?? 0) };
}

/** Repair only derivable geometry. Rows with no valid entry/risk remain failed. */
export async function repairActiveSignalRiskGeometry(batchSize = 500) {
  const { rows } = await db.query<any>(
    `SELECT id, direction, entry_price, stop_loss, target1, risk_reward
       FROM q365_signals
      WHERE status='active' AND entry_price > 0
        AND (stop_loss <= 0 OR target1 <= 0 OR risk_reward <= 0)
      ORDER BY generated_at ASC LIMIT ?`, [batchSize],
  );
  let repaired = 0;
  let failed = 0;
  for (const row of rows) {
    const entry = Number(row.entry_price);
    const direction = String(row.direction).toUpperCase();
    let stop = Number(row.stop_loss);
    let target = Number(row.target1);
    if (!(stop > 0) && target > 0) {
      const reward = Math.abs(target - entry);
      stop = direction === 'SELL' ? entry + reward / 2 : entry - reward / 2;
    }
    if (!(target > 0) && stop > 0) {
      const risk = Math.abs(entry - stop);
      target = direction === 'SELL' ? entry - risk * 2 : entry + risk * 2;
    }
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(target - entry);
    if (!(stop > 0) || !(target > 0) || !(risk > 0) || !(reward > 0)) {
      failed++;
      continue;
    }
    await db.query(
      `UPDATE q365_signals SET stop_loss=?, target1=?, risk_reward=?
        WHERE id=? AND status='active' AND (stop_loss<=0 OR target1<=0 OR risk_reward<=0)`,
      [stop, target, reward / risk, row.id],
    );
    repaired++;
  }
  const { rows: remainingRows } = await db.query<any>(
    `SELECT COUNT(*) AS c FROM q365_signals WHERE status='active'
      AND (entry_price<=0 OR stop_loss<=0 OR target1<=0 OR risk_reward<=0)`,
  );
  return { scanned: rows.length, repaired, failed, remaining: Number(remainingRows[0]?.c ?? 0) };
}

async function persistDailyReport(tradingDate: string) {
  const [{ rows }, movers, coverage] = await Promise.all([
    db.query<any>(
      `SELECT id, symbol, direction, signal_type, confidence_score, risk_score,
              entry_price, stop_loss, target1, target2, risk_reward, status, generated_at
         FROM q365_signals WHERE DATE(generated_at)=? ORDER BY confidence_score DESC LIMIT 2000`,
      [tradingDate],
    ),
    getHistoricalMarketMovers(tradingDate, { limit: 20 }),
    candleCoverage(tradingDate),
  ]);
  const market = getMarketStatus();
  const approved = rows.filter((row: any) => row.status === 'active');
  const input: DailyReportInput = {
    reportDate: tradingDate,
    marketStatus: { isOpen: market.isOpen, label: market.label, state: market.state },
    signals: { approved, highPotential: [], watchlist: [], developing: [],
      scannerCandidates: [], riskRestricted: [], rejected: [] },
    dueDiligenceSummary: null,
    dataQuality: { provider: 'candles_warehouse', lastSuccessAt: `${tradingDate}T00:00:00.000Z`,
      staleMinutes: null, symbolsRequested: coverage.expected, symbolsReturned: coverage.symbols,
      coveragePercent: coverage.expected > 0 ? coverage.symbols / coverage.expected * 100 : null,
      isBootstrap: false, isFallback: false, freshnessLabel: 'persisted_eod' },
    marketMovers: movers.available ? movers.movers : undefined,
  };
  const report = buildDailySignalReport(input);
  await db.query(
    `INSERT INTO q365_daily_signal_reports
       (report_date, report_status, data_status, market_status, report_json, data_quality_json, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE report_status=VALUES(report_status), data_status=VALUES(data_status),
       market_status=VALUES(market_status), report_json=VALUES(report_json),
       data_quality_json=VALUES(data_quality_json), generated_at=NOW(), updated_at=NOW()`,
    [tradingDate, report.reportStatus, report.dataStatus, report.marketStatus,
     JSON.stringify(report), JSON.stringify(report.dataQuality)],
  );
  return report;
}

export function createProductionMaintenanceStages(): MaintenanceStage[] {
  return [
    { name: 'market_data', dependencies: [], critical: true, maxAttempts: 3, async run({ tradingDate }) {
      const result = await runDailyEodIngestion({ date: tradingDate });
      if (!result.ok) throw new Error(result.warnings.join('; ') || 'EOD ingestion failed');
      const count = result.sources.reduce((sum, source) => sum + source.inserted + source.updated, 0);
      return { status: 'succeeded', counts: { processed: count, succeeded: count }, metadata: { sources: result.sources } };
    } },
    { name: 'market_data_coverage', dependencies: ['market_data'], critical: true, async run({ tradingDate }) {
      const coverage = await candleCoverage(tradingDate);
      if (coverage.expected <= 0 || coverage.symbols < coverage.expected) {
        throw new Error(`Partial EOD coverage ${coverage.symbols}/${coverage.expected}`);
      }
      return { status: 'succeeded', counts: { expected: coverage.expected, processed: coverage.symbols, succeeded: coverage.symbols } };
    } },
    { name: 'universe', dependencies: ['market_data_coverage'], critical: true, async run() {
      const result = await ensureUniverseReady();
      if (!result.ok) throw new Error(result.error ?? 'Universe not ready');
      return { status: 'succeeded', metadata: result as unknown as Record<string, unknown> };
    } },
    { name: 'signals', dependencies: ['universe'], critical: true, maxAttempts: 2, async run() {
      const result = await runEveningScanJob();
      if (!result.ok) throw new Error(result.error ?? 'Signal scan failed');
      return { status: 'succeeded', counts: { expected: result.total_symbols, processed: result.scanned_symbols,
        succeeded: result.signals_persisted ?? result.signals_generated, failed: result.failed_symbols } };
    } },
    { name: 'risk_geometry', dependencies: ['signals'], critical: true, async run() {
      const result = await repairActiveSignalRiskGeometry();
      if (result.remaining > 0) throw new Error(`${result.remaining} active signals still lack valid risk geometry`);
      return { status: 'succeeded', counts: { processed: result.scanned, succeeded: result.repaired, failed: result.failed } };
    } },
    { name: 'manipulation', dependencies: ['risk_geometry'], critical: true, maxAttempts: 3, async run({ tradingDate }) {
      const result = await runDailyManipulationScan({ date: tradingDate, skipIngestion: true });
      if (!result.ok || result.scan.failed > 0 || result.scan.snapshotsPersisted < result.scan.scanned) {
        throw new Error(result.reason || `Manipulation coverage ${result.scan.snapshotsPersisted}/${result.scan.scanned}`);
      }
      return { status: 'succeeded', counts: { expected: result.scan.scanned, processed: result.scan.scanned,
        succeeded: result.scan.snapshotsPersisted, failed: result.scan.failed } };
    } },
    { name: 'scoring_confirmation', dependencies: ['manipulation'], async run() {
      const result = await runLateRescoreJob();
      if (!result.ok) throw new Error(result.error ?? 'Rescore failed');
      return { status: 'succeeded', counts: { processed: result.scanned_symbols, succeeded: result.signals_generated,
        failed: result.failed_symbols } };
    } },
    { name: 'history_backfill', dependencies: ['scoring_confirmation'], maxAttempts: 2, async run() {
      const result = await runCandleBackfillJob({ maxFetch: 50, resume: true, minBars: 220 });
      if (result.status === 'aborted_auth') throw new Error(result.failures[0]?.reason ?? 'History backfill authentication failed');
      const handled = result.fetched + result.skippedSufficient;
      return { status: result.failed > 0 || result.deferred > 0 || result.deferredDueToBudget > 0 ? 'partial' : 'succeeded', counts: { expected: result.totalSymbols,
        processed: handled, succeeded: handled, failed: result.failed } };
    } },
    { name: 'backtesting_evaluation', dependencies: ['history_backfill'], maxAttempts: 2, async run() {
      const result = await evaluateSignalOutcomes();
      return { status: 'succeeded', counts: { processed: result.scanned, succeeded: result.evaluated,
        failed: result.failed } };
    } },
    { name: 'learning_review', dependencies: ['backtesting_evaluation'], maxAttempts: 2, async run() {
      const results = await runLearningJobs();
      const failed = results.filter((result) => result.status === 'failed');
      if (failed.length) throw new Error(failed.map((result) => `${result.name}: ${result.error}`).join('; '));
      return { status: 'succeeded', counts: { expected: results.length, processed: results.length, succeeded: results.length } };
    } },
    { name: 'daily_report', dependencies: ['learning_review'], maxAttempts: 2, async run({ tradingDate }) {
      const report = await persistDailyReport(tradingDate);
      if (report.reportStatus === 'INSUFFICIENT_DATA') throw new Error(report.warnings.join('; ') || 'Daily report insufficient data');
      return { status: report.reportStatus === 'PARTIAL' ? 'partial' : 'succeeded', metadata: { reportStatus: report.reportStatus } };
    } },
    { name: 'health_snapshot', dependencies: ['daily_report'], async run() {
      return { status: 'succeeded', metadata: { source: 'q365_maintenance_job_runs' } };
    } },
  ];
}
