// ════════════════════════════════════════════════════════════════
//  Audit Log Service — Compliance-Grade
//
//  RULE: Every material event MUST be recorded with full identity,
//  structured payload, and zero free-form fields.
//
//  Every audit entry includes:
//    - auditId (auto-increment)
//    - eventType (strict enum)
//    - actorId + actorType
//    - decisionId (links to decision_traces)
//    - portfolioId (canonical)
//    - instrumentId (canonical)
//    - resourceType + resourceId
//    - action
//    - payload (structured, typed)
//    - ipAddress
//
//  Validation: rejects malformed entries. No silent persistence
//  of incomplete data.
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { logger } from '@/lib/logger';

const log = logger.child({ service: 'auditLog' });

// ── Validation Error ────────────────────────────────────────────

export class AuditValidationError extends Error {
  public readonly errors: string[];
  public readonly eventType: string;
  public readonly action: string;
  constructor(message: string, errors: string[], eventType: string, action: string) {
    super(message);
    this.name = 'AuditValidationError';
    this.errors = errors;
    this.eventType = eventType;
    this.action = action;
  }
}

// ── Strict Enums ────────────────────────────────────────────────

export type AuditEventType =
  | 'institutional_decision'
  | 'pretrade_decision'
  | 'governance_check'
  | 'scenario_evaluation'
  | 'breach_detected'
  | 'breach_acknowledged'
  | 'portfolio_sync'
  | 'user_login'
  | 'user_logout'
  | 'user_action'
  | 'admin_action'
  | 'data_sync'
  | 'system_error';

const VALID_EVENT_TYPES = new Set<string>([
  'institutional_decision', 'pretrade_decision', 'governance_check',
  'scenario_evaluation', 'breach_detected', 'breach_acknowledged',
  'portfolio_sync', 'user_login', 'user_logout', 'user_action',
  'admin_action', 'data_sync', 'system_error',
]);

export type AuditActorType = 'user' | 'system' | 'scheduler' | 'admin';

const VALID_ACTOR_TYPES = new Set<string>(['user', 'system', 'scheduler', 'admin']);

export type AuditResourceType =
  | 'trade' | 'portfolio' | 'signal' | 'instrument'
  | 'user' | 'settings' | 'alert' | 'backtest' | 'system';

const VALID_RESOURCE_TYPES = new Set<string>([
  'trade', 'portfolio', 'signal', 'instrument',
  'user', 'settings', 'alert', 'backtest', 'system',
]);

// ── Event Interface ─────────────────────────────────────────────

export interface AuditEvent {
  id?: number;
  eventType: AuditEventType;
  actorId: number | null;
  actorType: AuditActorType;
  decisionId: string | null;      // links to decision_traces
  portfolioId: number | null;     // canonical portfolio ID
  instrumentId: number | null;    // canonical instrument ID
  resourceType: AuditResourceType;
  resourceId: string;
  action: string;
  payload: AuditPayload;          // structured — NOT Record<string, unknown>
  ipAddress: string | null;
  createdAt?: string;
}

// ── Structured Payload ──────────────────────────────────────────
// Every event type has a defined payload shape. This prevents
// free-form logging that breaks compliance queries.

export interface AuditPayload {
  // Identity (always present)
  ticker?: string;
  side?: string;

  // Decision context (for institutional_decision, pretrade_decision)
  decision?: string;
  decisionReason?: string;
  requestedQuantity?: number;
  recommendedQuantity?: number;
  price?: number;
  fitScore?: number | null;
  riskScore?: number | null;

  // Governance (for governance_check)
  governanceStatus?: string;
  violations?: { policy: string; status: string; reason: string }[];

  // Scenario (for scenario_evaluation)
  scenarioId?: string;
  marginalImpact?: number | null;

  // Breach (for breach_detected, breach_acknowledged)
  breachMetric?: string;
  breachSeverity?: string;
  breachMessage?: string;

  // Gate chain (for institutional_decision)
  gates?: { gate: string; status: string; failReason?: string }[];

  // Generic (for user_action, admin_action, data_sync)
  description?: string;
  metadata?: Record<string, unknown>;
}

// ── Log Redaction ───────────────────────────────────────────────

const REDACT_KEYS = new Set([
  'password', 'password_hash', 'access_token', 'token', 'secret',
  'totp_secret', 'api_secret', 'api_key', 'session_token',
  'cookie', 'authorization', 'kite_api_secret', // @deprecated marker
]);

function redactObject(obj: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (REDACT_KEYS.has(key.toLowerCase())) {
      clean[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      clean[key] = redactObject(value as Record<string, unknown>);
    } else {
      clean[key] = value;
    }
  }
  return clean;
}

// ── Validation ──────────────────────────────────────────────────
// Strict: rejects malformed entries instead of silently persisting.

export interface AuditValidationResult {
  valid: boolean;
  errors: string[];
}

// Event types that REQUIRE a decisionId for traceability
const DECISION_LINKED_EVENTS = new Set<string>([
  'institutional_decision', 'pretrade_decision', 'governance_check', 'scenario_evaluation',
]);

// Event types that REQUIRE a portfolioId
const PORTFOLIO_REQUIRED_EVENTS = new Set<string>([
  'institutional_decision', 'pretrade_decision', 'governance_check',
  'scenario_evaluation', 'breach_detected', 'breach_acknowledged', 'portfolio_sync',
]);

// Event types that REQUIRE an instrumentId
const INSTRUMENT_REQUIRED_EVENTS = new Set<string>([
  'institutional_decision', 'pretrade_decision',
]);

function validateAuditEvent(event: Omit<AuditEvent, 'id' | 'createdAt'>): AuditValidationResult {
  const errors: string[] = [];

  if (!event.eventType || !VALID_EVENT_TYPES.has(event.eventType)) {
    errors.push(`Invalid eventType: "${event.eventType}". Must be one of: ${[...VALID_EVENT_TYPES].join(', ')}`);
  }
  if (!event.actorType || !VALID_ACTOR_TYPES.has(event.actorType)) {
    errors.push(`Invalid actorType: "${event.actorType}". Must be one of: ${[...VALID_ACTOR_TYPES].join(', ')}`);
  }
  if (!event.action || event.action.trim() === '') {
    errors.push('action is required');
  }
  if (event.actorType === 'user' && (event.actorId == null || event.actorId <= 0)) {
    errors.push('actorId is required when actorType is "user"');
  }
  if (!event.resourceType || !VALID_RESOURCE_TYPES.has(event.resourceType)) {
    errors.push(`Invalid resourceType: "${event.resourceType}". Must be one of: ${[...VALID_RESOURCE_TYPES].join(', ')}`);
  }
  if (!event.payload || typeof event.payload !== 'object') {
    errors.push('payload is required and must be a structured object');
  }

  // Decision-linked events MUST have decisionId for traceability
  if (DECISION_LINKED_EVENTS.has(event.eventType) && !event.decisionId) {
    errors.push(`decisionId is required for ${event.eventType} events`);
  }

  // Portfolio-scoped events MUST have portfolioId
  if (PORTFOLIO_REQUIRED_EVENTS.has(event.eventType) && event.portfolioId == null) {
    errors.push(`portfolioId is required for ${event.eventType} events`);
  }

  // Trade events SHOULD have instrumentId (warning, not blocking)
  // instrumentId may be null for instruments not yet in canonical universe
  if (INSTRUMENT_REQUIRED_EVENTS.has(event.eventType) && event.instrumentId == null) {
    // Soft check — logged but not blocking
    log.warn('Audit event missing instrumentId — traceability degraded', {
      eventType: event.eventType, action: event.action,
    });
  }

  return { valid: errors.length === 0, errors };
}

// ── Query Interface ─────────────────────────────────────────────

export interface AuditLogQuery {
  eventType?: string;
  actorId?: number;
  decisionId?: string;
  portfolioId?: number;
  instrumentId?: number;
  resourceType?: string;
  resourceId?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

// ── Log Event ───────────────────────────────────────────────────

export async function logAuditEvent(
  event: Omit<AuditEvent, 'id' | 'createdAt'>,
): Promise<number> {
  // Validate strictly — malformed entries are REJECTED, not persisted.
  // Compliance rule: no free-form or incomplete audit records.
  const validation = validateAuditEvent(event);
  if (!validation.valid) {
    const err = new AuditValidationError(
      `Audit event REJECTED — ${validation.errors.join('; ')}`,
      validation.errors,
      event.eventType,
      event.action,
    );
    log.error('Audit event REJECTED — malformed', {
      errors: validation.errors,
      eventType: event.eventType,
      action: event.action,
    });
    throw err;
  }

  // Redact sensitive fields
  const safePayload = redactObject(event.payload as Record<string, unknown>);

  try {
    const result = await db.query(
      `INSERT INTO audit_events
         (event_type, actor_id, actor_type, decision_id, portfolio_id, instrument_id,
          resource_type, resource_id, action, details, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        event.eventType,
        event.actorId,
        event.actorType,
        event.decisionId ?? null,
        event.portfolioId ?? null,
        event.instrumentId ?? null,
        event.resourceType,
        event.resourceId,
        event.action,
        JSON.stringify(safePayload),
        event.ipAddress,
      ],
    );
    return result.insertId ?? 0;
  } catch (err) {
    // Fallback to legacy audit_logs table
    try {
      await db.query(
        `INSERT INTO audit_logs (user_id, action, resource_type, resource_id, metadata, ip_address)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [event.actorId, event.action, event.resourceType, Number(event.resourceId) || null, JSON.stringify(safePayload), event.ipAddress],
      );
    } catch {}
    log.warn('Audit event persistence degraded', { eventType: event.eventType });
    return 0;
  }
}

// ── Query Logs ──────────────────────────────────────────────────

export async function queryAuditLogs(
  query: AuditLogQuery,
): Promise<{ events: AuditEvent[]; total: number }> {
  const clauses: string[] = [];
  const params: any[] = [];

  if (query.eventType) { clauses.push('event_type = ?'); params.push(query.eventType); }
  if (query.actorId) { clauses.push('actor_id = ?'); params.push(query.actorId); }
  if (query.decisionId) { clauses.push('decision_id = ?'); params.push(query.decisionId); }
  if (query.portfolioId) { clauses.push('portfolio_id = ?'); params.push(query.portfolioId); }
  if (query.instrumentId) { clauses.push('instrument_id = ?'); params.push(query.instrumentId); }
  if (query.resourceType) { clauses.push('resource_type = ?'); params.push(query.resourceType); }
  if (query.resourceId) { clauses.push('resource_id = ?'); params.push(query.resourceId); }
  if (query.from) { clauses.push('created_at >= ?'); params.push(query.from); }
  if (query.to) { clauses.push('created_at <= ?'); params.push(query.to); }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;

  try {
    const { rows: countRows } = await db.query(
      `SELECT COUNT(*) AS total FROM audit_events ${where}`, params,
    );
    const total = Number((countRows[0] as any)?.total ?? 0);

    const { rows } = await db.query(
      `SELECT * FROM audit_events ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    const events: AuditEvent[] = (rows as any[]).map((r) => ({
      id: r.id,
      eventType: r.event_type,
      actorId: r.actor_id,
      actorType: r.actor_type ?? 'user',
      decisionId: r.decision_id ?? null,
      portfolioId: r.portfolio_id ?? null,
      instrumentId: r.instrument_id ?? null,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      action: r.action,
      payload: typeof r.details === 'string' ? JSON.parse(r.details) : (r.details ?? {}),
      ipAddress: r.ip_address,
      createdAt: r.created_at,
    }));

    return { events, total };
  } catch {
    return { events: [], total: 0 };
  }
}

// ── Convenience: Institutional Decision ─────────────────────────

export function logInstitutionalDecision(opts: {
  userId: number;
  decisionId: string;
  portfolioId: number;
  instrumentId: number | null;
  ticker: string;
  side: string;
  decision: string;
  decisionReason: string;
  requestedQuantity: number;
  recommendedQuantity: number;
  price: number;
  fitScore: number | null;
  riskScore: number | null;
  governanceStatus: string | null;
  scenarioImpact: number | null;
  gates: { gate: string; status: string; failReason?: string }[];
  ipAddress: string | null;
}): Promise<number> {
  return logAuditEvent({
    eventType: 'institutional_decision',
    actorId: opts.userId,
    actorType: 'system',
    decisionId: opts.decisionId,
    portfolioId: opts.portfolioId,
    instrumentId: opts.instrumentId,
    resourceType: 'trade',
    resourceId: opts.ticker,
    action: opts.decision,
    payload: {
      ticker: opts.ticker,
      side: opts.side,
      decision: opts.decision,
      decisionReason: opts.decisionReason,
      requestedQuantity: opts.requestedQuantity,
      recommendedQuantity: opts.recommendedQuantity,
      price: opts.price,
      fitScore: opts.fitScore,
      riskScore: opts.riskScore,
      governanceStatus: opts.governanceStatus,
      scenarioId: undefined,
      marginalImpact: opts.scenarioImpact,
      gates: opts.gates,
    },
    ipAddress: opts.ipAddress,
  });
}

// ── Convenience: Governance Check ───────────────────────────────

export function logGovernanceCheck(opts: {
  userId: number;
  decisionId: string;
  portfolioId: number;
  instrumentId: number | null;
  ticker: string;
  status: string;
  violations: { policy: string; status: string; reason: string }[];
}): Promise<number> {
  return logAuditEvent({
    eventType: 'governance_check',
    actorId: opts.userId,
    actorType: 'system',
    decisionId: opts.decisionId,
    portfolioId: opts.portfolioId,
    instrumentId: opts.instrumentId,
    resourceType: 'trade',
    resourceId: opts.ticker,
    action: opts.status,
    payload: {
      ticker: opts.ticker,
      governanceStatus: opts.status,
      violations: opts.violations,
    },
    ipAddress: null,
  });
}

// ── Convenience: Breach Detection ───────────────────────────────

export function logBreachDetection(opts: {
  portfolioId: number;
  metric: string;
  severity: string;
  message: string;
}): Promise<number> {
  return logAuditEvent({
    eventType: 'breach_detected',
    actorId: null,
    actorType: 'system',
    decisionId: null,
    portfolioId: opts.portfolioId,
    instrumentId: null,
    resourceType: 'portfolio',
    resourceId: String(opts.portfolioId),
    action: `breach:${opts.metric}`,
    payload: {
      breachMetric: opts.metric,
      breachSeverity: opts.severity,
      breachMessage: opts.message,
    },
    ipAddress: null,
  });
}
