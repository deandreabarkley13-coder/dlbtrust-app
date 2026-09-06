'use strict';

const status = document.getElementById('status');

getSettings().then(({ baseUrl, token }) => {
  document.getElementById('baseUrl').value = baseUrl;
  document.getElementById('token').value = token;
});

document.getElementById('save').addEventListener('click', async () => {
  const baseUrl = document.getElementById('baseUrl').value.trim() || DEFAULT_BASE_URL;
  const token = document.getElementById('token').value.trim();
  await chrome.storage.local.set({ baseUrl, token });
  status.textContent = 'Saved.';
});

document.getElementById('test').addEventListener('click', async () => {
  status.textContent = 'Testing…';
  try {
    const r = await api('/api/dapp/thirdweb/settlement/readiness');
    status.textContent = `Connected. thirdweb settlement ${r.live ? 'LIVE' : 'shadow'}; ${r.issues.length ? r.issues.join('; ') : 'no issues'}.`;
  } catch (e) {
    status.textContent = `Failed: ${e.message}`;
  }
});
