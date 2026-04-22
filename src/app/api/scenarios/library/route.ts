// GET /api/scenarios/library — Available scenario definitions
import { withApiHandler } from '@/lib/apiHandler';
import { getScenarioLibrary } from '@/services/scenarioStressService';

export const GET = withApiHandler(async () => {
  const scenarios = getScenarioLibrary();
  return { data: scenarios, count: scenarios.length };
});
