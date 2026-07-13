import { describe, expect, it } from 'vitest';
import { validateDeployment } from '@/lib/operations/deploymentValidation';

describe('deployment validation', () => {
  it('passes when blocking checks succeed', () => {
    const result = validateDeployment({
      generatedAt: '2026-01-11T00:00:00Z',
      databaseConnected: true,
      databaseLatencyMs: 5,
      reportsDirWritable: true,
      sessionSecretPresent: true,
    });
    expect(result.passed).toBe(true);
    expect(result.checks.some((c) => c.name === 'configuration_valid' && c.passed)).toBe(true);
  });

  it('blocks deployment on database failure', () => {
    const result = validateDeployment({
      generatedAt: '2026-01-11T00:00:00Z',
      databaseConnected: false,
      sessionSecretPresent: true,
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((c) => c.name === 'database_connectivity')?.passed).toBe(false);
  });

  it('skips database check offline without blocking', () => {
    const result = validateDeployment({
      generatedAt: '2026-01-11T00:00:00Z',
      databaseConnected: undefined,
      sessionSecretPresent: true,
    });
    expect(result.passed).toBe(true);
    expect(result.checks.find((c) => c.name === 'database_connectivity')?.blocking).toBe(false);
  });
});
