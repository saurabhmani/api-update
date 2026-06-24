// ════════════════════════════════════════════════════════════════
//  Learning observations — persistence writer (Phase 6 fallback)
//
//  Upserts rows into `q365_signal_learning_observations`. One row per
//  signal_id — idempotent and duplicate-safe.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { migrateLearningPersistence } from '@/lib/db/migrateLearningPersistence';
import type { LearningRecommendation, LearningTag } from '@/lib/learning/signalReviewEngine';

export interface LearningObservationWrite {
  signalId:       number;
  strategyId:     string;
  learningTags:   LearningTag[];
  recommendation: LearningRecommendation;
  reviewedAt:     string;
}

export interface PersistLearningObservationsResult {
  upserted: number;
  skipped:  number;
}

let _schemaReady = false;

async function ensureSchema(): Promise<void> {
  if (_schemaReady) return;
  await migrateLearningPersistence();
  _schemaReady = true;
}

/**
 * Idempotent upsert — at most one observation row per signal_id.
 * Re-reviewing the same signal updates tags / recommendation / reviewed_at.
 */
export async function persistLearningObservations(
  observations: LearningObservationWrite[],
): Promise<PersistLearningObservationsResult> {
  if (observations.length === 0) return { upserted: 0, skipped: 0 };

  await ensureSchema();

  let upserted = 0;
  let skipped  = 0;

  for (const obs of observations) {
    if (!Number.isFinite(obs.signalId) || obs.signalId <= 0) {
      skipped++;
      continue;
    }

    const tagsJson = JSON.stringify(obs.learningTags);
    const reviewedAt = obs.reviewedAt.slice(0, 19).replace('T', ' ');

    const { rows: existing } = await db.query<{ id: number }>(
      `SELECT id FROM q365_signal_learning_observations WHERE signal_id = ? LIMIT 1`,
      [obs.signalId],
    );

    if (existing.length > 0) {
      await db.query(
        `UPDATE q365_signal_learning_observations
            SET strategy_id    = ?,
                learning_tags  = ?,
                recommendation = ?,
                reviewed_at    = ?
          WHERE signal_id = ?`,
        [obs.strategyId, tagsJson, obs.recommendation, reviewedAt, obs.signalId],
      );
    } else {
      await db.query(
        `INSERT INTO q365_signal_learning_observations
           (signal_id, strategy_id, learning_tags, recommendation, reviewed_at)
         VALUES (?, ?, ?, ?, ?)`,
        [obs.signalId, obs.strategyId, tagsJson, obs.recommendation, reviewedAt, obs.signalId],
      );
    }
    upserted++;
  }

  return { upserted, skipped };
}
