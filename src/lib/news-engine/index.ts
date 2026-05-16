// ════════════════════════════════════════════════════════════════
//  News Intelligence Engine — Public API
//
//  Single import point for all news-engine functionality.
//  Phase 1: Ingestion + Normalization + Entity Linking
//  Phase 2: Scoring (7 dimensions + composites)
//  Phase 3: Impact (symbol/sector/market + signal integration)
//  Phase 4: Feedback + Learning + Calibration
// ════════════════════════════════════════════════════════════════

// ── Phase 1 Types ────────────────────────────────────────────────
export type {
  NewsEvent,
  RawNewsItem,
  EntityLink,
  NewsAdapter,
  NewsSourceId,
  NewsCategory,
  SentimentLabel,
  NewsQueryFilter,
  IngestionResult,
} from './types/newsEngine.types';

// ── Phase 2 Types (Scoring) ──────────────────────────────────────
export type {
  NewsScoreCard,
  TrustScore,
  SentimentDimensionScore,
  ImportanceScore,
  NoveltyScore,
  FreshnessScore,
  DirectnessScore,
  ManipulationSuspicionScore,
  ManipulationFlag,
  ScoringWeights,
  ScoringResult,
} from './types/scoring.types';
export { DEFAULT_SCORING_WEIGHTS, SOURCE_TRUST_CONFIG, CATEGORY_IMPORTANCE } from './types/scoring.types';

// ── Phase 3 Types (Impact) ───────────────────────────────────────
export type {
  SymbolImpact,
  SectorImpact,
  MarketImpact,
  NewsImpactResult,
  EventRiskDetail,
  EventRiskCategory,
  NewsModifierForSignal,
  EnrichedNewsContext,
} from './types/impact.types';

// ── Phase 4 Types (Feedback) ─────────────────────────────────────
export type {
  NewsSignalLinkage,
  NewsLinkedOutcome,
  NewsCategoryCalibration,
  NewsSourceCalibration,
  NewsSentimentCalibration,
  NewsCalibrationState,
  NewsAdaptiveRecommendation,
  NewsCalibrationResult,
} from './types/feedback.types';

// ── Pipeline ─────────────────────────────────────────────────────
export { runNewsPipeline, runFullPipeline } from './pipeline/runNewsPipeline';
export type { FullPipelineResult } from './pipeline/runNewsPipeline';

// ── Ingestion (for targeted use) ─────────────────────────────────
export { ingestFromAllSources } from './ingestion/ingestAll';
export { fetchFinnhubCompanyNews } from './ingestion/finnhubAdapter';

// ── Normalization ────────────────────────────────────────────────
export { normalizeRawItem, normalizeAll } from './normalization/normalizeEvent';

// ── Entity linking ───────────────────────────────────────────────
export { resolveEntities } from './entity-linking/entityResolver';

// ── Scoring ──────────────────────────────────────────────────────
export { computeScoreCard, scoreEventForAllSymbols } from './scoring/computeScoreCard';
export {
  scoreTrust,
  scoreSentiment,
  scoreImportance,
  scoreNovelty,
  scoreFreshness,
  scoreDirectness,
  scoreManipulationSuspicion,
} from './scoring/scorers';
export { scoreEvents, scoreUnscoredEvents } from './scoring/runScoringPipeline';

// ── Impact (Trading Intelligence) ────────────────────────────────
export {
  computeSymbolImpact,
  computeSectorImpact,
  computeMarketImpact,
  computeNewsImpact,
  getSymbolImpact,
} from './impact/computeImpact';
export { classifyEventRisk, aggregateEventRisks } from './impact/eventRiskClassifier';
export {
  getNewsModifierForSignal,
  buildModifierFromImpact,
  enrichSignalWithNews,
  buildSignalNewsContext,
  buildLegacyNewsContext,
} from './impact/signalIntegration';

// ── Feedback + Calibration ───────────────────────────────────────
export { saveSignalNewsLinkage, buildLinkages, loadNewsLinkedOutcomes } from './feedback/linkageTracker';
export { calibrateByCategory, calibrateBySource, calibrateBySentiment } from './feedback/calibrationEngine';
export {
  generateCategoryRecommendations,
  generateSourceRecommendations,
  generateSentimentRecommendations,
} from './feedback/adaptiveEngine';
export { runNewsCalibration } from './feedback/runNewsCalibration';

// ── Repository — write ───────────────────────────────────────────
export { saveNewsEvents } from './repository/saveNewsEvents';
export { saveNewsScores } from './repository/saveNewsScores';
export { ensureNewsSchemas } from './repository/ensureNewsSchemas';

// ── Repository — read ────────────────────────────────────────────
export {
  queryNewsEvents,
  getNewsForSymbol,
  getNewsForSector,
  getEntityLinksForEvent,
  getRecentIngestionLogs,
  countUnprocessedEvents,
} from './repository/readNewsEvents';
export {
  queryNewsScores,
  getTopScoresForSymbol,
  getHighManipulationEvents,
} from './repository/saveNewsScores';
