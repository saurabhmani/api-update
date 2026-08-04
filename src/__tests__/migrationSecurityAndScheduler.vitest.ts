import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('migration security and scheduler characterization', () => {
  it.each([
    ['src/app/api/backtests/route.ts', 'requireSession'],
    ['src/app/api/backtests/[id]/route.ts', 'requireSession'],
    ['src/app/api/backtests/[id]/cancel/route.ts', 'requireSession'],
    ['src/app/api/backtests/process-queue/route.ts', 'requireAdmin'],
    ['src/app/api/scanner/custom-universe/run/route.ts', 'requireAdmin'],
    ['src/app/api/manipulation-engine/scan/route.ts', 'requireAdmin'],
  ])('%s has a server-side %s guard', (file, guard) => {
    const source = fs.readFileSync(file, 'utf8');
    expect(source).toContain(`import { ${guard} } from '@/lib/session'`);
    expect(source).toContain(`await ${guard}()`);
  });

  it('custom server disables duplicate in-process scheduler ownership', () => {
    const source = fs.readFileSync('server.js', 'utf8');
    expect(source).toContain("process.env.Q365_INPROC_SCHEDULER = '0'");
    expect(source).toContain("'src/lib/workers/scheduler.ts'");
  });

  it('production instrumentation does not enable development scheduler defaults', () => {
    const source = fs.readFileSync('src/instrumentation.ts', 'utf8');
    expect(source).toContain('Q365_INPROC_SCHEDULER');
    expect(source).toContain("NODE_ENV === 'production'");
  });

  it('backtest queue retains an atomic queued-only claim', () => {
    const source = fs.readFileSync('src/lib/backtesting/queue/leaseQueue.ts', 'utf8');
    expect(source).toMatch(/UPDATE backtest_runs[\s\S]+WHERE run_id\s*=\s*\?\s+AND status\s*=\s*'queued'/);
  });
});
