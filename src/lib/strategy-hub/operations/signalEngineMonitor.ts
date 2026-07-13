// ════════════════════════════════════════════════════════════════
//  Signal Engine monitoring for Strategy Hub ops (Phase 6)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { getInstitutionalHealthSnapshot } from '@/lib/monitor/institutionalHealth';
import { getPipelineHeartbeat } from '@/lib/marketData/providers/batchScheduler';
import { snapshotStrategyScanHistogram } from '@/lib/signal-engine/observability/strategyScanHistogram';
import type { SignalEngineMonitor } from './types';

export async function loadSignalEngineMonitor(): Promise<SignalEngineMonitor> {
  const [institutional, heartbeat, signalCounts, lastScan] = await Promise.all([
    Promise.resolve(getInstitutionalHealthSnapshot()),
    Promise.resolve(getPipelineHeartbeat()),
    loadRecentSignalCounts(),
    loadLastScanTime(),
  ]);

  const histogram = snapshotStrategyScanHistogram();
  const strategiesProcessed = histogram.reduce((s, h) => s + h.evaluated, 0);
  const signalsApproved = histogram.reduce((s, h) => s + h.confirmed, 0);
  const signalsRejected = histogram.reduce((s, h) => s + h.rejected, 0);
  const signalsGenerated = signalCounts.generated;
  const fullScan = institutional.full_scan;
  const inFlight = fullScan.starts > fullScan.completes;
  const errorCount = fullScan.failures + (institutional.elite?.rejected_total ?? 0);

  const scanStatus: SignalEngineMonitor['scanStatus'] =
    inFlight ? 'running'
    : errorCount > 10 ? 'error'
    : fullScan.last_completed_at ? 'idle'
    : 'degraded';

  const mem = process.memoryUsage();
  const heartbeatAt = heartbeat?.at ? new Date(heartbeat.at).toISOString() : null;

  return {
    scanStatus,
    currentStrategy: histogram.find((h) => h.evaluated > 0)?.strategy ?? null,
    queueSize: inFlight ? 1 : 0,
    strategiesProcessed: strategiesProcessed || signalCounts.strategiesWithSignals,
    signalsGenerated,
    signalsApproved: signalsApproved || signalCounts.approved,
    signalsRejected: signalsRejected || signalCounts.rejected,
    processingTimeMs: fullScan.last_elapsed_ms ?? null,
    throughputPerMin: fullScan.last_approved
      ? Math.round((fullScan.last_approved / Math.max(1, (fullScan.last_elapsed_ms ?? 60000) / 60000)) * 10) / 10
      : 0,
    memoryUsageMb: Math.round(mem.rss / 1024 / 1024),
    errorCount,
    lastScanAt: lastScan ?? fullScan.last_completed_at ?? heartbeatAt,
    strategyStats: histogram.map((h) => ({
      strategyId: h.strategy,
      evaluated: h.evaluated,
      matched: h.matched,
      confirmed: h.confirmed,
      rejected: h.rejected,
    })),
  };
}

async function loadRecentSignalCounts(): Promise<{
  generated: number;
  approved: number;
  rejected: number;
  strategiesWithSignals: number;
}> {
  try {
    const { rows } = await db.query<{
      generated: number;
      approved: number;
      rejected: number;
      strategies_with_signals: number;
    }>(
      `SELECT COUNT(*) AS generated,
              SUM(CASE WHEN classification IN ('APPROVED','APPROVED_SIGNAL')
                        OR status = 'APPROVED_SIGNAL' THEN 1 ELSE 0 END) AS approved,
              SUM(CASE WHEN classification = 'REJECTED' OR status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected,
              COUNT(DISTINCT signal_type) AS strategies_with_signals
         FROM q365_signals
        WHERE generated_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)`,
    );
    const row = rows?.[0];
    return {
      generated: Number(row?.generated ?? 0),
      approved: Number(row?.approved ?? 0),
      rejected: Number(row?.rejected ?? 0),
      strategiesWithSignals: Number(row?.strategies_with_signals ?? 0),
    };
  } catch {
    return { generated: 0, approved: 0, rejected: 0, strategiesWithSignals: 0 };
  }
}

async function loadLastScanTime(): Promise<string | null> {
  try {
    const { rows } = await db.query<{ last_scan: string }>(
      `SELECT MAX(generated_at) AS last_scan FROM q365_signals`,
    );
    const v = rows?.[0]?.last_scan;
    return v ? new Date(v).toISOString() : null;
  } catch {
    return null;
  }
}
