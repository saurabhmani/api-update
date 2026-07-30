import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const canonical = readFileSync('src/lib/db/migrateCanonical.ts', 'utf8');
const queryProvider = readFileSync('src/providers/QueryProvider.tsx', 'utf8');
const dashboard = readFileSync('src/app/dashboard/page.tsx', 'utf8');
const tradeSetup = readFileSync('src/app/trade-setups/page.tsx', 'utf8');

describe('database and client request optimization contracts', () => {
  it('checks ordered index columns before canonical MySQL DDL', () => {
    expect(canonical).toContain('INFORMATION_SCHEMA.STATISTICS');
    expect(canonical).toContain('GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX)');
    expect(canonical).toContain('idx_sessions_user_expires');
    expect(canonical).toContain('idx_pp_portfolio_added');
    expect(canonical).toContain('idx_ts_user_status_created');
    expect(canonical).toContain('idx_news_published_category_date');
    expect(canonical).toContain('idx_paper_orders_account_created');
    expect(canonical).not.toContain('postgres');
  });

  it('does not globally make real-time data long-lived', () => {
    expect(queryProvider).toContain('staleTime: 30_000');
    expect(queryProvider).toContain('gcTime: 5 * 60_000');
    expect(queryProvider).toContain('refetchOnWindowFocus: false');
  });

  it('cancels obsolete dashboard requests and preserves identical URLs', () => {
    expect(dashboard).toContain('requestControllerRef.current?.abort()');
    expect(dashboard).toContain("fetch('/api/dashboard'");
    expect(dashboard).not.toContain('/api/dashboard?_=');
  });

  it('does not poll trade setup generation in hidden tabs', () => {
    expect(tradeSetup).toContain("document.visibilityState === 'visible'");
    expect(tradeSetup).toContain('signal,');
  });
});
