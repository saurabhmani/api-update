#!/usr/bin/env tsx
import 'tsconfig-paths/register';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectProductionHealth } from '@/lib/operations/productionHealthCollector';
import { collectOperationalDashboard } from '@/lib/operations/operationalDashboardCollector';
import { evaluateOperationalAlerts } from '@/lib/operations/operationalAlerts';
import { validateDeployment } from '@/lib/operations/deploymentValidation';
import { validateSecurityOperations } from '@/lib/operations/securityOperations';
import { buildReleaseManifest } from '@/lib/operations/releaseGovernance';
import { buildOperationalReport, exportOperationalReportBundle } from '@/lib/operations/operationalReporting';

async function main(): Promise<void> {
  const generatedAt = new Date().toISOString();
  const health = await collectProductionHealth();
  const dashboard = await collectOperationalDashboard();
  const alerts = evaluateOperationalAlerts({ health, generatedAt });
  const deployment = validateDeployment({
    generatedAt,
    databaseConnected: health.dependencies.find((d) => d.name === 'mysql')?.status !== 'unhealthy',
    sessionSecretPresent: Boolean(process.env.SESSION_SECRET),
  });
  const security = validateSecurityOperations({ generatedAt });
  const release = buildReleaseManifest({ generatedAt, validationResult: deployment });

  const report = buildOperationalReport({
    generatedAt,
    health,
    dashboard,
    alerts,
    deployment,
    security,
    release,
  });
  const bundle = exportOperationalReportBundle(report);

  const dir = join(process.cwd(), 'reports', 'operations');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, `ops_live_${generatedAt.slice(0, 19).replace(/[:T]/g, '-')}`);
  writeFileSync(`${base}.json`, bundle.json);
  writeFileSync(`${base}.csv`, bundle.csv);
  writeFileSync(`${base}.md`, bundle.markdown);
  console.log(bundle.markdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
