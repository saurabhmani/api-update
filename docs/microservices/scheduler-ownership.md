# Scheduler ownership

The monolith remains the default Backtest queue scheduler owner. Immediate submission dispatch, minute drain, and manual drain converge on the ownership guard. Service mode blocks monolith claims; disabled mode blocks both. The independent nightly Backtest schedule is unchanged.

| Job | Current owner/trigger | Zone | Duplicate control | Future owner / rollback |
|---|---|---|---|---|
| Readiness/scans/rescores/evening | scheduler -> daily schedule | Asia/Kolkata | run locks/process flags | Signal; re-enable monolith |
| Manipulation | `server.js` 13:00 UTC plus daily-schedule evidence | Mixed | ownership ambiguity | Intelligence; one flag+lock; legacy trigger |
| Learning | `server.js` 15:00 UTC | UTC | one-shot guard | Strategy governance; legacy child |
| News | standalone script crons | Asia/Kolkata | process ownership | Intelligence; standalone rollback |
| Close snapshot/outcomes | scheduler/in-proc | Asia/Kolkata | mode flags | Signal/Market; legacy scheduler |
| Snapshot lifecycle | scheduler/in-proc 30s | continuous | mode flags | Signal; legacy interval |
| Signal maturity | scheduler/in-proc 60s | continuous | mode flags | Signal; legacy interval |
| Backtest drain | scheduler every minute | continuous | atomic claim/env enablement | Backtest Worker; monolith disabled-but-available |
| Alerts/heartbeat/retention | scheduler/instrumentation | mixed | mode flags | Platform/Alerting; legacy path |

Move protocol: add owner flag and durable claim/lock; disable old; enable new; prove one execution; retain disabled rollback; emit owner metrics.
The monolith Backtest queue drain is scheduled only when local intent is monolith, but each tick and each individual claim independently refreshes MySQL ownership authority. A scheduled callback cannot claim when authority is disabled, service-owned, unavailable, or epoch-mismatched. Immediate submission and the admin manual drain converge on the same check. The separate nightly analytical Backtest remains monolith scheduler-owned and is not a queue claim.
The independent-process harness invokes the same monolith queue entry point used by immediate, scheduled, and manual drains; it does not introduce a second scheduler implementation.
