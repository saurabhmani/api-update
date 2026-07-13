# Product A — Release Governance (Phase 5)

## Release Manifest

Every release records:

| Field | Source |
|-------|--------|
| `gitCommit` | `.git/HEAD` or `GIT_COMMIT` / `GITHUB_SHA` |
| `buildVersion` | `package.json` version |
| `configurationVersion` | `SIGNAL_ENGINE_CONFIG_VERSION` |
| `learningVersion` | `OUTCOME_INTELLIGENCE_VERSION` |
| `adaptiveVersion` | `ADAPTIVE_LEARNING_VERSION` |
| `schemaVersion` | `OPERATIONS_SCHEMA_VERSION` |
| `benchmarkVersion` | `PERFORMANCE_REPORT_VERSION` |
| `validationStatus` | Deployment validation result |
| `validationChecks` | Per-check pass/fail |
| `releaseNotes` | `RELEASE_NOTES` env or manual |

## Generation

```bash
npm run release:manifest
# writes releases/manifest-{version}-{date}.json
```

## CI Integration

The `operations-gate` job in `.github/workflows/ci.yml` runs:

1. Operations tests
2. `benchmark:operations`
3. `validate:deployment`
4. `release:manifest`

Deployment is blocked when validation fails.

## API

`GET /api/operations/release` — current release manifest for operators.
