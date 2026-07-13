# Product A — Multi-Asset Platform (Phase 6)

## Architecture

```
Asset Registry → Feature Adapter Router → SignalFeatures (canonical shape)
       ↓
Strategy Registry (metadata filter)
       ↓
Existing canonical pipeline (unchanged for NSE equity)
```

## Feature Adapters

| Adapter | Asset Classes | Implementation |
|---------|---------------|----------------|
| `equityAdapter` | equity, etf, futures, commodity | Delegates 1:1 to `buildSignalFeatures` |
| `indexAdapter` | index | Relaxed liquidity thresholds |
| `cryptoAdapter` | crypto | Scaled volume floor |
| `forexAdapter` | forex | Pip-scale prices |

Entry point: `buildCanonicalSignalFeatures()` in `featureAdapterRouter.ts`

Optional hook in `buildSignalFeatures()` — only routes when non-equity `asset` is passed.

## Risk Models

`multiAssetRisk.ts` generalizes:

- Tick values and lot sizing
- ATR stop distance
- Slippage, fees, spread estimates
- Currency conversion to base (INR)

## Configuration

`multiAssetConfig.ts` supports layered overrides:

```
base (signalEnginePhase2Config + adaptive runtime)
  → asset overrides
  → strategy overrides
  → runtime overrides
```

## Analytics

`multiAssetAnalytics.ts` adds dimensions:

- `assetClass`, `strategyFamily`, `marketSession`, `currency`, `region`

## Constraints

1. No duplicate pipelines — single canonical path
2. NSE equity default when asset unspecified
3. Deterministic, replay-compatible
4. API compatibility preserved

## Module Root

`src/lib/platform/`
