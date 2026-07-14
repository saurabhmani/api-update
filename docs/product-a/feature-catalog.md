# Product A — Feature Catalog

**Phase:** 1  
**Canonical builder:** `src/lib/signal-engine/features/buildSignalFeatures.ts`

---

## Principle

All Product A signal features are built from **one** function:

```
buildSignalFeatures(candles, marketRegime) → SignalFeatures
```

Identical normalized candle input + regime label → identical features (see `featureFingerprint.ts`).

---

## Feature Groups → Modules

| Group | Builder | Indicators / sources |
|-------|---------|----------------------|
| **Trend** | `features/buildTrendFeatures.ts` | EMA 9/21/20/50/200, SMA 200 (`indicators/ema.ts`, `indicators/sma.ts`) |
| **Momentum** | `features/buildMomentumFeatures.ts` | RSI 14, MACD, ROC 5/20, Stochastic, ADX, divergence |
| **Volume** | `features/buildVolumeFeatures.ts` | Avg vol 20d, OBV slope, climax ratio (`indicators/obv.ts`) |
| **Volatility** | `features/buildVolatilityFeatures.ts` | ATR %, gap %, squeeze (`indicators/atr.ts`, `indicators/bollingerBands.ts`) |
| **Structure** | `features/buildStructureFeatures.ts` | Breakout distance, Fib levels, range (`indicators/fibonacci.ts`) |
| **Context** | inline in `buildSignalFeatures.ts` | `marketRegime`, `liquidityPass` |

---

## Indicator Implementations (canonical)

| Metric | Module | Notes |
|--------|--------|-------|
| ATR | `indicators/atr.ts` | Wilder smoothing |
| EMA | `indicators/ema.ts` | SMA seed, standard k=2/(n+1) |
| SMA | `indicators/sma.ts` | Simple average |
| VWAP | `indicators/vwap.ts` | Session VWAP where used |
| RSI | `indicators/rsi.ts` | Wilder RSI(14) |
| MACD | `indicators/macd.ts` | 12/26/9 default |
| ADX | `indicators/adx.ts` | Wilder ADX(14) |
| Stochastic | `indicators/stochastic.ts` | %K / %D |
| OBV | `indicators/obv.ts` | On-balance volume slope |
| Bollinger | `indicators/bollingerBands.ts` | Squeeze detection |
| Fibonacci | `indicators/fibonacci.ts` + `structure/fibZoneQuality.ts` + `structure/confirmedSwingAnchors.ts` | Retracements/extensions; ATR-confirmed impulse anchors; zone quality (Phase 5) |

Constants: `constants/signalEngine.constants.ts`

---

## Deprecated / Non-canonical Implementations

| Module | Status | Notes |
|--------|--------|-------|
| `scanner/indicatorEngine.ts` | Deprecated | Parallel scanner path; not Product A |
| `lib/pipeline/indicators.ts` | Separate | Incremental tick EMA/RSI for streaming — not signal batch |
| `lib/strategy-lab/indicators.ts` | Separate product | Strategy Lab UI only |
| `scanner/yahooDataService.ts` | Deprecated stub | Custom universe scanner only |

**Do not** add new signal-feature calculations outside `src/lib/signal-engine/features/` and `src/lib/signal-engine/indicators/`.

---

## Pre-build Normalization (Phase 1)

Before feature builders run:

1. `validateCandleSeriesIntegrity()` — dedupe, sort, reject corrupt bars
2. `validateCandleSeries()` — min count (callers)

---

## Testing

```bash
npm run test:feature-consistency
```

Fingerprints: `src/lib/signal-engine/features/featureFingerprint.ts`
