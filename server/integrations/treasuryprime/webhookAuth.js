'use strict';

/**
 * Authentication for inbound Treasury Prime webhooks.
 *
 * Treasury Prime does not sign its callbacks. The only validation it offers is
 * the basic_user/basic_secret pair recorded on the webhook object: every
 * notification to that URL then carries
 *   Authorization: Basic base64(basic_user:basic_secret)
 * so the registered credentials and the ones checked here must be the same
 * pair, held in TREASURY_PRIME_WEBHOOK_USER / TREASURY_PRIME_WEBHOOK_SECRET.
 */

const { timingSafeEqual } = require('../paymentHub/paymentCrypto');

function webhookUser() {
  return process.env.TREASURY_PRIME_WEBHOOK_USER || 'dlbtrust';
}

function expectedBasicHeader(secret) {
  return `Basic ${Buffer.from(`${webhookUser()}:${secret}`).toString('base64')}`;
}

function encodedCredentials(secret) {
  return Buffer.from(`${webhookUser()}:${secret}`).toString('base64');
}

/**
 * True when the request carries the credentials registered on the webhook.
 * Accepts Treasury Prime's Basic header, and the legacy shared-secret header
 * for internal replays; both compared in constant time.
 */
function isAuthentic(headers = {}, secret) {
  if (!secret) return false;
  const header = String(headers.authorization || headers.Authorization || '');
  const match = /^basic\s+(.+)$/i.exec(header.trim());
  if (match && timingSafeEqual(match[1].trim(), encodedCredentials(secret))) return true;
  return timingSafeEqual(String(headers['x-treasury-prime-secret'] || ''), secret);
}

module.exports = { webhookUser, expectedBasicHeader, isAuthentic };
