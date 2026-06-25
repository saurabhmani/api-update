// Input validation — sanitization and schema checks

import { ValidationError } from '@/lib/errors';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SAFE_STRING_RE = /^[\w\s@.,!?\-+/'"():;#&%]*$/;

export function validateEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !EMAIL_RE.test(trimmed)) {
    throw new ValidationError('Invalid email address');
  }
  if (trimmed.length > 255) throw new ValidationError('Email too long');
  return trimmed;
}

export function validatePassword(password: string): void {
  if (!password || password.length < 8) {
    throw new ValidationError('Password must be at least 8 characters');
  }
  if (password.length > 128) {
    throw new ValidationError('Password too long');
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
    throw new ValidationError('Password must contain at least one letter and one number');
  }
}

export function sanitizeString(input: string, maxLen = 500): string {
  const trimmed = input.trim().slice(0, maxLen);
  if (!SAFE_STRING_RE.test(trimmed)) {
    throw new ValidationError('Input contains invalid characters');
  }
  return trimmed;
}

export function validateTotpToken(token: string): string {
  const cleaned = token.replace(/\s/g, '');
  if (!/^\d{6}$/.test(cleaned)) {
    throw new ValidationError('TOTP token must be 6 digits');
  }
  return cleaned;
}

export function validateConsentType(type: string): string {
  const allowed = [
    'terms_of_service', 'privacy_policy', 'trading_disclaimer',
    'live_trading_risk', 'data_processing', 'marketing',
  ];
  if (!allowed.includes(type)) {
    throw new ValidationError('Invalid consent type');
  }
  return type;
}
