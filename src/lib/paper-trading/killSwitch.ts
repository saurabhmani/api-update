// Kill Switch — halt paper trading

import type { PaperAccount } from './types';

export type KillSwitchAction = 'ACTIVATE' | 'DEACTIVATE';

export interface KillSwitchState {
  active: boolean;
  reason: string | null;
  activatedAt: string | null;
}

export function shouldBlockTrading(account: PaperAccount, globalHalt: boolean): KillSwitchState {
  const active = globalHalt || account.killSwitchActive;
  return {
    active,
    reason: active ? 'Kill switch is active — all paper orders blocked' : null,
    activatedAt: active ? account.updatedAt : null,
  };
}

export function isGlobalKillSwitchActive(): boolean {
  return process.env.PAPER_KILL_SWITCH === '1' || process.env.PAPER_TRADING_HALT === '1';
}
