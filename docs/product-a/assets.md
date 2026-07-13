# Product A — Asset Registry (Phase 6)

## Supported Asset Classes

| Class | Example | Tradable | Notes |
|-------|---------|----------|-------|
| `equity` | NSE:RELIANCE | Yes | Product A default |
| `index` | NSE:NIFTY50 | Yes | Relaxed liquidity floors |
| `etf` | NSE:NIFTYBEES | Yes | Equity-like session |
| `futures` | NSE:NIFTY_FUT | Yes | Lot-size aware |
| `options` | NSE:NIFTY_OPT | Metadata only | No feature pipeline |
| `forex` | FX:EURUSD | Yes | 24x5 session |
| `crypto` | CRYPTO:BTCUSD | Yes | 24x7 session |
| `commodity` | MCX:GOLD | Yes | MCX calendar |

## Asset Definition Fields

- `market hours` — via `calendar.sessions`
- `tickSize`, `lotSize`, `pricePrecision`
- `currency`, `timezone`, `region`
- `trading calendar` — weekends, holidays, sessions

## API

```typescript
import { resolveAssetForSymbol, listAssets, registerAsset } from '@/lib/platform/assetRegistry';

const asset = resolveAssetForSymbol('RELIANCE'); // NSE equity default
```

## Module

`src/lib/platform/assetRegistry.ts`
