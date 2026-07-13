# Product A Strategy Performance

Version: 3.0.0  
Source: `analytics/performanceAnalytics.ts`

## Dimensions

Metrics are aggregated independently by:

- Strategy
- Sector
- Symbol
- Market regime
- Timeframe
- ISO-like UTC week
- Calendar month
- Calendar quarter

## Metrics

- Win rate
- Average realized return percentage
- Average holding period in bars
- Average realized reward/risk
- Maximum drawdown in R
- Sample count

Drawdown is calculated from chronological realized-R equity. Ties use signal
ID, making replay ordering deterministic.

## Dashboard data

`buildAllPerformanceDimensions()` returns typed dashboard-ready data without
changing an HTTP response contract. Consumers may read generated JSON reports
or add an API adapter in a later contract-approved phase.

## Ranking

The strategy leaderboard in reports is sorted by average realized R and sample
count. This is analytics ranking only and does not affect signal ranking.
