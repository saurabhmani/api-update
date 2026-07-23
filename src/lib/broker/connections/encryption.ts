// Broker credential encryption — AES-256-GCM at rest
//
// Production requires BROKER_TOKEN_ENCRYPTION_KEY (64 hex chars).
// Dev may fall back to ENCRYPTION_KEY / SESSION_SECRET only when
// NODE_ENV !== 'production'.

import crypto from 'crypto';
import { decrypt, encrypt, isEncrypted } from '@/lib/encryption';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Versioned ciphertext: brk1:<base64(iv || ciphertext || tag)> */
const PREFIX_V1 = 'brk1:';
/** Legacy shared encrypt() prefix — still decryptable. */
const LEGACY_PREFIX = 'enc:';

let _brokerKey: Buffer | null = null;
let _brokerKeyValidated = false;

function resolveBrokerKey(): Buffer | null {
  if (_brokerKey) return _brokerKey;

  const explicit = process.env.BROKER_TOKEN_ENCRYPTION_KEY?.trim();
  if (explicit && /^[0-9a-fA-F]{64}$/.test(explicit)) {
    _brokerKey = Buffer.from(explicit, 'hex');
    return _brokerKey;
  }

  return null;
}

function allowLegacyFallback(): boolean {
  return process.env.NODE_ENV !== 'production'
    || process.env.BROKER_TOKEN_ALLOW_LEGACY_KEY === '1';
}

/**
 * Validate broker encryption key availability at startup.
 * In production, BROKER_TOKEN_ENCRYPTION_KEY is mandatory.
 */
export function validateBrokerTokenEncryptionKey(): {
  ok: boolean;
  source: 'BROKER_TOKEN_ENCRYPTION_KEY' | 'ENCRYPTION_KEY' | 'SESSION_SECRET' | 'none';
  warning?: string;
  error?: string;
} {
  _brokerKeyValidated = true;
  const brokerKey = resolveBrokerKey();
  if (brokerKey) {
    return { ok: true, source: 'BROKER_TOKEN_ENCRYPTION_KEY' };
  }

  if (process.env.NODE_ENV === 'production' && process.env.BROKER_TOKEN_ALLOW_LEGACY_KEY !== '1') {
    return {
      ok: false,
      source: 'none',
      error:
        'BROKER_TOKEN_ENCRYPTION_KEY is required in production (64 hex characters). '
        + 'Set BROKER_TOKEN_ALLOW_LEGACY_KEY=1 only if intentionally using ENCRYPTION_KEY.',
    };
  }

  const encKey = process.env.ENCRYPTION_KEY?.trim();
  if (encKey && encKey.length >= 64) {
    return {
      ok: true,
      source: 'ENCRYPTION_KEY',
      warning: 'BROKER_TOKEN_ENCRYPTION_KEY unset — using ENCRYPTION_KEY for broker tokens (dev/legacy).',
    };
  }

  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (sessionSecret && sessionSecret.length >= 16) {
    return {
      ok: true,
      source: 'SESSION_SECRET',
      warning:
        'BROKER_TOKEN_ENCRYPTION_KEY and ENCRYPTION_KEY unset — deriving broker key from SESSION_SECRET (dev only).',
    };
  }

  return {
    ok: false,
    source: 'none',
    error: 'No broker token encryption key available.',
  };
}

export function assertBrokerEncryptionReady(): void {
  const result = validateBrokerTokenEncryptionKey();
  if (!result.ok) {
    throw new Error(
      result.error
      ?? 'Broker token encryption is not configured. Set BROKER_TOKEN_ENCRYPTION_KEY (64 hex chars).',
    );
  }
}

function packCipher(iv: Buffer, encrypted: Buffer, tag: Buffer): string {
  return PREFIX_V1 + Buffer.concat([iv, encrypted, tag]).toString('base64');
}

function unpackCipher(ciphertext: string): { iv: Buffer; encrypted: Buffer; tag: Buffer } {
  const raw = ciphertext.startsWith(PREFIX_V1)
    ? ciphertext.slice(PREFIX_V1.length)
    : ciphertext.startsWith(LEGACY_PREFIX)
      ? ciphertext.slice(LEGACY_PREFIX.length)
      : ciphertext;
  const packed = Buffer.from(raw, 'base64');
  if (packed.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('Invalid encrypted broker credential');
  }
  return {
    iv: packed.subarray(0, IV_BYTES),
    encrypted: packed.subarray(IV_BYTES, packed.length - TAG_BYTES),
    tag: packed.subarray(packed.length - TAG_BYTES),
  };
}

function encryptWithBrokerKey(plaintext: string): string {
  const key = resolveBrokerKey();
  if (!key) {
    if (!allowLegacyFallback()) {
      throw new Error('BROKER_TOKEN_ENCRYPTION_KEY required');
    }
    return encrypt(plaintext);
  }

  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return packCipher(iv, encrypted, tag);
}

function decryptWithBrokerKey(ciphertext: string): string {
  const key = resolveBrokerKey();
  if (!key) {
    if (!allowLegacyFallback()) {
      throw new Error('BROKER_TOKEN_ENCRYPTION_KEY required');
    }
    return decrypt(ciphertext);
  }

  if (!ciphertext.startsWith(PREFIX_V1) && !ciphertext.startsWith(LEGACY_PREFIX)) {
    // May be legacy shared encrypt() or plaintext migration remnant.
    return decrypt(ciphertext);
  }

  const { iv, encrypted, tag } = unpackCipher(ciphertext);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/** Encrypt a broker credential for database storage. */
export function encryptBrokerCredential(value: string): string {
  if (!value) throw new Error('Cannot encrypt empty broker credential');
  assertBrokerEncryptionReady();
  if (value.startsWith(PREFIX_V1) || isEncrypted(value)) return value;
  return encryptWithBrokerKey(value);
}

/**
 * Decrypt a broker credential immediately before a broker API call.
 * Never expose the result to the frontend or logs.
 * Tamper/auth failures throw a generic error (no ciphertext echoed).
 */
export function decryptBrokerCredential(value: string): string {
  if (!value) throw new Error('Cannot decrypt empty broker credential');
  assertBrokerEncryptionReady();
  try {
    return decryptWithBrokerKey(value);
  } catch {
    if (allowLegacyFallback() && value.startsWith(LEGACY_PREFIX)) {
      try {
        return decrypt(value);
      } catch {
        throw new Error('Broker credential decryption failed');
      }
    }
    throw new Error('Broker credential decryption failed');
  }
}

/** Test helper — reset cached key between cases. */
export function resetBrokerEncryptionCacheForTests(): void {
  _brokerKey = null;
  _brokerKeyValidated = false;
}
