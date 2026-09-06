'use strict';

const DEFAULT_BASE_URL = 'https://p01--dlbtrust-app--gcq8bn6c4zlp.code.run';

async function getSettings() {
  const stored = await chrome.storage.local.get(['baseUrl', 'token']);
  return { baseUrl: (stored.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''), token: stored.token || '' };
}

async function api(path, opts = {}) {
  const { baseUrl, token } = await getSettings();
  if (!token) throw new Error('No operator token saved. Open the extension options.');
  const res = await fetch(baseUrl + path, {
    method: opts.method || 'GET',
    headers: { 'x-admin-token': token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    cache: 'no-store',
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`${res.status}: ${text.slice(0, 200)}`); }
  if (!res.ok || json.success === false) throw new Error(json.error || `HTTP ${res.status}`);
  return json.data;
}

const usd = (n) => Number(n || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
