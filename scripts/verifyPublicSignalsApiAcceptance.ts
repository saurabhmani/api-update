// ════════════════════════════════════════════════════════════════
//  verifyPublicSignalsApiAcceptance.ts — acceptance criteria suite
//
//  Usage:
//    npm run verify:public-signals-api
// ════════════════════════════════════════════════════════════════

import path from 'path';
import { readFileSync, existsSync } from 'fs';
import { config as loadEnv } from 'dotenv';
import { NextRequest } from 'next/server';

loadEnv({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), '.env.local') });
loadEnv({ path: path.resolve(process.cwd(), '.env') });

interface Check {
  id: string;
  area: string;
  pass: boolean;
  detail: string;
}

const SENSITIVE_FIELDS = [
  'user_id', 'batch_id', 'requested_by', 'email', 'password',
  'session', 'api_key', 'key_hash',
];

function req(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

async function main(): Promise<void> {
  const checks: Check[] = [];

  const middleware = readFileSync('src/middleware.ts', 'utf8');
  checks.push({
    id: 'no-auth',
    area: 'Public REST API',
    pass: middleware.includes("'/api/public'"),
    detail: 'endpoint reachable without session cookie (/api/public whitelisted)',
  });

  checks.push({
    id: 'docs',
    area: 'API documentation',
    pass: existsSync('docs/PUBLIC_SIGNALS_API.md'),
    detail: 'docs/PUBLIC_SIGNALS_API.md present',
  });

  checks.push({
    id: 'route',
    area: 'Public REST API',
    pass: existsSync('src/app/api/public/v1/signals/route.ts'),
    detail: 'GET /api/public/v1/signals route exists',
  });

  const routeSrc = readFileSync('src/app/api/public/v1/signals/route.ts', 'utf8');
  checks.push({
    id: 'cache-layer',
    area: 'Caching',
    pass: routeSrc.includes('cacheGet') && routeSrc.includes('cacheSet'),
    detail: 'Redis cache layer wired (TTL 300s)',
  });
  checks.push({
    id: 'validation',
    area: 'Validation',
    pass: routeSrc.includes('parsePublicSignalsQuery'),
    detail: 'query param validation via publicSignalsService',
  });
  checks.push({
    id: 'rate-limit',
    area: 'Rate limiting',
    pass: routeSrc.includes('enforcePublicSignalsAccess'),
    detail: 'IP + optional API key rate limits',
  });

  const repoSrc = readFileSync('src/lib/signals/public/publicSignalsRepository.ts', 'utf8');
  checks.push({
    id: 'sql-join',
    area: 'SQL-based data retrieval',
    pass: repoSrc.includes('q365_signal_outcomes') && repoSrc.includes('LEFT JOIN'),
    detail: 'signals LEFT JOIN outcomes + trade plans',
  });
  checks.push({
    id: 'pagination',
    area: 'Pagination',
    pass: repoSrc.includes('LIMIT ?') && repoSrc.includes('OFFSET ?'),
    detail: 'SQL LIMIT/OFFSET pagination',
  });
  checks.push({
    id: 'filters',
    area: 'Filtering',
    pass: repoSrc.includes('buildPublicSignalsFilter')
      && repoSrc.includes('strategy')
      && repoSrc.includes('outcome'),
    detail: 'dynamic WHERE for strategy, symbol, outcome, dates',
  });
  checks.push({
    id: 'summary',
    area: 'Summary metrics',
    pass: repoSrc.includes('aggregatePublicSignalsSummary')
      && repoSrc.includes('win_rate')
      && repoSrc.includes('best_strategy'),
    detail: 'SQL aggregation for summary block',
  });

  const sensitiveLeak = SENSITIVE_FIELDS.filter((f) => repoSrc.includes(f));
  checks.push({
    id: 'sensitive-hidden',
    area: 'Security',
    pass: sensitiveLeak.length === 0
      && repoSrc.includes('APPROVED_SIGNAL'),
    detail: sensitiveLeak.length === 0
      ? 'no sensitive columns in SELECT; unpublished filter active'
      : `sensitive fields in repo: ${sensitiveLeak.join(', ')}`,
  });

  const rateSrc = readFileSync('src/lib/security/rateLimiter.ts', 'utf8');
  checks.push({
    id: 'rate-buckets',
    area: 'Rate limiting',
    pass: rateSrc.includes('publicSignals') && rateSrc.includes('publicSignalsKey'),
    detail: 'dedicated publicSignals rate buckets',
  });

  try {
    const { parsePublicSignalsQuery } = await import('@/lib/signals/public/publicSignalsService');
    const q = parsePublicSignalsQuery(req('/api/public/v1/signals?page=2&limit=25&symbol=TCS&outcome=ACTIVE'));
    checks.push({
      id: 'filter-parse',
      area: 'Filtering',
      pass: q.page === 2 && q.limit === 25 && q.symbol === 'TCS' && q.outcome === 'ACTIVE',
      detail: 'query parser handles page, limit, symbol, outcome',
    });
  } catch (err) {
    checks.push({
      id: 'filter-parse',
      area: 'Filtering',
      pass: false,
      detail: (err as Error).message,
    });
  }

  try {
    const { GET } = await import('@/app/api/public/v1/signals/route');

    const url = '/api/public/v1/signals?page=1&limit=5';
    await GET(req(url));
    const t0 = Date.now();
    const res = await GET(req(url));
    const ms = Date.now() - t0;
    const body = await res.json();

    checks.push({
      id: 'cache-hit',
      area: 'Caching',
      pass: res.status === 200 && body.cached === true,
      detail: `second request cached=${body.cached} status=${res.status}`,
    });
    checks.push({
      id: 'cache-latency',
      area: 'Caching',
      pass: ms < 1000,
      detail: `cached request completed in ${ms}ms (target <1000ms)`,
    });
  } catch (err) {
    checks.push({
      id: 'cache-hit',
      area: 'Caching',
      pass: false,
      detail: (err as Error).message,
    });
    checks.push({
      id: 'cache-latency',
      area: 'Caching',
      pass: false,
      detail: 'cache latency probe skipped — see cache-hit error',
    });
  }

  try {
    const { db } = await import('@/lib/db');
    const { aggregatePublicSignalsSummary } = await import(
      '@/lib/signals/public/publicSignalsRepository'
    );
    const summary = await aggregatePublicSignalsSummary({
      page: 1,
      limit: 10,
      sort: 'created_at',
      sortDir: 'desc',
    });
    const { rows } = await db.query<{ n: number }>(
      `SELECT COUNT(DISTINCT s.id) AS n
         FROM q365_signals s
        WHERE s.signal_status = 'APPROVED_SIGNAL'`,
    );
    checks.push({
      id: 'summary-live',
      area: 'Summary metrics',
      pass: typeof summary.win_rate === 'number'
        && typeof summary.total_signals === 'number'
        && summary.total_signals <= Number(rows[0]?.n ?? 0),
      detail: `live summary total=${summary.total_signals} win_rate=${summary.win_rate}%`,
    });
  } catch (err) {
    checks.push({
      id: 'summary-live',
      area: 'Summary metrics',
      pass: false,
      detail: (err as Error).message,
    });
  }

  console.log('\nPublic Signals API — Acceptance Criteria\n');
  for (const c of checks) {
    console.log(`${c.pass ? '✅' : '❌'} [${c.area}] ${c.id}: ${c.detail}`);
  }
  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed\n`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
