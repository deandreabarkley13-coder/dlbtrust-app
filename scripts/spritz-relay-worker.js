// Cloudflare Worker: relays dlbtrust-app -> https://platform.spritz.finance.
// Mirrors scripts/spritz-relay.cjs. The app sends the Spritz key in
// `x-spritz-key` and the shared relay secret in `Authorization` (SPRITZ_PROXY_AUTH);
// the worker checks the relay secret, then forwards with `Authorization: Bearer <key>`.
// Deploy: scripts/deploy-spritz-relay-worker.sh (needs CLOUDFLARE_API_TOKEN, RELAY_AUTH).
const TARGET = 'https://platform.spritz.finance';
const HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'cf-connecting-ip', 'cf-ray', 'cf-visitor', 'cf-ipcountry', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip'];

export default {
  async fetch(request, env) {
    if (env.RELAY_AUTH && request.headers.get('authorization') !== env.RELAY_AUTH) {
      return new Response('Unauthorized', { status: 401 });
    }
    const url = new URL(request.url);
    const target = new URL(url.pathname + url.search, TARGET);
    const headers = new Headers(request.headers);
    for (const h of HOP) headers.delete(h);
    headers.delete('authorization');
    const key = headers.get('x-spritz-key');
    headers.delete('x-spritz-key');
    if (key) headers.set('authorization', `Bearer ${key}`);
    const init = { method: request.method, headers, redirect: 'manual' };
    if (!['GET', 'HEAD'].includes(request.method)) init.body = request.body;
    return fetch(target, init);
  },
};
