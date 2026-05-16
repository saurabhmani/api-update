// ════════════════════════════════════════════════════════════════
//  AES-256-GCM Encryption — Column-level encryption at rest
//
//  Used for high-value secrets in the database:
//    - Kite access tokens (trading API credentials)
//    - TOTP secrets (2FA seed keys)
//
//  Key derivation:
//    ENCRYPTION_KEY env var → 64-char hex (32 bytes)
//    Falls back to SHA-256(SESSION_SECRET) if ENCRYPTION_KEY not set
//
//  Ciphertext format (base64-encoded):
//    [12B IV] [ciphertext] [16B auth tag]
//
//  RULE: Encrypt on write, decrypt on read. No plaintext secrets
//  should ever be persisted to disk or database.
// ════════════════════════════════════════════════════════════════

import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREFIX = 'enc:';  // Marks encrypted values (vs legacy plaintext)

// ── Key Resolution ──────────────────────────────────────────────

let _key: Buffer | null = null;

function getKey(): Buffer {
  if (_key) return _key;

  const explicit = process.env.ENCRYPTION_KEY?.trim();
  if (explicit && explicit.length >= 64) {
    _key = Buffer.from(explicit.slice(0, 64), 'hex');
    return _key;
  }

  // Derive from SESSION_SECRET as fallback
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (sessionSecret && sessionSecret.length >= 16) {
    _key = crypto.createHash('sha256').update(sessionSecret).digest();
    return _key;
  }

  throw new Error(
    'No encryption key available. Set ENCRYPTION_KEY (64 hex chars) or SESSION_SECRET (16+ chars) in environment.',
  );
}

// ── Encrypt ─────────────────────────────────────────────────────

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a prefixed base64 string: "enc:<base64(iv + ciphertext + tag)>"
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Pack: [iv][ciphertext][tag]
  const packed = Buffer.concat([iv, encrypted, tag]);
  return PREFIX + packed.toString('base64');
}

// ── Decrypt ─────────────────────────────────────────────────────

/**
 * Decrypt an AES-256-GCM ciphertext.
 * Accepts both prefixed ("enc:...") and raw base64 formats.
 * Returns the original plaintext string.
 *
 * If the input is NOT encrypted (no prefix, not valid base64),
 * returns it as-is — this allows transparent migration from
 * plaintext to encrypted values.
 */
export function decrypt(ciphertext: string): string {
  // Plaintext passthrough: if not encrypted, return as-is
  if (!ciphertext.startsWith(PREFIX)) {
    return ciphertext;
  }

  const key = getKey();
  const raw = ciphertext.slice(PREFIX.length);
  const packed = Buffer.from(raw, 'base64');

  if (packed.length < IV_BYTES + TAG_BYTES + 1) {
    throw new Error('Invalid encrypted data: too short');
  }

  const iv = packed.subarray(0, IV_BYTES);
  const tag = packed.subarray(packed.length - TAG_BYTES);
  const encrypted = packed.subarray(IV_BYTES, packed.length - TAG_BYTES);

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}

// ── Helpers ─────────────────────────────────────────────────────

/** Check if a value is already encrypted */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/**
 * Encrypt only if not already encrypted.
 * Safe to call on values that may or may not be encrypted.
 */
export function ensureEncrypted(value: string): string {
  if (isEncrypted(value)) return value;
  return encrypt(value);
}
