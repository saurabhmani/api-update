import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import * as riskFacade from '@risk-engine';
import * as marketFacade from '@market-data';
import { computePhase3Risk } from '@/lib/signal-engine/risk/phase3Risk';
import { evaluatePortfolioFit } from '@/lib/signal-engine/portfolio-fit/evaluatePortfolioFit';
import { evaluateExecutionReadiness } from '@/lib/signal-engine/execution/executionReadiness';
import { resolvePrice, resolveBatch } from '@/lib/marketData/resolver/marketDataResolver';
import { loadBacktestWorkerConfig, serviceMayClaimJobs } from '../../services/backtest-worker/src/config';

describe('migration safety facades', () => {
  it('delegates Risk operations to the identical legacy implementations', () => {
    expect(riskFacade.evaluateSignalRisk).toBe(computePhase3Risk);
    expect(riskFacade.evaluatePortfolioFit).toBe(evaluatePortfolioFit);
    expect(riskFacade.evaluatePreTrade).toBe(evaluateExecutionReadiness);
    expect(riskFacade.RISK_ENGINE_VERSION.failurePolicy).toBe('preserve-legacy-fail-closed-gates');
  });

  it('delegates Market Data operations to the identical active resolver', () => {
    expect(marketFacade.resolvePrice).toBe(resolvePrice);
    expect(marketFacade.getQuotes).toBe(resolveBatch);
    expect(marketFacade.MARKET_DATA_VERSION.contractVersion).toBe('1.0.0');
  });

  it('keeps Backtest Worker ownership on the monolith by default', () => {
    const config = loadBacktestWorkerConfig({} as NodeJS.ProcessEnv);
    expect(config.owner).toBe('monolith');
    expect(serviceMayClaimJobs(config)).toBe(false);
    expect(() => loadBacktestWorkerConfig({ BACKTEST_PROCESSOR_OWNER: 'both' } as unknown as NodeJS.ProcessEnv)).toThrow(/Invalid/);
  });

  it('prevents production imports that bypass selected facades', () => {
    const root = path.resolve(process.cwd(), 'src');
    const forbiddenRisk = /signal-engine\/(?:risk\/phase3Risk|portfolio-fit\/evaluatePortfolioFit|execution\/executionReadiness|risk\/stressTestEngine)/;
    const forbiddenMarket = /marketData\/resolver\/marketDataResolver/;
    const violations: string[] = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (file.includes(`${path.sep}__tests__`) || file.includes(`${path.sep}marketData`)) continue;
          visit(file);
        } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
          const relative = path.relative(root, file).split(path.sep).join('/');
          const source = fs.readFileSync(file, 'utf8');
          const riskAllowed = relative.startsWith('lib/signal-engine/') && relative !== 'lib/signal-engine/pipeline/generatePhase3Signals.ts';
          const marketAllowed = relative.startsWith('lib/signal-engine/');
          if ((!riskAllowed && forbiddenRisk.test(source)) || (!marketAllowed && forbiddenMarket.test(source))) violations.push(relative);
        }
      }
    };
    visit(root);
    expect(violations).toEqual([]);
  });
});
