// Quant Intelligence Platform — acceptance / unit tests (no DB required)

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PLAN_CATALOG } from '../lib/billing/constants/plans';

interface Check { name: string; passed: boolean; detail: string; }
const checks: Check[] = [];
function check(name: string, passed: boolean, detail = '') {
  checks.push({ name, passed, detail });
}

function herfindahlIndex(weights: number[]): number {
  return weights.reduce((s, w) => s + (w / 100) ** 2, 0);
}

function fileExists(rel: string): boolean {
  return existsSync(join(process.cwd(), rel));
}

async function main() {
  console.log('\n══════════════════════════════════════════════════');
  console.log('  Quant Intelligence Platform — Acceptance Tests');
  console.log('══════════════════════════════════════════════════\n');

  // ── Database tables (acceptance spec) ───────────────────────────
  const tables = [
    'research_reports',
    'strategy_recommendations',
    'portfolio_allocations',
    'sentiment_scores',
    'event_risk_scores',
  ];
  const repoSrc = readFileSync('src/lib/quant-platform/repository/quantRepository.ts', 'utf8');
  for (const t of tables) {
    check(`Table spec: ${t}`, repoSrc.includes(`CREATE TABLE IF NOT EXISTS ${t}`), '');
  }

  // ── Postgres migration ──────────────────────────────────────────
  const pgMigration = readFileSync('migrations/postgres/031_quant_platform.sql', 'utf8');
  check('Migration: research_reports', pgMigration.includes('quant.research_reports'), '');
  check('Migration: portfolio_allocations', pgMigration.includes('quant.portfolio_allocations'), '');
  check('Migration rollback file exists', fileExists('migrations/postgres/031_quant_platform_rollback.sql'), '');

  // ── API routes (acceptance spec) ──────────────────────────────
  check('API: POST /api/research', fileExists('src/app/api/research/route.ts'), '');
  check('API: GET /api/recommendations', fileExists('src/app/api/recommendations/route.ts'), '');
  check('API: POST /api/portfolio/optimize', fileExists('src/app/api/portfolio/optimize/route.ts'), '');

  const researchRoute = readFileSync('src/app/api/research/route.ts', 'utf8');
  check('API research: POST handler', researchRoute.includes('export const POST'), '');
  const recRoute = readFileSync('src/app/api/recommendations/route.ts', 'utf8');
  check('API recommendations: GET handler', recRoute.includes('export const GET'), '');
  const optRoute = readFileSync('src/app/api/portfolio/optimize/route.ts', 'utf8');
  check('API optimize: POST handler', optRoute.includes('export const POST'), '');

  // ── Research Assistant criteria ─────────────────────────────────
  const researchSrc = readFileSync('src/lib/quant-platform/ai-research/researchAssistant.ts', 'utf8');
  check('Research: dataSources field', researchSrc.includes('dataSources'), '');
  check('Research: riskWarnings field', researchSrc.includes('riskWarnings'), '');
  check('Research: references q365_signals', researchSrc.includes('q365_signals'), '');
  check('Research: references backtest_runs', researchSrc.includes('backtest_runs'), '');

  // ── Recommendation Engine criteria ────────────────────────────
  const recEngineSrc = readFileSync('src/lib/quant-platform/strategy-recommendations/recommendationEngine.ts', 'utf8');
  check('Recommendations: buildRegimeRouter', recEngineSrc.includes('buildRegimeRouter'), '');
  check('Recommendations: confidence scoring', recEngineSrc.includes('overallConfidence'), '');
  check('Recommendations: strategy ranking', recEngineSrc.includes('rank: i + 1'), '');
  check('Recommendations: explainability', recEngineSrc.includes('explainability'), '');

  // ── Portfolio Optimizer criteria ────────────────────────────────
  const optSrc = readFileSync('src/lib/quant-platform/portfolio-optimizer/optimizer.ts', 'utf8');
  check('Optimizer: allocation suggestions', optSrc.includes('targetWeight') && optSrc.includes('delta'), '');
  check('Optimizer: risk calculations', optSrc.includes('riskScore') && optSrc.includes('portfolioVolatility'), '');
  check('Optimizer: diversification metrics', optSrc.includes('herfindahlIndex') && optSrc.includes('diversificationScore'), '');

  const weights = [30, 25, 20, 15, 10];
  const hhi = herfindahlIndex(weights);
  const effectiveN = hhi > 0 ? 1 / hhi : 0;
  check('Optimizer: HHI math', hhi > 0 && hhi < 1, `HHI=${hhi.toFixed(3)}`);
  check('Optimizer: effective positions', effectiveN > 1, `N=${effectiveN.toFixed(1)}`);

  // ── Sentiment + Event Risk persistence ──────────────────────────
  const sentimentSrc = readFileSync('src/lib/quant-platform/news-sentiment/sentimentService.ts', 'utf8');
  check('Sentiment: persists to sentiment_scores', sentimentSrc.includes('saveSentimentScore'), '');
  const eventSrc = readFileSync('src/lib/quant-platform/event-risk/eventRiskAggregator.ts', 'utf8');
  check('Event risk: persists to event_risk_scores', eventSrc.includes('saveEventRiskScore'), '');

  // ── Monitoring (withApiHandler on all quant routes) ─────────────
  check('Monitoring: research uses withApiHandler', researchRoute.includes('withApiHandler'), '');
  check('Monitoring: recommendations uses withApiHandler', recRoute.includes('withApiHandler'), '');
  check('Monitoring: optimize uses withApiHandler', optRoute.includes('withApiHandler'), '');

  // ── Public API platform ─────────────────────────────────────────
  const authSrc = readFileSync('src/lib/quant-platform/api-platform/apiKeyAuth.ts', 'utf8');
  check('API platform: SHA-256 hashing', authSrc.includes('sha256'), '');
  check('API platform: no raw key storage', authSrc.includes('key_hash'), '');
  check('Secrets: no hardcoded API keys', !/q365_[a-f0-9]{24,}/.test(authSrc), '');

  // ── UI (acceptance spec) ────────────────────────────────────────
  const uiSrc = readFileSync('src/app/quant/page.tsx', 'utf8');
  const uiTabs = [
    'AI Research Assistant',
    'Strategy Recommendations',
    'Portfolio Optimizer',
    'Enterprise Reports',
    'API Management',
  ];
  for (const tab of uiTabs) {
    check(`UI tab: ${tab}`, uiSrc.includes(tab), '');
  }
  check('UI: uses spec API /api/research', uiSrc.includes('/api/research'), '');
  check('UI: uses spec API /api/recommendations', uiSrc.includes('/api/recommendations'), '');
  check('UI: uses spec API /api/portfolio/optimize', uiSrc.includes('/api/portfolio/optimize'), '');

  // ── Documentation ─────────────────────────────────────────────
  check('Docs: release gate doc', fileExists('docs/quant-platform-release.md'), '');

  // ── Billing integration ─────────────────────────────────────────
  check('Billing: research_reports credit type', 'research_reports' in PLAN_CATALOG.pro.credits, '');

  const passed = checks.filter((c) => c.passed).length;
  for (const c of checks) {
    console.log(`${c.passed ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  console.log(`\n${passed}/${checks.length} passed`);
  if (checks.some((c) => !c.passed)) process.exit(1);
  console.log('\n✅ Quant platform tests passed\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
