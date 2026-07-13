# Product A Performance Reporting

Version: 3.0.0  
Source: `analytics/performanceReporting.ts`

## Report sections

- Overall Product A performance
- Strategy leaderboard
- Confidence calibration and reliability curve
- Feature/outcome association summary
- Historical market-regime summary
- Recent 30-day trends
- Historical baseline comparison
- All dashboard aggregation dimensions

Feature importance means observed association only. It is not causal and is
never converted into an adaptive feature weight.

## JSON and CSV

- `reportToJson()` exports the complete versioned report.
- `reportToCsv()` exports performance dimensions and calibration buckets.

Generate both files:

`npm run report:product-a-performance`

Optional lookback:

`npm run report:product-a-performance -- --days=730`

Outputs are written to `reports/product-a/performance-YYYYMMDD.json` and CSV.
Reports should remain untracked operational artifacts.

## Determinism

Report generation uses a supplied timestamp. If omitted, it derives the
timestamp from the latest evaluated outcome rather than wall-clock time.
Records are sorted by generated timestamp and signal ID where order matters.

## Tests

`npm run test:performance-reporting`
