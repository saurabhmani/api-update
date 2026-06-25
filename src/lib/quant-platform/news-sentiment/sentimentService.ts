// News Sentiment Engine — aggregate sentiment from news-engine

import { db } from '@/lib/db';
import type { SentimentSummary } from '../types';
import { saveSentimentScore } from '../repository/quantRepository';

export async function getNewsSentiment(symbol?: string): Promise<SentimentSummary> {
  try {
    const where = symbol ? 'WHERE e.symbol = ?' : '';
    const params = symbol ? [symbol.toUpperCase()] : [];
    const { rows } = await db.query(
      `SELECT e.headline, e.category, s.sentiment_score, s.manipulation_score
         FROM q365_news_events e
         LEFT JOIN q365_news_scores s ON s.event_id = e.id
        ${where}
        ORDER BY e.published_at DESC LIMIT 50`,
      params,
    );

    const events = rows as any[];
    let bullish = 0;
    let bearish = 0;
    let neutral = 0;
    let sentimentSum = 0;
    let manipSum = 0;

    for (const e of events) {
      const score = Number(e.sentiment_score ?? 0);
      sentimentSum += score;
      manipSum += Number(e.manipulation_score ?? 0);
      if (score > 0.2) bullish++;
      else if (score < -0.2) bearish++;
      else neutral++;
    }

    const summary: SentimentSummary = {
      symbol: symbol?.toUpperCase(),
      overallSentiment: events.length ? Math.round((sentimentSum / events.length) * 100) / 100 : 0,
      bullishCount: bullish,
      bearishCount: bearish,
      neutralCount: neutral,
      topEvents: events.slice(0, 10).map((e) => ({
        headline: e.headline ?? '—',
        sentiment: Number(e.sentiment_score ?? 0),
        category: e.category ?? 'general',
      })),
      manipulationRisk: events.length ? Math.round((manipSum / events.length) * 100) / 100 : 0,
    };
    await saveSentimentScore(summary).catch(() => {});
    return summary;
  } catch {
    return {
      symbol: symbol?.toUpperCase(),
      overallSentiment: 0,
      bullishCount: 0,
      bearishCount: 0,
      neutralCount: 0,
      topEvents: [],
      manipulationRisk: 0,
    };
  }
}
