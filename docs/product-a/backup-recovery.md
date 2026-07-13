# Product A — Backup & Recovery (Phase 5)

## Backup Categories

| Category | Table / Path |
|----------|--------------|
| `signals` | `q365_signals` |
| `outcomes` | `q365_signal_outcomes` |
| `learning_snapshots` | `q365_learning_snapshots` |
| `adaptive_parameters` | `q365_adaptive_parameters` |
| `reports` | `reports/` directory |
| `configuration` | Env snapshot (manual) |

## Backup Command

```bash
npm run backup:operational
# writes backups/backup_{timestamp}/ with JSON exports + manifest.json
```

## Restore

Each category has a documented restore procedure in `backupRecovery.ts`:

- **Snapshots / parameters**: `INSERT IGNORE` — immutable, never UPDATE
- **Outcomes**: Import rows; re-evaluate only missing signals
- **Configuration**: Restore env; set `SIGNAL_ENGINE_CONFIG_VERSION=1` for replay parity

## Rollback

| Type | Procedure |
|------|-----------|
| Promotion | `rollbackParameter()` or restore `q365_adaptive_parameter_pointer` |
| Learning | `activateLearningSnapshot(priorId)` — pointer only |
| Release | Redeploy prior manifest git commit + `validate:deployment` |

## Replay

Historical replay uses versioned config + snapshot pointers. Never mutate immutable snapshot or parameter rows.
