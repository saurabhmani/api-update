import type { OutcomeAnalyticsRecord } from './outcomeAnalytics';

export type HistoricalEnvironment =
  | 'trending'
  | 'range_bound'
  | 'high_volatility'
  | 'low_volatility'
  | 'gap_driven'
  | 'news_driven';

export interface HistoricalEnvironmentInput {
  marketRegime: string;
  atrPct?: number | null;
  gapPct?: number | null;
  manualTags?: string[];
}

export interface FeatureOutcomeAssociation {
  feature: string;
  sampleCount: number;
  averageFeatureScore: number;
  winRate: number;
  averageRealizedR: number;
  successfulAverageScore: number | null;
  unsuccessfulAverageScore: number | null;
}

/** Deterministic historical classification; manual news tags take priority. */
export function classifyHistoricalEnvironment(
  input: HistoricalEnvironmentInput,
): HistoricalEnvironment {
  const tags = (input.manualTags ?? []).map((tag) => tag.toLowerCase());
  if (tags.some((tag) => tag === 'news-driven' || tag === 'news_driven')) return 'news_driven';
  if (Math.abs(input.gapPct ?? 0) >= 2 || /gap/i.test(input.marketRegime)) return 'gap_driven';
  if ((input.atrPct ?? 0) >= 5 || /high volatility/i.test(input.marketRegime)) return 'high_volatility';
  if ((input.atrPct ?? Infinity) <= 1.5 || /low volatility/i.test(input.marketRegime)) return 'low_volatility';
  if (/sideways|range|neutral/i.test(input.marketRegime)) return 'range_bound';
  return 'trending';
}

function round(value: number, decimals = 4): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Reports associations only; never creates or applies feature weights. */
export function buildFeatureOutcomeAssociations(
  records: readonly OutcomeAnalyticsRecord[],
): FeatureOutcomeAssociation[] {
  const groups = new Map<string, Array<{ score: number; win: boolean; realizedR: number }>>();
  for (const record of records) {
    const win = record.outcome.target1Hit && record.outcome.exitReason !== 'stop';
    for (const feature of record.topContributingFeatures ?? []) {
      const group = groups.get(feature.feature) ?? [];
      group.push({
        score: feature.score,
        win,
        realizedR: record.outcome.realizedRewardRisk ?? record.outcome.pnlR,
      });
      groups.set(feature.feature, group);
    }
  }

  return [...groups.entries()].map(([feature, rows]) => {
    const wins = rows.filter((row) => row.win);
    const losses = rows.filter((row) => !row.win);
    const mean = (values: number[]) =>
      values.length === 0 ? null : round(values.reduce((sum, value) => sum + value, 0) / values.length);
    return {
      feature,
      sampleCount: rows.length,
      averageFeatureScore: mean(rows.map((row) => row.score)) ?? 0,
      winRate: round(wins.length / rows.length),
      averageRealizedR: mean(rows.map((row) => row.realizedR)) ?? 0,
      successfulAverageScore: mean(wins.map((row) => row.score)),
      unsuccessfulAverageScore: mean(losses.map((row) => row.score)),
    };
  }).sort((a, b) => b.sampleCount - a.sampleCount || b.winRate - a.winRate);
}
