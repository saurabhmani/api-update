// GET /api/canonical/sectors — List all sectors
import { withApiHandler } from '@/lib/apiHandler';
import { getSectors } from '@/services/canonicalDataService';

export const GET = withApiHandler(async () => {
  const sectors = await getSectors();
  return { data: sectors, count: sectors.length };
});
