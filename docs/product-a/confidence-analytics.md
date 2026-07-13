# Product A Confidence Analytics

Version: 3.0.0  
Source: `analytics/confidenceAnalytics.ts`

Confidence analytics are report-only. They do not modify confidence scores,
weights, strategy matching, ranking, or rejection behavior.

## Metrics

- Predicted confidence: stored setup confidence divided by 100
- Observed win rate: target 1 reached before a stop
- Bucket calibration error: absolute predicted/observed difference
- Reliability curve: populated confidence buckets
- Brier score: mean squared probabilistic error
- Expected calibration error (ECE): sample-weighted bucket error
- Maximum calibration error (MCE): largest bucket error

Default bucket width is 10 confidence points and may be set between 5 and 25
for analytical comparisons.

## Historical benchmark

`npm run benchmark:confidence-calibration`

The benchmark reads canonical stored outcomes and emits JSON. It never writes
calibration values back to signal generation.

## Reproducibility

Calibration reports include version and sample count. Immutable learning
snapshots capture the complete report and content hash.
