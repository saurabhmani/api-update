// ════════════════════════════════════════════════════════════════
//  Strategy Mode display helpers (Phase 2)
// ════════════════════════════════════════════════════════════════

import type { StrategyMode } from '@/lib/signal-engine/types/signalEngine.types';

export const MANAGEABLE_STRATEGY_MODES: StrategyMode[] = [
  'CONFIRMED_ENABLED',
  'WATCHLIST_ONLY',
  'DISABLED',
];

export function strategyModeLabel(mode: StrategyMode | string): string {
  switch (mode) {
    case 'CONFIRMED_ENABLED': return 'Enabled';
    case 'WATCHLIST_ONLY':    return 'Watchlist';
    case 'DISABLED':          return 'Disabled';
    case 'EXPERIMENTAL':      return 'Experimental';
    default:                  return String(mode).replace(/_/g, ' ');
  }
}

export function strategyModeDescription(mode: StrategyMode | string): string {
  switch (mode) {
    case 'CONFIRMED_ENABLED':
      return 'Participates in confirmed / approved signal generation';
    case 'WATCHLIST_ONLY':
      return 'Monitoring only — excluded from approved signals';
    case 'DISABLED':
      return 'Stopped — will not produce new approved signals';
    case 'EXPERIMENTAL':
      return 'Experimental — capped to watchlist-tier outcomes';
    default:
      return '';
  }
}

export type StrategyModeBadgeTone = 'green' | 'orange' | 'red' | 'gray' | 'blue';

export function strategyModeTone(mode: StrategyMode | string): StrategyModeBadgeTone {
  switch (mode) {
    case 'CONFIRMED_ENABLED': return 'green';
    case 'WATCHLIST_ONLY':    return 'orange';
    case 'DISABLED':          return 'red';
    case 'EXPERIMENTAL':      return 'blue';
    default:                  return 'gray';
  }
}
