// ════════════════════════════════════════════════════════════════
//  News → Signal Linkage Tracker
//
//  Records which news events influenced each signal's confidence
//  modifier. This enables outcome-level calibration: did signals
//  that were boosted by earnings news outperform?
//
//  Populated during Phase 4 signal generation.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { ensureNewsSchemas } from '../repository/ensureNewsSchemas';
import type { NewsSignalLinkage, NewsLinkedOutcome } from '../types/feedback.types';

/**
 * Link a signal to the news events that influenced it.
 * Called during Phase 4 after enrichSignalWithNews().
 *
 * Validates each linkage before saving:
 *  - signal_id must be truthy
 *  - news_event_id must be truthy
 *  - Invalid/incomplete rows are skipped with a warning
 */
export async function saveSignalNewsLinkage(
  linkages: NewsSignalLinkage[],
): Promise<number> {
  await ensureNewsSchemas();

  let saved = 0;
  let skipped = 0;
  for (const l of linkages) {
    // Validate: both IDs must exist
    if (!l.signalId || !l.newsEventId) {
      skipped++;
      console.warn(`[linkageTracker] skipped invalid linkage: signalId=${l.signalId}, newsEventId=${l.newsEventId}`);
      continue;
    }
    try {
      await db.query(
        `INSERT INTO q365_signal_news_linkage
           (signal_id, news_event_id, symbol,
            impact_contribution, trust_at_linkage,
            sentiment_at_linkage, modifier_applied,
            linkage_type, linkage_confidence,
            signal_generated_at, news_event_published_at,
            scoring_version, linked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           impact_contribution = VALUES(impact_contribution),
           modifier_applied = VALUES(modifier_applied),
           linkage_type = VALUES(linkage_type),
           linkage_confidence = VALUES(linkage_confidence)`,
        [
          l.signalId,
          l.newsEventId,
          l.symbol,
          l.impactContribution,
          l.trustAtLinkage,
          l.sentimentAtLinkage,
          l.modifierApplied,
          l.linkageType ?? 'direct_symbol',
          l.linkageConfidence ?? 50,
          l.signalGeneratedAt ?? null,
          l.newsEventPublishedAt ?? null,
          l.scoringVersion ?? 'v1',
          l.linkedAt,
        ],
      );
      saved++;
    } catch (err) {
      console.warn(`[linkageTracker] save failed sig=${l.signalId} news=${l.newsEventId}:`, (err as Error).message);
    }
  }
  if (skipped > 0) {
    console.warn(`[linkageTracker] skipped ${skipped} invalid linkages`);
  }
  return saved;
}

/**
 * Build linkage records from scored news events for a signal.
 * Called with the news score cards that were used to compute the symbol impact.
 *
 * @param signalId        - The DB ID of the signal
 * @param symbol          - Symbol this linkage is for
 * @param modifierApplied - The confidence modifier that was applied
 * @param newsEventIds    - News event IDs + scores from the impact computation
 * @param signalGeneratedAt - When the signal was generated (for audit)
 */
export function buildLinkages(
  signalId: number,
  symbol: string,
  modifierApplied: number,
  newsEventIds: Array<{ eventId: number; impactScore: number; trustScore: number; sentimentScore: number }>,
  signalGeneratedAt?: string,
): NewsSignalLinkage[] {
  const now = new Date().toISOString();
  return newsEventIds.map((ne) => ({
    signalId,
    newsEventId:          ne.eventId,
    symbol,
    impactContribution:   ne.impactScore,
    trustAtLinkage:       ne.trustScore,
    sentimentAtLinkage:   ne.sentimentScore,
    modifierApplied,
    linkageType:          'direct_symbol' as const,
    linkageConfidence:    Math.min(100, Math.round(ne.trustScore * 0.8 + ne.impactScore * 0.2)),
    signalGeneratedAt:    signalGeneratedAt ?? now,
    scoringVersion:       'v1',
    linkedAt:             now,
  }));
}

/**
 * Load outcomes joined with their news linkage context.
 * This is the core query for calibration: for each outcome,
 * what news category/source/sentiment was in play?
 *
 * @param lookbackDays - how far back to load outcomes
 */
export async function loadNewsLinkedOutcomes(
  lookbackDays = 90,
): Promise<NewsLinkedOutcome[]> {
  await ensureNewsSchemas();

  const { rows } = await db.query<any>(
    `SELECT
       snl.signal_id,
       snl.symbol,
       snl.news_event_id,
       ne.category AS news_category,
       ne.source_id AS news_source_id,
       ne.sentiment AS news_sentiment,
       ns.sentiment_score,
       ns.trust_score,
       ns.importance_score,
       snl.modifier_applied,
       o.outcome_label,
       o.target1_hit,
       o.target2_hit,
       o.stop_hit,
       o.max_fav_excursion_pct AS mfe_pct,
       o.max_adv_excursion_pct AS mae_pct,
       o.return_bar5_pct,
       o.return_bar10_pct
     FROM q365_signal_news_linkage snl
     JOIN q365_news_events ne ON ne.id = snl.news_event_id
     LEFT JOIN q365_news_scores ns ON ns.news_event_id = ne.id AND ns.symbol = snl.symbol
     JOIN q365_signal_outcomes o ON o.signal_id = snl.signal_id
     WHERE snl.linked_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
     ORDER BY snl.linked_at DESC`,
    [lookbackDays],
  );

  return rows.map((r: any) => ({
    signalId:        Number(r.signal_id),
    symbol:          r.symbol,
    newsEventId:     Number(r.news_event_id),
    newsCategory:    r.news_category ?? 'general',
    newsSourceId:    r.news_source_id ?? 'gnews',
    newsSentiment:   r.news_sentiment ?? 'neutral',
    sentimentScore:  Number(r.sentiment_score ?? 0),
    trustScore:      Number(r.trust_score ?? 50),
    importanceScore: Number(r.importance_score ?? 0),
    modifierApplied: Number(r.modifier_applied ?? 0),
    outcomeLabel:    r.outcome_label,
    target1Hit:      !!Number(r.target1_hit),
    target2Hit:      !!Number(r.target2_hit),
    stopHit:         !!Number(r.stop_hit),
    mfePct:          Number(r.mfe_pct ?? 0),
    maePct:          Number(r.mae_pct ?? 0),
    returnBar5Pct:   r.return_bar5_pct != null ? Number(r.return_bar5_pct) : null,
    returnBar10Pct:  r.return_bar10_pct != null ? Number(r.return_bar10_pct) : null,
  }));
}
