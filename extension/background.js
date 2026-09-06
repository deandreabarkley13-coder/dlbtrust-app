'use strict';

importScripts('api.js');

const ALARM = 'dlb-settlement-poll';

async function refreshBadge() {
  try {
    const queue = await api('/api/dapp/thirdweb/settlement/queue?limit=100');
    const pending = queue.counts.distributionsAwaiting + queue.counts.expensesAwaiting + queue.counts.openTransfers;
    await chrome.action.setBadgeText({ text: pending ? String(pending) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: queue.readiness.live ? '#10b981' : '#f59e0b' });
    await chrome.storage.local.set({ lastQueue: queue, lastError: null, lastPoll: Date.now() });
  } catch (e) {
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    await chrome.storage.local.set({ lastError: e.message, lastPoll: Date.now() });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  refreshBadge();
});
chrome.runtime.onStartup.addListener(refreshBadge);
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === ALARM) refreshBadge(); });
chrome.storage.onChanged.addListener((changes) => { if (changes.token || changes.baseUrl) refreshBadge(); });
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === 'refresh') { refreshBadge().then(() => reply({ ok: true })); return true; }
  return false;
});
