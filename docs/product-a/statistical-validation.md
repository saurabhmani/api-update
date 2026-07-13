# Product A — Statistical Validation (Phase 4)

## Purpose

No adaptive parameter may advance past **candidate** without passing statistical validation. Unstable learning is rejected.

## Required Evidence

| Gate | Default Threshold |
|------|-------------------|
| Minimum sample size | 100 outcomes |
| Minimum win count | 30 wins |
| Confidence interval | Wilson 95% CI computed |
| Effect size | \|mean realized R\| ≥ 0.05 |
| Stability across windows | First/second half win-rate delta score ≥ 0.7 |
| Outlier detection | IQR outlier rate ≤ 15% |

## API

```typescript
import { validateAdaptiveEvidence } from '@/lib/signal-engine/adaptive/statisticalValidation';

const metrics = validateAdaptiveEvidence(outcomeRecords);
if (!metrics.passed) {
  // rejectionReasons explain failure
}
```

## Design Rules

1. Validation is **pure** — no DB writes, no signal generation side effects.
2. Rejected candidates remain in store with `approvalStatus: rejected` for audit.
3. Promotion pipeline calls validation before approval.

## Module

`src/lib/signal-engine/adaptive/statisticalValidation.ts`
