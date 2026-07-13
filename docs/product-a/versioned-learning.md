# Product A Versioned Learning

Snapshot schema version: 1.0.0  
Learning analytics version: 3.0.0

The existing `learningScheduler` remains the only scheduled learning
orchestrator. Phase 3 adds a final report-only snapshot job after canonical
outcome, calibration, performance, manipulation, and news jobs.

## Immutable snapshot contents

- Configuration version
- Feature version
- Confidence version
- Learning version
- Benchmark version
- Outcome version
- Source lookback and signal range
- Full benchmark/performance metrics
- SHA-256 content hash

Snapshot IDs are content-addressed:

`learn_YYYYMMDD_<first 12 hash characters>`

## Persistence

- `q365_learning_snapshots`: immutable snapshot body
- `q365_learning_snapshot_audit`: create, activate, replay, rollback audit
- `q365_learning_snapshot_pointer`: active analytics snapshot pointer

Snapshot persistence uses `INSERT IGNORE`; no update path exists.

## Replay

`replayLearningSnapshot(snapshot, records)` verifies the content hash and
rebuilds analytics at the stored timestamp. It does not invoke signal
generation.

## Rollback

`activateLearningSnapshot(..., { rollback: true })` changes only the active
analytics pointer and writes an audit row. It never mutates an immutable
snapshot, signal, score, feature, or model.

## Scheduled recalculation

Run `npm run learning-scheduler`. Daily runs create versioned snapshots after
outcomes have been recalculated.
