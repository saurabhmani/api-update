// Enterprise Reports — multi-section institutional reports

import { DISCLAIMERS } from '@/lib/constants/disclaimer';
import { explainMarketConditions } from '../ai-research/researchAssistant';
import { getStrategyRecommendations } from '../strategy-recommendations/recommendationEngine';
import { computeSectorRotation } from '../sector-rotation/sectorRotationEngine';
import { getNewsSentiment } from '../news-sentiment/sentimentService';
import type { EnterpriseReport } from '../types';
import { saveEnterpriseReport } from '../repository/quantRepository';

export async function generateEnterpriseReport(
  userId: number,
  reportType: 'daily' | 'weekly' | 'risk' | 'strategy' | 'full',
): Promise<EnterpriseReport> {
  const [market, strategies, sectors, sentiment] = await Promise.all([
    explainMarketConditions(),
    getStrategyRecommendations(userId),
    computeSectorRotation(),
    getNewsSentiment(),
  ]);

  const sections = [
    ...market,
    {
      title: 'Strategy Recommendations',
      content: strategies.recommendations
        .filter((r) => r.action === 'PROMOTE' || r.action === 'ACTIVE')
        .slice(0, 5)
        .map((r) => `${r.strategyName}: ${r.action} (${r.confidence}% confidence) — ${r.reason}`)
        .join('\n') || 'No active recommendations.',
      confidence: strategies.overallConfidence / 100,
    },
    {
      title: 'Sector Rotation',
      content: `${sectors.narrative} Phase: ${sectors.phase}. Leaders: ${sectors.leaders.map((l) => l.sector).join(', ')}.`,
      confidence: sectors.conviction / 100,
    },
    {
      title: 'News Sentiment',
      content: `Overall sentiment: ${sentiment.overallSentiment}. Bullish: ${sentiment.bullishCount}, Bearish: ${sentiment.bearishCount}. Manipulation risk: ${sentiment.manipulationRisk}.`,
      confidence: 0.7,
    },
  ];

  const report: EnterpriseReport = {
    reportType,
    title: `Enterprise ${reportType.charAt(0).toUpperCase() + reportType.slice(1)} Report`,
    status: 'completed',
    sections,
    generatedAt: new Date().toISOString(),
  };

  const id = await saveEnterpriseReport(userId, report);
  return { ...report, id };
}

export function formatReportAsMarkdown(report: EnterpriseReport): string {
  const lines = [
    `# ${report.title}`,
    `_Generated: ${report.generatedAt}_`,
    '',
    ...report.sections.flatMap((s) => [`## ${s.title}`, '', s.content, '']),
    '---',
    DISCLAIMERS.STANDARD,
  ];
  return lines.join('\n');
}
