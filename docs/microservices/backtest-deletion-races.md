# Backtest deletion race matrix

| Race | Allowed order | Allowed final state | Forbidden state | Audit expectation | Test |
| --- | --- | --- | --- | --- | --- |
| Delete vs claim | active-state lock rejects delete; claim may win | `running` | deleted while owned | deletion decision | live MySQL claim-delete race |
| Delete vs cancellation | terminal cancellation may be deleted; request may observe missing | deleted or terminal | orphan children | destructive audit | live MySQL cancel-delete race |
| Delete vs running execution | delete rejected | running/cancel_requested | deleted active job | rejection audit | active deletion test |
| Delete vs completion | delete sees running and rejects, or completion commits first and terminal deletion follows | completed or transactionally deleted | active row deleted; orphan artifacts | decision audit | live MySQL completion-delete race |
| Delete vs failure/recovery/retry | active states reject deletion | failed/dead/queued/running | deleted leased/retryable job | decision audit | state allowlist tests |

Deletion obtains a scoped parent row lock and completes all child and parent deletes in one MySQL transaction. Rollback preserves all rows if any child deletion fails.
