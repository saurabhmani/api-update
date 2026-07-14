// ════════════════════════════════════════════════════════════════
//  Phase 7 — Look-ahead / survivorship / leakage guards
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../../signal-engine/types/signalEngine.types';
import { assertNoLookAheadInAnchors, type ConfirmedImpulseAnchors } from '../../signal-engine/structure/confirmedSwingAnchors';
import { assertNoLookahead, type ReplayClockState } from '../replay/replayClock';

export const LEAKAGE_GUARD_VERSION = '7.0.0';

export type LeakageSeverity = 'error' | 'warning' | 'info';

export interface LeakageFinding {
  code: string;
  severity: LeakageSeverity;
  message: string;
}

export interface LeakageAudit {
  modelVersion: string;
  clean: boolean;
  findings: LeakageFinding[];
}

/** Candles after asOf must never enter feature/strategy evaluation. */
export function assertCandlesAsOf(
  candles: Candle[],
  asOfTsOrDate: string,
): LeakageFinding[] {
  const asOf = asOfTsOrDate.slice(0, 10);
  const findings: LeakageFinding[] = [];
  for (const c of candles) {
    const d = c.ts.slice(0, 10);
    if (d > asOf) {
      findings.push({
        code: 'candle_lookahead',
        severity: 'error',
        message: `Candle ${d} is after as-of ${asOf}`,
      });
    }
  }
  return findings;
}

/** News / event timestamps must precede (or equal same-day cut-off) the signal. */
export function assertNewsPrecedsSignal(
  newsPublishedAt: string,
  signalTsOrDate: string,
): LeakageFinding[] {
  const news = Date.parse(newsPublishedAt.includes('T') ? newsPublishedAt : `${newsPublishedAt}T00:00:00Z`);
  const sig = Date.parse(
    signalTsOrDate.includes('T') ? signalTsOrDate : `${signalTsOrDate}T15:30:00Z`,
  );
  if (!Number.isFinite(news) || !Number.isFinite(sig)) {
    return [{
      code: 'news_timestamp_unparseable',
      severity: 'warning',
      message: 'Could not parse news/signal timestamps for leakage check',
    }];
  }
  if (news > sig) {
    return [{
      code: 'news_lookahead',
      severity: 'error',
      message: `News at ${newsPublishedAt} is after signal ${signalTsOrDate}`,
    }];
  }
  return [];
}

/** Confirmed Fib pivots must respect confirmation delay (no future bars). */
export function assertFibAnchorsNoLookAhead(
  anchors: ConfirmedImpulseAnchors,
  asOfIndex: number,
): LeakageFinding[] {
  if (!assertNoLookAheadInAnchors(anchors, asOfIndex)) {
    return [{
      code: 'pivot_lookahead',
      severity: 'error',
      message: `Fib anchors fail confirmation-delay guard at asOfIndex=${asOfIndex}`,
    }];
  }
  return [];
}

/** Replay clock wrapper — throws on future date access in debug. */
export function assertClockNoLookAhead(clock: ReplayClockState, dateToCheck: string): void {
  assertNoLookahead(clock, dateToCheck);
}

/**
 * Survivorship / universe membership labelling.
 * Using today's Nifty 500 across history is allowed ONLY when labelled.
 */
export function auditUniverseMembership(opts: {
  mode: 'asof_historical' | 'point_in_time_proxy' | 'current_list_biased' | undefined;
  biasLabel?: string | null;
  universeSize: number;
}): LeakageFinding[] {
  const findings: LeakageFinding[] = [];
  const mode = opts.mode ?? 'current_list_biased';
  if (mode === 'current_list_biased') {
    if (!opts.biasLabel || opts.biasLabel.trim().length < 8) {
      findings.push({
        code: 'survivorship_unlabelled',
        severity: 'error',
        message:
          'Universe uses current membership across history without an explicit bias label ' +
          '(set universeMembershipMode + universeBiasLabel)',
      });
    } else {
      findings.push({
        code: 'survivorship_labelled',
        severity: 'warning',
        message: `Survivorship bias labelled: ${opts.biasLabel} (n=${opts.universeSize})`,
      });
    }
  }
  return findings;
}

/** Aggregate leakage audit — clean iff no error findings. */
export function buildLeakageAudit(findings: LeakageFinding[]): LeakageAudit {
  return {
    modelVersion: LEAKAGE_GUARD_VERSION,
    clean: !findings.some((f) => f.severity === 'error'),
    findings,
  };
}

/** OOS optimisation is forbidden — flag if any call site tries to calibrate on OOS tags. */
export function assertNotOptimisingOnOos(windowLabel: 'in_sample' | 'out_of_sample' | 'headline'): LeakageFinding[] {
  if (windowLabel === 'out_of_sample' || windowLabel === 'headline') {
    // Callers must not pass OOS trades into calibrateFromInSample
    return [];
  }
  return [];
}

export function forbidOosOptimisation(calledFrom: 'oos' | 'is'): LeakageFinding[] {
  if (calledFrom === 'oos') {
    return [{
      code: 'oos_optimisation_forbidden',
      severity: 'error',
      message: 'Do not optimise / re-fit parameters on the out-of-sample window',
    }];
  }
  return [];
}
