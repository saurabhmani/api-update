// GET /api/governance/rules — List all active governance rules
import { withApiHandler } from '@/lib/apiHandler';
import { getGovernanceRules } from '@/services/governanceService';

export const GET = withApiHandler(async () => {
  const rules = await getGovernanceRules();
  return { data: rules, count: rules.length };
});
