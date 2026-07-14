# Robustness Report Template (Phase 7)

**Version:** `7.0.0`  
**Usage:** Attach to every strategy-version promotion packet. Fill from `runRobustnessSuite` + walk-forward headline.

## Identity

| Field | Value |
|-------|-------|
| Strategy id | |
| Strategy version | |
| Code version | |
| Config version / frozen artefact hashes | |
| Data version | |
| Walk-forward model | `7.0.0` |
| Headline source | `out_of_sample_only` |

## OOS headline (only)

| Metric | Value |
|--------|-------|
| Trades (OOS) | |
| Expectancy R | |
| Profit factor | |
| Max drawdown % | |
| Sharpe (mean folds) | |
| Consistency score | |

## Stress results

| Stress | N | Exp R | PF | Pass |
|--------|---|-------|----|------|
| baseline_oos | | | | |
| param_perturb_+5conf | | | | |
| slippage_+15bps | | | | |
| entry_delay_1bar | | | | |
| missing_data_20pct | | | | |
| high_vol_events | | | | |

## Slices

- Regime-by-regime:
- Sector-by-sector:
- Year-by-year:
- Long vs short:

## Bootstrap / Monte Carlo

| Statistic | Value |
|-----------|-------|
| Exp R p05 / p50 / p95 | |
| Max DD p50 / p95 (reshuffle) | |

## Baselines & ablations

| Kind | Exp R | Notes |
|------|-------|-------|
| previous_production | | |
| buy_and_hold | | |
| random_entry | | |
| unfiltered | | |
| ablation_* | | |

## Leakage audit

| Code | Severity | Message |
|------|----------|---------|
| | | |

## Approval

- [ ] OOS expectancy ≥ floor  
- [ ] PF ≥ floor  
- [ ] DD ≤ ceiling  
- [ ] Sample size sufficient  
- [ ] Not dependent on one year/sector/symbol  
- [ ] Calibration acceptable  
- [ ] Parameter perturbation intact  
- [ ] No unresolved leakage errors  
- [ ] Elite 78% (if reported) includes n + CI  

**Decision:** Approve / Restrict / Research-only  
**Health action:** none / restrict_elite / restricted  
