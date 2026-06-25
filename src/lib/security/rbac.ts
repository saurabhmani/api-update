// RBAC — role-based access control

import { ForbiddenError } from '@/lib/errors';
import type { Permission, Role } from './types';
import type { SessionUser } from '@/lib/session';
import { getPermissionsForRoleFromDb } from './repository/securityRepository';

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  user: [
    'signals:read',
    'portfolio:read',
    'portfolio:write',
    'trading:paper',
    'billing:read',
    'compliance:consent',
  ],
  trader: [
    'signals:read',
    'signals:write',
    'portfolio:read',
    'portfolio:write',
    'trading:paper',
    'trading:live',
    'billing:read',
    'compliance:consent',
  ],
  analyst: [
    'signals:read',
    'signals:write',
    'portfolio:read',
    'billing:read',
    'compliance:consent',
  ],
  admin: ['*'],
};

export function normalizeRole(role: string): Role {
  if (role === 'admin' || role === 'trader' || role === 'analyst') return role;
  return 'user';
}

export function getPermissionsForRole(role: string): Permission[] {
  return ROLE_PERMISSIONS[normalizeRole(role)] ?? ROLE_PERMISSIONS.user;
}

export async function getPermissionsForRoleAsync(role: string): Promise<Permission[]> {
  const fromDb = await getPermissionsForRoleFromDb(role);
  if (fromDb.length > 0) return fromDb as Permission[];
  return getPermissionsForRole(role);
}

export function hasPermission(role: string, permission: Permission): boolean {
  const perms = getPermissionsForRole(role);
  if (perms.includes('*')) return true;
  return perms.includes(permission);
}

export async function hasPermissionAsync(role: string, permission: Permission): Promise<boolean> {
  const perms = await getPermissionsForRoleAsync(role);
  if (perms.includes('*')) return true;
  return perms.includes(permission);
}

export function requirePermission(user: SessionUser, permission: Permission): void {
  if (!hasPermission(user.role, permission)) {
    throw new ForbiddenError(`Missing permission: ${permission}`);
  }
}

export function isAdmin(user: SessionUser): boolean {
  return user.role === 'admin';
}

export function getRbacMatrix(): Record<Role, Permission[]> {
  return { ...ROLE_PERMISSIONS };
}
