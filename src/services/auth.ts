import bcrypt from 'bcryptjs';
import speakeasy from 'speakeasy';
import { randomBytes, createHash } from 'crypto';
import { db } from '@/lib/db';
import { cacheDel } from '@/lib/redis';
import { encrypt, decrypt } from '@/lib/encryption';
import type { User } from '@/types';

const SESSION_MAX_AGE = parseInt(process.env.SESSION_MAX_AGE || '86400');
const MAX_ATTEMPTS    = 5;
const LOCK_MINUTES    = 30;

// ── Login ─────────────────────────────────────────────────────────
export async function loginUser(email: string, password: string): Promise<{
  user: User; requires2fa: boolean; sessionToken?: string;
} | { error: string }> {
  const { rows } = await db.query<User & { password_hash: string; locked_until: string; failed_login_attempts: number }>(
    `SELECT * FROM users WHERE email = ?`, [email.toLowerCase()]
  );
  if (!rows.length) return { error: 'Invalid email or password' };

  const user = rows[0];
  if (!user.is_active) return { error: 'Account is disabled' };
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    return { error: `Account locked until ${new Date(user.locked_until).toLocaleTimeString()}` };
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    const attempts = user.failed_login_attempts + 1;
    // MySQL DATETIME rejects ISO 8601 with the trailing 'Z' (22007
    // truncated value). Format as 'YYYY-MM-DD HH:MM:SS' which MySQL
    // accepts directly.
    const lockUntil = attempts >= MAX_ATTEMPTS
      ? new Date(Date.now() + LOCK_MINUTES * 60 * 1000)
          .toISOString()
          .slice(0, 19)
          .replace('T', ' ')
      : null;
    await db.query(
      `UPDATE users SET failed_login_attempts=?, locked_until=? WHERE id=?`,
      [attempts, lockUntil, user.id]
    );
    return { error: attempts >= MAX_ATTEMPTS ? `Account locked for ${LOCK_MINUTES} minutes` : 'Invalid email or password' };
  }

  // Reset failed attempts
  await db.query(`UPDATE users SET failed_login_attempts=0, locked_until=NULL, last_login_at=NOW() WHERE id=?`, [user.id]);

  if (user.totp_enabled) {
    return { user, requires2fa: true };
  }

  const token = await createSession(user.id);
  return { user, requires2fa: false, sessionToken: token };
}

// ── Register ─────────────────────────────────────────────────────
export async function registerUser(
  email: string, password: string, name: string,
): Promise<{ user: { id: number; email: string; name: string; role: string }; sessionToken: string } | { error: string }> {
  const emailLower = email.toLowerCase().trim();

  if (!emailLower || !password || !name.trim()) {
    return { error: 'Email, password, and name are required' };
  }
  if (password.length < 8) {
    return { error: 'Password must be at least 8 characters' };
  }

  // Check if email already exists
  const { rows: existing } = await db.query(`SELECT id FROM users WHERE email = ?`, [emailLower]);
  if ((existing as any[]).length > 0) {
    return { error: 'An account with this email already exists' };
  }

  const hash = await bcrypt.hash(password, 12);
  const result = await db.query(
    `INSERT INTO users (email, password_hash, name, role, is_active, created_at)
     VALUES (?, ?, ?, 'user', TRUE, NOW())`,
    [emailLower, hash, name.trim()],
  );

  // db.query returns { rows: [], insertId, affectedRows } for INSERTs.
  // rows is always empty for INSERT — read insertId from the envelope.
  const insertId = result.insertId;
  if (!insertId) return { error: 'Registration failed' };

  const userId = Number(insertId);
  const sessionToken = await createSession(userId);

  return {
    user: { id: userId, email: emailLower, name: name.trim(), role: 'user' },
    sessionToken,
  };
}

// ── Create session ────────────────────────────────────────────────
export async function createSession(userId: number, device?: string, ip?: string): Promise<string> {
  const token    = randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE * 1000);
  // Ensure userId is integer (MySQL strict mode) and use ISO string for datetime
  const uid = typeof userId === 'number' ? userId : parseInt(String(userId), 10);
  const expiresStr = expiresAt.toISOString().slice(0, 19).replace('T', ' ');
  const r = await db.query(
    `INSERT INTO user_sessions (user_id, token, device, ip_address, expires_at) VALUES (?,?,?,?,?)`,
    [uid, token, device || null, ip || null, expiresStr]
  );
  console.log(`[AUTH] Session Created: ${uid}  insertId=${r.insertId ?? 'undefined'}`);
  if (!r.insertId) console.error('[AUTH] ❌ user_sessions INSERT returned no insertId');
  return token;
}

// ── Invalidate session ────────────────────────────────────────────
export async function invalidateSession(token: string) {
  await db.query(`DELETE FROM user_sessions WHERE token=?`, [token]);
  await cacheDel(`session:${token}`);
}

// ── Verify TOTP ───────────────────────────────────────────────────
export async function verifyTotp(userId: number, token: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT totp_secret FROM users WHERE id=?`, [userId]);
  if (!rows.length || !rows[0].totp_secret) return false;
  // Decrypt TOTP secret (transparent: handles both encrypted and legacy plaintext)
  const secret = decrypt(rows[0].totp_secret);
  return speakeasy.totp.verify({ secret, encoding: 'base32', token, window: 1 });
}

// ── Setup TOTP ────────────────────────────────────────────────────
export async function initTotp(userId: number, email: string): Promise<{ secret: string; otpauth_url: string }> {
  const secret = speakeasy.generateSecret({ name: `Quantorus365 (${email})`, issuer: 'Quantorus365' });
  // Encrypt TOTP secret before persisting (AES-256-GCM)
  const encryptedSecret = encrypt(secret.base32);
  await db.query(`UPDATE users SET totp_secret=? WHERE id=?`, [encryptedSecret, userId]);
  // Return plaintext to the caller (for QR code generation) — never stored in plaintext
  return { secret: secret.base32, otpauth_url: secret.otpauth_url! };
}

export async function confirmTotp(userId: number, token: string): Promise<boolean> {
  const valid = await verifyTotp(userId, token);
  if (valid) await db.query(`UPDATE users SET totp_enabled=TRUE WHERE id=?`, [userId]);
  return valid;
}

// ── Password reset ────────────────────────────────────────────────
export async function createPasswordReset(email: string): Promise<string | null> {
  const { rows } = await db.query(`SELECT id FROM users WHERE email=? AND is_active=TRUE`, [email.toLowerCase()]);
  if (!rows.length) return null;
  const rawToken = randomBytes(32).toString('hex');
  const hash     = createHash('sha256').update(rawToken).digest('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1hr
  await db.query(
    `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?,?,?)`,
    [rows[0].id, hash, expiresAt]
  );
  return rawToken;
}

export async function resetPassword(rawToken: string, newPassword: string): Promise<boolean> {
  const hash = createHash('sha256').update(rawToken).digest('hex');
  const { rows } = await db.query(
    `SELECT pr.id, pr.user_id FROM password_resets pr
     WHERE pr.token_hash=? AND pr.used=FALSE AND pr.expires_at > NOW()`,
    [hash]
  );
  if (!rows.length) return false;
  const passwordHash = await bcrypt.hash(newPassword, 12);
  await db.query(`UPDATE users SET password_hash=? WHERE id=?`, [passwordHash, rows[0].user_id]);
  await db.query(`UPDATE password_resets SET used=TRUE WHERE id=?`, [rows[0].id]);
  return true;
}

// ── Change password ───────────────────────────────────────────────
export async function changePassword(userId: number, current: string, newPw: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT password_hash FROM users WHERE id=?`, [userId]);
  if (!rows.length) return false;
  const valid = await bcrypt.compare(current, rows[0].password_hash);
  if (!valid) return false;
  const hash = await bcrypt.hash(newPw, 12);
  await db.query(`UPDATE users SET password_hash=?, updated_at=NOW() WHERE id=?`, [hash, userId]);
  return true;
}

// ── Hash new password ─────────────────────────────────────────────
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}
