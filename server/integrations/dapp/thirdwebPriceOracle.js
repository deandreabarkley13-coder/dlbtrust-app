'use strict';

/**
 * USD price oracle backed by thirdweb's token API
 * (GET https://api.thirdweb.com/v1/tokens?chainId=&tokenAddress=).
 *
 * Prices an on-chain quantity (smallest units) in USD so distribution limits
 * can be enforced against a market valuation instead of a caller-stated one.
 * Native assets use the 0xEeee…EEeE sentinel. Quotes are cached for
 * THIRDWEB_PRICE_CACHE_MS (default 60s) and rejected when the upstream price
 * is older than THIRDWEB_PRICE_MAX_AGE_MS (default 15 min).
 */

const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const DEFAULT_API_URL = 'https://api.thirdweb.com';

function str(name, def = '') { return (process.env[name] || def).toString().trim(); }
function num(name, def) { const n = Number(process.env[name]); return Number.isFinite(n) ? n : def; }

const cache = new Map();

class ThirdwebPriceOracle {
  static getConfig() {
    return {
      enabled: str('THIRDWEB_PRICE_ORACLE_ENABLED', 'true').toLowerCase() !== 'false',
      apiUrl: str('THIRDWEB_API_URL', DEFAULT_API_URL).replace(/\/+$/, ''),
      secretKey: str('THIRDWEB_SECRET_KEY'),
      cacheMs: num('THIRDWEB_PRICE_CACHE_MS', 60000),
      maxAgeMs: num('THIRDWEB_PRICE_MAX_AGE_MS', 15 * 60 * 1000),
      timeoutMs: num('THIRDWEB_API_TIMEOUT_MS', 20000),
    };
  }

  static readiness() {
    const cfg = this.getConfig();
    const issues = [];
    if (!cfg.enabled) issues.push('THIRDWEB_PRICE_ORACLE_ENABLED=false');
    if (!cfg.secretKey) issues.push('THIRDWEB_SECRET_KEY not configured');
    return { provider: 'thirdweb-token-api', enabled: cfg.enabled, apiUrl: cfg.apiUrl, cacheMs: cfg.cacheMs, ready: issues.length === 0, issues };
  }

  static clearCache() { cache.clear(); }

  static _key(chainId, tokenAddress) { return `${chainId}:${String(tokenAddress || NATIVE_TOKEN).toLowerCase()}`; }

  /** Spot price and decimals for a token; native when tokenAddress is omitted. */
  static async getPrice({ chainId, tokenAddress } = {}) {
    const cfg = this.getConfig();
    if (!cfg.enabled) throw Object.assign(new Error('price oracle disabled'), { status: 503 });
    if (!cfg.secretKey) throw Object.assign(new Error('THIRDWEB_SECRET_KEY is required for price lookups'), { status: 503 });
    const chain = Number(chainId);
    if (!Number.isInteger(chain) || chain <= 0) throw new Error('chainId required');
    const token = tokenAddress || NATIVE_TOKEN;
    const key = this._key(chain, token);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.fetchedAt < cfg.cacheMs) return hit;

    const query = new URLSearchParams({ chainId: String(chain), tokenAddress: token, limit: '1' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    let response;
    try {
      response = await fetch(`${cfg.apiUrl}/v1/tokens?${query}`, { headers: { 'x-secret-key': cfg.secretKey }, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.error) {
      const detail = json.error ? (json.error.message || JSON.stringify(json.error)) : response.statusText;
      throw Object.assign(new Error(`thirdweb price lookup failed (${response.status}): ${detail}`), { status: 502 });
    }
    const result = json.result || json;
    const row = (result.tokens || [])[0];
    const priceUsd = row ? Number(row.priceUsd ?? (row.prices && row.prices.USD)) : NaN;
    if (!row || !Number.isFinite(priceUsd) || priceUsd <= 0) {
      throw Object.assign(new Error(`no USD price for ${token} on chain ${chain}`), { status: 422, code: 'PRICE_UNAVAILABLE' });
    }
    const priceTimestamp = row.priceTimestamp || (row.price_data && row.price_data.price_timestamp) || null;
    if (priceTimestamp && Date.now() - new Date(priceTimestamp).getTime() > cfg.maxAgeMs) {
      throw Object.assign(new Error(`USD price for ${row.symbol} is stale (${priceTimestamp})`), { status: 422, code: 'PRICE_STALE' });
    }
    const quote = {
      chainId: chain,
      tokenAddress: row.address || token,
      symbol: row.symbol,
      decimals: Number(row.decimals),
      priceUsd,
      priceTimestamp,
      source: 'thirdweb',
      fetchedAt: Date.now(),
    };
    cache.set(key, quote);
    return quote;
  }

  /** USD value of `quantity` smallest units. */
  static async quoteUsd({ chainId, tokenAddress, quantity } = {}) {
    const price = await this.getPrice({ chainId, tokenAddress });
    const units = BigInt(quantity);
    if (units < 0n) throw new Error('quantity must be non-negative');
    const scale = 10n ** BigInt(price.decimals);
    const whole = units / scale;
    const frac = units % scale;
    const amount = Number(whole) + Number(frac) / Number(scale);
    const amountUsd = Math.round(amount * price.priceUsd * 100) / 100;
    return { ...price, quantity: units.toString(), amount, amountUsd };
  }

  /** Smallest units needed to cover `amountUsd` at the current price. */
  static async quantityForUsd({ chainId, tokenAddress, amountUsd } = {}) {
    const price = await this.getPrice({ chainId, tokenAddress });
    const usd = Number(amountUsd);
    if (!Number.isFinite(usd) || usd <= 0) throw new Error('amountUsd must be a positive number');
    const amount = usd / price.priceUsd;
    const scaled = BigInt(Math.round(amount * 10 ** Math.min(price.decimals, 15)));
    const quantity = price.decimals > 15 ? scaled * 10n ** BigInt(price.decimals - 15) : scaled;
    return { ...price, amountUsd: usd, amount, quantity: quantity.toString() };
  }
}

module.exports = { ThirdwebPriceOracle, NATIVE_TOKEN };
