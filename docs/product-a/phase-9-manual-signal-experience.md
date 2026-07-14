# Phase 9 — Product A Manual Signal Experience

**Status:** Complete  
**Date:** 2026-07-14  
**Contract version:** `9.0.0`

## Objective

Present advanced signal intelligence so a subscriber can make a **disciplined manual** decision. Product A never places broker orders.

## Deliverables

| Item | Location |
|------|----------|
| Canonical signal contract | `src/lib/signals/productASignalContract.ts` |
| Why-not-trade copy | `src/lib/signals/whyNotTrade.ts` |
| Manual actions (allowed/prohibited) | `src/lib/signals/manualExecutionSupport.ts` |
| Scarcity messaging | `src/lib/signals/productAScarcity.ts` |
| Strategy transparency | `src/lib/signals/strategyTransparency.ts` |
| Advanced signal card UI | `src/components/signals/ProductASignalCard.tsx` |
| Manual actions API | `POST /api/signals/manual-actions` |
| Wire attachment | `responseAssembly.ts` → `product_a` on tier rows |
| Detail page | `/signals/[key]` renders Product A card |
| Strategy performance transparency | `/strategies/performance` + API `transparency` map |

## Workflow for subscribers

1. Read elite / actionable card (confidence, decision score, entry, stop, T1–T3, R:R).
2. Read why-trade / why-not-trade (no stack traces).
3. Optional: capital calculator → illustrative quantity.
4. Manual actions only: copy plan, watchlist, alerts, journal.
5. Execute **outside** Quantorus with their own broker.

## Acceptance

- API `counters.approvedTotal`, dashboard tab count, and rendered elite rows stay consistent (same assembly pipeline).
- Same signal → same confidence / entry / stop / targets via `product_a` contract.
- Expired / invalidated → `executionAllowed: false` (invariant tests).
- Elite cards carry `auditSnapshotId` when available (`reproducible: true`).
- No place-order / auto-execute / broker-credential UI or API actions.
- Zero elite is acceptable scarcity messaging — no relax/synthetic fill.

## Verification

```bash
npm run test:phase9
```

**Phase 10 status:** Documented — see `docs/product-a/phase-10-release-gate.md`.
