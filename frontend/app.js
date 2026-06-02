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
    case 'contacts': loadContacts(); break;
    case 'payments': loadPayments(); break;
    case 'accounting': loadAccounting(); break;
    case 'blockchain': loadBlockchain(); break;
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

// --- Contacts / CRM ---

async function loadContacts() {
  try {
    const filter = document.getElementById('contact-filter')?.value || '';
    const typeParam = filter ? `?type=${filter}` : '';

    const [contactsData, dashboard] = await Promise.all([
      api(`/crm/contacts${typeParam}`),
      api('/crm/dashboard'),
    ]);

    // CRM Metrics
    const byType = {};
    (dashboard.by_type || []).forEach(t => { byType[t.contact_type] = t.count; });

    document.getElementById('crm-metrics').innerHTML = `
      <div class="metric-card primary">
        <span class="metric-label">Total Contacts</span>
        <span class="metric-value">${dashboard.total_contacts || 0}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Trustees</span>
        <span class="metric-value">${byType.trustee || 0}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Beneficiaries</span>
        <span class="metric-value">${byType.beneficiary || 0}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Vendors</span>
        <span class="metric-value">${byType.vendor || 0}</span>
      </div>
      <div class="metric-card warn">
        <span class="metric-label">Pending KYC</span>
        <span class="metric-value">${dashboard.pending_kyc || 0}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Payment Methods</span>
        <span class="metric-value">${dashboard.total_payment_methods || 0}</span>
      </div>`;

    // Contacts Table
    const contacts = contactsData.contacts || [];
    let html = `<table>
      <thead><tr>
        <th>Name</th><th>Type</th><th>Email</th><th>Phone</th><th>Status</th><th>KYC</th><th>Actions</th>
      </tr></thead><tbody>`;

    if (contacts.length === 0) {
      html += '<tr><td colspan="7" style="text-align:center;color:var(--text-secondary);padding:40px">No contacts yet. Click "+ New Contact" to add your first trustee, beneficiary, or vendor.</td></tr>';
    } else {
      for (const c of contacts) {
        const typeBadge = c.contact_type === 'trustee' ? 'badge-frozen' : c.contact_type === 'vendor' ? 'badge-reversed' : 'badge-approved';
        html += `<tr style="cursor:pointer" onclick="viewContact(${c.id})">
          <td><strong>${c.display_name || (c.first_name + ' ' + c.last_name)}</strong>
            ${c.company_name ? `<br><small style="color:var(--text-secondary)">${c.company_name}</small>` : ''}</td>
          <td><span class="badge ${typeBadge}">${c.contact_type}</span></td>
          <td>${c.email || '—'}</td>
          <td>${c.phone || '—'}</td>
          <td>${badge(c.status)}</td>
          <td>${badge(c.kyc_status)}</td>
          <td>
            <button class="btn btn-sm" onclick="event.stopPropagation();viewContact(${c.id})">View</button>
            <button class="btn btn-sm" onclick="event.stopPropagation();showAddPayment(${c.id})">+ Payment</button>
            ${c.status === 'active' ? `<button class="btn btn-sm btn-danger" onclick="event.stopPropagation();deactivateContact(${c.id})">Deactivate</button>` : ''}
          </td>
        </tr>`;
      }
    }
    html += '</tbody></table>';
    document.getElementById('contacts-table').innerHTML = html;

    // Hide detail panel when reloading list
    document.getElementById('contact-detail-panel').classList.add('hidden');
  } catch (err) {
    document.getElementById('contacts-table').innerHTML = `<p style="padding:20px;color:var(--danger)">Error: ${err.message}</p>`;
  }
}

async function viewContact(id) {
  try {
    const c = await api(`/crm/contacts/${id}`);
    const panel = document.getElementById('contact-detail-panel');
    panel.classList.remove('hidden');

    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3 style="margin:0">${c.display_name || (c.first_name + ' ' + c.last_name)}</h3>
        <button class="btn btn-sm" onclick="document.getElementById('contact-detail-panel').classList.add('hidden')">Close</button>
      </div>
      <div class="panels-row">
        <div>
          <p><strong>Type:</strong> ${badge(c.contact_type)}</p>
          <p><strong>Status:</strong> ${badge(c.status)}</p>
          <p><strong>Email:</strong> ${c.email || '—'}</p>
          <p><strong>Phone:</strong> ${c.phone || '—'}</p>
          ${c.company_name ? `<p><strong>Company:</strong> ${c.company_name}</p>` : ''}
          ${c.address_line1 ? `<p><strong>Address:</strong> ${c.address_line1}${c.city ? ', ' + c.city : ''}${c.state ? ', ' + c.state : ''} ${c.zip || ''}</p>` : ''}
          <p><strong>KYC:</strong> ${badge(c.kyc_status)} | <strong>AML Risk:</strong> ${c.aml_risk_rating}</p>
        </div>
        <div>`;

    // Type-specific fields
    if (c.contact_type === 'beneficiary') {
      html += `<p><strong>Class:</strong> ${c.beneficiary_class || '—'}</p>
               <p><strong>Distribution %:</strong> ${c.distribution_pct || 0}%</p>`;
    } else if (c.contact_type === 'trustee') {
      html += `<p><strong>Role:</strong> ${c.trustee_role || '—'}</p>
               <p><strong>Start:</strong> ${formatDate(c.trustee_start_date)}</p>`;
    } else if (c.contact_type === 'vendor') {
      html += `<p><strong>Category:</strong> ${c.vendor_category || '—'}</p>
               <p><strong>Terms:</strong> ${c.payment_terms || '—'}</p>`;
    }

    html += `</div></div>`;

    // Payment Methods
    const pms = c.payment_methods || [];
    html += `<h4 style="margin:16px 0 8px">Payment Methods (${pms.length})</h4>`;
    if (pms.length) {
      html += '<table><thead><tr><th>Label</th><th>Type</th><th>Bank</th><th>Account</th><th>Default</th><th>Verified</th></tr></thead><tbody>';
      for (const pm of pms) {
        html += `<tr>
          <td>${pm.label}</td>
          <td>${pm.method_type.toUpperCase()}</td>
          <td>${pm.bank_name || '—'}</td>
          <td>${pm.account_number || '—'} (${pm.account_type || ''})</td>
          <td>${pm.is_default ? '<span style="color:var(--success)">Yes</span>' : 'No'}</td>
          <td>${pm.verified ? '<span style="color:var(--success)">Verified</span>' : '<span style="color:var(--warning)">Pending</span>'}</td>
        </tr>`;
      }
      html += '</tbody></table>';
    } else {
      html += '<p style="color:var(--text-secondary)">No payment methods configured</p>';
    }
    html += `<button class="btn btn-sm btn-primary" style="margin-top:8px" onclick="showAddPayment(${id})">+ Add Payment Method</button>`;

    // Relationships
    const rels = c.relationships || [];
    html += `<h4 style="margin:16px 0 8px">Account Relationships (${rels.length})</h4>`;
    if (rels.length) {
      html += '<table><thead><tr><th>Relationship</th><th>Account</th><th>Role</th><th>Share %</th><th>Status</th></tr></thead><tbody>';
      for (const r of rels) {
        html += `<tr>
          <td>${r.relationship_type}</td>
          <td>${r.account_number || '—'} — ${r.account_name || '—'}</td>
          <td>${r.role_detail || '—'}</td>
          <td>${r.share_pct != null ? r.share_pct + '%' : '—'}</td>
          <td>${badge(r.status)}</td>
        </tr>`;
      }
      html += '</tbody></table>';
    } else {
      html += '<p style="color:var(--text-secondary)">No account relationships</p>';
    }

    // Documents
    const docs = c.documents || [];
    html += `<h4 style="margin:16px 0 8px">Documents (${docs.length})</h4>`;
    if (docs.length) {
      html += '<table><thead><tr><th>Type</th><th>Name</th><th>Issued</th><th>Expires</th><th>Status</th></tr></thead><tbody>';
      for (const d of docs) {
        html += `<tr>
          <td>${d.document_type}</td>
          <td>${d.document_name}</td>
          <td>${formatDate(d.issue_date)}</td>
          <td>${formatDate(d.expiry_date)}</td>
          <td>${badge(d.status)}</td>
        </tr>`;
      }
      html += '</tbody></table>';
    } else {
      html += '<p style="color:var(--text-secondary)">No documents on file</p>';
    }

    // Recent Notes
    const notes = c.recent_notes || [];
    html += `<h4 style="margin:16px 0 8px">Recent Notes (${notes.length})</h4>`;
    if (notes.length) {
      for (const n of notes) {
        html += `<div class="activity-item">
          <strong>${n.subject || n.note_type}</strong> — ${n.body}
          <div class="activity-time">${formatTime(n.created_at)} by ${n.created_by}</div>
        </div>`;
      }
    } else {
      html += '<p style="color:var(--text-secondary)">No notes</p>';
    }

    document.getElementById('contact-detail-content').innerHTML = html;
    panel.scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    showToast('Failed to load contact: ' + err.message, 'error');
  }
}

function toggleContactFields() {
  const type = document.getElementById('new-contact-type').value;
  document.getElementById('beneficiary-fields').classList.toggle('hidden', type !== 'beneficiary');
  document.getElementById('trustee-fields').classList.toggle('hidden', type !== 'trustee');
  document.getElementById('vendor-fields').classList.toggle('hidden', type !== 'vendor');
}

function showCreateContact() {
  document.getElementById('create-contact-modal').classList.remove('hidden');
  toggleContactFields();
}

async function createContact(e) {
  e.preventDefault();
  const form = new FormData(e.target);
  const body = {};
  for (const [k, v] of form.entries()) {
    if (v !== '') body[k] = v;
  }
  if (body.distribution_pct) body.distribution_pct = parseFloat(body.distribution_pct);
  if (body.is_default) body.is_default = 1;

  try {
    await api('/crm/contacts', { method: 'POST', body: JSON.stringify(body) });
    showToast('Contact created');
    hideModal('create-contact-modal');
    e.target.reset();
    loadContacts();
  } catch (err) { showToast(err.message, 'error'); }
}

async function deactivateContact(id) {
  if (!confirm('Deactivate this contact?')) return;
  try {
    await api(`/crm/contacts/${id}`, { method: 'DELETE' });
    showToast('Contact deactivated');
    loadContacts();
  } catch (err) { showToast(err.message, 'error'); }
}

function showAddPayment(contactId) {
  document.getElementById('pm-contact-id').value = contactId;
  document.getElementById('add-payment-modal').classList.remove('hidden');
}

async function addPaymentMethod(e) {
  e.preventDefault();
  const form = new FormData(e.target);
  const contactId = form.get('contact_id');
  const body = {};
  for (const [k, v] of form.entries()) {
    if (k !== 'contact_id' && v !== '') body[k] = v;
  }
  body.is_default = form.has('is_default') ? 1 : 0;

  try {
    await api(`/crm/contacts/${contactId}/payment-methods`, { method: 'POST', body: JSON.stringify(body) });
    showToast('Payment method added');
    hideModal('add-payment-modal');
    e.target.reset();
    viewContact(contactId);
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

// --- External Payments ---

async function loadPayments() {
  try {
    const filter = document.getElementById('payment-status-filter')?.value || '';
    const statusParam = filter ? `?status=${filter}` : '';

    const [paymentsData, summary] = await Promise.all([
      api(`/external-transfers${statusParam}`),
      api('/external-transfers/summary'),
    ]);

    // Metrics
    document.getElementById('payment-metrics').innerHTML = `
      <div class="metric-card primary">
        <span class="metric-label">Total Paid</span>
        <span class="metric-value">$${Number(summary.total_paid_usd || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
      </div>
      <div class="metric-card warn">
        <span class="metric-label">Pending Approval</span>
        <span class="metric-value">${summary.pending_approval || 0}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">In Transit</span>
        <span class="metric-value">${summary.in_transit || 0}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Completed</span>
        <span class="metric-value">${summary.completed_count || 0}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Total Fees</span>
        <span class="metric-value">$${Number(summary.total_fees_usd || 0).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Total Transfers</span>
        <span class="metric-value">${summary.total_transfers || 0}</span>
      </div>`;

    // Table
    const payments = paymentsData.transfers || [];
    let html = `<table>
      <thead><tr>
        <th>Transfer #</th><th>Recipient</th><th>Type</th><th>Amount</th><th>Fee</th><th>Method</th><th>Status</th><th>Date</th><th>Actions</th>
      </tr></thead><tbody>`;

    if (payments.length === 0) {
      html += '<tr><td colspan="9" style="text-align:center;color:var(--text-secondary);padding:40px">No external payments yet. Click "+ New Payment" to send funds to a vendor or beneficiary.</td></tr>';
    } else {
      for (const p of payments) {
        const typeBadge = p.payment_type === 'vendor_payment' ? 'badge-reversed' : p.payment_type === 'beneficiary_distribution' ? 'badge-approved' : 'badge-frozen';
        html += `<tr>
          <td><strong>${p.transfer_number}</strong></td>
          <td>${p.contact_name || 'Contact #' + p.contact_id}${p.contact_type ? '<br><small style="color:var(--text-secondary)">' + p.contact_type + '</small>' : ''}</td>
          <td><span class="badge ${typeBadge}">${(p.payment_type || '').replace(/_/g, ' ')}</span></td>
          <td>${formatUSD(p.amount_cents)}</td>
          <td>${p.fee_cents > 0 ? formatUSD(p.fee_cents) : '—'}</td>
          <td>${(p.payment_method || 'ach').toUpperCase()}</td>
          <td>${badge(p.status)}</td>
          <td>${formatDate(p.created_at)}</td>
          <td>${paymentActions(p)}</td>
        </tr>`;
      }
    }
    html += '</tbody></table>';
    document.getElementById('payments-table').innerHTML = html;
  } catch (err) {
    document.getElementById('payments-table').innerHTML = `<p style="padding:20px;color:var(--danger)">Error: ${err.message}</p>`;
  }
}

function paymentActions(p) {
  let btns = '';
  if (p.status === 'draft') {
    btns += `<button class="btn btn-sm btn-success" onclick="approvePayment(${p.id})">Approve</button> `;
    btns += `<button class="btn btn-sm btn-danger" onclick="rejectPayment(${p.id})">Reject</button> `;
  }
  if (p.status === 'pending_approval') {
    btns += `<button class="btn btn-sm btn-success" onclick="approvePayment(${p.id})">Approve</button> `;
    btns += `<button class="btn btn-sm btn-danger" onclick="rejectPayment(${p.id})">Reject</button> `;
  }
  if (p.status === 'approved') {
    btns += `<button class="btn btn-sm btn-primary" onclick="processPayment(${p.id})">Process</button> `;
    btns += `<button class="btn btn-sm btn-danger" onclick="cancelPayment(${p.id})">Cancel</button> `;
  }
  if (p.status === 'processing') {
    btns += `<button class="btn btn-sm btn-success" onclick="completePayment(${p.id})">Complete</button> `;
  }
  if (p.status === 'failed' || p.status === 'returned') {
    btns += `<button class="btn btn-sm" onclick="retryPayment(${p.id})">Retry</button> `;
  }
  return btns || '—';
}

async function approvePayment(id) {
  try {
    const data = await api(`/external-transfers/${id}/approve`, { method: 'POST', body: JSON.stringify({ approved_by: 'dashboard_user' }) });
    showToast(data.message || 'Payment approved');
    loadPayments();
  } catch (err) { showToast(err.message, 'error'); }
}

async function rejectPayment(id) {
  const reason = prompt('Rejection reason (optional):');
  if (reason === null) return;
  try {
    await api(`/external-transfers/${id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
    showToast('Payment rejected');
    loadPayments();
  } catch (err) { showToast(err.message, 'error'); }
}

async function processPayment(id) {
  try {
    const data = await api(`/external-transfers/${id}/process`, { method: 'POST' });
    showToast(data.message || 'Payment processing — funds debited');
    loadPayments();
  } catch (err) { showToast(err.message, 'error'); }
}

async function completePayment(id) {
  try {
    await api(`/external-transfers/${id}/complete`, { method: 'POST' });
    showToast('Payment completed');
    loadPayments();
  } catch (err) { showToast(err.message, 'error'); }
}

async function cancelPayment(id) {
  if (!confirm('Cancel this payment?')) return;
  try {
    await api(`/external-transfers/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'Cancelled by user' }) });
    showToast('Payment cancelled');
    loadPayments();
  } catch (err) { showToast(err.message, 'error'); }
}

async function retryPayment(id) {
  try {
    await api(`/external-transfers/${id}/retry`, { method: 'POST' });
    showToast('Payment reset to draft — you can re-approve and process');
    loadPayments();
  } catch (err) { showToast(err.message, 'error'); }
}

async function showCreatePayment() {
  // Populate contacts dropdown (active vendors + beneficiaries + trustees)
  const contactsData = await api('/crm/contacts?status=active');
  const contacts = (contactsData.contacts || []).filter(c => c.status === 'active');
  const contactOpts = contacts.map(c => `<option value="${c.id}">${c.display_name || (c.first_name + ' ' + c.last_name)} (${c.contact_type})</option>`).join('');
  document.getElementById('payment-contact').innerHTML = '<option value="">Select a contact...</option>' + contactOpts;
  document.getElementById('payment-pm').innerHTML = '<option value="">Use default method</option>';

  // Populate source accounts dropdown
  const accountsData = await api('/accounts');
  const active = (accountsData.accounts || []).filter(a => a.status === 'active');
  const acctOpts = active.map(a => `<option value="${a.id}">${a.account_number} — ${a.account_name} (${formatUSD(a.balance_cents)})</option>`).join('');
  document.getElementById('payment-from-account').innerHTML = acctOpts;

  document.getElementById('create-payment-modal').classList.remove('hidden');
}

async function loadContactPaymentMethods() {
  const contactId = document.getElementById('payment-contact').value;
  const pmSelect = document.getElementById('payment-pm');
  if (!contactId) {
    pmSelect.innerHTML = '<option value="">Use default method</option>';
    return;
  }
  try {
    const data = await api(`/crm/contacts/${contactId}/payment-methods`);
    const methods = data.payment_methods || [];
    let opts = '<option value="">Use default method</option>';
    for (const m of methods) {
      if (m.status !== 'active') continue;
      const acctDisplay = m.account_number ? ' (' + (m.account_number.length > 4 ? '****' + m.account_number.slice(-4) : m.account_number) + ')' : '';
      opts += `<option value="${m.id}">${m.label} — ${m.method_type.toUpperCase()}${m.bank_name ? ' @ ' + m.bank_name : ''}${acctDisplay}${m.is_default ? ' [Default]' : ''}</option>`;
    }
    pmSelect.innerHTML = opts;
  } catch (err) {
    pmSelect.innerHTML = '<option value="">Use default method</option>';
  }
}

async function createPayment(e) {
  e.preventDefault();
  const form = new FormData(e.target);
  const body = {
    contact_id: parseInt(form.get('contact_id')),
    from_account_id: parseInt(form.get('from_account_id')),
    amount: parseFloat(form.get('amount')),
    payment_type: form.get('payment_type'),
    payment_method: form.get('payment_method'),
    priority: form.get('priority'),
    description: form.get('description') || null,
    memo: form.get('memo') || null,
    invoice_number: form.get('invoice_number') || null,
    scheduled_date: form.get('scheduled_date') || null,
  };
  const pmId = form.get('payment_method_id');
  if (pmId) body.payment_method_id = parseInt(pmId);

  try {
    const data = await api('/external-transfers', { method: 'POST', body: JSON.stringify(body) });
    const msg = data.auto_approved ? `Payment created & auto-approved (${data.transfer_number})` : `Payment created — ${data.approval_tier} approval required (${data.transfer_number})`;
    showToast(msg);
    hideModal('create-payment-modal');
    e.target.reset();
    loadPayments();
  } catch (err) { showToast(err.message, 'error'); }
}

// --- Trust Accounting ---

function switchAccountingTab() {
  const tab = $('#accounting-tab').value;
  $$('.accounting-subview').forEach(v => v.classList.add('hidden'));
  const target = document.getElementById(`acct-${tab}`);
  if (target) target.classList.remove('hidden');

  switch (tab) {
    case 'dashboard': loadAccountingDashboard(); break;
    case 'journal': loadJournalEntries(); break;
    case 'ledger': loadGeneralLedger(); break;
    case 'trial-balance': loadFormalTrialBalance(); break;
    case 'coa': loadChartOfAccounts(); break;
    case 'allocations': loadAllocations(); break;
    case 'reports': break; // loaded on click
  }
}

async function loadAccounting() {
  $('#accounting-tab').value = 'dashboard';
  $$('.accounting-subview').forEach(v => v.classList.add('hidden'));
  $('#acct-dashboard').classList.remove('hidden');
  loadAccountingDashboard();
}

async function loadAccountingDashboard() {
  try {
    const dash = await api('/trust-accounting/dashboard');

    // Metrics
    $('#acct-metrics').innerHTML = `
      <div class="metric-card primary">
        <span class="metric-label">Chart of Accounts</span>
        <span class="metric-value">${dash.chart_of_accounts.total}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Journal Entries</span>
        <span class="metric-value">${dash.journal_entries.total}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">This Year</span>
        <span class="metric-value">${dash.journal_entries.this_year}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Open Periods</span>
        <span class="metric-value">${dash.open_periods.length}</span>
      </div>
    `;

    // Trial balance check
    const tbColor = dash.trial_balance.balanced ? 'var(--success)' : 'var(--danger)';
    const tbIcon = dash.trial_balance.balanced ? '✓ Balanced' : '✗ Unbalanced';
    $('#acct-tb-check').innerHTML = `
      <div style="text-align:center;padding:20px">
        <div style="font-size:1.5rem;font-weight:600;color:${tbColor};margin-bottom:12px">${tbIcon}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:0.9rem">
          <div>
            <div style="color:var(--text-secondary)">Total Debits</div>
            <div style="font-weight:600">${dash.trial_balance.total_debit_usd}</div>
          </div>
          <div>
            <div style="color:var(--text-secondary)">Total Credits</div>
            <div style="font-weight:600">${dash.trial_balance.total_credit_usd}</div>
          </div>
        </div>
      </div>
    `;

    // Income vs Principal YTD
    const totalAlloc = (dash.ytd_allocations.principal_cents || 0) + (dash.ytd_allocations.income_cents || 0);
    const pPct = totalAlloc > 0 ? Math.round(((dash.ytd_allocations.principal_cents || 0) / totalAlloc) * 100) : 0;
    const iPct = totalAlloc > 0 ? 100 - pPct : 0;
    $('#acct-alloc-summary').innerHTML = `
      <div style="padding:20px">
        <div style="display:flex;height:24px;border-radius:12px;overflow:hidden;margin-bottom:16px;background:var(--bg-hover)">
          ${pPct > 0 ? `<div style="width:${pPct}%;background:var(--accent);display:flex;align-items:center;justify-content:center;font-size:0.75rem;color:#fff;font-weight:600">${pPct}%</div>` : ''}
          ${iPct > 0 ? `<div style="width:${iPct}%;background:var(--success);display:flex;align-items:center;justify-content:center;font-size:0.75rem;color:#fff;font-weight:600">${iPct}%</div>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:0.9rem">
          <div>
            <div style="color:var(--accent);font-weight:600">● Principal</div>
            <div>${dash.ytd_allocations.principal_usd}</div>
          </div>
          <div>
            <div style="color:var(--success);font-weight:600">● Income</div>
            <div>${dash.ytd_allocations.income_usd}</div>
          </div>
        </div>
      </div>
    `;

    // Recent journal entries
    if (dash.recent_entries && dash.recent_entries.length) {
      let html = '<table><thead><tr><th>Entry #</th><th>Date</th><th>Type</th><th>Description</th><th>Debit</th><th>Credit</th></tr></thead><tbody>';
      for (const je of dash.recent_entries) {
        html += `<tr>
          <td><code>${je.entry_number}</code></td>
          <td>${formatDate(je.entry_date)}</td>
          <td>${badge(je.entry_type)}</td>
          <td>${je.description}</td>
          <td>${formatUSD(je.total_debit_cents)}</td>
          <td>${formatUSD(je.total_credit_cents)}</td>
        </tr>`;
      }
      html += '</tbody></table>';
      $('#acct-recent-je').innerHTML = html;
    } else {
      $('#acct-recent-je').innerHTML = '<p style="color:var(--text-secondary);padding:20px">No journal entries yet. Click "+ Journal Entry" to create one.</p>';
    }
  } catch (err) {
    showToast('Failed to load accounting dashboard: ' + err.message, 'error');
  }
}

async function loadJournalEntries() {
  try {
    const data = await api('/trust-accounting/journal-entries?limit=50');
    if (!data.entries.length) {
      $('#journal-entries-table').innerHTML = '<p style="color:var(--text-secondary);padding:20px">No journal entries yet.</p>';
      return;
    }
    let html = '<table><thead><tr><th>Entry #</th><th>Date</th><th>Type</th><th>Description</th><th>Source</th><th>Debit</th><th>Credit</th><th>Status</th><th>Actions</th></tr></thead><tbody>';
    for (const je of data.entries) {
      const reversed = je.is_reversed ? '<span class="badge badge-cancelled">Reversed</span>' : '<span class="badge badge-active">Posted</span>';
      html += `<tr>
        <td><code>${je.entry_number}</code></td>
        <td>${formatDate(je.entry_date)}</td>
        <td>${badge(je.entry_type)}</td>
        <td>${je.description}</td>
        <td>${je.source_engine || '—'}</td>
        <td>${formatUSD(je.total_debit_cents)}</td>
        <td>${formatUSD(je.total_credit_cents)}</td>
        <td>${reversed}</td>
        <td>${!je.is_reversed ? `<button class="btn btn-sm btn-danger" onclick="reverseJournalEntry(${je.id})">Reverse</button>` : '—'}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    $('#journal-entries-table').innerHTML = html;
  } catch (err) {
    showToast('Failed to load journal entries: ' + err.message, 'error');
  }
}

async function loadGeneralLedger() {
  try {
    const accountFilter = $('#gl-account-filter').value;
    const params = accountFilter ? `?account_id=${accountFilter}` : '';
    const data = await api(`/trust-accounting/general-ledger${params}`);

    // Populate filter if not yet done
    if ($('#gl-account-filter').options.length <= 1) {
      const coa = await api('/trust-accounting/chart-of-accounts?active=true');
      for (const acct of coa.accounts) {
        const opt = document.createElement('option');
        opt.value = acct.id;
        opt.textContent = `${acct.account_code} — ${acct.account_name}`;
        $('#gl-account-filter').appendChild(opt);
      }
    }

    let html = '';
    for (const acct of data.accounts) {
      if (acct.entry_count === 0 && !accountFilter) continue;
      html += `<div class="panel" style="margin-bottom:12px">
        <h3 style="margin-bottom:8px">${acct.account_code} — ${acct.account_name} <span style="font-weight:400;color:var(--text-secondary)">(${acct.account_type}, ${acct.normal_balance})</span> <span style="float:right;font-weight:600">${acct.balance_usd}</span></h3>`;
      if (acct.entries.length) {
        html += '<table><thead><tr><th>Date</th><th>Entry #</th><th>Description</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody>';
        for (const e of acct.entries) {
          html += `<tr>
            <td>${formatDate(e.entry_date)}</td>
            <td><code>${e.entry_number}</code></td>
            <td>${e.entry_description || e.description || '—'}</td>
            <td>${e.debit_cents ? formatUSD(e.debit_cents) : '—'}</td>
            <td>${e.credit_cents ? formatUSD(e.credit_cents) : '—'}</td>
            <td style="font-weight:600">${e.running_balance_usd}</td>
          </tr>`;
        }
        html += '</tbody></table>';
      } else {
        html += '<p style="color:var(--text-secondary)">No entries in this period</p>';
      }
      html += '</div>';
    }
    $('#general-ledger-table').innerHTML = html || '<p style="color:var(--text-secondary);padding:20px">No ledger entries found.</p>';
  } catch (err) {
    showToast('Failed to load general ledger: ' + err.message, 'error');
  }
}

async function loadFormalTrialBalance() {
  try {
    const data = await api('/trust-accounting/trial-balance');
    const balColor = data.balanced ? 'var(--success)' : 'var(--danger)';
    let html = `<div style="text-align:center;margin-bottom:16px">
      <h3>Trust Accounting Trial Balance</h3>
      <span style="color:var(--text-secondary)">As of ${formatDate(data.as_of_date)}</span>
      <span style="margin-left:12px;color:${balColor};font-weight:600">${data.balanced ? '✓ Balanced' : '✗ UNBALANCED'}</span>
    </div>`;
    html += '<table><thead><tr><th>Code</th><th>Account</th><th>Type</th><th style="text-align:right">Debit</th><th style="text-align:right">Credit</th></tr></thead><tbody>';
    for (const row of data.rows) {
      html += `<tr>
        <td><code>${row.account_code}</code></td>
        <td>${row.account_name}</td>
        <td>${badge(row.account_type)}</td>
        <td style="text-align:right">${row.debit_cents ? row.debit_usd : '—'}</td>
        <td style="text-align:right">${row.credit_cents ? row.credit_usd : '—'}</td>
      </tr>`;
    }
    html += `</tbody><tfoot><tr style="font-weight:700;border-top:2px solid var(--border)">
      <td colspan="3">TOTALS</td>
      <td style="text-align:right">${data.total_debit_usd}</td>
      <td style="text-align:right">${data.total_credit_usd}</td>
    </tr></tfoot></table>`;
    $('#formal-trial-balance').innerHTML = html;
  } catch (err) {
    showToast('Failed to load trial balance: ' + err.message, 'error');
  }
}

async function loadChartOfAccounts() {
  try {
    const data = await api('/trust-accounting/chart-of-accounts');
    let html = '<table><thead><tr><th>Code</th><th>Name</th><th>Type</th><th>Sub-Type</th><th>Normal Balance</th><th>System</th></tr></thead><tbody>';
    for (const acct of data.accounts) {
      html += `<tr>
        <td><code>${acct.account_code}</code></td>
        <td>${acct.account_name}</td>
        <td>${badge(acct.account_type)}</td>
        <td>${acct.sub_type || '—'}</td>
        <td>${acct.normal_balance}</td>
        <td>${acct.is_system ? 'Yes' : 'No'}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    $('#coa-table').innerHTML = html;
  } catch (err) {
    showToast('Failed to load chart of accounts: ' + err.message, 'error');
  }
}

async function loadAllocations() {
  try {
    const data = await api('/trust-accounting/income-principal');

    $('#alloc-metrics').innerHTML = `
      <div class="metric-card">
        <span class="metric-label">Total Allocations</span>
        <span class="metric-value">${data.count}</span>
      </div>
      <div class="metric-card" style="border-left:3px solid var(--accent)">
        <span class="metric-label">Principal</span>
        <span class="metric-value">${data.principal_total_usd}</span>
      </div>
      <div class="metric-card" style="border-left:3px solid var(--success)">
        <span class="metric-label">Income</span>
        <span class="metric-value">${data.income_total_usd}</span>
      </div>
    `;

    if (!data.allocations.length) {
      $('#allocations-table').innerHTML = '<p style="color:var(--text-secondary);padding:20px">No allocations yet. Click "+ Record Allocation" to classify income vs principal.</p>';
      return;
    }

    let html = '<table><thead><tr><th>Date</th><th>Category</th><th>Classification</th><th>Amount</th><th>Description</th><th>Rule</th></tr></thead><tbody>';
    for (const a of data.allocations) {
      const clsColor = a.classification === 'principal' ? 'var(--accent)' : 'var(--success)';
      html += `<tr>
        <td>${formatDate(a.allocation_date)}</td>
        <td>${a.category}</td>
        <td><span style="color:${clsColor};font-weight:600">${a.classification}</span></td>
        <td>${formatUSD(a.amount_cents)}</td>
        <td>${a.description || '—'}</td>
        <td style="font-size:0.8rem;color:var(--text-secondary)">${a.rule_applied || '—'}</td>
      </tr>`;
    }
    html += '</tbody></table>';
    $('#allocations-table').innerHTML = html;
  } catch (err) {
    showToast('Failed to load allocations: ' + err.message, 'error');
  }
}

// --- Report Loaders ---

async function loadBalanceSheet() {
  try {
    const data = await api('/trust-accounting/reports/balance-sheet');
    let html = `<h3 style="margin-bottom:4px">Balance Sheet — ${data.trust_name}</h3>
      <span style="color:var(--text-secondary);font-size:0.85rem">As of ${formatDate(data.as_of_date)}</span>
      <span style="margin-left:12px;color:${data.balanced ? 'var(--success)' : 'var(--danger)'};font-weight:600">${data.balanced ? '✓ Balanced' : '✗ Unbalanced'}</span>`;

    const renderSection = (title, items, total) => {
      let s = `<h4 style="margin:16px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px">${title}</h4>`;
      if (items.length) {
        for (const item of items) {
          s += `<div style="display:flex;justify-content:space-between;padding:4px 0">
            <span>${item.account_code} — ${item.account_name}</span>
            <span style="font-weight:500">${item.balance_usd}</span>
          </div>`;
        }
      } else {
        s += '<div style="color:var(--text-secondary);padding:4px 0">No entries</div>';
      }
      s += `<div style="display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--border);font-weight:700">
        <span>Total ${title}</span><span>${total}</span>
      </div>`;
      return s;
    };

    html += renderSection('Assets', data.assets.items, data.assets.total_usd);
    html += renderSection('Liabilities', data.liabilities.items, data.liabilities.total_usd);
    html += renderSection('Corpus (Principal)', data.corpus.items, data.corpus.total_usd);
    html += `<div style="display:flex;justify-content:space-between;padding:12px 0;border-top:2px solid var(--border);font-weight:700;font-size:1.1rem;margin-top:8px">
      <span>Total Liabilities + Corpus</span><span>${data.total_liabilities_and_corpus_usd}</span>
    </div>`;

    $('#report-output').innerHTML = html;
  } catch (err) {
    showToast('Failed to load balance sheet: ' + err.message, 'error');
  }
}

async function loadIncomeStatement() {
  try {
    const data = await api('/trust-accounting/reports/income-statement');
    let html = `<h3 style="margin-bottom:4px">Income Statement — ${data.trust_name}</h3>
      <span style="color:var(--text-secondary);font-size:0.85rem">${formatDate(data.period.start_date)} to ${formatDate(data.period.end_date)}</span>`;

    const renderSection = (title, items, total, color) => {
      let s = `<h4 style="margin:16px 0 8px;border-bottom:1px solid var(--border);padding-bottom:4px">${title}</h4>`;
      if (items.length) {
        for (const item of items) {
          s += `<div style="display:flex;justify-content:space-between;padding:4px 0">
            <span>${item.account_code} — ${item.account_name}</span>
            <span style="font-weight:500">${item.amount_usd}</span>
          </div>`;
        }
      } else {
        s += '<div style="color:var(--text-secondary);padding:4px 0">No entries</div>';
      }
      s += `<div style="display:flex;justify-content:space-between;padding:8px 0;border-top:1px solid var(--border);font-weight:700;color:${color}">
        <span>Total ${title}</span><span>${total}</span>
      </div>`;
      return s;
    };

    html += renderSection('Income', data.income.items, data.income.total_usd, 'var(--success)');
    html += renderSection('Expenses', data.expenses.items, data.expenses.total_usd, 'var(--danger)');
    html += `<div style="display:flex;justify-content:space-between;padding:12px 0;border-top:2px solid var(--border);font-weight:700;font-size:1.1rem;margin-top:8px">
      <span>Net Income</span><span style="color:${data.net_income_cents >= 0 ? 'var(--success)' : 'var(--danger)'}">${data.net_income_usd}</span>
    </div>`;

    $('#report-output').innerHTML = html;
  } catch (err) {
    showToast('Failed to load income statement: ' + err.message, 'error');
  }
}

async function loadDNIReport() {
  try {
    const data = await api('/trust-accounting/reports/dni');
    let html = `<h3 style="margin-bottom:4px">Distributable Net Income (DNI) — ${data.trust_name}</h3>
      <span style="color:var(--text-secondary);font-size:0.85rem">${formatDate(data.period.start_date)} to ${formatDate(data.period.end_date)}</span>`;

    html += '<div style="margin-top:16px">';
    html += `<div style="display:flex;justify-content:space-between;padding:8px 0"><span>Gross Trust Income</span><span style="font-weight:600;color:var(--success)">${data.gross_income_usd}</span></div>`;

    if (data.income_breakdown.length) {
      for (const item of data.income_breakdown) {
        html += `<div style="display:flex;justify-content:space-between;padding:4px 16px;font-size:0.9rem;color:var(--text-secondary)"><span>${item.category}</span><span>${item.amount_usd}</span></div>`;
      }
    }

    html += `<div style="display:flex;justify-content:space-between;padding:8px 0"><span>Less: Deductible Expenses</span><span style="font-weight:600;color:var(--danger)">(${data.deductible_expenses_usd})</span></div>`;
    html += `<div style="display:flex;justify-content:space-between;padding:12px 0;border-top:2px solid var(--border);font-weight:700;font-size:1.1rem;margin-top:8px">
      <span>Distributable Net Income (IRC §643(a))</span><span>${data.distributable_net_income_usd}</span>
    </div>`;
    html += '</div>';

    $('#report-output').innerHTML = html;
  } catch (err) {
    showToast('Failed to load DNI report: ' + err.message, 'error');
  }
}

async function loadK1Report() {
  try {
    const data = await api('/trust-accounting/reports/k1-data');
    let html = `<h3 style="margin-bottom:4px">Schedule K-1 Data — ${data.trust_name}</h3>
      <span style="color:var(--text-secondary);font-size:0.85rem">${formatDate(data.period.start_date)} to ${formatDate(data.period.end_date)}</span>
      <span style="margin-left:12px">Trust EIN: ${data.trust_ein}</span>`;

    html += `<div style="margin-top:12px;padding:8px;background:var(--bg-hover);border-radius:8px;font-size:0.9rem">
      <strong>DNI:</strong> ${data.dni.distributable_net_income_usd} | <strong>Total Distributed:</strong> ${data.total_distributed_usd}
    </div>`;

    if (data.beneficiaries.length) {
      html += '<table style="margin-top:16px"><thead><tr><th>Beneficiary</th><th>Tax ID</th><th>Type</th><th>Distributions</th><th>% of DNI</th></tr></thead><tbody>';
      for (const b of data.beneficiaries) {
        html += `<tr>
          <td>${b.beneficiary_name}</td>
          <td>${b.tax_id_masked || '—'}</td>
          <td>${b.tax_id_type || '—'}</td>
          <td>${b.total_distributions_usd}</td>
          <td>${b.share_of_dni}%</td>
        </tr>`;
      }
      html += '</tbody></table>';
    } else {
      html += '<p style="color:var(--text-secondary);margin-top:12px">No active beneficiaries found in CRM.</p>';
    }

    $('#report-output').innerHTML = html;
  } catch (err) {
    showToast('Failed to load K-1 data: ' + err.message, 'error');
  }
}

// --- Journal Entry Creation ---

let jeLineCount = 2;

async function showCreateJournalEntry() {
  jeLineCount = 2;
  document.getElementById('create-je-modal').classList.remove('hidden');
  // Set default date to today
  const today = new Date().toISOString().slice(0, 10);
  document.querySelector('#create-je-form [name="entry_date"]').value = today;

  // Populate account dropdowns
  try {
    const coa = await api('/trust-accounting/chart-of-accounts?active=true');
    $$('.je-account').forEach(sel => {
      sel.innerHTML = '<option value="">Select Account...</option>';
      for (const acct of coa.accounts) {
        const opt = document.createElement('option');
        opt.value = acct.id;
        opt.textContent = `${acct.account_code} — ${acct.account_name}`;
        sel.appendChild(opt);
      }
    });
  } catch (_) {}
  updateJEBalanceCheck();
}

function addJELine() {
  const container = document.getElementById('je-lines');
  const div = document.createElement('div');
  div.className = 'je-line';
  div.style.cssText = 'display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;margin-bottom:8px';
  div.innerHTML = `
    <select name="line_account_${jeLineCount}" class="je-account" required>
      <option value="">Select Account...</option>
    </select>
    <input type="number" name="line_debit_${jeLineCount}" placeholder="Debit $" step="0.01" min="0" oninput="updateJEBalanceCheck()">
    <input type="number" name="line_credit_${jeLineCount}" placeholder="Credit $" step="0.01" min="0" oninput="updateJEBalanceCheck()">
  `;
  container.appendChild(div);

  // Populate the new account dropdown
  api('/trust-accounting/chart-of-accounts?active=true').then(coa => {
    const sel = div.querySelector('.je-account');
    for (const acct of coa.accounts) {
      const opt = document.createElement('option');
      opt.value = acct.id;
      opt.textContent = `${acct.account_code} — ${acct.account_name}`;
      sel.appendChild(opt);
    }
  }).catch(() => {});

  jeLineCount++;
}

function updateJEBalanceCheck() {
  let totalDebits = 0, totalCredits = 0;
  for (let i = 0; i < jeLineCount; i++) {
    const d = parseFloat(document.querySelector(`[name="line_debit_${i}"]`)?.value || 0);
    const c = parseFloat(document.querySelector(`[name="line_credit_${i}"]`)?.value || 0);
    totalDebits += d;
    totalCredits += c;
  }
  const diff = Math.abs(totalDebits - totalCredits);
  const el = $('#je-balance-check');
  if (totalDebits === 0 && totalCredits === 0) {
    el.innerHTML = '<span style="color:var(--text-secondary)">Enter debit and credit amounts</span>';
  } else if (diff < 0.01) {
    el.innerHTML = `<span style="color:var(--success);font-weight:600">✓ Balanced — Debits: $${totalDebits.toFixed(2)} = Credits: $${totalCredits.toFixed(2)}</span>`;
    el.style.background = 'rgba(16,185,129,0.1)';
  } else {
    el.innerHTML = `<span style="color:var(--danger);font-weight:600">✗ Unbalanced — Debits: $${totalDebits.toFixed(2)} ≠ Credits: $${totalCredits.toFixed(2)} (diff: $${diff.toFixed(2)})</span>`;
    el.style.background = 'rgba(239,68,68,0.1)';
  }
}

// Add input listeners for balance check
document.addEventListener('input', (e) => {
  if (e.target.name && (e.target.name.startsWith('line_debit_') || e.target.name.startsWith('line_credit_'))) {
    updateJEBalanceCheck();
  }
});

async function createJournalEntry(e) {
  e.preventDefault();
  const form = new FormData(e.target);

  const lines = [];
  for (let i = 0; i < jeLineCount; i++) {
    const accountId = form.get(`line_account_${i}`);
    const debit = parseFloat(form.get(`line_debit_${i}`) || 0);
    const credit = parseFloat(form.get(`line_credit_${i}`) || 0);
    if (!accountId) continue;
    if (debit === 0 && credit === 0) continue;
    lines.push({
      account_id: parseInt(accountId),
      debit_cents: Math.round(debit * 100),
      credit_cents: Math.round(credit * 100),
    });
  }

  const body = {
    entry_date: form.get('entry_date'),
    entry_type: form.get('entry_type'),
    description: form.get('description'),
    memo: form.get('memo') || null,
    reference_type: form.get('reference_type') || null,
    source_engine: form.get('source_engine') || null,
    lines,
  };

  try {
    const data = await api('/trust-accounting/journal-entries', { method: 'POST', body: JSON.stringify(body) });
    showToast(`Journal entry ${data.entry_number} posted`);
    hideModal('create-je-modal');
    e.target.reset();
    loadAccounting();
  } catch (err) { showToast(err.message, 'error'); }
}

async function reverseJournalEntry(id) {
  if (!confirm('Are you sure you want to reverse this journal entry?')) return;
  try {
    const data = await api(`/trust-accounting/journal-entries/${id}/reverse`, { method: 'POST', body: JSON.stringify({}) });
    showToast(data.message);
    loadJournalEntries();
  } catch (err) { showToast(err.message, 'error'); }
}

// --- Allocation Creation ---

function showCreateAllocation() {
  document.getElementById('create-alloc-modal').classList.remove('hidden');
  const today = new Date().toISOString().slice(0, 10);
  document.querySelector('#create-alloc-form [name="allocation_date"]').value = today;
}

async function createAllocation(e) {
  e.preventDefault();
  const form = new FormData(e.target);
  const body = {
    category: form.get('category'),
    classification: form.get('classification') || null,
    amount_cents: Math.round(parseFloat(form.get('amount')) * 100),
    allocation_date: form.get('allocation_date') || null,
    description: form.get('description') || null,
  };

  try {
    const data = await api('/trust-accounting/income-principal', { method: 'POST', body: JSON.stringify(body) });
    showToast(data.message);
    hideModal('create-alloc-modal');
    e.target.reset();
    loadAllocations();
  } catch (err) { showToast(err.message, 'error'); }
}

// --- Helpers ---

function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// --- Blockchain / Crypto Rails ---

async function loadBlockchain() {
  try {
    const [dashboard, wallets] = await Promise.all([
      api('/blockchain/dashboard'),
      api('/blockchain/wallets'),
    ]);

    // Metrics
    const d = dashboard;
    $('#chain-metrics').innerHTML = `
      <div class="metric-card primary">
        <span class="metric-label">Total USDC Balance</span>
        <span class="metric-value">$${parseFloat(d.wallets.totalUsdc).toLocaleString('en-US', {minimumFractionDigits: 2})}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Active Wallets</span>
        <span class="metric-value">${d.wallets.active}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Completed Transfers</span>
        <span class="metric-value">${d.transactions.completed}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Pending</span>
        <span class="metric-value">${d.transactions.pending}</span>
      </div>
    `;

    // Connection status
    const netInfo = d.network || {};
    $('#chain-connection-status').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div style="display:flex;gap:16px;align-items:center">
          <span class="badge badge-${d.environment === 'production' ? 'active' : 'pending'}">${(d.environment || 'sandbox').toUpperCase()}</span>
          <span style="font-size:0.85rem;color:var(--text-muted)">Network: <strong style="color:var(--text-primary)">${netInfo.name || d.blockchain}</strong></span>
          <span style="font-size:0.85rem">Circle: <strong style="color:${d.connected ? 'var(--success)' : 'var(--danger)'}">${d.connected ? 'Connected' : 'Not Connected'}</strong></span>
        </div>
        <div style="display:flex;gap:8px">
          <span style="font-size:0.8rem;color:var(--text-muted)">Daily Limit: $${parseFloat(d.dailyLimit).toLocaleString()}</span>
          <span style="font-size:0.8rem;color:var(--text-muted)">Approval ≥ $${parseFloat(d.approvalThreshold).toLocaleString()}</span>
          <button class="btn" onclick="showChainConfig()" style="font-size:0.8rem;padding:4px 10px">Configure</button>
        </div>
      </div>
    `;

    // Wallets grid
    const walletsHtml = wallets.wallets.length === 0
      ? '<p style="color:var(--text-muted);text-align:center;padding:20px">No wallets yet. Click "+ New Wallet" to create one.</p>'
      : wallets.wallets.map(w => `
        <div style="background:var(--bg-main);border:1px solid var(--border);border-radius:10px;padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px">
            <div>
              <strong style="font-size:0.95rem">${w.wallet_name}</strong>
              <span class="badge badge-${w.status === 'active' ? 'active' : 'frozen'}" style="margin-left:6px;font-size:0.7rem">${w.status}</span>
            </div>
            <span class="badge" style="font-size:0.7rem">${w.wallet_type_label || w.wallet_type}</span>
          </div>
          <div style="font-size:1.3rem;font-weight:600;color:var(--accent-primary);margin:8px 0">$${parseFloat(w.usdc_balance).toLocaleString('en-US', {minimumFractionDigits: 2})} <span style="font-size:0.75rem;color:var(--text-muted)">USDC</span></div>
          <div style="font-size:0.75rem;color:var(--text-muted);font-family:monospace;margin-bottom:8px">${w.address_masked || '—'}</div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:8px">${(w.blockchain_info && w.blockchain_info.name) || w.blockchain}</div>
          <div style="display:flex;gap:6px">
            <button class="btn" onclick="syncWallet(${w.id})" style="font-size:0.75rem;padding:3px 8px">Sync</button>
            ${w.status === 'active'
              ? `<button class="btn" onclick="freezeWallet(${w.id})" style="font-size:0.75rem;padding:3px 8px;color:var(--warning)">Freeze</button>`
              : `<button class="btn" onclick="unfreezeWallet(${w.id})" style="font-size:0.75rem;padding:3px 8px;color:var(--success)">Unfreeze</button>`
            }
          </div>
        </div>
      `).join('');
    $('#chain-wallets-grid').innerHTML = walletsHtml;

    // Load transactions and fiat orders
    loadBlockchainTransactions();
    loadFiatOrders();
  } catch (err) {
    console.error('Failed to load blockchain dashboard:', err);
    $('#chain-metrics').innerHTML = '<div class="metric-card"><span class="metric-label">Error loading dashboard</span></div>';
  }
}

async function loadBlockchainTransactions() {
  try {
    const filter = document.getElementById('chain-tx-filter')?.value;
    const params = filter ? `?status=${filter}` : '';
    const data = await api(`/blockchain/transactions${params}`);

    if (data.transactions.length === 0) {
      $('#chain-transactions-table').innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:16px">No on-chain transactions yet</p>';
      return;
    }

    const rows = data.transactions.map(tx => `
      <tr>
        <td style="font-family:monospace;font-size:0.8rem">${tx.tx_number}</td>
        <td>${tx.transfer_type_label || tx.transfer_type}</td>
        <td style="font-family:monospace;font-size:0.8rem">${tx.from_address_masked || '—'}</td>
        <td style="font-family:monospace;font-size:0.8rem">${tx.to_address_masked || '—'}</td>
        <td style="font-weight:600">$${parseFloat(tx.amount).toLocaleString('en-US', {minimumFractionDigits: 2})} <span style="font-size:0.75rem;color:var(--text-muted)">${tx.token}</span></td>
        <td>${badge(tx.status)}</td>
        <td>${tx.tx_hash ? `<a href="${tx.explorer_url}" target="_blank" style="font-size:0.75rem;color:var(--accent-primary)">View</a>` : '—'}</td>
        <td style="font-size:0.8rem">${formatTime(tx.created_at)}</td>
        <td>
          ${tx.status === 'pending_approval' ? `<button class="btn" onclick="approveChainTx(${tx.id})" style="font-size:0.75rem;padding:2px 8px;color:var(--success)">Approve</button>` : ''}
          ${['initiated','pending_approval','submitted'].includes(tx.status) ? `<button class="btn" onclick="cancelChainTx(${tx.id})" style="font-size:0.75rem;padding:2px 8px;color:var(--danger)">Cancel</button>` : ''}
          ${tx.circle_tx_id ? `<button class="btn" onclick="syncChainTx(${tx.id})" style="font-size:0.75rem;padding:2px 8px">Sync</button>` : ''}
        </td>
      </tr>
    `).join('');

    $('#chain-transactions-table').innerHTML = `
      <table><thead><tr>
        <th>TX #</th><th>Type</th><th>From</th><th>To</th><th>Amount</th><th>Status</th><th>Explorer</th><th>Date</th><th>Actions</th>
      </tr></thead><tbody>${rows}</tbody></table>
    `;
  } catch (err) {
    console.error('Failed to load blockchain transactions:', err);
  }
}

async function loadFiatOrders() {
  try {
    const data = await api('/blockchain/fiat/orders');

    if (data.orders.length === 0) {
      $('#fiat-orders-table').innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:12px">No fiat gateway orders yet</p>';
      return;
    }

    const rows = data.orders.map(o => `
      <tr>
        <td style="font-family:monospace;font-size:0.8rem">${o.order_number}</td>
        <td><span class="badge badge-${o.direction === 'on_ramp' ? 'active' : 'pending'}">${o.direction === 'on_ramp' ? 'USD → USDC' : 'USDC → USD'}</span></td>
        <td style="font-weight:600">$${parseFloat(o.fiat_amount).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
        <td>${o.crypto_amount ? `$${parseFloat(o.crypto_amount).toLocaleString('en-US', {minimumFractionDigits: 2})} USDC` : '—'}</td>
        <td>${badge(o.status)}</td>
        <td>${o.rail || '—'}</td>
        <td style="font-size:0.8rem">${formatTime(o.created_at)}</td>
      </tr>
    `).join('');

    $('#fiat-orders-table').innerHTML = `
      <table><thead><tr>
        <th>Order #</th><th>Direction</th><th>Fiat</th><th>Crypto</th><th>Status</th><th>Rail</th><th>Date</th>
      </tr></thead><tbody>${rows}</tbody></table>
    `;
  } catch (err) {
    console.error('Failed to load fiat orders:', err);
  }
}

// Wallet actions

function showCreateWalletModal() {
  document.getElementById('create-wallet-modal').classList.remove('hidden');
}

async function createWallet(e) {
  e.preventDefault();
  try {
    const result = await api('/blockchain/wallets', {
      method: 'POST',
      body: JSON.stringify({
        wallet_name: $('#cw-name').value,
        wallet_type: $('#cw-type').value,
        blockchain: $('#cw-blockchain').value,
      }),
    });
    hideModal('create-wallet-modal');
    showToast(`Wallet "${result.wallet.wallet_name}" created${result.circle_connected ? ' (Circle)' : ' (local)'}`, 'success');
    loadBlockchain();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

async function syncWallet(id) {
  try {
    const result = await api(`/blockchain/wallets/${id}/sync`, { method: 'POST' });
    showToast(result.synced ? 'Wallet synced' : 'Sync skipped: ' + (result.reason || 'unknown'), result.synced ? 'success' : 'info');
    loadBlockchain();
  } catch (err) {
    showToast(`Sync failed: ${err.message}`, 'error');
  }
}

async function freezeWallet(id) {
  if (!confirm('Freeze this wallet? No transfers will be allowed.')) return;
  try {
    await api(`/blockchain/wallets/${id}/freeze`, { method: 'POST' });
    showToast('Wallet frozen', 'success');
    loadBlockchain();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

async function unfreezeWallet(id) {
  try {
    await api(`/blockchain/wallets/${id}/unfreeze`, { method: 'POST' });
    showToast('Wallet unfrozen', 'success');
    loadBlockchain();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

// Send USDC

async function showSendUsdcModal() {
  document.getElementById('send-usdc-modal').classList.remove('hidden');
  try {
    const data = await api('/blockchain/wallets?status=active');
    const sel = document.getElementById('su-from-wallet');
    sel.innerHTML = '<option value="">Select wallet...</option>' +
      data.wallets.map(w => `<option value="${w.id}">${w.wallet_name} ($${parseFloat(w.usdc_balance).toFixed(2)} USDC)</option>`).join('');
  } catch (err) {
    console.error('Failed to load wallets for send modal:', err);
  }
}

async function sendUsdc(e) {
  e.preventDefault();
  try {
    const result = await api('/blockchain/send', {
      method: 'POST',
      body: JSON.stringify({
        from_wallet_id: parseInt($('#su-from-wallet').value),
        to_address: $('#su-to-address').value,
        amount: $('#su-amount').value,
        transfer_type: $('#su-type').value,
        description: $('#su-description').value || undefined,
      }),
    });
    hideModal('send-usdc-modal');
    const msg = result.requires_approval
      ? `Transfer of $${parseFloat(result.transaction.amount).toFixed(2)} USDC requires approval`
      : `Transfer of $${parseFloat(result.transaction.amount).toFixed(2)} USDC ${result.circle_submitted ? 'submitted to Circle' : 'queued locally'}`;
    showToast(msg, 'success');
    loadBlockchain();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

// Transaction actions

async function approveChainTx(id) {
  if (!confirm('Approve this USDC transfer?')) return;
  try {
    await api(`/blockchain/transactions/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ approved_by: 'trustee' }),
    });
    showToast('Transfer approved', 'success');
    loadBlockchainTransactions();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

async function cancelChainTx(id) {
  const reason = prompt('Cancellation reason (optional):');
  if (reason === null) return;
  try {
    await api(`/blockchain/transactions/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason || 'Cancelled by user' }),
    });
    showToast('Transfer cancelled', 'success');
    loadBlockchainTransactions();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

async function syncChainTx(id) {
  try {
    const result = await api(`/blockchain/transactions/${id}/sync`, { method: 'POST' });
    showToast(result.synced ? 'Transaction synced from Circle' : 'Sync skipped', result.synced ? 'success' : 'info');
    loadBlockchainTransactions();
  } catch (err) {
    showToast(`Sync failed: ${err.message}`, 'error');
  }
}

// Fiat gateway

async function initOnRamp(e) {
  e.preventDefault();
  try {
    const amount = document.getElementById('onramp-amount').value;
    const result = await api('/blockchain/fiat/on-ramp', {
      method: 'POST',
      body: JSON.stringify({ amount }),
    });
    const steps = result.instructions?.steps || [];
    document.getElementById('onramp-result').innerHTML = `
      <div style="background:rgba(76,175,80,0.1);border:1px solid rgba(76,175,80,0.3);border-radius:8px;padding:12px;font-size:0.85rem">
        <strong style="color:var(--success)">On-ramp order ${result.order.order_number} created</strong>
        <ol style="margin:8px 0 0 16px;color:var(--text-muted)">${steps.map(s => `<li>${s}</li>`).join('')}</ol>
      </div>
    `;
    loadFiatOrders();
  } catch (err) {
    document.getElementById('onramp-result').innerHTML = `<span style="color:var(--danger)">${err.message}</span>`;
  }
}

async function initOffRamp(e) {
  e.preventDefault();
  try {
    const amount = document.getElementById('offramp-amount').value;
    const result = await api('/blockchain/fiat/off-ramp', {
      method: 'POST',
      body: JSON.stringify({ amount }),
    });
    document.getElementById('offramp-result').innerHTML = `
      <div style="background:rgba(33,150,243,0.1);border:1px solid rgba(33,150,243,0.3);border-radius:8px;padding:12px;font-size:0.85rem">
        <strong style="color:var(--accent-primary)">Off-ramp order ${result.order.order_number} created</strong>
        <p style="margin:4px 0 0;color:var(--text-muted)">${result.circle_submitted ? 'Submitted to Circle for processing' : 'Order queued — configure Circle payout destination to process'}</p>
      </div>
    `;
    loadFiatOrders();
  } catch (err) {
    document.getElementById('offramp-result').innerHTML = `<span style="color:var(--danger)">${err.message}</span>`;
  }
}

// Config

async function showChainConfig() {
  document.getElementById('chain-config-modal').classList.remove('hidden');
  try {
    const data = await api('/blockchain/config');
    const html = data.config.map(c => `
      <div style="margin-bottom:10px">
        <label style="font-size:0.8rem;color:var(--text-muted)">${c.key} <span style="font-size:0.7rem">${c.description || ''}</span></label>
        <input type="${c.is_sensitive ? 'password' : 'text'}" data-config-key="${c.key}" value="${c.value || ''}"
          style="width:100%;padding:8px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:0.85rem"
          placeholder="${c.is_sensitive ? '••••••••' : ''}">
      </div>
    `).join('');
    document.getElementById('chain-config-form').innerHTML = html;
  } catch (err) {
    document.getElementById('chain-config-form').innerHTML = `<p style="color:var(--danger)">${err.message}</p>`;
  }
}

async function saveChainConfig() {
  try {
    const inputs = document.querySelectorAll('#chain-config-form input[data-config-key]');
    const updates = [];
    inputs.forEach(inp => {
      if (inp.value && inp.value !== '••••••••') {
        updates.push({ key: inp.dataset.configKey, value: inp.value });
      }
    });
    if (updates.length === 0) { showToast('No changes to save', 'info'); return; }
    await api('/blockchain/config', {
      method: 'PUT',
      body: JSON.stringify({ updates }),
    });
    hideModal('chain-config-modal');
    showToast(`${updates.length} config(s) saved`, 'success');
    loadBlockchain();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
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
