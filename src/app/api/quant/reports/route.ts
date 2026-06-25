// GET/POST /api/quant/reports — enterprise reports

import { NextRequest } from 'next/server';
import { withApiHandler } from '@/lib/apiHandler';
import { requireSession } from '@/lib/session';
import { generateEnterpriseReport, formatReportAsMarkdown } from '@/lib/quant-platform';

export const dynamic = 'force-dynamic';

export const GET = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const reportType = (req.nextUrl.searchParams.get('type') ?? 'daily') as
    'daily' | 'weekly' | 'risk' | 'strategy' | 'full';
  const report = await generateEnterpriseReport(user.id, reportType);
  const markdown = formatReportAsMarkdown(report);
  return { report, markdown };
});

export const POST = withApiHandler(async (req: NextRequest) => {
  const user = await requireSession();
  const body = await req.json().catch(() => ({}));
  const reportType = (body.type ?? 'full') as 'daily' | 'weekly' | 'risk' | 'strategy' | 'full';
  const report = await generateEnterpriseReport(user.id, reportType);
  const markdown = formatReportAsMarkdown(report);
  return { report, markdown };
});
