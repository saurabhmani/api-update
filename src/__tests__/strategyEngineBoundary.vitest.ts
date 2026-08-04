import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  STRATEGY_ENGINE_VERSION,
  STRATEGY_REGISTRY,
  buildTradePlanForStrategy,
  evaluateStrategyRegimeEligibility,
  resolveConflicts,
  runAllStrategies,
} from '@strategy-engine';

describe('Strategy Engine public boundary', () => {
  it('exposes the versioned evaluation, conflict, scoring/plan, and registry surface', () => {
    expect(STRATEGY_ENGINE_VERSION).toEqual({
      contractVersion: '1.0.0',
      implementation: 'quantorus365-monolith',
    });
    expect(runAllStrategies).toBeTypeOf('function');
    expect(resolveConflicts).toBeTypeOf('function');
    expect(buildTradePlanForStrategy).toBeTypeOf('function');
    expect(evaluateStrategyRegimeEligibility).toBeTypeOf('function');
    expect(Object.keys(STRATEGY_REGISTRY).length).toBeGreaterThan(10);
  });

  it('prevents production consumers from importing Strategy Engine internals', () => {
    const root = path.resolve(process.cwd(), 'src');
    const forbidden = /signal-engine\/(?:strategy-engine|strategies\/strategyRegistry|scoring\/strategyScorers|trade-plan\/buildTradePlan)/;
    const violations: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (file.includes(`${path.sep}signal-engine`) || file.includes(`${path.sep}__tests__`)) continue;
          visit(file);
        } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
          if (forbidden.test(fs.readFileSync(file, 'utf8'))) {
            violations.push(path.relative(process.cwd(), file));
          }
        }
      }
    };
    visit(root);
    expect(violations).toEqual([]);
  });
});
