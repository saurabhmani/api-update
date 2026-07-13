# Feature Research

Research features are computed in `src/lib/research/features/researchFeatures.ts`. They are **research-only** and never feed the production signal engine.

## Catalog

| Feature | Description |
|---------|-------------|
| `market_breadth` | Up/down bar ratio over lookback |
| `volume_profile` | Volume concentration vs mean |
| `anchored_vwap` | VWAP deviation from anchor |
| `order_flow_proxy` | Close-location × volume proxy |
| `relative_strength` | Return vs rolling mean |
| `volatility_clustering` | Autocorrelation of squared returns |
| `trend_persistence` | Directional run length |
| `fractal_dimension` | Path complexity estimate |
| `entropy` | Shannon entropy of return bins |
| `hurst_exponent` | Mean-reversion vs persistence |
| `rolling_correlation` | Price-volume correlation |
| `market_internals` | Composite breadth + volume signal |

## API

```typescript
import { computeResearchFeatures, discoverSignificantFeatures } from '@/lib/research/features/researchFeatures';

const vectors = computeResearchFeatures('AAPL', candles);
const significant = discoverSignificantFeatures(vectors, returnByBar);
```

## AI Interfaces

Feature importance, clustering, and regime discovery are available via `src/lib/research/ai/researchAi.ts` with explainability strings on every result.

## Governance

Research features cannot be promoted without passing Phase 7 governance and Phase 4 adaptive promotion pipeline.
