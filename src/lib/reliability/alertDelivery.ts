// Platform Reliability — alert delivery (Slack, Email, System notifications)

import { logger } from '@/lib/logger';
import type { AlertChannel, DeliveryStatus } from './types';
import { notifyAdminsSystem, recordAlertDelivery } from './repository/reliabilityRepository';

const log = logger.child({ service: 'reliability.alertDelivery' });

export interface DeliverableAlert {
  id: string;
  severity: string;
  title: string;
  detail: string;
  context?: Record<string, unknown>;
}

function channelsEnabled(): Record<AlertChannel, boolean> {
  return {
    slack: Boolean(process.env.SLACK_OPS_WEBHOOK_URL),
    email: Boolean(process.env.OPS_EMAIL_TO || process.env.RESEND_API_KEY),
    system: process.env.RELIABILITY_SYSTEM_ALERTS !== 'false',
  };
}

async function sendSlack(alert: DeliverableAlert): Promise<DeliveryStatus> {
  const url = process.env.SLACK_OPS_WEBHOOK_URL;
  if (!url) return 'skipped';

  const emoji = alert.severity === 'critical' ? ':rotating_light:' : alert.severity === 'warning' ? ':warning:' : ':information_source:';
  const body = {
    text: `${emoji} *${alert.title}* [${alert.severity.toUpperCase()}]\n${alert.detail}`,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${emoji} *${alert.title}*\n*Severity:* ${alert.severity}\n${alert.detail}`,
        },
      },
    ],
  };

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok ? 'sent' : 'failed';
  } catch (e) {
    log.warn('Slack delivery failed', { error: e instanceof Error ? e.message : String(e) });
    return 'failed';
  }
}

async function sendEmail(alert: DeliverableAlert): Promise<DeliveryStatus> {
  const recipients = (process.env.OPS_EMAIL_TO ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!recipients.length) return 'skipped';

  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.OPS_EMAIL_FROM ?? 'ops@quantorus365.com';

  if (resendKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${resendKey}`,
        },
        body: JSON.stringify({
          from,
          to: recipients,
          subject: `[${alert.severity.toUpperCase()}] ${alert.title}`,
          text: `${alert.title}\n\nSeverity: ${alert.severity}\n\n${alert.detail}`,
        }),
      });
      return res.ok ? 'sent' : 'failed';
    } catch (e) {
      log.warn('Resend email failed', { error: e instanceof Error ? e.message : String(e) });
      return 'failed';
    }
  }

  // Fallback: log-only when no provider configured
  log.info('Email alert (no provider)', { to: recipients, title: alert.title });
  return 'skipped';
}

async function sendSystemNotification(alert: DeliverableAlert): Promise<DeliveryStatus> {
  if (process.env.RELIABILITY_SYSTEM_ALERTS === 'false') return 'skipped';
  try {
    const count = await notifyAdminsSystem(alert.title, alert.detail, alert.severity);
    return count > 0 ? 'sent' : 'skipped';
  } catch {
    return 'failed';
  }
}

const CHANNEL_SENDERS: Record<AlertChannel, (a: DeliverableAlert) => Promise<DeliveryStatus>> = {
  slack: sendSlack,
  email: sendEmail,
  system: sendSystemNotification,
};

export async function deliverAlert(
  alert: DeliverableAlert,
  channels?: AlertChannel[],
): Promise<Array<{ channel: AlertChannel; status: DeliveryStatus; error?: string }>> {
  const enabled = channelsEnabled();
  const targetChannels = channels ?? (['slack', 'email', 'system'] as AlertChannel[]);
  const results: Array<{ channel: AlertChannel; status: DeliveryStatus; error?: string }> = [];

  for (const channel of targetChannels) {
    if (!enabled[channel]) {
      await recordAlertDelivery({
        alertId: alert.id,
        channel,
        severity: alert.severity,
        title: alert.title,
        status: 'skipped',
        payload: alert.context,
      });
      results.push({ channel, status: 'skipped' });
      continue;
    }

    let status: DeliveryStatus = 'failed';
    let error: string | undefined;
    try {
      status = await CHANNEL_SENDERS[channel](alert);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = 'failed';
    }

    await recordAlertDelivery({
      alertId: alert.id,
      channel,
      severity: alert.severity,
      title: alert.title,
      status,
      errorMessage: error,
      payload: alert.context,
    });
    results.push({ channel, status, error });
  }

  return results;
}

export function getAlertChannelStatus() {
  const enabled = channelsEnabled();
  return {
    slack: { enabled: enabled.slack, config: 'SLACK_OPS_WEBHOOK_URL' },
    email: { enabled: enabled.email, config: 'OPS_EMAIL_TO / RESEND_API_KEY' },
    system: { enabled: enabled.system, config: 'RELIABILITY_SYSTEM_ALERTS' },
  };
}
