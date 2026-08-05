/**
 * Broker browser-token security — OAuth retired; tokens must not appear in client bundles.
 * Retained as a lightweight guard that kiteconnect secrets are not in public paths.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

describe('broker token browser security (post-migration)', () => {
  it('data-source page does not embed Kite API secrets', () => {
    const p = join(process.cwd(), 'src/app/data-source/page.tsx');
    expect(existsSync(p)).toBe(true);
    const src = readFileSync(p, 'utf8');
    expect(src).not.toMatch(/KITE_API_SECRET/);
    expect(src).not.toMatch(/access_token\s*=/);
    expect(src.toLowerCase()).toContain('indianapi');
  });
});
