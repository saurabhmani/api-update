# Quantorus365 — FINAL STATUS

> **Vendor decommission complete:** Default market-data primary is **Kite**. Fallback: Yahoo → NSE → DB. News uses RSS/GNews/news-engine; movers use rankings/MySQL.

**Architecture:** Kite primary → Yahoo emergency/enrichment → NSE direct → DB stale tier.
