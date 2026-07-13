import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, requireSession } from '@/lib/session';
import { AuthenticationError, ForbiddenError } from '@/lib/errors';
import {
  loadAutomationSettings,
  runAutomationJob,
  saveAutomationSettings,
  setSchedulerJobPaused,
} from '@/lib/strategy-hub/services/strategyOperationsService';
import { recordOpsEvent } from '@/lib/strategy-hub/repository/opsEvents';
import type { AutomationJobType } from '@/lib/strategy-hub/operations/types';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await requireSession();
    const settings = await loadAutomationSettings();
    return NextResponse.json({
      ok: true,
      settings,
      canManage: user.role === 'admin',
    });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to load automation settings' }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const settings = await saveAutomationSettings(body.settings ?? body, admin.email ?? `user:${admin.id}`);
    await recordOpsEvent({
      eventType: 'automation-settings',
      title: 'Automation settings updated',
      actor: admin.email ?? `user:${admin.id}`,
    });
    return NextResponse.json({ ok: true, settings });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: 'Failed to save settings' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const job = body.job as AutomationJobType;
    const action = String(body.action ?? 'run');

    if (action === 'pause' || action === 'resume') {
      const jobId = String(body.jobId ?? '');
      if (!jobId) {
        return NextResponse.json({ ok: false, error: 'jobId required' }, { status: 400 });
      }
      await setSchedulerJobPaused(jobId, action === 'pause');
      await recordOpsEvent({
        eventType: 'scheduler-control',
        title: `Scheduler job ${action}d`,
        description: jobId,
        actor: admin.email ?? `user:${admin.id}`,
      });
      return NextResponse.json({ ok: true, jobId, paused: action === 'pause' });
    }

    if (!job) {
      return NextResponse.json({ ok: false, error: 'job required' }, { status: 400 });
    }
    const result = await runAutomationJob(job, admin.email ?? `user:${admin.id}`);
    return NextResponse.json({ ok: result.ok, message: result.message });
  } catch (e) {
    if (e instanceof AuthenticationError) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
    }
    if (e instanceof ForbiddenError) {
      return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: 'Automation action failed' }, { status: 500 });
  }
}
