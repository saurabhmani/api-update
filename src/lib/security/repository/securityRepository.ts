// Security & Compliance — MySQL persistence

import { db } from '@/lib/db';
import type { ConsentType, RetentionPolicy, SecurityAuditEntry, UserConsent } from '../types';

let migrated = false;

export async function ensureSecurityTables(): Promise<void> {
  if (migrated) return;
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_consents (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        consent_type VARCHAR(64) NOT NULL,
        version VARCHAR(32) NOT NULL,
        accepted TINYINT(1) NOT NULL DEFAULT 1,
        ip_address VARCHAR(64),
        user_agent VARCHAR(512),
        accepted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at DATETIME,
        INDEX idx_user_consents_user (user_id, consent_type),
        UNIQUE KEY uq_consent_active (user_id, consent_type, version)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS security_audit_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        actor_email VARCHAR(255),
        event_type VARCHAR(64) NOT NULL,
        action VARCHAR(128) NOT NULL,
        resource VARCHAR(128),
        detail_json JSON,
        ip_address VARCHAR(64),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sec_audit_time (created_at),
        INDEX idx_sec_audit_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS data_retention_policies (
        id INT AUTO_INCREMENT PRIMARY KEY,
        data_category VARCHAR(64) NOT NULL UNIQUE,
        retention_days INT NOT NULL,
        description TEXT,
        active TINYINT(1) NOT NULL DEFAULT 1,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS encrypted_secrets (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        secret_key VARCHAR(128) NOT NULL UNIQUE,
        encrypted_value TEXT NOT NULL,
        category VARCHAR(64) NOT NULL DEFAULT 'general',
        rotated_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS roles (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(32) NOT NULL UNIQUE,
        description VARCHAR(255),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS permissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        code VARCHAR(64) NOT NULL UNIQUE,
        description VARCHAR(255),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        role_id INT NOT NULL,
        permission_id INT NOT NULL,
        PRIMARY KEY (role_id, permission_id),
        INDEX idx_rp_role (role_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS security_events (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        actor_email VARCHAR(255),
        event_type VARCHAR(64) NOT NULL,
        action VARCHAR(128) NOT NULL,
        resource VARCHAR(128),
        severity VARCHAR(16) NOT NULL DEFAULT 'info',
        detail_json JSON,
        ip_address VARCHAR(64),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_sec_events_time (created_at),
        INDEX idx_sec_events_type (event_type, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await db.query(`
      CREATE TABLE IF NOT EXISTS consent_logs (
        id BIGINT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        consent_type VARCHAR(64) NOT NULL,
        version VARCHAR(32) NOT NULL,
        accepted TINYINT(1) NOT NULL DEFAULT 1,
        ip_address VARCHAR(64),
        user_agent VARCHAR(512),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_consent_logs_user (user_id, created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await seedRetentionPolicies();
    await seedRbac();
    try {
      await db.query(`ALTER TABLE users MODIFY COLUMN role VARCHAR(32) NOT NULL DEFAULT 'user'`);
    } catch { /* already widened */ }
    migrated = true;
  } catch {
    // Non-fatal
  }
}

async function seedRbac(): Promise<void> {
  const roles = [
    ['user', 'Standard user'],
    ['trader', 'Live trading access'],
    ['analyst', 'Research and signals'],
    ['admin', 'Full platform admin'],
  ];
  for (const [name, desc] of roles) {
    await db.query(`INSERT IGNORE INTO roles (name, description) VALUES (?, ?)`, [name, desc]);
  }

  const perms = [
    ['signals:read', 'Read signals'],
    ['signals:write', 'Write signals'],
    ['portfolio:read', 'Read portfolio'],
    ['portfolio:write', 'Write portfolio'],
    ['trading:paper', 'Paper trading'],
    ['trading:live', 'Live trading'],
    ['billing:read', 'Read billing'],
    ['billing:write', 'Manage billing'],
    ['admin:users', 'Manage users'],
    ['admin:audit', 'View audit logs'],
    ['admin:pipeline', 'Pipeline control'],
    ['admin:security', 'Security admin'],
    ['compliance:consent', 'Manage consent'],
    ['*', 'Wildcard admin'],
  ];
  for (const [code, desc] of perms) {
    await db.query(`INSERT IGNORE INTO permissions (code, description) VALUES (?, ?)`, [code, desc]);
  }

  const rolePermMap: Record<string, string[]> = {
    user: ['signals:read', 'portfolio:read', 'portfolio:write', 'trading:paper', 'billing:read', 'compliance:consent'],
    trader: ['signals:read', 'signals:write', 'portfolio:read', 'portfolio:write', 'trading:paper', 'trading:live', 'billing:read', 'compliance:consent'],
    analyst: ['signals:read', 'signals:write', 'portfolio:read', 'billing:read', 'compliance:consent'],
    admin: ['*'],
  };

  for (const [roleName, permCodes] of Object.entries(rolePermMap)) {
    const { rows: roleRows } = await db.query(`SELECT id FROM roles WHERE name = ?`, [roleName]);
    const roleId = (roleRows[0] as any)?.id;
    if (!roleId) continue;
    for (const code of permCodes) {
      const { rows: permRows } = await db.query(`SELECT id FROM permissions WHERE code = ?`, [code]);
      const permId = (permRows[0] as any)?.id;
      if (permId) {
        await db.query(`INSERT IGNORE INTO role_permissions (role_id, permission_id) VALUES (?, ?)`, [roleId, permId]);
      }
    }
  }
}

async function seedRetentionPolicies(): Promise<void> {
  const policies = [
    ['audit_logs', 2555, '7 years — regulatory audit trail'],
    ['session_logs', 90, 'Session activity retention'],
    ['api_health_logs', 365, 'API health monitoring history'],
    ['user_consents', 2555, 'Consent records'],
    ['security_events', 730, 'Security event log — 2 years'],
  ];
  for (const [cat, days, desc] of policies) {
    await db.query(
      `INSERT IGNORE INTO data_retention_policies (data_category, retention_days, description) VALUES (?, ?, ?)`,
      [cat, days, desc],
    );
  }
}

export async function recordConsent(input: {
  userId: number;
  consentType: ConsentType;
  version: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<void> {
  await ensureSecurityTables();
  await db.query(
    `INSERT INTO user_consents (user_id, consent_type, version, accepted, ip_address, user_agent)
     VALUES (?, ?, ?, 1, ?, ?)
     ON DUPLICATE KEY UPDATE
       accepted = 1,
       ip_address = VALUES(ip_address),
       user_agent = VALUES(user_agent),
       accepted_at = CURRENT_TIMESTAMP,
       revoked_at = NULL`,
    [input.userId, input.consentType, input.version, input.ipAddress ?? null, input.userAgent ?? null],
  );
  await db.query(
    `INSERT INTO consent_logs (user_id, consent_type, version, accepted, ip_address, user_agent)
     VALUES (?, ?, ?, 1, ?, ?)`,
    [input.userId, input.consentType, input.version, input.ipAddress ?? null, input.userAgent ?? null],
  );
}

export async function revokeConsent(userId: number, consentType: ConsentType): Promise<void> {
  await ensureSecurityTables();
  await db.query(
    `UPDATE user_consents SET accepted = 0, revoked_at = NOW()
     WHERE user_id = ? AND consent_type = ? AND revoked_at IS NULL`,
    [userId, consentType],
  );
}

export async function getUserConsents(userId: number): Promise<UserConsent[]> {
  await ensureSecurityTables();
  try {
    const { rows } = await db.query(
      `SELECT id, user_id, consent_type, version, accepted, ip_address, accepted_at, revoked_at
         FROM user_consents WHERE user_id = ? ORDER BY accepted_at DESC`,
      [userId],
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id),
      userId: Number(r.user_id),
      consentType: r.consent_type,
      version: r.version,
      accepted: Boolean(r.accepted),
      ipAddress: r.ip_address,
      acceptedAt: new Date(r.accepted_at).toISOString(),
      revokedAt: r.revoked_at ? new Date(r.revoked_at).toISOString() : null,
    }));
  } catch {
    return [];
  }
}

export async function writeSecurityAudit(input: {
  userId?: number;
  actorEmail?: string;
  eventType: string;
  action: string;
  resource?: string;
  detail?: Record<string, unknown>;
  ipAddress?: string;
  severity?: string;
}): Promise<void> {
  await ensureSecurityTables();
  const detailJson = input.detail ? JSON.stringify(input.detail) : null;
  const severity = input.severity ?? (input.eventType === 'rate_limit' ? 'warning' : 'info');

  await db.query(
    `INSERT INTO security_audit_logs (user_id, actor_email, event_type, action, resource, detail_json, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [input.userId ?? null, input.actorEmail ?? null, input.eventType, input.action, input.resource ?? null, detailJson, input.ipAddress ?? null],
  );
  await db.query(
    `INSERT INTO security_events (user_id, actor_email, event_type, action, resource, severity, detail_json, ip_address)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [input.userId ?? null, input.actorEmail ?? null, input.eventType, input.action, input.resource ?? null, severity, detailJson, input.ipAddress ?? null],
  );
  await db.query(
    `INSERT INTO audit_logs (user_id, action, resource_type, metadata, ip_address)
     VALUES (?, ?, ?, ?, ?)`,
    [input.userId ?? null, input.action, input.eventType, detailJson, input.ipAddress ?? null],
  );
}

export async function listSecurityAudit(opts?: {
  userId?: number;
  limit?: number;
}): Promise<SecurityAuditEntry[]> {
  await ensureSecurityTables();
  const limit = opts?.limit ?? 100;
  const where = opts?.userId ? 'WHERE user_id = ?' : '';
  const params = opts?.userId ? [opts.userId, limit] : [limit];
  try {
    const { rows } = await db.query(
      `SELECT id, user_id, actor_email, event_type, action, resource, detail_json, ip_address, created_at
         FROM security_audit_logs ${where}
        ORDER BY created_at DESC LIMIT ?`,
      params,
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id),
      userId: r.user_id != null ? Number(r.user_id) : null,
      actorEmail: r.actor_email,
      eventType: r.event_type,
      action: r.action,
      resource: r.resource,
      detail: parseJson(r.detail_json),
      ipAddress: r.ip_address,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function listRetentionPolicies(): Promise<RetentionPolicy[]> {
  await ensureSecurityTables();
  try {
    const { rows } = await db.query(
      `SELECT data_category, retention_days, description, active FROM data_retention_policies WHERE active = 1`,
    );
    return (rows as any[]).map((r) => ({
      dataCategory: r.data_category,
      retentionDays: Number(r.retention_days),
      description: r.description,
      active: Boolean(r.active),
    }));
  } catch {
    return [];
  }
}

export async function storeEncryptedSecret(key: string, encryptedValue: string, category = 'general'): Promise<void> {
  await ensureSecurityTables();
  await db.query(
    `INSERT INTO encrypted_secrets (secret_key, encrypted_value, category, rotated_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE encrypted_value = VALUES(encrypted_value), rotated_at = NOW()`,
    [key, encryptedValue, category],
  );
}

export async function getEncryptedSecret(key: string): Promise<string | null> {
  await ensureSecurityTables();
  try {
    const { rows } = await db.query(`SELECT encrypted_value FROM encrypted_secrets WHERE secret_key = ?`, [key]);
    return (rows[0] as any)?.encrypted_value ?? null;
  } catch {
    return null;
  }
}

function parseJson(val: unknown): Record<string, unknown> {
  if (!val) return {};
  if (typeof val === 'object') return val as Record<string, unknown>;
  try { return JSON.parse(String(val)); } catch { return {}; }
}

export async function listSecurityEvents(opts?: { userId?: number; limit?: number }) {
  await ensureSecurityTables();
  const limit = opts?.limit ?? 100;
  const where = opts?.userId ? 'WHERE user_id = ?' : '';
  const params = opts?.userId ? [opts.userId, limit] : [limit];
  try {
    const { rows } = await db.query(
      `SELECT id, user_id, actor_email, event_type, action, resource, severity, detail_json, ip_address, created_at
         FROM security_events ${where} ORDER BY created_at DESC LIMIT ?`,
      params,
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id),
      userId: r.user_id != null ? Number(r.user_id) : null,
      actorEmail: r.actor_email,
      eventType: r.event_type,
      action: r.action,
      resource: r.resource,
      severity: r.severity,
      detail: parseJson(r.detail_json),
      ipAddress: r.ip_address,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function listConsentLogs(userId?: number, limit = 50) {
  await ensureSecurityTables();
  try {
    const where = userId ? 'WHERE user_id = ?' : '';
    const params = userId ? [userId, limit] : [limit];
    const { rows } = await db.query(
      `SELECT id, user_id, consent_type, version, accepted, ip_address, created_at
         FROM consent_logs ${where} ORDER BY created_at DESC LIMIT ?`,
      params,
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id),
      userId: Number(r.user_id),
      consentType: r.consent_type,
      version: r.version,
      accepted: Boolean(r.accepted),
      ipAddress: r.ip_address,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  } catch {
    return [];
  }
}

export async function listAuditLogsUnified(opts?: { userId?: number; limit?: number }) {
  await ensureSecurityTables();
  const limit = opts?.limit ?? 100;
  try {
    const where = opts?.userId ? 'WHERE user_id = ?' : '';
    const params = opts?.userId ? [opts.userId, limit] : [limit];
    const { rows } = await db.query(
      `SELECT id, user_id, action, resource_type, metadata, ip_address, created_at
         FROM audit_logs ${where} ORDER BY created_at DESC LIMIT ?`,
      params,
    );
    return (rows as any[]).map((r) => ({
      id: Number(r.id),
      userId: r.user_id != null ? Number(r.user_id) : null,
      action: r.action,
      resourceType: r.resource_type,
      metadata: parseJson(r.metadata),
      ipAddress: r.ip_address,
      createdAt: new Date(r.created_at).toISOString(),
      source: 'audit_logs',
    }));
  } catch {
    return [];
  }
}

export async function listRoles() {
  await ensureSecurityTables();
  try {
    const { rows } = await db.query(`SELECT id, name, description FROM roles ORDER BY id`);
    return rows as Array<{ id: number; name: string; description: string }>;
  } catch {
    return [];
  }
}

export async function listPermissions() {
  await ensureSecurityTables();
  try {
    const { rows } = await db.query(`SELECT id, code, description FROM permissions ORDER BY id`);
    return rows as Array<{ id: number; code: string; description: string }>;
  } catch {
    return [];
  }
}

export async function getPermissionsForRoleFromDb(roleName: string): Promise<string[]> {
  await ensureSecurityTables();
  try {
    const { rows } = await db.query(
      `SELECT p.code FROM permissions p
         JOIN role_permissions rp ON rp.permission_id = p.id
         JOIN roles r ON r.id = rp.role_id
        WHERE r.name = ?`,
      [roleName],
    );
    return (rows as any[]).map((r) => r.code as string);
  } catch {
    return [];
  }
}

export async function assignUserRole(userId: number, roleName: string): Promise<void> {
  await db.query(`UPDATE users SET role = ? WHERE id = ?`, [roleName, userId]);
}
