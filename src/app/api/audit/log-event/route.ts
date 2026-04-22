// POST /api/audit/log-event — Record an audit event
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { logAuditEvent, AuditValidationError } from '@/services/auditLogService';
import { requireSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json();
  const {
    eventType, resourceType, resourceId, action,
    payload, details,                 // accept 'details' as legacy alias for 'payload'
    decisionId, portfolioId, instrumentId,
  } = body;

  if (!eventType || !action) {
    throw new ValidationError('eventType and action are required');
  }

  const ip = req.headers.get('x-forwarded-for') ?? req.headers.get('x-real-ip') ?? null;

  try {
    const id = await logAuditEvent({
      eventType,
      actorId: user.id,
      actorType: 'user',
      decisionId: decisionId ?? null,
      portfolioId: portfolioId ?? null,
      instrumentId: instrumentId ?? null,
      resourceType: resourceType ?? 'system',
      resourceId: resourceId ?? '',
      action,
      payload: payload ?? details ?? {},
      ipAddress: ip,
    });

    return { data: { id }, message: 'Audit event logged' };
  } catch (err) {
    if (err instanceof AuditValidationError) {
      throw new ValidationError(`Audit validation failed: ${err.errors.join('; ')}`);
    }
    throw err;
  }
});
