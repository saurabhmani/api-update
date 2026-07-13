// Confirmation engine — final gate before indicator/signal calculation.

import { isMarketOpen } from '@/lib/marketData/marketHours';
import { liveFeedBlocksApprovals } from '@/lib/marketData/liveFeedState';
import type {
  ApprovalDecision,
  ConfirmationResult,
  ConfirmationStatus,
  FeedValidationResult,
} from './types';

export interface ConfirmationContext {
  indicatorsAgree?:    boolean | null;
  institutionalPass?:  boolean | null;
  riskPass?:           boolean | null;
}

export function runConfirmationEngine(
  validation: FeedValidationResult,
  approval: ApprovalDecision,
  ctx: ConfirmationContext = {},
  now = Date.now(),
): ConfirmationResult {
  const dataFreshnessLive = isMarketOpen()
    && !liveFeedBlocksApprovals()
    && !validation.metrics.delayedUpdate;

  let status: ConfirmationStatus;

  if (validation.status === 'no_reliable_data') {
    status = 'unavailable';
  } else if (validation.status === 'data_mismatch') {
    status = 'mismatch';
  } else if (validation.status === 'single_source') {
    status = 'single_source';
  } else if (validation.status === 'pending_validation') {
    status = 'pending';
  } else if (approval.allowed && dataFreshnessLive) {
    const gatesOk =
      (ctx.indicatorsAgree !== false)
      && (ctx.institutionalPass !== false)
      && (ctx.riskPass !== false);
    status = gatesOk ? 'confirmed' : 'pending';
  } else {
    status = validation.metrics.delayedUpdate ? 'stale' : 'pending';
  }

  return {
    symbol: validation.symbol,
    status,
    validation,
    approval,
    indicatorsAgree: ctx.indicatorsAgree ?? null,
    institutionalPass: ctx.institutionalPass ?? null,
    riskPass: ctx.riskPass ?? null,
    dataFreshnessLive,
    confirmedAt: now,
  };
}

/** True when live signal recalc / promotion may proceed. */
export function confirmationAllowsSignalGeneration(c: ConfirmationResult): boolean {
  return c.status === 'confirmed'
    && c.approval.allowed
    && c.dataFreshnessLive
    && c.approval.confidenceScore >= (
      Number(process.env.DUAL_SOURCE_MIN_CONFIDENCE) || 80
    );
}
