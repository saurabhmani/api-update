# Product A — Portfolio Context (Phase 6)

## Purpose

Signals may optionally include portfolio context for **reporting only**. This module does **not** modify signal generation, scoring, or ranking.

## Report Fields

| Field | Description |
|-------|-------------|
| `sectorExposure` | Signed weight by sector |
| `assetExposure` | Weight by asset class |
| `correlationSummary` | Pairwise correlations |
| `concentrationScore` | HHI-based concentration |
| `allocationSummary` | Per-symbol allocation |

## Usage

```typescript
import { buildPortfolioContextReport } from '@/lib/platform/portfolioContext';

const report = buildPortfolioContextReport({
  positions: [
    { symbol: 'RELIANCE', assetClass: 'equity', sector: 'Energy', weight: 0.1, direction: 'long' },
  ],
  correlationMatrix: { RELIANCE: { TCS: 0.3 } },
});
```

## Integration

Portfolio context is attachable to analytics and operational reports. It is not wired into `generatePhase3Signals` or rejection engines.

## Module

`src/lib/platform/portfolioContext.ts`
