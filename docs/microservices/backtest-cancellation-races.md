# Backtest cancellation race matrix

| Race | Winner/order | Allowed final state | Disallowed outcome | Test |
| --- | --- | --- | --- | --- |
| Cancel vs claim | cancel first | `cancelled` | processor claim | live MySQL claim race |
| Cancel vs claim | claim first/concurrent | `cancel_requested` with one owner | uncancelled running after successful request | live MySQL claim race |
| Cancel vs completion | cancel commits first | `cancel_requested`, then `cancelled` | completed after cancellation wins | live MySQL completion race |
| Cancel vs completion | completion commits first | `completed` | later state regression | live MySQL completion race |
| Cancel vs failure | cancellation observed first | `cancelled` | retry/requeue | live MySQL failure race |
| Cancel vs expired lease/recovery | cancellation then expiry | `cancelled` | requeue | live MySQL recovery race |
| Cancel vs shutdown | acknowledged before stop | `cancelled` | completion | worker checkpoint/lifecycle tests |
| Cancel vs shutdown | stop before acknowledgement | `cancel_requested`, then recovery to `cancelled` | retry claim | recovery and lifecycle tests |

Conditional state and owner predicates determine the winner. Attempt count is incremented only by a claim and is never reset by cancellation or recovery.
