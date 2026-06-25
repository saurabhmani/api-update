// Event Risk Detection — unified news + manipulation risk

import { classifyEventRisk } from '@/lib/news-engine/impact/eventRiskClassifier';
import { db } from '@/lib/db';
import type { EventRiskSummary } from '../types';
import { saveEventRiskScore } from '../repository/quantRepository';

export async function detectEventRisk(symbol: string): Promise<EventRiskSummary> {
  const sym = symbol.toUpperCase();
  let newsEventRisk = 0;
  let eventCategory = 'none';
  let suppressTrade = false;
  const reasons: string[] = [];

  try {
    const { rows } = await db.query(
      `SELECT e.category, e.headline, s.event_risk_score, s.manipulation_score
         FROM q365_news_events e
         LEFT JOIN q365_news_scores s ON s.event_id = e.id
        WHERE e.symbol = ?
        ORDER BY e.published_at DESC LIMIT 5`,
      [sym],
    );
    for (const row of rows as any[]) {
      const classified = classifyEventRisk(
        row.category ?? 'general',
        row.headline ?? '',
        null,
        0,
        Number(row.manipulation_score ?? 0),
        Number(row.event_risk_score ?? 50),
      );
      if (classified.riskScore > newsEventRisk) {
        newsEventRisk = classified.riskScore;
        eventCategory = classified.category;
        suppressTrade = classified.suppressTrade;
        reasons.push(classified.reason);
      }
    }
  } catch { /* optional */ }

  let manipulationScore = 0;
  try {
    const { rows } = await db.query(
      `SELECT composite_score FROM q365_manipulation_snapshots
        WHERE symbol = ? ORDER BY scanned_at DESC LIMIT 1`,
      [sym],
    );
    manipulationScore = Number((rows[0] as any)?.composite_score ?? 0);
    if (manipulationScore > 60) {
      reasons.push(`Manipulation surveillance score elevated: ${manipulationScore}`);
      if (manipulationScore > 80) suppressTrade = true;
    }
  } catch { /* optional */ }

  const overallRisk = Math.min(100, Math.round(newsEventRisk * 0.6 + manipulationScore * 0.4));

  const summary: EventRiskSummary = {
    symbol: sym,
    overallRisk,
    eventCategory,
    suppressTrade,
    reasons: reasons.length ? reasons : ['No elevated event risk detected'],
    manipulationScore,
    newsEventRisk,
  };
  await saveEventRiskScore(summary).catch(() => {});
  return summary;
}
