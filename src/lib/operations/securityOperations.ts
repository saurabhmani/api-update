// ════════════════════════════════════════════════════════════════
//  Phase 5 — Security Operations
// ════════════════════════════════════════════════════════════════

import type { SecurityValidationResult } from './types';
import { getSignalEngineConfig } from '@/lib/signal-engine/config/signalEnginePhase2Config';
import { getActivePromotedParameter } from '@/lib/signal-engine/adaptive/adaptiveParameterStore';
import { verifyAdaptiveParameterRecord } from '@/lib/signal-engine/adaptive/adaptiveParameterStore';
import { getAdaptiveAuditTrail } from '@/lib/signal-engine/adaptive/learningAudit';

const REQUIRED_SECRETS = [
  'SESSION_SECRET',
] as const;

const OPTIONAL_PROVIDER_SECRETS = [
  'DATABASE_URL',
  'REDIS_URL',
  'INDIANAPI_KEY',
] as const;

export interface SecurityCheckInput {
  generatedAt: string;
  env?: Record<string, string | undefined>;
  adminRoleVerified?: boolean;
}

export function validateSecurityOperations(input: SecurityCheckInput): SecurityValidationResult {
  const env = input.env ?? process.env;
  const checks: SecurityValidationResult['checks'] = [];

  for (const key of REQUIRED_SECRETS) {
    const value = env[key];
    checks.push({
      name: `secret_${key.toLowerCase()}`,
      passed: Boolean(value && value.length >= 16),
      severity: 'critical',
      message: value ? `${key} present` : `${key} missing or too short`,
    });
  }

  for (const key of OPTIONAL_PROVIDER_SECRETS) {
    const value = env[key];
    if (!value) {
      checks.push({
        name: `credential_${key.toLowerCase()}`,
        passed: true,
        severity: 'info',
        message: `${key} not configured (optional)`,
      });
    } else if (value.includes('changeme') || value.includes('placeholder')) {
      checks.push({
        name: `credential_${key.toLowerCase()}`,
        passed: false,
        severity: 'critical',
        message: `${key} appears to be a placeholder`,
      });
    } else {
      checks.push({
        name: `credential_${key.toLowerCase()}`,
        passed: true,
        severity: 'info',
        message: `${key} configured`,
      });
    }
  }

  const config = getSignalEngineConfig();
  checks.push({
    name: 'configuration_integrity',
    passed: Boolean(config.configVersionLabel) && config.version >= 1,
    severity: 'warning',
    message: `Configuration ${config.configVersionLabel}`,
  });

  const active = getActivePromotedParameter();
  if (active) {
    checks.push({
      name: 'parameter_integrity',
      passed: verifyAdaptiveParameterRecord(active),
      severity: 'critical',
      message: `Adaptive parameter ${active.parameterId} hash valid`,
    });
  }

  const audit = getAdaptiveAuditTrail();
  checks.push({
    name: 'audit_trail_available',
    passed: true,
    severity: 'info',
    message: `${audit.length} in-process audit entries`,
  });

  checks.push({
    name: 'permission_validation',
    passed: input.adminRoleVerified !== false,
    severity: 'warning',
    message: input.adminRoleVerified === false ? 'Admin role not verified' : 'Permission check OK',
  });

  const failed = checks.some((c) => !c.passed && c.severity === 'critical');
  return { passed: !failed, generatedAt: input.generatedAt, checks };
}
