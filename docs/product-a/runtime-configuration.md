# Product A — Runtime Configuration (Phase 4)

## Loading Order

```
Base configuration (signalEnginePhase2Config)
        ↓
Versioned adaptive parameters (promoted pointer)
        ↓
Merged runtime configuration (immutable, cached)
```

## API

```typescript
import { getRuntimeSignalEngineConfig } from '@/lib/signal-engine/adaptive/runtimeConfiguration';

const { config, manifest } = getRuntimeSignalEngineConfig();
// config — merged Phase 2 + adaptive overlay
// manifest — version metadata for replay audit
```

## Properties

- **Immutable** — `Object.freeze` on merged config
- **Cached** — invalidated on promotion/rollback
- **Version-aware** — manifest records base + adaptive IDs and hashes
- **Replayable** — `SIGNAL_ENGINE_CONFIG_VERSION=1` bypasses adaptive overlay semantics via base config

## Environment

| Flag | Default | Effect |
|------|---------|--------|
| `SIGNAL_ADAPTIVE_RUNTIME_ENABLED` | `true` | Load promoted overlay at runtime |

When no promoted parameter exists, runtime config equals base config exactly.

## Consumers

Phase 2 modules read runtime config:

- `phase2RejectionGates.ts`
- `confidenceCalibration.ts`
- `tradePlanEnhancements.ts`

## Module

`src/lib/signal-engine/adaptive/runtimeConfiguration.ts`
