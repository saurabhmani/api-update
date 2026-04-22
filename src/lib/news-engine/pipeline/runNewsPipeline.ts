// ════════════════════════════════════════════════════════════════
//  News Intelligence Pipeline
//
//  Unified entry point:
//    ingestFromAllSources → normalize → entity-link → persist → score
//
//  Returns IngestionResult with full audit trail.
// ════════════════════════════════════════════════════════════════

import type { IngestionResult } from '../types/newsEngine.types';
import type { ScoringResult } from '../types/scoring.types';
import type { NewsImpactResult } from '../types/impact.types';
import { ingestFromAllSources } from '../ingestion/ingestAll';
import { normalizeAll } from '../normalization/normalizeEvent';
import { saveNewsEvents, logIngestionRun } from '../repository/saveNewsEvents';
import { scoreEvents } from '../scoring/runScoringPipeline';
import { computeNewsImpact } from '../impact/computeImpact';
import { eventBus } from '@/lib/eventBus';
import { logger } from '@/lib/logger';

const log = logger.child({ component: 'newsPipeline' });

export interface FullPipelineResult {
  ingestion: IngestionResult;
  scoring:   ScoringResult | null;
  impact:    NewsImpactResult | null;
  durationMs: number;
}

/**
 * Run the full news intelligence pipeline:
 *   1. Fetch from all sources in parallel
 *   2. Normalize each item (dedup hash, category, sentiment)
 *   3. Resolve entities (symbol, sector, macro, commodity)
 *   4. Persist to DB (skip duplicates)
 *   5. Score all newly inserted events (7 dimensions + composites)
 *   6. Log the run for auditing
 */
export async function runNewsPipeline(
  query = 'Indian stock market NSE',
  limit = 15,
): Promise<IngestionResult> {
  const full = await runFullPipeline(query, limit);
  return full.ingestion;
}

/**
 * Full pipeline returning ingestion, scoring, AND impact results.
 *
 * Complete chain:
 *   1. Fetch from all sources in parallel
 *   2. Normalize (dedup hash, category, sentiment)
 *   3. Resolve entities (symbol, sector, macro, commodity)
 *   4. Persist to DB (skip duplicates)
 *   5. Score all newly inserted events (7 dimensions + composites)
 *   6. Compute market-wide impact (symbol/sector/market)
 *   7. Log the run for auditing
 *
 * This is the SINGLE entry point for both cron scheduling and
 * on-demand API calls. Every stage produces deterministic outputs
 * and the audit log enables replay/debugging.
 */
export async function runFullPipeline(
  query = 'Indian stock market NSE',
  limit = 15,
): Promise<FullPipelineResult> {
  const startMs = Date.now();

  // Step 1: Multi-source ingestion
  const raw = await ingestFromAllSources(query, limit);

  // Step 2+3: Normalize + entity-link (synchronous per item)
  const events = normalizeAll(raw.items);

  // Step 4: Persist (dedup via UNIQUE hash) — now returns events with IDs
  const newEvents = await saveNewsEvents(events);
  const duplicatesSkipped = events.length - newEvents.length;

  // Step 5: Score newly inserted events (7 dimensions + composites)
  let scoring: ScoringResult | null = null;
  if (newEvents.length > 0) {
    try {
      scoring = await scoreEvents(newEvents);
      log.info('Scoring complete', {
        totalScored: scoring.totalScored,
        symbolScores: scoring.symbolScores,
        durationMs: scoring.durationMs,
      });
    } catch (err) {
      log.warn('Scoring failed', { error: (err as Error).message });
    }
  }

  // Step 6: Compute market-wide impact from recently scored events
  // This pre-computes symbol/sector/market impacts so the signal engine
  // can query them instantly via getSymbolImpact() without re-scanning.
  let impact: NewsImpactResult | null = null;
  try {
    impact = await computeNewsImpact(24);
    log.info('Impact computed', {
      symbolCount: impact.symbolImpacts.size,
      sectorCount: impact.sectorImpacts.size,
      marketTone: impact.marketImpact.marketTone,
    });
  } catch (err) {
    log.warn('Impact computation failed', { error: (err as Error).message });
  }

  const durationMs = Date.now() - startMs;

  const ingestion: IngestionResult = {
    totalFetched:        raw.items.length,
    duplicatesSkipped,
    newEvents:           newEvents.length,
    errors:              raw.errors,
    sourceBreakdown:     raw.sourceBreakdown,
    sourceClassCoverage: raw.sourceClassCoverage,
  };

  // Step 7: Audit log
  await logIngestionRun({
    ...ingestion,
    durationMs,
  }).catch((err) => {
    log.warn('Audit log failed', { error: (err as Error).message });
  });

  log.info('Pipeline run complete', {
    fetched: raw.items.length,
    newEvents: newEvents.length,
    duplicatesSkipped,
    errors: raw.errors.length,
    durationMs,
  });

  // Emit real-time events
  if (newEvents.length > 0) {
    eventBus.emit('news:new', { newEvents: newEvents.length, totalFetched: raw.items.length });
  }
  eventBus.emit('pipeline:status', { stage: 'news', status: 'completed', durationMs, newEvents: newEvents.length });

  return { ingestion, scoring, impact, durationMs };
}
