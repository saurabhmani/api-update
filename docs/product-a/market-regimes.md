# Product A Historical Market Regimes

Version: 3.0.0  
Source: `analytics/regimeAndExplainabilityAnalytics.ts`

Historical environments are classified for analytics only:

- `trending`: directional regime not matched by another category
- `range_bound`: sideways, range, or neutral label
- `high_volatility`: ATR at least 5% or high-volatility regime label
- `low_volatility`: ATR no greater than 1.5%
- `gap_driven`: absolute opening gap at least 2%
- `news_driven`: explicit manual `news-driven` or `news_driven` tag

Priority is:

1. Manual news tag
2. Gap-driven
3. High volatility
4. Low volatility
5. Range-bound
6. Trending

Manual tags are never inferred. Regime classification is deterministic and
does not change the market regime used during signal generation.

Performance reports aggregate each strategy within these environments using
the canonical outcome record.
