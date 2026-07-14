// Approval gateway — no signal path without passing validation policy.

import type {
  ApprovalDecision,
  ApprovalStatus,
  DualSourceConfig,
  FeedSourceId,
  FeedValidationResult,
} from './types';
import { computeConfidenceScore } from './confidenceEngine';

export function evaluateApprovalGateway(
  validation: FeedValidationResult,
  config: Pick<
    DualSourceConfig,
    'allowSingleSourceSignals' | 'authoritativeOnConflict' | 'minConfidenceForSignal'
  >,
  now = Date.now(),
): ApprovalDecision {
  const { score, band } = computeConfidenceScore({ validation }, now);
  const reasons: string[] = [...validation.reasons];

  let authoritativeSource: FeedSourceId | null = null;
  let authoritativeLtp: number | null = null;

  if (validation.yahoo && validation.kite) {
    if (validation.status === 'confirmed') {
      authoritativeLtp = (validation.yahoo.ltp + validation.kite.ltp) / 2;
      authoritativeSource = config.authoritativeOnConflict ?? 'kite';
    } else if (config.authoritativeOnConflict) {
      const pick = config.authoritativeOnConflict === 'yahoo'
        ? validation.yahoo
        : validation.kite;
      authoritativeSource = pick.source;
      authoritativeLtp = pick.ltp;
      reasons.push(`authoritative_override_${pick.source}`);
    }
  } else if (validation.yahoo) {
    authoritativeSource = 'yahoo';
    authoritativeLtp = validation.yahoo.ltp;
  } else if (validation.kite) {
    authoritativeSource = 'kite';
    authoritativeLtp = validation.kite.ltp;
  }

  let status: ApprovalStatus;
  let allowed = false;

  switch (validation.status) {
    case 'confirmed':
      allowed = score >= config.minConfidenceForSignal;
      status = allowed ? 'approved' : 'held';
      if (!allowed) reasons.push(`confidence_below_${config.minConfidenceForSignal}`);
      break;
    case 'single_source':
      allowed = config.allowSingleSourceSignals && score >= config.minConfidenceForSignal;
      status = allowed ? 'approved' : 'awaiting_confirmation';
      reasons.push('single_source_policy');
      break;
    case 'pending_validation':
      status = 'awaiting_confirmation';
      reasons.push('pending_cross_validation');
      break;
    case 'data_mismatch':
      status = 'held';
      reasons.push('data_mismatch_hold');
      break;
    default:
      status = 'rejected';
      reasons.push('no_reliable_data');
  }

  return {
    symbol: validation.symbol,
    allowed,
    status,
    validationStatus: validation.status,
    confidenceScore: score,
    confidenceBand: band,
    authoritativeSource,
    authoritativeLtp,
    reasons,
    decidedAt: now,
  };
}
