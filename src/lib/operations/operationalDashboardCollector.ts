// ════════════════════════════════════════════════════════════════
//  Phase 5 — Operational Dashboard Collector
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { collectHealthProbeInput } from './productionHealthCollector';
import { buildOperationalDashboard, bucketConfidenceDistribution, aggregateRejectionDistribution } from './operationalDashboard';
import type { OperationalDashboardData } from './types';

export async function collectOperationalDashboard(): Promise<OperationalDashboardData> {
  const health = await collectHealthProbeInput();
  const generatedAt = health.generatedAt;

  let promotionHistory: OperationalDashboardData['promotionHistory'] = [];
  try {
    const { rows } = await db.query<{ parameter_id: string; approval_status: string; promoted_at: string | null }>(
      `SELECT parameter_id, approval_status, promoted_at
       FROM q365_adaptive_parameters
       ORDER BY created_at DESC LIMIT 20`,
    );
    promotionHistory = rows.map((r) => ({
      parameterId: r.parameter_id,
      status: r.approval_status,
      promotedAt: r.promoted_at ? String(r.promoted_at) : null,
    }));
  } catch { /* table may not exist */ }

  let confidenceDistribution: Record<string, number> = {};
  try {
    const { rows } = await db.query<{ confidence_score: number }>(
      `SELECT confidence_score FROM q365_signals
       WHERE DATE(generated_at) = CURDATE() AND confidence_score IS NOT NULL`,
    );
    confidenceDistribution = bucketConfidenceDistribution(rows.map((r) => Number(r.confidence_score)));
  } catch { /* ignore */ }

  let rejectionDistribution: Record<string, number> = {};
  try {
    const { rows } = await db.query<{ reason_type: string }>(
      `SELECT reason_type FROM q365_signal_reasons
       WHERE DATE(created_at) = CURDATE() AND reason_type IS NOT NULL`,
    );
    rejectionDistribution = aggregateRejectionDistribution(rows.map((r) => String(r.reason_type)));
  } catch { /* ignore */ }

  return buildOperationalDashboard({
    generatedAt,
    health,
    promotionHistory,
    confidenceDistribution,
    rejectionDistribution,
  });
}
