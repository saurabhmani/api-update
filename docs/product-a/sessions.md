# Product A — Market Sessions (Phase 6)

## Session Types

| Type | Description |
|------|-------------|
| `pre_market` | Pre-open order collection |
| `regular` | Primary trading session |
| `post_market` | After-hours |
| `twenty_four_seven` | Crypto / continuous markets |

## NSE Equity

Delegates to `marketHours.ts` for regular session — **unchanged Product A behaviour**.

Equity signal generation remains allowed when market is closed (EOD warehouse parity).

## API

```typescript
import { getSessionStatus, validateSessionForSignalGeneration } from '@/lib/platform/marketSessionEngine';

const status = getSessionStatus(asset);
const { allowed, reason } = validateSessionForSignalGeneration(asset);
```

## Holiday Calendars

Per-asset `calendar.holidays` array. NSE holidays can be extended via asset registration without modifying `marketHours.ts`.

## Module

`src/lib/platform/marketSessionEngine.ts`
