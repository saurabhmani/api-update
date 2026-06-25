// Compliance Layer — consent, disclaimers, retention

import { DISCLAIMERS } from '@/lib/constants/disclaimer';
import { LIVE_DISCLAIMER_VERSION } from '@/lib/broker';
import type { ConsentType, SecurityStatus } from './types';
import {
  getUserConsents,
  listRetentionPolicies,
  recordConsent,
  revokeConsent,
} from './repository/securityRepository';
import { getPermissionsForRole } from './rbac';
import { countActiveSessions } from './sessionManager';
import { db } from '@/lib/db';

export const CONSENT_VERSIONS: Record<ConsentType, string> = {
  terms_of_service: '2026.1',
  privacy_policy: '2026.1',
  trading_disclaimer: '2026.1',
  live_trading_risk: LIVE_DISCLAIMER_VERSION,
  data_processing: '2026.1',
  marketing: '2026.1',
};

export const REQUIRED_CONSENTS: ConsentType[] = [
  'terms_of_service',
  'privacy_policy',
  'trading_disclaimer',
  'data_processing',
];

export function getTradingDisclaimers() {
  return {
    short: DISCLAIMERS.SHORT,
    standard: DISCLAIMERS.STANDARD,
    signalCard: DISCLAIMERS.SIGNAL_CARD,
    setupCard: DISCLAIMERS.SETUP_CARD,
    intelligencePage: DISCLAIMERS.INTELLIGENCE_PAGE,
    footer: DISCLAIMERS.FOOTER,
    optionIntel: DISCLAIMERS.OPTION_INTEL,
    liveTrading: 'Live trading involves substantial risk of loss. You may lose more than your initial investment. Only trade with capital you can afford to lose.',
    bannedPhrases: ['guaranteed profit', 'assured return', 'sure shot', 'risk free'],
  };
}

export async function acceptConsent(
  userId: number,
  consentType: ConsentType,
  ipAddress?: string,
  userAgent?: string,
): Promise<void> {
  await recordConsent({
    userId,
    consentType,
    version: CONSENT_VERSIONS[consentType],
    ipAddress,
    userAgent,
  });
}

export async function checkRequiredConsents(userId: number): Promise<{
  accepted: ConsentType[];
  pending: ConsentType[];
  allAccepted: boolean;
}> {
  const consents = await getUserConsents(userId);
  const active = new Set(
    consents.filter((c) => c.accepted && !c.revokedAt).map((c) => c.consentType),
  );
  const accepted = REQUIRED_CONSENTS.filter((t) => active.has(t));
  const pending = REQUIRED_CONSENTS.filter((t) => !active.has(t));
  return { accepted, pending, allAccepted: pending.length === 0 };
}

export async function getComplianceStatus(userId: number, role: string): Promise<SecurityStatus> {
  const { rows } = await db.query(
    `SELECT totp_enabled FROM users WHERE id = ?`,
    [userId],
  );
  const mfaEnabled = Boolean((rows[0] as any)?.totp_enabled);
  const consentCheck = await checkRequiredConsents(userId);

  return {
    mfaEnabled,
    activeSessions: await countActiveSessions(userId),
    consentsAccepted: consentCheck.accepted,
    consentsPending: consentCheck.pending,
    permissions: getPermissionsForRole(role),
    role,
  };
}

export async function getRetentionPolicies() {
  return listRetentionPolicies();
}

export { revokeConsent, getUserConsents };
