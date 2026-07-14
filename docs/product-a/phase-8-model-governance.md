# Phase 8 — Controlled Learning and Model Governance

**Status:** Complete  
**Date:** 2026-07-14  
**Model / outcome version:** `8.0.0`  
**Governance version:** `8.0.0`

## Workflow (mandatory)

```
observe
 → calculate recommendation (observational)
 → validate on frozen historical / OOS sample
 → compare champion vs challenger (shadow)
 → approve (versioned event)
 → deploy versioned config
 → monitor (drift)
```

Nightly `learningScheduler` **does not** rewrite production weights unless `SIGNAL_ADAPTIVE_AUTO_APPROVE` **and** `SIGNAL_ADAPTIVE_AUTO_PROMOTE` are explicitly enabled — and even then a **versioned approval/deploy event** is recorded.

## Deliverables

| Item | Location |
|------|----------|
| Complete outcome lifecycle | `feedback/outcomeTracker.ts` + `q365_signal_outcomes` columns |
| Recommendation shrinkage / evidence | `computeAdaptiveRecommendation` |
| Governance + completeness gate | `learning/modelGovernance.ts` |
| Champion/challenger shadow eval | `learning/championChallenger.ts` |
| Drift → Restrict (never loosen) | `driftDetection.ts` + `applyDriftRestrictions` |
| Versioned approve/deploy/rollback | `approveAndDeployVersioned` / `rollbackVersioned` |
| Pipeline integration | `adaptive/runAdaptiveLearningPipeline.ts` |

## Acceptance

- No scheduled job changes production weights without a versioned approval event (defaults OFF)
  - Includes confidence calibration job B: modifiers stay frozen unless `SIGNAL_ADAPTIVE_AUTO_APPROVE` **and** `SIGNAL_ADAPTIVE_AUTO_PROMOTE` are on **and** completeness ≥ 85%
- Every score change carries evidence, comparison, rollback pointer
- Learning cannot bypass Phase 3 rejections (modifier cap ±8 / cycle bounds)
- Material drift auto-restricts strategy health (elite blocked); never loosens thresholds
- Outcome completeness ≥ 85% required before calibration candidates are derived

## Verification

```bash
npm run test:phase8
npm run test:drift-detection
npm run test:promotion-pipeline
```

**Do not start Phase 9 until signed off.**
