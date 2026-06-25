// Secret Management — encrypted secret storage

import { encrypt, decrypt } from '@/lib/encryption';
import { getEncryptedSecret, storeEncryptedSecret, writeSecurityAudit } from './repository/securityRepository';

export async function setSecret(key: string, plaintext: string, category = 'general', actorId?: number): Promise<void> {
  const encrypted = encrypt(plaintext);
  await storeEncryptedSecret(key, encrypted, category);
  await writeSecurityAudit({
    userId: actorId,
    eventType: 'secret',
    action: 'secret.store',
    resource: key,
    detail: { category },
  });
}

export async function getSecret(key: string): Promise<string | null> {
  const stored = await getEncryptedSecret(key);
  if (!stored) return null;
  try {
    return decrypt(stored);
  } catch {
    return null;
  }
}

export async function rotateSecret(key: string, newPlaintext: string, actorId?: number): Promise<void> {
  await setSecret(key, newPlaintext, 'rotated', actorId);
  await writeSecurityAudit({
    userId: actorId,
    eventType: 'secret',
    action: 'secret.rotate',
    resource: key,
  });
}

export function validateEncryptionAvailable(): boolean {
  try {
    return Boolean(process.env.ENCRYPTION_KEY || process.env.SESSION_SECRET);
  } catch {
    return false;
  }
}
