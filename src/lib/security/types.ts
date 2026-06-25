// Security & Compliance — shared types

export type Role = 'user' | 'admin' | 'trader' | 'analyst';

export type Permission =
  | 'signals:read'
  | 'signals:write'
  | 'portfolio:read'
  | 'portfolio:write'
  | 'trading:paper'
  | 'trading:live'
  | 'admin:users'
  | 'admin:audit'
  | 'admin:pipeline'
  | 'admin:security'
  | 'billing:read'
  | 'billing:write'
  | 'compliance:consent'
  | '*';

export type ConsentType =
  | 'terms_of_service'
  | 'privacy_policy'
  | 'trading_disclaimer'
  | 'live_trading_risk'
  | 'data_processing'
  | 'marketing';

export interface UserConsent {
  id: number;
  userId: number;
  consentType: ConsentType;
  version: string;
  accepted: boolean;
  ipAddress: string | null;
  acceptedAt: string;
  revokedAt: string | null;
}

export interface SecurityAuditEntry {
  id: number;
  userId: number | null;
  actorEmail: string | null;
  eventType: string;
  action: string;
  resource: string | null;
  detail: Record<string, unknown>;
  ipAddress: string | null;
  createdAt: string;
}

export interface SessionInfo {
  id: number;
  device: string | null;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface RetentionPolicy {
  dataCategory: string;
  retentionDays: number;
  description: string | null;
  active: boolean;
}

export interface SecurityStatus {
  mfaEnabled: boolean;
  activeSessions: number;
  consentsAccepted: string[];
  consentsPending: string[];
  permissions: Permission[];
  role: string;
}
