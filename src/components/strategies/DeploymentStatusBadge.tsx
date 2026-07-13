'use client';

import { Badge } from '@/components/ui';
import {
  deploymentLifecycleLabel,
  deploymentLifecycleTone,
  type DeploymentLifecycle,
} from '@/lib/strategy-hub/deploymentLifecycle';

type BadgeVariant = 'default' | 'green' | 'red' | 'orange' | 'gray' | 'dark';

function toneToVariant(tone: ReturnType<typeof deploymentLifecycleTone>): BadgeVariant {
  switch (tone) {
    case 'green':  return 'green';
    case 'orange': return 'orange';
    case 'red':    return 'red';
    case 'blue':   return 'default';
    case 'gray':
    default:       return 'gray';
  }
}

interface Props {
  status: DeploymentLifecycle;
  compact?: boolean;
}

export function DeploymentStatusBadge({ status, compact }: Props) {
  const label = deploymentLifecycleLabel(status);
  const variant = toneToVariant(deploymentLifecycleTone(status));
  return (
    <Badge variant={variant} style={compact ? { fontSize: '0.7rem' } : undefined}>
      {label}
    </Badge>
  );
}
