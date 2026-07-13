import { describe, it, expect } from 'vitest';
import {
  normalizeDeploymentLifecycle,
  resolveDeploymentLifecycle,
  deploymentLifecycleLabel,
  canTransition,
  isDeployedLifecycle,
} from './deploymentLifecycle';

describe('deploymentLifecycle', () => {
  it('normalizes legacy statuses', () => {
    expect(normalizeDeploymentLifecycle('registered')).toBe('draft');
    expect(normalizeDeploymentLifecycle('staging')).toBe('draft');
    expect(normalizeDeploymentLifecycle('paper_ready')).toBe('validated');
    expect(normalizeDeploymentLifecycle('paper_deployed')).toBe('paper_deployed');
  });

  it('resolves lifecycle from readiness when not deployed', () => {
    expect(resolveDeploymentLifecycle({ readinessReady: false })).toBe('draft');
    expect(resolveDeploymentLifecycle({ readinessReady: true })).toBe('validated');
    expect(resolveDeploymentLifecycle({ storedStatus: 'validated', readinessReady: false })).toBe('validated');
  });

  it('preserves deployed and disabled stored states', () => {
    expect(resolveDeploymentLifecycle({ storedStatus: 'paper_deployed' })).toBe('paper_deployed');
    expect(resolveDeploymentLifecycle({ storedStatus: 'live' })).toBe('live');
    expect(resolveDeploymentLifecycle({ storedStatus: 'disabled' })).toBe('disabled');
    expect(resolveDeploymentLifecycle({ strategyModeDisabled: true })).toBe('disabled');
  });

  it('labels lifecycle states', () => {
    expect(deploymentLifecycleLabel('paper_deployed')).toBe('Paper Deployed');
    expect(deploymentLifecycleLabel('live')).toBe('Live');
  });

  it('enforces transition rules', () => {
    expect(canTransition('draft', 'validated')).toBe(true);
    expect(canTransition('validated', 'paper_deployed')).toBe(true);
    expect(canTransition('live', 'paper_deployed')).toBe(true);
    expect(canTransition('draft', 'live')).toBe(false);
    expect(canTransition('paper_deployed', 'disabled')).toBe(true);
  });

  it('identifies deployed lifecycles', () => {
    expect(isDeployedLifecycle('paper_deployed')).toBe(true);
    expect(isDeployedLifecycle('live')).toBe(true);
    expect(isDeployedLifecycle('validated')).toBe(false);
  });
});
