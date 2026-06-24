// ════════════════════════════════════════════════════════════════
//  Learning persistence probe — DB read for engine health map
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import type { EngineStatus } from '@/lib/signals/engineHealthMap';

export const LEARNING_MATURE_OBSERVATION_THRESHOLD = 30;

export interface LearningPersistenceProbe {
  tableExists:          boolean;
  observationCount:     number;
  distinctStrategies:   number;
  lastReviewedAt:       string | null;
}

export interface LearningPersistenceHealth {
  status:        EngineStatus;
  primaryIssue:  string | null;
  warnings:      string[];
  findings:      string[];
  readiness:     'NOT_CONFIGURED' | 'INSUFFICIENT_DATA' | 'LIMITED' | 'SUFFICIENT';
}

/** Direct warehouse probe — never throws. */
export async function probeLearningPersistence(): Promise<LearningPersistenceProbe> {
  const empty: LearningPersistenceProbe = {
    tableExists: false,
    observationCount: 0,
    distinctStrategies: 0,
    lastReviewedAt: null,
  };
  try {
    const { rows: tables } = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM information_schema.tables
        WHERE table_schema = DATABASE()
          AND table_name = 'q365_signal_learning_observations'`,
    );
    if (Number(tables[0]?.n ?? 0) < 1) return empty;

    const { rows } = await db.query<{
      cnt: number | string;
      strategies: number | string;
      last_reviewed: string | Date | null;
    }>(
      `SELECT COUNT(*) AS cnt,
              COUNT(DISTINCT strategy_id) AS strategies,
              MAX(reviewed_at) AS last_reviewed
         FROM q365_signal_learning_observations
        WHERE signal_id IS NOT NULL`,
    );
    const r = rows[0];
    const rawLast = r?.last_reviewed ?? null;
    const lastReviewedAt = rawLast == null
      ? null
      : typeof rawLast === 'string'
        ? new Date(rawLast).toISOString()
        : new Date(rawLast).toISOString();

    return {
      tableExists:        true,
      observationCount:   Number(r?.cnt ?? 0),
      distinctStrategies: Number(r?.strategies ?? 0),
      lastReviewedAt,
    };
  } catch {
    return empty;
  }
}

/**
 * Honest health from persisted observation statistics.
 *
 * A — table missing        → NOT_CONFIGURED
 * B — table empty          → INSUFFICIENT_DATA
 * C — count 1..29          → INSUFFICIENT_DATA (below maturity threshold)
 * D — count ≥ 30           → HEALTHY (mature dataset)
 */
export function evaluateLearningPersistenceHealth(
  probe: LearningPersistenceProbe | null | undefined,
): LearningPersistenceHealth {
  const warnings: string[] = [];
  const findings: string[] = [];

  if (!probe) {
    return {
      status:       'UNKNOWN',
      primaryIssue: 'Learning persistence probe did not complete.',
      warnings:     ['Learning observation warehouse was not probed — status unknown.'],
      findings:     [],
      readiness:    'NOT_CONFIGURED',
    };
  }

  if (!probe.tableExists) {
    return {
      status:       'NOT_CONFIGURED',
      primaryIssue: 'Learning observations table is not deployed.',
      warnings:     ['Run npm run db:migrate-learning to create q365_signal_learning_observations.'],
      findings:     [],
      readiness:    'NOT_CONFIGURED',
    };
  }

  const n = probe.observationCount;

  if (n === 0) {
    return {
      status:       'INSUFFICIENT_DATA',
      primaryIssue: 'No persisted learning observations yet.',
      warnings:     [
        'Learning Engine persistence is wired but the observation warehouse is empty.',
        'Call GET /api/strategies/learning after matured outcomes exist to populate rows.',
      ],
      findings:     [],
      readiness:    'INSUFFICIENT_DATA',
    };
  }

  if (n < LEARNING_MATURE_OBSERVATION_THRESHOLD) {
    warnings.push(
      `${n} reviewed signal(s) persisted — below the ${LEARNING_MATURE_OBSERVATION_THRESHOLD}-signal statistical readiness threshold.`,
    );
    findings.push(`${probe.distinctStrategies} distinct strategy_id value(s) represented.`);
    if (probe.lastReviewedAt) {
      findings.push(`Latest review at ${probe.lastReviewedAt}.`);
    }
    return {
      status:       'INSUFFICIENT_DATA',
      primaryIssue: 'Learning dataset is below the maturity threshold for HEALTHY status.',
      warnings,
      findings,
      readiness:    'INSUFFICIENT_DATA',
    };
  }

  findings.push(`${n} persisted observations across ${probe.distinctStrategies} strategy bucket(s).`);
  if (probe.lastReviewedAt) {
    findings.push(`Latest review at ${probe.lastReviewedAt}.`);
  }
  return {
    status:       'HEALTHY',
    primaryIssue: null,
    warnings:     [],
    findings,
    readiness:    'SUFFICIENT',
  };
}
