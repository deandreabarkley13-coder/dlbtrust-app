'use strict';

const el = (id) => document.getElementById(id);
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '—');

function setStatus(text, isError) {
  el('status').textContent = text || '';
  el('status').style.color = isError ? '#ef4444' : '#94a3b8';
}

function renderPayables(target, items, kind) {
  if (!items.length) { target.innerHTML = '<span class="muted">Nothing awaiting settlement.</span>'; return; }
  target.innerHTML = '';
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'row';
    const who = kind === 'distribution' ? item.beneficiary : item.payee;
    const note = kind === 'distribution' ? item.memo : item.description;
    row.innerHTML = `
      <div>
        <div><span class="amt">${usd(item.amountUsd)}</span> <span class="muted">${item.status}</span></div>
        <div class="meta" title="${item.id}">${who || item.id} · ${short(item.destination)}${note ? ` · ${note}` : ''}</div>
      </div>`;
    const btn = document.createElement('button');
    btn.className = 'act';
    btn.textContent = item.thirdwebTransferId ? 'Sent' : 'Settle';
    btn.disabled = !item.canSettle;
    btn.title = item.canSettle ? 'Send via thirdweb server wallet' : (item.destination ? 'Not approved yet' : 'No EVM destination address');
    btn.addEventListener('click', () => settle(kind, item, btn));
    row.appendChild(btn);
    target.appendChild(row);
  }
}

function renderOpen(target, transfers) {
  if (!transfers.length) { target.innerHTML = '<span class="muted">No transfers awaiting confirmation.</span>'; return; }
  target.innerHTML = '';
  for (const t of transfers) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div>
        <div><span class="amt">${t.amountUsd != null ? usd(t.amountUsd) : `${t.quantity} units`}</span> <span class="muted">${t.status}${t.shadow ? ' (shadow)' : ''}</span></div>
        <div class="meta">${t.purpose || ''} → ${short(t.to)} · ${t.reference || t.id}</div>
      </div>
      <span class="muted">${t.transactionId ? short(t.transactionId) : ''}</span>`;
    target.appendChild(row);
  }
}

async function settle(kind, item, btn) {
  const live = el('mode').classList.contains('live');
  const prompt = `${live ? 'LIVE: broadcast' : 'Shadow: record'} ${usd(item.amountUsd)} to ${item.destination} via thirdweb?`;
  if (!confirm(prompt)) return;
  btn.disabled = true;
  setStatus(`Settling ${item.id}…`);
  try {
    const path = kind === 'distribution' ? `/api/dapp/thirdweb/settlement/distributions/${item.id}` : `/api/dapp/thirdweb/settlement/expenses/${item.id}`;
    const result = await api(path, { method: 'POST', body: {} });
    const t = result.transfer || {};
    setStatus(`${item.id}: ${t.status || 'ok'}${t.transactionId ? ` · tx ${t.transactionId}` : ''}${t.reason ? `\n${t.reason}` : ''}`);
    await load();
  } catch (e) {
    setStatus(e.message, true);
    btn.disabled = false;
  }
}

async function load() {
  setStatus('Loading…');
  try {
    const [queue, summary] = await Promise.all([
      api('/api/dapp/thirdweb/settlement/queue?limit=100'),
      api('/api/trust-ops/summary').catch(() => null),
    ]);
    const r = queue.readiness;
    el('mode').textContent = r.live ? 'LIVE' : 'SHADOW';
    el('mode').className = `pill ${r.live ? 'live' : 'shadow'}`;
    el('issues').textContent = r.issues.length ? r.issues.join(' · ') : '';
    if (summary) {
      el('k-net').textContent = usd(summary.netWorth);
      el('k-cash').textContent = usd(summary.bySource?.cash?.balance);
      el('k-bonds').textContent = usd(summary.bondValue);
    }
    el('k-wallet').textContent = short(r.serverWallet.address);
    if (r.serverWallet.address) {
      api(`/api/dapp/thirdweb/server-wallet/balance?tokenAddress=${encodeURIComponent(r.settlementToken || '')}`)
        .then((b) => { if (b && b.displayValue != null) el('k-wallet').textContent = `${Number(b.displayValue).toLocaleString()} ${b.symbol || ''}`; })
        .catch(() => undefined);
    }
    el('c-dist').textContent = `(${queue.counts.distributionsAwaiting})`;
    el('c-exp').textContent = `(${queue.counts.expensesAwaiting})`;
    el('c-open').textContent = `(${queue.counts.openTransfers})`;
    renderPayables(el('dist'), queue.distributions, 'distribution');
    renderPayables(el('exp'), queue.expenses, 'expense');
    renderOpen(el('open'), queue.openTransfers);
    setStatus(`Live as of ${new Date(queue.asOf).toLocaleTimeString()}`);
    chrome.runtime.sendMessage({ type: 'refresh' }, () => chrome.runtime.lastError);
  } catch (e) {
    setStatus(e.message, true);
  }
}

el('refresh').addEventListener('click', load);
el('options').addEventListener('click', (ev) => { ev.preventDefault(); chrome.runtime.openOptionsPage(); });
el('reconcile').addEventListener('click', async () => {
  setStatus('Reconciling with thirdweb…');
  try {
    const r = await api('/api/dapp/thirdweb/settlement/reconcile', { method: 'POST', body: {} });
    setStatus(`Checked ${r.checked} transfer(s); ${r.results.filter((x) => x.applied).length} finalized.`);
    await load();
  } catch (e) { setStatus(e.message, true); }
});

load();
