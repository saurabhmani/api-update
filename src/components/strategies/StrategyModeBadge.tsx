'use client';

import { Badge } from '@/components/ui';
import {
  strategyModeDescription,
  strategyModeLabel,
  strategyModeTone,
} from '@/lib/strategy-hub/strategyModeDisplay';
import type { StrategyMode } from '@/lib/signal-engine/types/signalEngine.types';

type BadgeVariant = 'default' | 'green' | 'red' | 'orange' | 'gray' | 'dark';

function toneToVariant(tone: ReturnType<typeof strategyModeTone>): BadgeVariant {
  switch (tone) {
    case 'green':  return 'green';
    case 'orange': return 'orange';
    case 'red':    return 'red';
    case 'blue':   return 'default';
    default:       return 'gray';
  }
}

interface Props {
  mode: StrategyMode | string;
  compact?: boolean;
  showTitle?: boolean;
}

export function StrategyModeBadge({ mode, compact, showTitle = true }: Props) {
  const label = strategyModeLabel(mode);
  const variant = toneToVariant(strategyModeTone(mode));
  return (
    <Badge
      variant={variant}
      style={compact ? { fontSize: '0.7rem' } : undefined}
      title={showTitle ? strategyModeDescription(mode) : undefined}
    >
      {label}
    </Badge>
  );
}
