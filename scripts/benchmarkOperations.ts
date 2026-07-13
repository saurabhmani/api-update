#!/usr/bin/env tsx
import 'tsconfig-paths/register';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProductionHealthSummary } from '@/lib/operations/productionHealthService';
import { evaluateOperationalAlerts } from '@/lib/operations/operationalAlerts';
import { validateDeployment } from '@/lib/operations/deploymentValidation';
import { validateSecurityOperations } from '@/lib/operations/securityOperations';
import { buildReleaseManifest } from '@/lib/operations/releaseGovernance';
import { buildOperationalReport, exportOperationalReportBundle } from '@/lib/operations/operationalReporting';

function main(): void {
  const generatedAt = new Date().toISOString();
  const health = buildProductionHealthSummary({
    generatedAt,
    marketData: { latencyMs: 12, lastCandleAt: generatedAt, candleCount: 1000, status: 'healthy' },
    scheduler: { jobs: [{ name: 'test', status: 'success', durationMs: 100, runAt: generatedAt }], status: 'healthy' },
    database: { latencyMs: 5, status: 'healthy' },
  });
  const alerts = evaluateOperationalAlerts({ health, generatedAt });
  const deployment = validateDeployment({ generatedAt, databaseConnected: true, sessionSecretPresent: true });
  const security = validateSecurityOperations({ generatedAt, env: { SESSION_SECRET: 'x'.repeat(32) } });
  const release = buildReleaseManifest({ generatedAt, validationResult: deployment });

  const report = buildOperationalReport({
    generatedAt,
    health,
    alerts,
    deployment,
    security,
    release,
  });
  const bundle = exportOperationalReportBundle(report);

  const dir = join(process.cwd(), 'reports', 'operations');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `ops_${generatedAt.slice(0, 10)}`);
  writeFileSync(`${base}.json`, bundle.json);
  writeFileSync(`${base}.csv`, bundle.csv);
  writeFileSync(`${base}.md`, bundle.markdown);

  console.log(JSON.stringify({
    benchmark: 'operations',
    overallStatus: health.overallStatus,
    alertCount: alerts.length,
    deploymentPassed: deployment.passed,
    securityPassed: security.passed,
    reportPath: base,
  }, null, 2));
}

main();
