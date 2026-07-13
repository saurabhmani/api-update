# Product A — Configuration (Phase 2)

**Version:** 2.0.0  
**Last updated:** 2026-07-13

## Version Control

| Env | Default | Effect |
|-----|---------|--------|
| `SIGNAL_ENGINE_CONFIG_VERSION` | `2` | `1` = Phase 1 compat; `2` = Phase 2 enhancements |

Config label: `2.0.0` (`SIGNAL_ENGINE_CONFIG_VERSION` constant in code).

## Feature Thresholds

| Env | Default | Description |
|-----|---------|-------------|
| `SIGNAL_P2_MIN_TREND_STRENGTH` | 35 | Min trend strength score |
| `SIGNAL_P2_MIN_VOLUME_QUALITY` | 30 | Min volume quality |
| `SIGNAL_P2_MIN_LIQUIDITY_QUALITY` | 40 | Min liquidity quality |
| `SIGNAL_P2_MIN_BREAKOUT_QUALITY` | 25 | Min breakout quality |
| `SIGNAL_P2_MAX_TREND_EXHAUSTION` | 75 | Max exhaustion for continuation |
| `SIGNAL_P2_MIN_MOMENTUM_PERSISTENCE` | 30 | Min momentum persistence |
| `SIGNAL_P2_MIN_MARKET_PARTICIPATION` | 35 | Min participation score |

## Rejection Thresholds

| Env | Default | Description |
|-----|---------|-------------|
| `SIGNAL_P2_REJECT_MIN_TREND` | 30 | Weak trend floor |
| `SIGNAL_P2_REJECT_MIN_LIQUIDITY` | 35 | Liquidity quality floor |
| `SIGNAL_P2_MAX_SPREAD_PCT` | 1.5 | Max estimated spread % |
| `SIGNAL_P2_MAX_ATR_PCT` | 8.0 | Max ATR% |
| `SIGNAL_P2_MIN_CONFIRMATION` | 40 | Min confirmation score |
| `SIGNAL_P2_MIN_RR` | 1.2 | Min reward/risk |
| `SIGNAL_P2_MAX_LATE_BREAKOUT_PCT` | 4.5 | Max breakout extension |
| `SIGNAL_P2_MAX_OVEREXTENSION_PCT` | 7.0 | Max EMA20 distance |

## Confidence Calibration

| Env | Default | Description |
|-----|---------|-------------|
| `SIGNAL_P2_CONFIDENCE_CALIBRATION` | true | Enable calibration |
| `SIGNAL_P2_CONFIDENCE_MAX_ADJ` | 5 | Max ± adjustment |
| `SIGNAL_P2_CONF_TREND_BONUS` | 60 | Trend strength for bonus |
| `SIGNAL_P2_CONF_VOL_BONUS` | 55 | Volume quality for bonus |
| `SIGNAL_P2_CONF_EXHAUST_PENALTY` | 70 | Exhaustion penalty threshold |

## Trade Plan

| Env | Default | Description |
|-----|---------|-------------|
| `SIGNAL_P2_ROUND_PRICES` | true | NSE tick rounding |
| `SIGNAL_P2_MIN_STOP_ATR` | 0.5 | Min stop in ATR units |
| `SIGNAL_P2_MAX_STOP_ATR` | 3.0 | Max stop in ATR units |
| `SIGNAL_P2_STRUCTURE_STOP_ATR` | 0.3 | Structure buffer |

## Phase 1 Constants (unchanged)

Institutional gates remain in `signalEngine.constants.ts` and `getStrategyRelaxConfig()`.

## Historical Replay

```bash
SIGNAL_ENGINE_CONFIG_VERSION=1 npm run benchmark:signal-quality
SIGNAL_ENGINE_CONFIG_VERSION=2 npm run benchmark:signal-quality
```

## Source

`src/lib/signal-engine/config/signalEnginePhase2Config.ts`
