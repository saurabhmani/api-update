import type {
  ConflictResolution,
  EnhancedMarketRegime,
  RelativeStrengthFeatures,
  SignalFeatures,
  StrategyCandidate,
  StrategyMatchResult,
  StrategyMode,
  StrategyName,
  StrategyRegistryEntry,
  TradePlan,
} from '@/lib/signal-engine/types/signalEngine.types';

/** Stable, transport-neutral Strategy Engine contract. */
export interface StrategyEngineInput {
  features: SignalFeatures;
  relativeStrength: RelativeStrengthFeatures;
  configuration?: StrategyEngineConfiguration;
}

export interface StrategyEngineConfiguration {
  enabledStrategies?: StrategyName[];
  marketRegime?: EnhancedMarketRegime | null;
  modeOverrides?: Partial<Record<StrategyName, StrategyMode>>;
}

export interface StrategyEngineEvaluationResult {
  candidates: StrategyCandidate[];
  rejections: StrategyEngineRejection[];
}

export interface StrategyEngineRejection {
  strategy: StrategyName;
  reason: string;
}

export interface StrategyEngineVersionMetadata {
  contractVersion: '1.0.0';
  implementation: 'quantorus365-monolith';
}

export type StrategyEngineErrorCode =
  | 'INVALID_INPUT'
  | 'UNSUPPORTED_CONFIGURATION'
  | 'EVALUATION_FAILED';

export interface StrategyEngineError {
  code: StrategyEngineErrorCode;
  message: string;
  retryable: boolean;
}

export type {
  ConflictResolution,
  RelativeStrengthFeatures,
  SignalFeatures,
  StrategyCandidate,
  StrategyMatchResult,
  StrategyName,
  StrategyRegistryEntry,
  TradePlan,
};
