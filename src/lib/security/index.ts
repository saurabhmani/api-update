export type {
  Role, Permission, ConsentType, UserConsent,
  SecurityAuditEntry, SessionInfo, RetentionPolicy, SecurityStatus,
} from './types';

export {
  getPermissionsForRole, getPermissionsForRoleAsync,
  hasPermission, hasPermissionAsync, requirePermission, isAdmin, getRbacMatrix,
} from './rbac';

export {
  listUserSessions, revokeSession, revokeAllSessions,
  enforceSessionLimit, countActiveSessions,
} from './sessionManager';

export { setSecret, getSecret, rotateSecret, validateEncryptionAvailable } from './secretManager';

export { checkRateLimit, enforceRateLimit, RATE_LIMITS } from './rateLimiter';

export {
  CONSENT_VERSIONS, REQUIRED_CONSENTS, getTradingDisclaimers,
  acceptConsent, checkRequiredConsents, getComplianceStatus,
  getRetentionPolicies, revokeConsent, getUserConsents,
} from './compliance';

export { validateEmail, validatePassword, sanitizeString, validateTotpToken, validateConsentType } from './validation';
export { toClientError } from './secureErrors';
export { logSecurityEvent, getSecurityAuditLog } from './audit';
export { handleMfaGet, handleMfaPost } from './mfaService';
export {
  listSecurityEvents, listConsentLogs, listRoles, listPermissions,
  assignUserRole, getPermissionsForRoleFromDb,
} from './repository/securityRepository';
