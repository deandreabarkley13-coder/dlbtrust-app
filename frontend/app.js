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
