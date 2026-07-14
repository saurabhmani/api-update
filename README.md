# Quantorus365

Institutional stock intelligence platform (Next.js + MySQL).

## Market data providers

**Default primary:** Zerodha **Kite Connect**.

**Fallback chain:** Kite → Yahoo (emergency / enrichment) → NSE direct → Database / cache.

Unsupported discovery surfaces (trending, shockers, most-active) return empty or rankings/MySQL data. News uses news-engine / RSS / GNews / NewsData. Corporate and fundamentals use Yahoo.

### Selection

1. `MARKET_DATA_PROVIDER=<name>` → `kite` | `yahoo` | `none` | `legacy`
2. Unset → **`kite`**

### Configure

```bash
MARKET_DATA_PROVIDER=kite
KITE_API_KEY=…
KITE_API_SECRET=…
KITE_ACCESS_TOKEN=…
YAHOO_EMERGENCY_FALLBACK_ENABLED=true
```

See [ARCHITECTURE.md](./ARCHITECTURE.md).
