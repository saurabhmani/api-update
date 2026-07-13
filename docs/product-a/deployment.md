# Product A — Deployment (Phase 5)

## Pre-Deployment Validation

```bash
npm run validate:deployment
```

Blocking checks:

| Check | Category |
|-------|----------|
| `configuration_valid` | configuration |
| `runtime_configuration` | runtime |
| `adaptive_parameter_integrity` | adaptive |
| `database_connectivity` | database |
| `session_secret` | security |

Non-blocking:

| Check | Category |
|-------|----------|
| `learning_snapshot_valid` | snapshots |
| `reports_path` | reports |

## Deploy Flow

```bash
# 1. CI gates (automatic on PR)
#    Build → Typecheck → Lint → Tests → Benchmarks → Validation → Manifest

# 2. Local / production deploy
bash scripts/deployAndValidate.sh

# 3. Post-deploy verification
npm run validate:signal-engine-functional
npm run check:signal-consistency
npm run report:operations
```

## CI/CD Pipeline

`.github/workflows/ci.yml`:

```
signals-gate (blocking)
  → typecheck, lint, test:signals-gate, build

operations-gate (blocking)
  → test:operations, monitoring, alerts, deployment-validation,
    backup-recovery, release-governance, benchmark:operations,
    validate:deployment, release:manifest

phase-tests (blocking)
  → Phase 1-4 regression suites
```

## Artifact Generation

Release manifest written to `releases/manifest-{version}-{date}.json` with content hash.

Operational reports written to `reports/operations/`.

## Rollback

See `docs/product-a/backup-recovery.md` and `docs/product-a/runbooks.md`.
