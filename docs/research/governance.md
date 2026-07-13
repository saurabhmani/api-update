# Research Governance

Promotion from research to production is **never automatic**. All paths must go through Phase 4 adaptive promotion governance.

## Promotion Requirements

| Requirement | Threshold |
|-------------|-----------|
| Statistical significance | ≥ 0.95 |
| Minimum trades | ≥ 100 |
| Walk-forward success | Required |
| Cross-regime stability | Required |
| Peer review | Required |
| Manual approval | Required |
| Phase 4 governance | Required — no bypass |

## Evaluation

```typescript
import { evaluatePromotionRequest } from '@/lib/research/governance/researchGovernance';

const decision = evaluatePromotionRequest(request, metrics, tradeCount);
if (decision.approved) {
  // Next: manual approval + Phase 4 promotionPipeline
}
```

## Blocking Conditions

Promotion is blocked when:

- Significance below threshold
- Trade count below floor
- Walk-forward not passed
- Cross-regime instability
- Peer review not approved
- Negative Sharpe
- Max drawdown > 25%

## Isolation Assertion

```typescript
import { assertResearchIsolation } from '@/lib/research/governance/researchGovernance';

assertResearchIsolation();
// { productionPipelineTouched: false, autoPromotionEnabled: false }
```

## Reports

Research outputs (Markdown, CSV, JSON) are informational only. They do not trigger production changes.
