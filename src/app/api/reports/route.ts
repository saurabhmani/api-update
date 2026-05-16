import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/session';
import { db } from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const user = await requireSession();
    const id   = req.nextUrl.searchParams.get('id');

    if (id) {
      const { rows } = await db.query(
        `SELECT * FROM reports WHERE id=? AND user_id=?`, [id, user.id]
      );
      if (!rows.length) return NextResponse.json({ error: 'Not found' }, { status: 404 });

      // Download — return file content (simplified)
      const download = req.nextUrl.searchParams.get('download');
      if (download === 'true') {
        const report = rows[0];
        const content = `Quantorus365 Report\nType: ${report.report_type}\nGenerated: ${report.created_at}\n`;
        return new NextResponse(content, {
          headers: {
            'Content-Type': report.format === 'pdf' ? 'application/pdf' : 'text/csv',
            'Content-Disposition': `attachment; filename="${report.report_type}-report.${report.format}"`,
          },
        });
      }
      return NextResponse.json({ report: rows[0] });
    }

    const { rows } = await db.query(
      `SELECT * FROM reports WHERE user_id=? ORDER BY created_at DESC LIMIT 50`,
      [user.id]
    );
    return NextResponse.json({ reports: rows });
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireSession();
    const { type, format = 'csv' } = await req.json();
    if (!type) return NextResponse.json({ error: 'type required' }, { status: 400 });

    const { rows } = await db.query(
      `INSERT INTO reports (user_id, name, report_type, format, status)
       VALUES (?,?,?,?,'completed')`,
      [user.id, `${type} report`, type, format]
    );
    return NextResponse.json({ report: rows[0] }, { status: 201 });
  } catch (e: any) {
    if (e.status === 401) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ error: 'Server error' }, { status: 500 });
  }
}
