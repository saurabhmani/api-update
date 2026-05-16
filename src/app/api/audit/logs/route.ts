// GET /api/audit/logs — Query audit trail
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { queryAuditLogs } from '@/services/auditLogService';

export const GET = withApiHandler(async (req: NextRequest) => {
  const sp = req.nextUrl.searchParams;

  const result = await queryAuditLogs({
    eventType: sp.get('eventType') ?? undefined,
    actorId: sp.get('actorId') ? Number(sp.get('actorId')) : undefined,
    resourceType: sp.get('resourceType') ?? undefined,
    resourceId: sp.get('resourceId') ?? undefined,
    from: sp.get('from') ?? undefined,
    to: sp.get('to') ?? undefined,
    limit: sp.get('limit') ? Number(sp.get('limit')) : 100,
    offset: sp.get('offset') ? Number(sp.get('offset')) : 0,
  });

  return { data: result.events, total: result.total, count: result.events.length };
});
