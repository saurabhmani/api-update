import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { getInvoiceById } from '@/lib/billing';

export const dynamic = 'force-dynamic';

/** GET /api/billing/invoices/[id] */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await requireSession();
    const { id } = await params;
    const invoice = await getInvoiceById(id);
    if (!invoice || invoice.userId !== user.id) {
      return NextResponse.json({ ok: false, error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, invoice });
  } catch {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }
}
