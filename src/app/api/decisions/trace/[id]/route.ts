// GET /api/decisions/trace/:id — Retrieve a decision trace by ID
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { NotFoundError } from '@/lib/errors';
import { getDecisionTraceById } from '@/services/decisionTraceBuilder';

export const GET = withApiHandler(async (req: NextRequest, ctx: any) => {
  const decisionId = ctx?.params?.id ?? req.nextUrl.searchParams.get('id');
  if (!decisionId) throw new NotFoundError('Decision trace', 'missing id');

  const trace = await getDecisionTraceById(decisionId);
  if (!trace) throw new NotFoundError('Decision trace', decisionId);

  return { data: trace };
});
