// ════════════════════════════════════════════════════════════════
//  Strategy Hub automation runner (Phase 6)
// ════════════════════════════════════════════════════════════════

import { db } from '@/lib/db';
import { invalidateAnalyticsCache } from '../analytics/analyticsCache';
import { loadAutomationSettings } from '../repository/automationSettings';
import { recordOpsEvent } from '../repository/opsEvents';
import { generateAlertsFromHealth, loadAlertsWithNames } from './alertEngine';
import { loadStrategyHealthSnapshots } from './healthMonitor';
import type { AutomationJobType } from './types';

async function logJobRun(jobName: string, status: 'success' | 'failed', durationMs: number, detail?: string) {
  try {
    await db.query(
      `INSERT INTO q365_learning_job_runs (job_name, status, duration_ms, detail)
       VALUES (?, ?, ?, ?)`,
      [jobName, status, durationMs, detail ?? null],
    );
  } catch {
    // learning job table may use different column shape — non-fatal
    try {
      await db.query(
        `INSERT INTO q365_learning_job_runs (job_name, status, duration_ms)
         VALUES (?, ?, ?)`,
        [jobName, status, durationMs],
      );
    } catch { /* ignore */ }
  }
}

export async function runAutomationJob(
  job: AutomationJobType,
  actor = 'system',
): Promise<{ ok: boolean; message: string }> {
  const started = Date.now();
  const settings = await loadAutomationSettings();

  try {
    switch (job) {
      case 'health_check': {
        if (!settings.automaticHealthChecks) {
          return { ok: false, message: 'Automatic health checks are disabled.' };
        }
        const snapshots = await loadStrategyHealthSnapshots();
        await generateAlertsFromHealth(snapshots);
        await recordOpsEvent({
          eventType: 'hub-health-check',
          title: 'Health check completed',
          description: `Evaluated ${snapshots.length} strategies.`,
          actor,
        });
        break;
      }
      case 'daily_validation': {
        if (!settings.scheduledDailyValidation) {
          return { ok: false, message: 'Scheduled daily validation is disabled.' };
        }
        await recordOpsEvent({
          eventType: 'hub-daily-validation',
          title: 'Daily validation sweep scheduled',
          description: 'Use admin manual validation per strategy or enable auto worker.',
          actor,
        });
        break;
      }
      case 'cache_refresh': {
        if (!settings.automaticCacheRefresh) {
          return { ok: false, message: 'Automatic cache refresh is disabled.' };
        }
        invalidateAnalyticsCache();
        const { invalidateOpsCache } = await import('./opsCache');
        invalidateOpsCache();
        await recordOpsEvent({
          eventType: 'hub-cache-refresh',
          title: 'Operational caches refreshed',
          actor,
        });
        break;
      }
      case 'performance_recalc': {
        if (!settings.scheduledPerformanceRecalc) {
          return { ok: false, message: 'Performance recalculation is disabled.' };
        }
        const { loadStrategyRankings } = await import('../services/strategyAnalyticsService');
        await loadStrategyRankings({ skipCache: true });
        await recordOpsEvent({
          eventType: 'hub-performance-recalc',
          title: 'Performance rankings recalculated',
          actor,
        });
        break;
      }
      case 'ranking_refresh': {
        if (!settings.automaticRankingRefresh) {
          return { ok: false, message: 'Ranking refresh is disabled.' };
        }
        const { loadStrategyRankings } = await import('../services/strategyAnalyticsService');
        await loadStrategyRankings({ skipCache: true });
        break;
      }
      case 'learning_refresh': {
        if (!settings.automaticLearningRefresh) {
          return { ok: false, message: 'Learning refresh is disabled.' };
        }
        await recordOpsEvent({
          eventType: 'hub-learning-refresh',
          title: 'Learning refresh triggered',
          description: 'Invoke GET /api/strategies/learning to persist observations.',
          actor,
        });
        break;
      }
      case 'ai_daily_review': {
        if (!settings.scheduledDailyAiReview) {
          return { ok: false, message: 'Daily AI review is disabled.' };
        }
        const { runScheduledAiAnalysis } = await import('../services/strategyAiService');
        const aiResult = await runScheduledAiAnalysis('daily_review', actor);
        if (!aiResult.ok) throw new Error(aiResult.message);
        break;
      }
      case 'ai_weekly_optimization': {
        if (!settings.scheduledWeeklyOptimizationReport) {
          return { ok: false, message: 'Weekly AI optimization report is disabled.' };
        }
        const { runScheduledAiAnalysis } = await import('../services/strategyAiService');
        const aiResult = await runScheduledAiAnalysis('weekly_optimization', actor);
        if (!aiResult.ok) throw new Error(aiResult.message);
        break;
      }
      case 'ai_monthly_executive': {
        if (!settings.scheduledMonthlyExecutiveSummary) {
          return { ok: false, message: 'Monthly executive summary is disabled.' };
        }
        const { runScheduledAiAnalysis } = await import('../services/strategyAiService');
        const aiResult = await runScheduledAiAnalysis('monthly_executive', actor);
        if (!aiResult.ok) throw new Error(aiResult.message);
        break;
      }
      case 'ai_anomaly_detection': {
        if (!settings.automaticAnomalyDetection) {
          return { ok: false, message: 'Automatic anomaly detection is disabled.' };
        }
        const { runScheduledAiAnalysis } = await import('../services/strategyAiService');
        const aiResult = await runScheduledAiAnalysis('anomaly_detection', actor);
        if (!aiResult.ok) throw new Error(aiResult.message);
        break;
      }
      case 'ai_recommendation_refresh': {
        if (!settings.automaticRecommendationRefresh) {
          return { ok: false, message: 'Automatic recommendation refresh is disabled.' };
        }
        const { runScheduledAiAnalysis } = await import('../services/strategyAiService');
        const aiResult = await runScheduledAiAnalysis('recommendation_refresh', actor);
        if (!aiResult.ok) throw new Error(aiResult.message);
        break;
      }
      default:
        return { ok: false, message: 'Unknown automation job.' };
    }

    await logJobRun(`hub-${job.replace('_', '-')}`, 'success', Date.now() - started);
    return { ok: true, message: `${job} completed.` };
  } catch (err) {
    await logJobRun(`hub-${job.replace('_', '-')}`, 'failed', Date.now() - started, String(err));
    return { ok: false, message: err instanceof Error ? err.message : 'Job failed.' };
  }
}

export async function runEnabledAutomations(actor = 'scheduler'): Promise<void> {
  const settings = await loadAutomationSettings();
  const jobs: AutomationJobType[] = [];
  if (settings.automaticHealthChecks) jobs.push('health_check');
  if (settings.scheduledDailyValidation) jobs.push('daily_validation');
  if (settings.automaticCacheRefresh) jobs.push('cache_refresh');
  if (settings.scheduledPerformanceRecalc) jobs.push('performance_recalc');
  if (settings.automaticRankingRefresh) jobs.push('ranking_refresh');
  if (settings.automaticLearningRefresh) jobs.push('learning_refresh');
  if (settings.scheduledDailyAiReview) jobs.push('ai_daily_review');
  if (settings.automaticAnomalyDetection) jobs.push('ai_anomaly_detection');
  if (settings.automaticRecommendationRefresh) jobs.push('ai_recommendation_refresh');
  for (const job of jobs) {
    await runAutomationJob(job, actor);
  }
}

export { loadAlertsWithNames };
