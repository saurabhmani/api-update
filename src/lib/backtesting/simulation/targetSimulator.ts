// ════════════════════════════════════════════════════════════════
//  Target Simulator
//
//  Checks whether targets (T1, T2, T3) were hit on a given bar.
//  Uses the same intra-bar price path as the stop simulator.
// ════════════════════════════════════════════════════════════════

import type { Candle } from '../../signal-engine/types/signalEngine.types';
import type { OpenPosition } from '../types';
import type { IntraBarAssumption } from '../utils/barExecution';
import { getIntraBarPricePath } from '../utils/barExecution';

export interface TargetCheckResult {
  target1Hit: boolean;
  target2Hit: boolean;
  target3Hit: boolean;
  /** Highest target hit on this bar (null if none) */
  highestTargetHit: 'target1' | 'target2' | 'target3' | null;
  /** Exit price if a new target was hit */
  exitPrice: number;
  /** Step in the intra-bar path where the highest target was hit */
  hitAtStep: number;
}

/**
 * Check which targets were hit on this bar.
 * Targets must be hit in order: T1 before T2, T2 before T3.
 */
export function checkTargets(
  pos: OpenPosition,
  candle: Candle,
  assumption: IntraBarAssumption,
): TargetCheckResult {
  const path = getIntraBarPricePath(candle, assumption);

  let t1 = pos.target1Hit;
  let t2 = pos.target2Hit;
  let t3 = pos.target3Hit;
  let highestNew: TargetCheckResult['highestTargetHit'] = null;
  let exitPrice = 0;
  let hitStep = -1;

  for (let step = 0; step < path.length; step++) {
    const price = path[step];

    if (pos.direction === 'long') {
      if (!t1 && price >= pos.target1) { t1 = true; highestNew = 'target1'; exitPrice = pos.target1; hitStep = step; }
      if (t1 && !t2 && price >= pos.target2) { t2 = true; highestNew = 'target2'; exitPrice = pos.target2; hitStep = step; }
      if (t2 && !t3 && price >= pos.target3) { t3 = true; highestNew = 'target3'; exitPrice = pos.target3; hitStep = step; }
    } else {
      if (!t1 && price <= pos.target1) { t1 = true; highestNew = 'target1'; exitPrice = pos.target1; hitStep = step; }
      if (t1 && !t2 && price <= pos.target2) { t2 = true; highestNew = 'target2'; exitPrice = pos.target2; hitStep = step; }
      if (t2 && !t3 && price <= pos.target3) { t3 = true; highestNew = 'target3'; exitPrice = pos.target3; hitStep = step; }
    }
  }

  return { target1Hit: t1, target2Hit: t2, target3Hit: t3, highestTargetHit: highestNew, exitPrice, hitAtStep: hitStep };
}
