import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { rateLimit } from 'express-rate-limit';

const MIN_JWT_SECRET_LENGTH = 32;
const MIN_ADMIN_PASSWORD_LENGTH = 12;

export function loadSecurityConfig(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const jwtSecret = String(env.JWT_SECRET || '').trim();
  const adminEmail = String(env.ADMIN_EMAIL || '').trim().toLowerCase() || null;
  const adminPassword = String(env.ADMIN_PASSWORD || '') || null;

  if (isProduction && jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new Error('JWT_SECRET must be at least 32 characters in production');
  }
  if (isProduction && (!adminEmail || !adminPassword)) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD are required in production');
  }
  if (adminPassword && adminPassword.length < MIN_ADMIN_PASSWORD_LENGTH) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters');
  }
  if (isProduction && (
    adminEmail === 'admin@salespot.local'
    || adminPassword === 'ChangeMe123!'
    || jwtSecret === 'development-only-change-me'
  )) {
    throw new Error('Default development credentials cannot be used in production');
  }

  return {
    isProduction,
    jwtSecret: jwtSecret || crypto.randomBytes(48).toString('hex'),
    adminEmail,
    adminPassword,
  };
}

export function createAuthLimiter({ limit = 10, windowMs = 15 * 60_000 } = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    message: { error: 'Too many failed attempts. Try again in 15 minutes.' },
  });
}

export function disableKnownDemoPasswords(db) {
  const unusablePasswordHash = bcrypt.hashSync(
    crypto.randomBytes(48).toString('hex'),
    12,
  );
  const disable = db.prepare('UPDATE users SET password_hash=? WHERE email=?');
  for (const email of [
    'sarah@example.com',
    'farm@example.com',
    'estate@example.com',
    'admin@salespot.local',
  ]) {
    disable.run(unusablePasswordHash, email);
  }
}
