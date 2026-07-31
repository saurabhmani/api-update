import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => readFileSync(file, 'utf8');

describe('high-impact API optimization contracts', () => {
  it('adds correlation and timing headers through withApiHandler', () => {
    const source = read('src/lib/apiHandler.ts');
    expect(source).toContain("'X-Request-ID'");
    expect(source).toContain("'Server-Timing'");
    expect(source).toContain('attachObservabilityHeaders(result)');
  });

  it('keeps dashboard authentication and uses user-scoped cache plus parallel I/O', () => {
    const source = read('src/app/api/dashboard/route.ts');
    expect(source).toContain('requireSession()');
    expect(source).toContain('cacheKeys.dashboardSummary(userId)');
    expect(source).toContain('Promise.allSettled([');
    expect(source).toContain('resolveUserFeedMeta(userId)');
    expect(source).toContain("'X-Cache': 'HIT'");
    expect(source).toContain('withApiHandler(async (req: NextRequest)');
  });

  it('validates rankings pagination and does not expose caught errors', () => {
    const source = read('src/app/api/rankings/route.ts');
    expect(source).toContain("code: 'INVALID_QUERY'");
    expect(source).toContain('limitRaw > 500');
    expect(source).toContain("!['NSE', 'BSE'].includes(exchangeRaw)");
    expect(source).toContain('const [result, rankingsMaxUpdatedAtResult] = await Promise.all([');
    expect(source).not.toMatch(/details:\s*err/);
    expect(source).toContain('withApiHandler(handleRankingsGet)');
  });

  it('uses the centralized ticker cache and hides internal failure details', () => {
    const source = read('src/app/api/ticker/route.ts');
    expect(source).toContain('cacheKeys.tickerStrip()');
    expect(source).toContain('cacheService.get');
    expect(source).toContain('cacheService.set');
    expect(source).not.toMatch(/details:\s*err/);
    expect(source).toContain('withApiHandler(handleTickerGet)');
  });

  it('invalidates read caches after related ranking and signal writes', () => {
    const rankings = read('src/services/rankingsService.ts');
    const signals = read('src/lib/signal-engine/repository/saveSignals.ts');
    expect(rankings).toContain("cachePattern('rankings', '*')");
    expect(rankings).toContain('cacheService.delete(cacheKeys.tickerStrip())');
    expect(signals).toContain('invalidateSignalGeneratedCaches');
  });
});
