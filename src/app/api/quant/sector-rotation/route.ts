// GET /api/quant/sector-rotation — sector rotation snapshot

import { withApiHandler } from '@/lib/apiHandler';
import { requireSession } from '@/lib/session';
import { computeSectorRotation } from '@/lib/quant-platform';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async () => {
  await requireSession();
  const data = await computeSectorRotation();
  return { data };
});
