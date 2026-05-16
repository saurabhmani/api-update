// GET /api/canonical/benchmarks — List all benchmarks
import { withApiHandler } from '@/lib/apiHandler';
import { getBenchmarks } from '@/services/canonicalDataService';

export const GET = withApiHandler(async () => {
  const benchmarks = await getBenchmarks();
  return { data: benchmarks, count: benchmarks.length };
});
