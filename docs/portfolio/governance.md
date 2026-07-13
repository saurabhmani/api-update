# Portfolio Governance

Portfolio recommendations are governed for institutional compliance.

## Requirements

| Property | Enforcement |
|----------|-------------|
| Versioned | `PORTFOLIO_SCHEMA_VERSION` on every recommendation |
| Auditable | `auditRecommendation()` writes governance records |
| Replayable | `replaySeed` stored for deterministic replay |
| No auto-execution | `canAutoExecute()` always returns `false` |

## Isolation

```typescript
import { assertPortfolioIsolation } from '@/lib/portfolio/governance/portfolioGovernance';

assertPortfolioIsolation();
// { productionPipelineTouched: false, autoExecutionEnabled: false, signalGenerationModified: false }
```

## Reports

All outputs (JSON, CSV, Markdown) include a footer:

> Portfolio recommendations — not auto-executed.

## Promotion Path

Portfolio recommendations do **not** modify Product A signals. Any production changes require separate Phase 4 governance and manual approval.
