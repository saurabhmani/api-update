// ════════════════════════════════════════════════════════════════
//  GET /api/engine-debug/log — Public engine debug log reader
//
//  No authentication required. Returns the contents of
//  src/app/engine-debug.log (ENGINE_DEBUG diagnostic lines only).
//
//  Query params:
//    ?format=text|json   — default json
//    ?lines=N            — last N lines (1–5000)
//    ?maxBytes=N         — cap read size (1 KiB–2 MiB, default 512 KiB)
//
//  Examples:
//    GET /api/engine-debug/log
//    GET /api/engine-debug/log?format=text&lines=200
// ════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server';
import { readEngineDebugLog } from '@/lib/engineDebug/engineDebugger';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

const NO_STORE = { 'Cache-Control': 'no-store, no-cache, must-revalidate' };

export async function GET(req: NextRequest): Promise<NextResponse> {
  const generatedAt = new Date().toISOString();
  const sp = req.nextUrl.searchParams;

  const format = (sp.get('format') ?? 'json').trim().toLowerCase();
  const linesRaw = sp.get('lines');
  const maxBytesRaw = sp.get('maxBytes');

  const lines = linesRaw != null && linesRaw !== ''
    ? Math.max(1, Math.min(5_000, Number(linesRaw) || 200))
    : undefined;
  const maxBytes = maxBytesRaw != null && maxBytesRaw !== ''
    ? Math.max(1_024, Math.min(2 * 1024 * 1024, Number(maxBytesRaw) || 512 * 1024))
    : undefined;

  try {
    const result = readEngineDebugLog({ lines, maxBytes });

    if (format === 'text' || format === 'plain') {
      return new NextResponse(result.content || '', {
        status: 200,
        headers: {
          ...NO_STORE,
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Engine-Debug-Exists': result.exists ? '1' : '0',
          'X-Engine-Debug-Truncated': result.truncated ? '1' : '0',
          'X-Engine-Debug-Lines': String(result.lineCount),
          'X-Engine-Debug-Size-Bytes': String(result.sizeBytes),
        },
      });
    }

    return NextResponse.json(
      {
        ok: true,
        generatedAt,
        path: 'src/app/engine-debug.log',
        exists: result.exists,
        truncated: result.truncated,
        sizeBytes: result.sizeBytes,
        lineCount: result.lineCount,
        content: result.content,
      },
      { status: 200, headers: NO_STORE },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to read engine debug log';
    return NextResponse.json(
      {
        ok: false,
        generatedAt,
        path: 'src/app/engine-debug.log',
        exists: false,
        truncated: false,
        sizeBytes: 0,
        lineCount: 0,
        content: '',
        error: message,
      },
      { status: 500, headers: NO_STORE },
    );
  }
}
