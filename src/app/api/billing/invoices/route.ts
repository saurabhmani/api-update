import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { listInvoices } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** GET /api/billing/invoices */
export async function GET() {
  try {
    const user = await requireSession();
    const invoices = await listInvoices(user.id);
    return NextResponse.json({ ok: true, invoices, count: invoices.length });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
