// ════════════════════════════════════════════════════════════════
//  Phase-11 Frontend Signal Types
//
//  Re-exports the canonical Phase-11 types from the engine so React
//  components can import them without reaching into @/lib/...,
//  keeping the dependency direction one-way (frontend depends on
//  engine types, engine never imports from src/types).
//
//  When the contract changes, edit:
//    src/lib/signal-engine/types/phase11Signal.ts
//    src/lib/signal-engine/repository/phase11Serialization.ts
//  This file just forwards.
// ════════════════════════════════════════════════════════════════

export type {
  SignalDirection,
  SignalStatus,
  SignalClassification,
  FactorScores,
  SignalExplanation,
  Phase11SignalRow,
  Phase11SignalSummary,
} from '@/lib/signal-engine/types/phase11Signal';

export type {
  Phase11ApiSignalResponse,
} from '@/lib/signal-engine/repository/phase11Serialization';

export { PHASE_11_REQUIRED_FIELDS } from '@/lib/signal-engine/repository/phase11Serialization';
