# Experiment Registry

Every research experiment is tracked in the in-memory experiment registry (`experimentRegistry.ts`). **No experiment is anonymous.**

## Required Fields

| Field | Description |
|-------|-------------|
| `experimentId` | Auto-generated: `exp_YYYYMMDD_author_N` |
| `author` | Named researcher (required, non-empty) |
| `description` | Human-readable purpose |
| `datasetId` | Linked research dataset |
| `features` | Research feature names used |
| `parameters` | Strategy/experiment parameters |
| `createdAt` | ISO timestamp |
| `gitCommit` | Git SHA at run time (optional) |
| `configurationVersion` | Signal engine config version for reproducibility |
| `randomSeed` | Deterministic seed |
| `result` | Metrics, trade count, notes |
| `status` | `draft` → `running` → `completed` / `failed` / `archived` |

## Usage

```typescript
import { registerExperiment, updateExperiment } from '@/lib/research/experimentRegistry';

const exp = registerExperiment({
  author: 'researcher@quantorus',
  description: 'Trend persistence study',
  datasetId: 'synth_001',
  features: ['trend_persistence', 'hurst_exponent'],
  parameters: { lookback: 20 },
  createdAt: new Date().toISOString(),
  configurationVersion: '2.0.0',
  randomSeed: 42,
});

updateExperiment(exp.experimentId, {
  status: 'completed',
  result: { metrics, tradeCount: 50, notes: 'Walk-forward passed' },
});
```

## End-to-End Runner

`runResearchExperiment()` orchestrates dataset load → features → strategy → backtest → benchmark → report → registry update.

## Tests

```bash
npm run test:experiment-registry
```
