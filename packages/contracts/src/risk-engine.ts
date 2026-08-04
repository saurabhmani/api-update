export type RiskDecision = 'approve' | 'reject' | 'warn' | 'unknown';

export interface RiskDecisionResult {
  decision: RiskDecision;
  riskScore?: number;
  rejectionCodes: string[];
  warningCodes: string[];
  reasons: string[];
  thresholdsApplied: Record<string, number | string | boolean>;
  calculationVersion: string;
  inputVersion: string;
  correlationId?: string;
  diagnostics?: Record<string, unknown>;
}

export interface RiskVersionMetadata {
  contractVersion: '1.0.0';
  implementation: 'quantorus365-monolith';
  failurePolicy: 'preserve-legacy-fail-closed-gates';
}
