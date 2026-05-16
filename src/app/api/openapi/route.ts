/**
 * GET /api/openapi
 *
 * Auto-generated OpenAPI 3.0 spec for every route.ts under src/app/api.
 * Walks the filesystem, detects exported HTTP verbs, converts the dynamic
 * segment syntax to OpenAPI path templates, and harvests query params
 * from `searchParams.get('…')` calls plus a leading JSDoc block (used as
 * the operation summary/description).
 *
 * No per-route annotation work is needed — every route shows up the
 * moment its file lands. Authors who want richer schemas can drop a
 * leading JSDoc above the handler; this generator picks it up verbatim.
 */
import { NextResponse }   from 'next/server';
import { requireAdmin }   from '@/lib/session';
import fs                 from 'node:fs/promises';
import path               from 'node:path';

export const dynamic    = 'force-dynamic';
export const revalidate = 0;

type HttpVerb = 'get' | 'post' | 'put' | 'patch' | 'delete' | 'head' | 'options';
const HTTP_VERBS: readonly HttpVerb[] = ['get','post','put','patch','delete','head','options'];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory())                                 out.push(...await walk(full));
    else if (/^route\.(ts|tsx|js|mjs)$/.test(e.name))    out.push(full);
  }
  return out;
}

/** Convert a Next.js App-Router file path to an OpenAPI path string.
 *  - `[id]`    → `{id}`
 *  - `[...x]`  → `{x}`
 *  - `[[...x]]`→ `{x}` */
function fileToApiPath(file: string, apiRoot: string): string {
  const rel = path.relative(apiRoot, file).replace(/\\/g, '/');
  const noFile = rel.replace(/\/route\.(ts|tsx|js|mjs)$/, '');
  const segs = noFile.split('/').filter(Boolean).map(seg => {
    let m = seg.match(/^\[\[\.\.\.(.+)\]\]$/); if (m) return `{${m[1]}}`;
    m     = seg.match(/^\[\.\.\.(.+)\]$/);     if (m) return `{${m[1]}}`;
    m     = seg.match(/^\[(.+)\]$/);           if (m) return `{${m[1]}}`;
    return seg;
  });
  return '/api' + (segs.length ? '/' + segs.join('/') : '');
}

function detectVerbs(src: string): HttpVerb[] {
  const found = new Set<HttpVerb>();
  const reFn  = /^\s*export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/gm;
  const reLet = /^\s*export\s+(?:const|let|var)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*[=:]/gm;
  let m: RegExpExecArray | null;
  while ((m = reFn.exec(src)))  found.add(m[1].toLowerCase() as HttpVerb);
  while ((m = reLet.exec(src))) found.add(m[1].toLowerCase() as HttpVerb);
  return HTTP_VERBS.filter(v => found.has(v));
}

function detectQueryParams(src: string): string[] {
  const found = new Set<string>();
  const re = /searchParams\.get\(\s*['"`]([^'"`]+)['"`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) found.add(m[1]);
  return [...found].sort();
}

function detectLeadingJsDoc(src: string): string | null {
  const m = src.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (!m) return null;
  const cleaned = m[1]
    .split('\n')
    .map(l => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
  return cleaned || null;
}

/** Group routes by their first path segment after /api ─
 *  e.g. /api/signals/[id] → tag "signals". */
function tagFor(apiPath: string): string {
  const parts = apiPath.split('/').filter(Boolean);
  return parts[1] ?? 'root';
}

export async function GET() {
  if (process.env.NODE_ENV === 'production') {
    try { await requireAdmin(); }
    catch { return NextResponse.json({ error: 'Unauthorized' }, { status: 401 }); }
  }

  const apiRoot = path.join(process.cwd(), 'src', 'app', 'api');
  const files   = (await walk(apiRoot)).sort();

  const paths: Record<string, Record<string, unknown>> = {};
  const tagSet = new Set<string>();

  for (const file of files) {
    const apiPath = fileToApiPath(file, apiRoot);
    const src     = await fs.readFile(file, 'utf8');
    const verbs   = detectVerbs(src);
    if (!verbs.length) continue;

    const docBlock   = detectLeadingJsDoc(src);
    const summary    = docBlock ? docBlock.split('\n')[0].slice(0, 120) : `${verbs[0].toUpperCase()} ${apiPath}`;
    const queryParams = detectQueryParams(src);
    const pathParams  = [...apiPath.matchAll(/\{([^}]+)\}/g)].map(m => m[1]);
    const tag         = tagFor(apiPath);
    tagSet.add(tag);

    const ops: Record<string, unknown> = {};
    for (const verb of verbs) {
      const op: Record<string, unknown> = {
        tags: [tag],
        summary,
        operationId: `${verb}_${apiPath.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '')}`,
        parameters: [
          ...pathParams.map(name => ({
            name, in: 'path', required: true, schema: { type: 'string' },
          })),
          ...queryParams.map(name => ({
            name, in: 'query', required: false, schema: { type: 'string' },
          })),
        ],
        responses: {
          '200': { description: 'OK' },
          '401': { description: 'Unauthorized' },
          '500': { description: 'Server error' },
        },
      };
      if (docBlock)                                         op.description = docBlock;
      if (['post','put','patch'].includes(verb)) {
        op.requestBody = {
          required: false,
          content: { 'application/json': { schema: { type: 'object', additionalProperties: true } } },
        };
      }
      ops[verb] = op;
    }
    paths[apiPath] = { ...(paths[apiPath] ?? {}), ...ops };
  }

  const spec = {
    openapi: '3.0.3',
    info: {
      title:       'Quantorus365 API',
      version:     '2.1.0',
      description: 'Auto-generated from src/app/api/**/route.ts. Most endpoints require the `q200_session` cookie (set on login).',
    },
    servers: [{ url: '/' }],
    tags: [...tagSet].sort().map(name => ({ name })),
    components: {
      securitySchemes: {
        sessionCookie: { type: 'apiKey', in: 'cookie', name: 'q200_session' },
      },
    },
    security: [{ sessionCookie: [] }],
    paths,
  };

  return NextResponse.json(spec, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
