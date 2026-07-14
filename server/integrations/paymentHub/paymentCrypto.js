'use strict';

const crypto = require('crypto');

const PREFIX = 'enc:v1:';

function isProduction() {
  return process.env.NODE_ENV === 'production';
}

function getKey() {
  const configured = process.env.PAYMENT_DATA_ENCRYPTION_KEY || '';
  const fallback = process.env.ADMIN_SECRET_TOKEN || '';
  const material = configured || (!isProduction() ? fallback : '');

  if (!material) {
    throw new Error('PAYMENT_DATA_ENCRYPTION_KEY is required for payment data encryption');
  }

  if (/^[a-f0-9]{64}$/i.test(material)) {
    return Buffer.from(material, 'hex');
  }

  if (/^[A-Za-z0-9+/]{43}=$/.test(material)) {
    const decoded = Buffer.from(material, 'base64');
    if (decoded.length === 32) return decoded;
  }

  if (isProduction()) {
    throw new Error('PAYMENT_DATA_ENCRYPTION_KEY must be a 32-byte base64 value or 64 hex characters');
  }

  return crypto.createHash('sha256').update(material).digest();
}

function validateConfiguration() {
  getKey();
  return true;
}

function encrypt(value) {
  if (value === undefined || value === null || value === '') return value;
  const text = String(value);
  if (text.startsWith(PREFIX)) return text;

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return PREFIX + [iv, tag, encrypted].map(part => part.toString('base64url')).join(':');
}

function decrypt(value) {
  if (value === undefined || value === null || value === '') return value;
  const text = String(value);
  if (!text.startsWith(PREFIX)) return text;

  const parts = text.slice(PREFIX.length).split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted payment data');

  const iv = Buffer.from(parts[0], 'base64url');
  const tag = Buffer.from(parts[1], 'base64url');
  const encrypted = Buffer.from(parts[2], 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

function mask(value, visible = 4) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  const suffix = text.slice(-visible);
  return '*'.repeat(Math.max(4, text.length - visible)) + suffix;
}

function hash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timingSafeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { encrypt, decrypt, mask, hash, timingSafeEqual, validateConfiguration };
