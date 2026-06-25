/**
 * Browser UI contracts — manipulation health (no Playwright).
 *
 * Static source checks + shared HTTP validator module shape.
 * Runtime HTTP validation: npm run test:ui-manipulation
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe('manipulation health — browser UI contracts (no third-party browser)', () => {
  it('engine-health page fetches /api/signals/engine-health (not fabricated)', () => {
    const page = read('src/app/signals/engine-health/page.tsx');
    expect(page).toMatch(/fetch\(['"]\/api\/signals\/engine-health['"]/);
    expect(page).toMatch(/Manipulation Risk Engine|manipulation/);
    expect(page).toMatch(/NOT CONFIGURED|INSUFFICIENT DATA/);
    expect(page).not.toMatch(/status:\s*['"]HEALTHY['"]\s*,\s*\/\/\s*hardcoded/i);
  });

  it('engine-health page maps manipulation node id and renders status from API', () => {
    const page = read('src/app/signals/engine-health/page.tsx');
    expect(page).toMatch(/node\.id === ['"]manipulation['"]/);
    expect(page).toMatch(/function StatusBadge/);
    expect(page).toMatch(/STATUS_PALETTE\[status\]/);
    expect(page).toMatch(/<StatusBadge status=\{node\.status\}/);
  });

  it('signals page renders manipulationRisk badge from wire envelope', () => {
    const page = read('src/app/signals/page.tsx');
    expect(page).toMatch(/manipulationRisk/);
    expect(page).toMatch(/manipulationBadgeLabel/);
    expect(page).toMatch(/ManipulationDetailBlock/);
  });

  it('HTTP validator script exists and uses fetch only (no browser driver imports)', () => {
    const script = read('scripts/uiValidateManipulationHealthHttp.mjs');
    expect(script).toMatch(/\/api\/signals\/engine-health/);
    expect(script).toMatch(/manipulationRiskMeta/);
    expect(script).toMatch(/await fetch\(/);
    expect(script).not.toMatch(/from ['"]playwright['"]|from ['"]puppeteer['"]/);
  });
});
