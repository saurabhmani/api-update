// POST /api/ai/explain-opportunity — AI-enhanced opportunity explanation
import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { ValidationError } from '@/lib/errors';
import { explainOpportunity } from '@/services/aiLayerService';

export const POST = withApiHandler(async (req: NextRequest) => {
  const body = await req.json();
  const { ticker } = body;
  if (!ticker) throw new ValidationError('ticker is required');

  const explanation = await explainOpportunity(ticker);
  return { data: explanation };
});
