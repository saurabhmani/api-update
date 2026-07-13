# Product A — Promotion Pipeline (Phase 4)

## Lifecycle

```
Candidate → Validation → Approval → Promotion → Rollback → Archive
```

| Stage | Status | Who |
|-------|--------|-----|
| Candidate | `candidate` | `learningScheduler` job H |
| Validation | `validated` or `rejected` | Statistical gates |
| Approval | `approved` | Operator or `SIGNAL_ADAPTIVE_AUTO_APPROVE` |
| Promotion | `promoted` | Operator or `SIGNAL_ADAPTIVE_AUTO_PROMOTE` |
| Rollback | `rolled_back` | Operator — restores `rollbackVersion` |
| Archive | `archived` | Terminal state |

## Environment Flags

| Flag | Default | Effect |
|------|---------|--------|
| `SIGNAL_ADAPTIVE_AUTO_APPROVE` | `false` | Auto-approve after validation |
| `SIGNAL_ADAPTIVE_AUTO_PROMOTE` | `false` | Auto-promote after approval + A/B |
| `SIGNAL_ADAPTIVE_WRITE_REPORTS` | `true` | Write JSON/CSV/Markdown to `reports/adaptive-learning/` |

## Scheduler Integration

Job **H** (`runAdaptiveLearningPipeline`) runs after immutable snapshot job G:

1. Derive candidate parameters from snapshot metrics
2. Register candidate
3. Run statistical validation
4. Optional auto-approve/promote (opt-in)
5. Generate promotion report bundle
6. Log audit entries

## Module

`src/lib/signal-engine/adaptive/promotionPipeline.ts`
