import { describe, expect, it } from 'vitest';
import { buildReleaseManifest, hashReleaseManifest, releaseManifestToJson } from '@/lib/operations/releaseGovernance';
import { validateDeployment } from '@/lib/operations/deploymentValidation';

describe('release governance', () => {
  it('builds release manifest with version metadata', () => {
    const deployment = validateDeployment({
      generatedAt: '2026-01-11T00:00:00Z',
      databaseConnected: true,
      sessionSecretPresent: true,
    });
    const manifest = buildReleaseManifest({
      generatedAt: '2026-01-11T00:00:00Z',
      gitCommit: 'abc123',
      buildVersion: '2.1.0',
      validationResult: deployment,
      releaseNotes: 'Phase 5 ops',
    });
    expect(manifest.gitCommit).toBe('abc123');
    expect(manifest.buildVersion).toBe('2.1.0');
    expect(manifest.validationStatus).toBe('passed');
    expect(manifest.configurationVersion).toBeTruthy();
  });

  it('hashes manifest deterministically', () => {
    const manifest = buildReleaseManifest({ generatedAt: '2026-01-11T00:00:00Z', gitCommit: 'abc' });
    const h1 = hashReleaseManifest(manifest);
    const h2 = hashReleaseManifest(manifest);
    expect(h1).toBe(h2);
    expect(releaseManifestToJson(manifest)).toContain('contentHash');
  });
});
