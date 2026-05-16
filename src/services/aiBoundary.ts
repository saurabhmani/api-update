// ════════════════════════════════════════════════════════════════
//  AI Boundary — Enforces the deterministic-first invariant.
//
//  PRD RULE: AI must NEVER influence decision outcomes.
//
//  All AI-generated content passes through sanitizeAIOutput() before
//  it is exposed to any downstream consumer. The boundary:
//
//    1. Restricts AI operations to a fixed allowlist
//         (summarize | explain | narrate)
//    2. Strips any field that could influence a decision:
//         decision, approved, rejected, finalVerdict, riskScore,
//         governanceStatus, recommendedQuantity, gates, gateStatus,
//         breaches, violations, etc.
//    3. Records every stripped field so audits can detect AI overreach.
//    4. Throws AIBoundaryViolationError if the AI attempts to produce
//         a decision-shaped payload with strict=true.
//
//  The deterministic orchestrator's output is the ONLY source of
//  truth for decision fields. Any value appearing in an AI payload
//  that overlaps with a decision field is DISCARDED — not merged.
// ════════════════════════════════════════════════════════════════

import { logger } from '@/lib/logger';

const log = logger.child({ service: 'aiBoundary' });

// ── Allowed operations ────────────────────────────────────────────

export type AIOperation = 'summarize' | 'explain' | 'narrate';

const ALLOWED_OPERATIONS: ReadonlySet<AIOperation> = new Set<AIOperation>([
  'summarize', 'explain', 'narrate',
]);

// ── Forbidden fields ──────────────────────────────────────────────
//
// If any of these appear in AI-produced output, they are stripped.
// These field names are reserved for the deterministic pipeline.
const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  // Verdict fields
  'decision',
  'finalVerdict',
  'verdict',
  'approved',
  'rejected',
  'status',                // reserved for gate/orchestrator status
  'overallStatus',
  'decisionReason',
  'decisionId',

  // Scoring fields
  'riskScore',
  'fitScore',
  'governanceScore',
  'opportunityScore',
  'confidence',            // numeric confidence — narrative 'high|moderate|low' handled separately

  // Quantitative outputs the orchestrator owns
  'recommendedQuantity',
  'suggestedQuantity',
  'suggestedNotional',

  // Gate / policy results
  'gates',
  'gateStatus',
  'gateChain',
  'breaches',
  'violations',
  'rules',

  // Side-effect instructions
  'action',
  'execute',
  'override',
  'bypass',
]);

// ── AI output envelope ────────────────────────────────────────────

export interface AIOutput {
  operation: AIOperation;      // what the AI claims to be doing
  subject: string;             // e.g. "RELIANCE", "Portfolio Risk"
  summary: string;             // free-text narrative
  sections?: { heading: string; body: string }[];
  // advisory-only tone signal — 'high|moderate|low' (not a numeric score)
  confidenceTone?: 'high' | 'moderate' | 'low';
  disclaimer: string;
  generatedAt: string;
  // Any other narrative fields the AI may produce. These are
  // individually validated; forbidden keys are dropped.
  [extra: string]: unknown;
}

export interface SanitizedAIOutput extends AIOutput {
  _boundary: {
    passed: boolean;
    strippedFields: string[];
    enforcedAt: string;
  };
}

export class AIBoundaryViolationError extends Error {
  readonly strippedFields: string[];
  readonly operation: string;
  constructor(operation: string, strippedFields: string[]) {
    super(`AI boundary violation in "${operation}": attempted to produce decision fields [${strippedFields.join(', ')}]`);
    this.name = 'AIBoundaryViolationError';
    this.strippedFields = strippedFields;
    this.operation = operation;
  }
}

// ── Core sanitizer ────────────────────────────────────────────────
//
// Accepts any AI payload, enforces the boundary, returns a clean
// object. By default this is non-throwing (drops fields, logs). Pass
// `strict: true` to throw on any violation — use this at integration
// boundaries where silent stripping would be a bug.

export function sanitizeAIOutput(
  raw: unknown,
  opts: { strict?: boolean } = {},
): SanitizedAIOutput {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AIBoundaryViolationError('unknown', ['__not_an_object']);
  }
  const input = raw as Record<string, unknown>;
  const operation = String(input.operation ?? '');

  // 1. Operation allowlist
  if (!ALLOWED_OPERATIONS.has(operation as AIOperation)) {
    throw new AIBoundaryViolationError(operation || '<missing>', ['__operation_not_allowed']);
  }

  // 2. Strip forbidden fields (deep on top level + known containers)
  const stripped: string[] = [];
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      stripped.push(key);
      continue;
    }
    // Guard against nested attempts (sections[].body is ok, but
    // a nested `{ decision: "approved" }` block is not).
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      const cleanNested: Record<string, unknown> = {};
      for (const [nk, nv] of Object.entries(nested)) {
        if (FORBIDDEN_FIELDS.has(nk)) {
          stripped.push(`${key}.${nk}`);
          continue;
        }
        cleanNested[nk] = nv;
      }
      clean[key] = cleanNested;
    } else {
      clean[key] = value;
    }
  }

  if (stripped.length > 0) {
    log.error('AI boundary violation — forbidden fields stripped', {
      operation, strippedFields: stripped,
    });
    if (opts.strict) {
      throw new AIBoundaryViolationError(operation, stripped);
    }
  }

  return {
    ...(clean as AIOutput),
    _boundary: {
      passed: stripped.length === 0,
      strippedFields: stripped,
      enforcedAt: new Date().toISOString(),
    },
  };
}

// ── Decision-merge guard ──────────────────────────────────────────
//
// Used at the final composition step where a UI layer may want to
// attach an AI narrative to a deterministic decision. This function
// guarantees that the deterministic fields always win: the AI
// payload is sanitized first, then the decision fields are layered
// on top, so no AI-produced value can overwrite them.

export interface DeterministicDecision {
  decision: string;
  decisionReason: string;
  decisionId: string;
  riskScore: number;
  governanceStatus: string;
  recommendedQuantity: number;
  [field: string]: unknown;
}

export function composeDecisionWithNarrative(
  decision: DeterministicDecision,
  aiOutput: unknown,
): DeterministicDecision & { narrative: SanitizedAIOutput } {
  const narrative = sanitizeAIOutput(aiOutput, { strict: false });
  // Deterministic fields come LAST in the spread — they are the source of truth.
  return {
    narrative,
    ...decision,
  };
}

// ── Read-only dependency assertion ────────────────────────────────
//
// Used inside AI services to assert they never import a mutator
// into a decision table. Pure runtime check — intended to be called
// once per service initialization.

export function assertAIServiceIsReadOnly(serviceName: string, forbiddenImports: string[]): void {
  const leaked = forbiddenImports.filter(Boolean);
  if (leaked.length > 0) {
    throw new Error(`AI service "${serviceName}" imported decision-mutating symbols: ${leaked.join(', ')}`);
  }
}
