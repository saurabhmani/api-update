# Quantorus365

Institutional stock intelligence platform (Next.js + MySQL).

## Market data providers (Phase 9)

**Default primary:** Zerodha **Kite Connect**.

**Safety net:** **IndianAPI** remains installed and fully functional as:

1. Automatic first fallback when Kite cannot satisfy a supported request (auth failure, rate limit, empty/error)
2. Exclusive path for capabilities Kite does not support — movers, trending, news, corporate data, mutual funds, forecasts, and related endpoints

### Selection precedence

1. `INDIANAPI_PRIMARY=true` → always **IndianAPI** (immediate recovery)
2. `MARKET_DATA_PROVIDER=<name>` → that name (`kite` \| `indianapi` \| …)
3. Unset → **`kite`**

### Supported live chain (quotes / batch / historical)

Kite → IndianAPI → Yahoo (emergency only) → Database / existing emergency providers

Do not remove IndianAPI adapters, quota tracking, or environment variables.

### Configure

See `.env.example` and [ARCHITECTURE.md](./ARCHITECTURE.md) § Market Data.

```bash
# Fresh install / Kite default
MARKET_DATA_PROVIDER=kite
INDIANAPI_PRIMARY=false
KITE_API_KEY=…
KITE_ACCESS_TOKEN=…
INDIANAPI_API_KEY=…   # keep for fallback + unsupported features

# Immediate recovery without deleting Kite config
INDIANAPI_PRIMARY=true
```
