# Product A — Feature Engineering (Phase 2)

**Version:** 2.0.0  
**Last updated:** 2026-07-13

## Overview

Phase 2 extends the canonical Phase 1 feature builders with **normalized enhanced features** (0–100 scores). All computation is deterministic and lives in:

- `src/lib/signal-engine/features/buildSignalFeatures.ts` — entry point
- `src/lib/signal-engine/features/buildEnhancedFeatures.ts` — Phase 2 scores
- `src/lib/signal-engine/features/normalizeFeatureScore.ts` — normalization utility

## Canonical Phase 1 Features (unchanged)

| Group | Source | Key outputs |
|-------|--------|-------------|
| Trend | `buildTrendFeatures.ts` | EMA 9/20/21/50/200, SMA 200, distances |
| Momentum | `buildMomentumFeatures.ts` | RSI, MACD, ROC, Stochastic, ADX, divergence |
| Volume | `buildVolumeFeatures.ts` | Volume ratios, OBV, VWAP, climax |
| Volatility | `buildVolatilityFeatures.ts` | ATR, Bollinger, gap, squeeze |
| Structure | `buildStructureFeatures.ts` | S/R, breakout distance, Fibonacci, swing counts |
| Context | `buildSignalFeatures.ts` | Regime label, liquidity pass |

## Phase 2 Enhanced Features

All scores are 0–100 unless noted. Higher = better quality, except **trendExhaustion** (higher = more exhausted).

| Feature | Definition |
|---------|------------|
| `trendStrength` | EMA stack alignment + ADX contribution |
| `volumeQuality` | Volume vs 20d avg, OBV slope, breakout volume ratio |
| `volatilityRegime` | Inverted ATR% — calmer markets score higher |
| `breakoutQuality` | Breakout distance + volume + higher-low structure |
| `liquidityQuality` | Liquidity pass + avg volume + price level |
| `relativeStrength` | RS vs index/sector + sector strength |
| `momentumPersistence` | ROC alignment, MACD, ADX, swing structure |
| `riskAdjustedReward` | Estimated R:R to resistance vs support stop |
| `atrEfficiency` | ROC20 per unit ATR% |
| `emaCompression` | Bollinger squeeze + narrow EMA spread |
| `swingStructure` | Higher lows, range compression, Fib zone |
| `supportResistanceProximity` | Distance to support + breakout proximity |
| `trendExhaustion` | EMA20 distance + high RSI + late breakout |
| `marketParticipation` | Volume expansion + OBV + climax |
| `multiTimeframeAlignment` | Daily-only proxy (full MTF via `multiTimeframeAlignment.ts`) |

## Normalization

```typescript
normalizeFeatureScore(value, min, max) → 0..100
```

Values below `min` → 0. Above `max` → 100.

## Configuration

Thresholds in `src/lib/signal-engine/config/signalEnginePhase2Config.ts`.  
Env prefix: `SIGNAL_P2_*`. See `docs/product-a/configuration.md`.

## Tests

```bash
npm run test:feature-consistency
npm run test:feature-engineering  # via featureEngineering.vitest.ts
```
