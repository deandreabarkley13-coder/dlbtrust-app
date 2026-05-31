/**
 * DLB Trust — Private Wealth Management Dashboard
 * Frontend integrating with Core Banking Engine API
 */

const API_BASE = window.location.origin.includes('devinapps.com')
  ? '' // Same-origin if served via proxy
  : 'https://user:b114c30032cca392bcba6d9715de5182@9d72b291ab2c-tunnel-i1m085wt.devinapps.com';

// Use relative path if frontend is served from same origin as API
const API = '/api';

// --- Utilities ---

function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function formatUSD(cents) {
  if (cents === null || cents === undefined) return '$0.00';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function badge(status) {
  const cls = `badge badge-${status || 'pending'}`;
  return `<span class="${cls}">${status || 'unknown'}</span>`;
}

function showToast(message, type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

async function api(path, options = {}) {
  try {
    const res = await fetch(`${API}${path}`, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  } catch (err) {
    console.error(`API Error: ${path}`, err);
    throw err;
  }
}

// --- Navigation ---

$$('.nav-links a').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const view = link.dataset.view;
    $$('.nav-links a').forEach(a => a.classList.remove('active'));
    link.classList.add('active');
    $$('.view').forEach(v => v.classList.remove('active'));
    $(`#view-${view}`).classList.add('active');
    loadView(view);
  });
});

function loadView(view) {
  switch (view) {
    case 'dashboard': loadDashboard(); break;
    case 'accounts': loadAccounts(); break;
    case 'transfers': loadTransfers(); break;
    case 'compliance': loadCompliance(); break;
    case 'activity': loadActivity(); break;
  }
}

// --- Dashboard ---

async function loadDashboard() {
  $('#dashboard-time').textContent = `Updated ${new Date().toLocaleTimeString()}`;

  try {
    const [netWorth, accounts, transfers, compliance, trialBalance] = await Promise.all([
      api('/wealth/net-worth'),
      api('/accounts'),
      api('/transfers'),
      api('/wealth/compliance'),
      api('/accounts/trial-balance'),
    ]);

    // Metrics
    $('#net-worth').textContent = `$${Number(netWorth.net_worth_usd || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
    const activeCount = (accounts.accounts || []).filter(a => a.status === 'active').length;
    $('#active-accounts').textContent = activeCount;
    const pendingCount = (transfers.transfers || []).filter(t => t.status === 'pending').length;
    $('#pending-transfers').textContent = pendingCount;
    $('#compliance-issues').textContent = compliance.total_issues || 0;

    // Account Balances Chart
    renderBalanceChart(accounts.accounts || []);

    // Recent Activity (from audit log)
    try {
      const audit = await api('/accounts/audit-log');
      renderRecentActivity(audit.entries || []);
    } catch (e) {
      $('#recent-activity').innerHTML = '<p style="color:var(--text-secondary)">No activity yet</p>';
    }

    // Trial Balance
    renderTrialBalance(trialBalance);
  } catch (err) {
    showToast('Failed to load dashboard: ' + err.message, 'error');
  }
}

function renderBalanceChart(accounts) {
  const active = accounts.filter(a => a.status !== 'closed').sort((a, b) => b.balance_cents - a.balance_cents);
  const maxBal = Math.max(...active.map(a => a.balance_cents), 1);

  let html = '<div class="bar-chart">';
  for (const acct of active.slice(0, 8)) {
    const pct = Math.max(2, (acct.balance_cents / maxBal) * 100);
    html += `
      <div class="bar-row">
        <span class="bar-label" title="${acct.account_name}">${acct.account_name}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <span class="bar-value">${formatUSD(acct.balance_cents)}</span>
      </div>`;
  }
  html += '</div>';
  $('#account-balances-chart').innerHTML = html;
}

function renderRecentActivity(entries) {
  if (!entries.length) {
    $('#recent-activity').innerHTML = '<p style="color:var(--text-secondary)">No activity</p>';
    return;
  }
  let html = '';
  for (const e of entries.slice(0, 10)) {
    html += `<div class="activity-item">
      <strong>${e.event_type}</strong> — ${e.action} on ${e.entity_type} #${e.entity_id}
      <div class="activity-time">${formatTime(e.created_at)} by ${e.actor}</div>
    </div>`;
  }
  $('#recent-activity').innerHTML = html;
}

function renderTrialBalance(tb) {
  $('#trial-balance-summary').innerHTML = `
    <div class="trial-item">
      <div class="trial-label">Total Assets</div>
      <div class="trial-value" style="color:var(--success)">${formatUSD(tb.total_assets_cents)}</div>
    </div>
    <div class="trial-item">
      <div class="trial-label">Total Liabilities</div>
      <div class="trial-value" style="color:var(--danger)">${formatUSD(tb.total_liabilities_cents)}</div>
    </div>
    <div class="trial-item">
      <div class="trial-label">Net Position</div>
      <div class="trial-value" style="color:var(--accent)">${formatUSD(tb.net_position_cents)}</div>
    </div>`;
}

// --- Accounts ---

async function loadAccounts() {
  try {
    const data = await api('/accounts');
    const accounts = data.accounts || [];

    let html = `<table>
      <thead><tr>
        <th>Account</th><th>Type</th><th>Status</th><th>Balance</th><th>Available</th><th>Interest</th><th>KYC</th><th>Actions</th>
      </tr></thead><tbody>`;

    for (const a of accounts) {
      html += `<tr>
        <td><strong>${a.account_number}</strong><br><small style="color:var(--text-secondary)">${a.account_name}</small></td>
        <td>${a.account_type}</td>
        <td>${badge(a.status)}</td>
        <td>${formatUSD(a.balance_cents)}</td>
        <td>${formatUSD(a.available_cents)}</td>
        <td>${a.interest_rate_bps || 0} bps</td>
        <td>${badge(a.kyc_status)}</td>
        <td>${accountActions(a)}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    $('#accounts-table').innerHTML = html;
  } catch (err) {
    $('#accounts-table').innerHTML = `<p style="padding:20px;color:var(--danger)">Error: ${err.message}</p>`;
  }
}

function accountActions(acct) {
  let btns = '';
  if (acct.status === 'pending') {
    btns += `<button class="btn btn-sm btn-success" onclick="activateAccount(${acct.id})">Activate</button> `;
  }
  if (acct.status === 'active') {
    btns += `<button class="btn btn-sm" onclick="freezeAccount(${acct.id})">Freeze</button> `;
    btns += `<button class="btn btn-sm" onclick="accrueInterest(${acct.id})">Accrue</button> `;
  }
  if (acct.status === 'frozen') {
    btns += `<button class="btn btn-sm btn-success" onclick="activateAccount(${acct.id})">Unfreeze</button> `;
  }
  return btns || '—';
}

async function activateAccount(id) {
  try {
    await api(`/accounts/${id}/activate`, { method: 'POST' });
    showToast('Account activated');
    loadAccounts();
  } catch (err) { showToast(err.message, 'error'); }
}

async function freezeAccount(id) {
  try {
    await api(`/accounts/${id}/freeze`, { method: 'POST', body: JSON.stringify({ reason: 'Administrative' }) });
    showToast('Account frozen');
    loadAccounts();
  } catch (err) { showToast(err.message, 'error'); }
}

async function accrueInterest(id) {
  try {
    const data = await api(`/accounts/${id}/interest/accrue`, { method: 'POST' });
    const cents = data.accrual?.accrued_cents || data.accrued_cents || 0;
    showToast(`Interest accrued: ${formatUSD(cents)}`);
    loadAccounts();
  } catch (err) { showToast(err.message, 'error'); }
}

function showCreateAccount() {
  $('#create-account-modal').classList.remove('hidden');
}

async function createAccount(e) {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    await api('/accounts', {
      method: 'POST',
      body: JSON.stringify({
        account_name: form.get('account_name'),
        account_type: form.get('account_type'),
        owner_type: form.get('owner_type'),
        balance_cents: Math.round(parseFloat(form.get('balance')) * 100),
        interest_rate_bps: parseInt(form.get('interest_rate_bps')),
      }),
    });
    showToast('Account created');
    hideModal('create-account-modal');
    e.target.reset();
    loadAccounts();
  } catch (err) { showToast(err.message, 'error'); }
}

// --- Transfers ---

async function loadTransfers() {
  try {
    const data = await api('/transfers');
    const transfers = data.transfers || [];

    let html = `<table>
      <thead><tr>
        <th>Transfer #</th><th>Type</th><th>Amount</th><th>Status</th><th>From → To</th><th>Date</th><th>Actions</th>
      </tr></thead><tbody>`;

    for (const t of transfers) {
      html += `<tr>
        <td><strong>${t.transfer_number}</strong></td>
        <td>${t.transfer_type}</td>
        <td>${formatUSD(t.amount_cents)}</td>
        <td>${badge(t.status)}</td>
        <td>#${t.from_account_id} → #${t.to_account_id}</td>
        <td>${formatDate(t.created_at)}</td>
        <td>${transferActions(t)}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    $('#transfers-table').innerHTML = html;
  } catch (err) {
    $('#transfers-table').innerHTML = `<p style="padding:20px;color:var(--danger)">Error: ${err.message}</p>`;
  }
}

function transferActions(t) {
  let btns = '';
  if (t.status === 'pending') {
    btns += `<button class="btn btn-sm btn-success" onclick="approveTransfer(${t.id})">Approve</button> `;
    btns += `<button class="btn btn-sm btn-danger" onclick="cancelTransfer(${t.id})">Cancel</button> `;
  }
  if (t.status === 'approved') {
    btns += `<button class="btn btn-sm btn-primary" onclick="executeTransfer(${t.id})">Execute</button> `;
  }
  return btns || '—';
}

async function approveTransfer(id) {
  try {
    await api(`/transfers/${id}/approve`, { method: 'POST', body: JSON.stringify({ approved_by: 'dashboard_user' }) });
    showToast('Transfer approved');
    loadTransfers();
  } catch (err) { showToast(err.message, 'error'); }
}

async function executeTransfer(id) {
  try {
    await api(`/transfers/${id}/execute`, { method: 'POST' });
    showToast('Transfer executed');
    loadTransfers();
    loadDashboard();
  } catch (err) { showToast(err.message, 'error'); }
}

async function cancelTransfer(id) {
  try {
    await api(`/transfers/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'Cancelled by user' }) });
    showToast('Transfer cancelled');
    loadTransfers();
  } catch (err) { showToast(err.message, 'error'); }
}

async function showCreateTransfer() {
  // Populate account dropdowns
  const data = await api('/accounts');
  const active = (data.accounts || []).filter(a => a.status === 'active');

  const opts = active.map(a => `<option value="${a.id}">${a.account_number} — ${a.account_name} (${formatUSD(a.balance_cents)})</option>`).join('');
  $('#transfer-from').innerHTML = opts;
  $('#transfer-to').innerHTML = opts;
  $('#create-transfer-modal').classList.remove('hidden');
}

async function createTransfer(e) {
  e.preventDefault();
  const form = new FormData(e.target);
  try {
    const data = await api('/transfers', {
      method: 'POST',
      body: JSON.stringify({
        from_account_id: parseInt(form.get('from_account_id')),
        to_account_id: parseInt(form.get('to_account_id')),
        amount_cents: Math.round(parseFloat(form.get('amount')) * 100),
        transfer_type: form.get('transfer_type'),
        description: form.get('description') || null,
      }),
    });
    const msg = data.auto_approved ? 'Transfer auto-approved' : 'Transfer created (pending approval)';
    showToast(msg);
    hideModal('create-transfer-modal');
    e.target.reset();
    loadTransfers();
  } catch (err) { showToast(err.message, 'error'); }
}

// --- Compliance ---

async function loadCompliance() {
  try {
    const [compliance, accounts] = await Promise.all([
      api('/wealth/compliance'),
      api('/accounts'),
    ]);

    // Compliance Issues
    const issues = compliance.issues || [];
    let issueHtml = '';
    if (issues.length === 0) {
      issueHtml = '<p style="color:var(--success)">No compliance issues</p>';
    } else {
      for (const issue of issues) {
        const cls = issue.severity === 'high' ? 'critical' : '';
        issueHtml += `<div class="issue-item ${cls}">
          <strong>${issue.type || issue.issue_type || 'Issue'}</strong>: ${issue.description || issue.message || JSON.stringify(issue)}
        </div>`;
      }
    }
    $('#compliance-list').innerHTML = issueHtml;

    // KYC Status
    const accts = accounts.accounts || [];
    let kycHtml = '<table><thead><tr><th>Account</th><th>KYC Status</th><th>AML Risk</th></tr></thead><tbody>';
    for (const a of accts) {
      kycHtml += `<tr>
        <td>${a.account_number}</td>
        <td>${badge(a.kyc_status)}</td>
        <td><span class="badge badge-${a.aml_risk_rating === 'high' ? 'closed' : 'active'}">${a.aml_risk_rating}</span></td>
      </tr>`;
    }
    kycHtml += '</tbody></table>';
    $('#kyc-status-list').innerHTML = kycHtml;

    // Tax Events
    try {
      const tax = await api('/wealth/tax-center');
      $('#tax-events-list').innerHTML = `<p style="color:var(--text-secondary)">Tax year: ${tax.tax_year || new Date().getFullYear()}<br>
        Interest income events: ${tax.interest_events?.length || 0}<br>
        Distribution events: ${tax.distribution_events?.length || 0}</p>`;
    } catch (e) {
      $('#tax-events-list').innerHTML = '<p style="color:var(--text-secondary)">No tax events</p>';
    }
  } catch (err) {
    showToast('Failed to load compliance: ' + err.message, 'error');
  }
}

// --- Activity / Audit Log ---

async function loadActivity() {
  try {
    const data = await api('/accounts/audit-log');
    const entries = data.entries || [];

    let html = `<table>
      <thead><tr><th>Time</th><th>Event</th><th>Entity</th><th>Action</th><th>Actor</th><th>Details</th></tr></thead><tbody>`;

    for (const e of entries) {
      let details = '';
      try { details = typeof e.details === 'string' ? e.details : JSON.stringify(e.details); } catch (_) {}
      html += `<tr>
        <td>${formatTime(e.created_at)}</td>
        <td><strong>${e.event_type}</strong></td>
        <td>${e.entity_type} #${e.entity_id}</td>
        <td>${e.action}</td>
        <td>${e.actor}</td>
        <td><small style="color:var(--text-secondary)">${details.slice(0, 60)}</small></td>
      </tr>`;
    }
    html += '</tbody></table>';
    $('#audit-log-table').innerHTML = html;
  } catch (err) {
    $('#audit-log-table').innerHTML = `<p style="padding:20px;color:var(--danger)">Error: ${err.message}</p>`;
  }
}

// --- Helpers ---

function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// --- Init ---

document.addEventListener('DOMContentLoaded', () => {
  loadDashboard();

  // Check API connectivity
  api('/accounts').then(() => {
    $('#api-status').textContent = 'Connected';
    $('.dot').style.background = 'var(--success)';
  }).catch(() => {
    $('#api-status').textContent = 'Disconnected';
    $('.dot').style.background = 'var(--danger)';
  });
});
