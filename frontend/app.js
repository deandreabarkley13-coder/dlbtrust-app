/**
 * DLB Trust — Private Wealth Management Dashboard
 * Frontend integrating with Core Banking Engine API
 */

const API_BASE = ''; // Use relative paths — configured via API constant below

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
    case 'virtual-accounts': loadVirtualAccounts(); break;
    case 'accounting': loadAccounting(); break;
    case 'fixed-income': loadFixedIncome(); break;
    case 'blockchain': loadBlockchain(); break;
    case 'cash-management': loadCashManagement(); break;
    case 'documents': loadDocuments(); break;
    case 'reports': loadReports(); break;
    case 'ai-agent': loadAIAgent(); break;
    case 'integration': loadIntegration(); break;
    case 'fineract': loadFineract(); break;
    case 'cdk': loadCDK(); break;
    case 'compliance': loadCompliance(); break;
    case 'approval': loadApproval(); break;
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

async function obpSetup() {
  const panel = document.getElementById('obp-panel');
  if (panel) panel.innerHTML = '<h4 style="margin:0;font-size:0.95rem">\ud83c\udfdb\ufe0f Initializing OBP...</h4><div style="margin-top:8px"><div class="spinner"></div> Setting up bank, accounts, and payment pipeline...</div>';
  try {
    const result = await api('/obp/setup', { method: 'POST' });
    showToast(result.success ? 'OBP initialized — self-hosted banking ready!' : 'OBP setup completed with warnings', result.success ? 'success' : 'warning');
    loadPayments(); // Refresh to show updated status
  } catch (err) {
    showToast('OBP setup failed: ' + err.message, 'error');
    if (panel) panel.innerHTML = '<h4 style="margin:0;font-size:0.95rem">\ud83c\udfdb\ufe0f OBP Setup Failed</h4><div style="color:var(--danger);margin-top:4px">' + err.message + '</div><button onclick="obpSetup()" style="margin-top:8px;padding:4px 12px;border-radius:4px;border:1px solid var(--border-color);cursor:pointer">Retry</button>';
  }
}

async function loadPayments() {
  try {
    const filter = document.getElementById('payment-status-filter')?.value || '';
    const statusParam = filter ? `?status=${filter}` : '';

    const [paymentsData, summary, deliveryStatus] = await Promise.all([
      api(`/external-transfers${statusParam}`),
      api('/external-transfers/summary'),
      api('/external-transfers/delivery-status').catch(() => ({ delivery_method: 'manual', connected: false })),
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
      </div>
      <div class="metric-card ${deliveryStatus.connected ? 'primary' : 'warn'}">
        <span class="metric-label">Delivery</span>
        <span class="metric-value" style="font-size:0.85rem">${
          deliveryStatus.delivery_method === 'column' ? '🏦 Column API' :
          deliveryStatus.delivery_method === 'dwolla' ? '🏦 Dwolla API' :
          deliveryStatus.delivery_method === 'obp' ? '🏛️ Open Banking' :
          deliveryStatus.delivery_method === 'openach' ? '🏦 OpenACH' :
          deliveryStatus.delivery_method === 'sftp' ? '📡 SFTP' : '📁 Manual'
        }</span>
      </div>`;

    // Delivery methods panel
    if (deliveryStatus.all_methods) {
      let methodsHtml = '<div style="margin-top:16px;padding:16px;background:var(--card-bg);border-radius:8px;border:1px solid var(--border-color)">';
      methodsHtml += '<h4 style="margin:0 0 12px 0;font-size:0.95rem">🔌 Payment Delivery Channels</h4>';
      methodsHtml += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px">';
      for (const m of deliveryStatus.all_methods) {
        const isActive = m.name === deliveryStatus.delivery_method;
        const iconMap = { column: '🏦', dwolla: '💳', obp: '🏛️', openach: '🔧', moov: '📦', sftp: '📡', manual: '📁' };
        methodsHtml += `<div style="padding:10px;border-radius:6px;border:1px solid ${m.connected ? 'var(--success)' : m.configured ? 'var(--warning)' : 'var(--border-color)'};background:${isActive ? 'rgba(34,197,94,0.08)' : 'transparent'}">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${iconMap[m.name] || '⚡'} ${m.label}</strong>
            <span style="font-size:0.75rem;padding:2px 6px;border-radius:4px;background:${m.connected ? 'var(--success)' : m.configured ? 'var(--warning)' : 'var(--text-secondary)'};color:white">${m.connected ? 'CONNECTED' : m.configured ? 'CONFIGURED' : 'NOT SET'}</span>
          </div>
          <div style="font-size:0.8rem;color:var(--text-secondary);margin-top:4px">${m.description || ''}</div>
          ${isActive ? '<div style="font-size:0.75rem;color:var(--success);margin-top:4px;font-weight:600">⚡ ACTIVE — payments route here first</div>' : ''}
          ${m.message ? '<div style="font-size:0.75rem;color:var(--text-secondary);margin-top:2px">' + m.message + '</div>' : ''}
        </div>`;
      }
      methodsHtml += '</div></div>';
      document.getElementById('payment-metrics').insertAdjacentHTML('afterend', methodsHtml);
    }

    // OBP Self-Hosted Control Panel
    try {
      const obpStatus = await api('/obp/status').catch(() => null);
      if (obpStatus) {
        let obpHtml = '<div id="obp-panel" style="margin-top:16px;padding:16px;background:var(--card-bg);border-radius:8px;border:1px solid var(--border-color)">';
        obpHtml += '<h4 style="margin:0 0 12px 0;font-size:0.95rem">\ud83c\udfdb\ufe0f Open Banking Project (Self-Hosted)</h4>';
        if (obpStatus.initialized) {
          obpHtml += `<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
            <span style="padding:4px 10px;border-radius:4px;background:var(--success);color:white;font-size:0.8rem;font-weight:600">RUNNING</span>
            <span style="font-size:0.85rem;color:var(--text-secondary)">Bank: ${obpStatus.bank_id || 'N/A'} | Account: ${obpStatus.account_id || 'N/A'}</span>
            <button onclick="obpSetup()" style="padding:4px 12px;border-radius:4px;border:1px solid var(--border-color);background:var(--card-bg);cursor:pointer;font-size:0.8rem">\u21bb Re-initialize</button>
          </div>`;
          obpHtml += `<div style="font-size:0.8rem;color:var(--text-secondary);margin-top:6px">${obpStatus.obp_url} \u2014 No external API keys. Full self-hosted control.</div>`;
        } else {
          obpHtml += `<div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center">
            <span style="padding:4px 10px;border-radius:4px;background:var(--warning);color:white;font-size:0.8rem;font-weight:600">NOT INITIALIZED</span>
            <button onclick="obpSetup()" style="padding:6px 16px;border-radius:6px;border:none;background:var(--primary);color:white;cursor:pointer;font-weight:600;font-size:0.85rem">\ud83d\ude80 Initialize OBP</button>
          </div>`;
          obpHtml += '<div style="font-size:0.8rem;color:var(--text-secondary);margin-top:6px">Click to auto-create bank, accounts, and connect payment pipeline. No API keys needed.</div>';
        }
        obpHtml += '</div>';

        const metricsEl = document.getElementById('payment-metrics');
        if (metricsEl) metricsEl.insertAdjacentHTML('afterend', obpHtml);
      }
    } catch (_) {}

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
  if (p.status === 'processing' || p.status === 'sent') {
    btns += `<button class="btn btn-sm btn-success" onclick="clearPayment(${p.id})" title="Mark as cleared/settled">✓ Clear</button> `;
    btns += `<button class="btn btn-sm btn-danger" onclick="returnPayment(${p.id})" title="Mark as failed/returned">✗ Fail</button> `;
    btns += `<button class="btn btn-sm" onclick="cancelPayment(${p.id})">Cancel</button> `;
  }
  if (p.status === 'failed' || p.status === 'returned') {
    btns += `<button class="btn btn-sm" onclick="retryPayment(${p.id})">Retry</button> `;
    if (p.return_code) btns += `<small style="color:var(--danger)">${p.return_code}</small> `;
  }
  if (p.status === 'completed') {
    btns += `<small style="color:var(--success)">✓ Cleared</small>`;
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
  // Show modal to collect banking details if not on file
  const transfer = await api(`/external-transfers/${id}`);
  const method = transfer.payment_method || 'ach';

  // If payment method has banking details, process directly
  if (transfer.payment_method_id) {
    try {
      const data = await api(`/external-transfers/${id}/process`, { method: 'POST' });
      showToast(data.message || `${method.toUpperCase()} payment executed`);
      if (data.payment_file) {
        showPaymentFileResult(data);
      }
      loadPayments();
    } catch (err) { showToast(err.message, 'error'); }
    return;
  }

  // No payment method on file — prompt for banking details
  const isWire = method === 'wire';
  const html = `
    <div class="modal-backdrop" id="process-payment-modal" onclick="if(event.target===this)hideModal('process-payment-modal')">
      <div class="modal" style="max-width:500px">
        <div class="modal-header">
          <h3>${isWire ? '🏦 Wire Transfer Details' : '🏧 ACH Payment Details'}</h3>
          <button class="modal-close" onclick="hideModal('process-payment-modal')">×</button>
        </div>
        <form onsubmit="executeProcessPayment(event, ${id})">
          <div class="form-group">
            <label>Recipient</label>
            <input type="text" value="${transfer.contact_name || ''}" disabled style="background:#f3f4f6">
          </div>
          <div class="form-group">
            <label>Amount</label>
            <input type="text" value="$${(transfer.amount_cents/100).toFixed(2)}" disabled style="background:#f3f4f6">
          </div>
          ${isWire ? `
            <div class="form-group">
              <label>Routing Number (ABA) — domestic wire</label>
              <input type="text" name="routing_number" placeholder="9-digit ABA routing number" maxlength="9" pattern="\\d{9}">
            </div>
            <div class="form-group">
              <label>— OR — SWIFT/BIC Code (international)</label>
              <input type="text" name="swift_bic" placeholder="e.g. CHASUS33" maxlength="11">
            </div>
          ` : `
            <div class="form-group">
              <label>Routing Number (ABA) *</label>
              <input type="text" name="routing_number" placeholder="9-digit ABA routing number" maxlength="9" pattern="\\d{9}" required>
            </div>
          `}
          <div class="form-group">
            <label>Account Number *</label>
            <input type="text" name="account_number" placeholder="Bank account number" required>
          </div>
          <div class="form-group">
            <label>Account Type</label>
            <select name="account_type">
              <option value="checking">Checking</option>
              <option value="savings">Savings</option>
            </select>
          </div>
          ${isWire ? `
            <div class="form-group">
              <label>Beneficiary Bank Name</label>
              <input type="text" name="bank_name" placeholder="e.g. Chase Bank">
            </div>
          ` : ''}
          <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px">
            <button type="button" class="btn" onclick="hideModal('process-payment-modal')">Cancel</button>
            <button type="submit" class="btn btn-primary">Execute ${method.toUpperCase()} Payment</button>
          </div>
        </form>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

async function executeProcessPayment(e, id) {
  e.preventDefault();
  const form = new FormData(e.target);
  const body = {};
  if (form.get('routing_number')) body.routing_number = form.get('routing_number');
  if (form.get('account_number')) body.account_number = form.get('account_number');
  if (form.get('account_type')) body.account_type = form.get('account_type');
  if (form.get('swift_bic')) body.swift_bic = form.get('swift_bic');
  if (form.get('bank_name')) body.bank_name = form.get('bank_name');

  try {
    const data = await api(`/external-transfers/${id}/process`, { method: 'POST', body: JSON.stringify(body) });
    hideModal('process-payment-modal');
    showToast(data.message || 'Payment executed');
    if (data.payment_file) {
      showPaymentFileResult(data);
    }
    loadPayments();
  } catch (err) { showToast(err.message, 'error'); }
}

function showPaymentFileResult(data) {
  const file = data.payment_file;
  const delivery = data.delivery || {};
  const settlement = data.settlement || {};
  const transmitted = data.transmitted !== false;
  const deliveryBadge = transmitted
    ? '<span class="badge badge-approved">TRANSMITTED</span>'
    : '<span class="badge badge-frozen">PENDING DELIVERY</span>';
  const deliveryMethod = delivery.delivery_method === 'openach' ? 'OpenACH' : delivery.delivery_method === 'obp' ? 'Open Banking Project' : delivery.delivery_method === 'column' ? 'Column API' : delivery.delivery_method === 'dwolla' ? 'Dwolla API' : delivery.delivery_method === 'platform_gateway' ? 'DLB Trust Banking System' : delivery.delivery_method;
  const deliveryInfo = transmitted
    ? `<div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:8px;padding:12px;margin-top:12px">
        <strong>🏦 Transmitted via ${deliveryMethod}</strong><br>
        <small>${delivery.message || ''}</small>
        ${settlement.expected_clear_date ? `<br><small><strong>Expected Clearing:</strong> ${new Date(settlement.expected_clear_date).toLocaleDateString()}</small>` : ''}
       </div>`
    : `<div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:12px;margin-top:12px">
        <strong>⏳ Payment processing</strong><br>
        <small>Payment file generated and queued for delivery through the banking system.</small>
       </div>`;

  const html = `
    <div class="modal-backdrop" id="payment-result-modal" onclick="if(event.target===this)hideModal('payment-result-modal')">
      <div class="modal" style="max-width:600px">
        <div class="modal-header">
          <h3>✅ Payment Executed</h3>
          <button class="modal-close" onclick="hideModal('payment-result-modal')">×</button>
        </div>
        <div style="padding:20px">
          <div style="background:#ecfdf5;border:1px solid #6ee7b7;border-radius:8px;padding:16px;margin-bottom:16px">
            <strong>Confirmation:</strong> ${data.confirmation_id || 'N/A'}<br>
            <strong>Amount Debited:</strong> $${data.debited}<br>
            <strong>GL Posted:</strong> ${data.gl_posted ? 'Yes' : 'No'}<br>
            <strong>Delivery:</strong> ${deliveryBadge}
          </div>
          <h4>Generated ${file.format.toUpperCase()} File</h4>
          <table style="width:100%;font-size:0.85rem">
            <tr><td><strong>Filename</strong></td><td>${file.filename}</td></tr>
            <tr><td><strong>Format</strong></td><td>${file.format}</td></tr>
            ${file.metadata.beneficiary ? `<tr><td><strong>Beneficiary</strong></td><td>${file.metadata.beneficiary}</td></tr>` : ''}
            ${file.metadata.amountUSD ? `<tr><td><strong>Amount</strong></td><td>$${file.metadata.amountUSD}</td></tr>` : ''}
            ${file.metadata.odfi ? `<tr><td><strong>ODFI</strong></td><td>${file.metadata.odfi}</td></tr>` : ''}
            ${file.metadata.imad ? `<tr><td><strong>IMAD</strong></td><td>${file.metadata.imad}</td></tr>` : ''}
            ${file.metadata.reference ? `<tr><td><strong>Reference</strong></td><td>${file.metadata.reference}</td></tr>` : ''}
          </table>
          ${deliveryInfo}
          <button class="btn btn-primary" onclick="loadPaymentFiles();hideModal('payment-result-modal')" style="margin-top:12px">View Payment Files</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

async function completePayment(id) {
  try {
    await api(`/external-transfers/${id}/complete`, { method: 'POST' });
    showToast('Payment completed');
    loadPayments();
  } catch (err) { showToast(err.message, 'error'); }
}

async function clearPayment(id) {
  try {
    const data = await api(`/external-transfers/${id}/clear`, { method: 'POST', body: JSON.stringify({ bank_reference: `CLR-${Date.now()}` }) });
    showToast(data.message || 'Payment cleared — funds delivered successfully', 'success');
    loadPayments();
  } catch (err) { showToast(err.message, 'error'); }
}

async function returnPayment(id) {
  const returnCodes = [
    'R01 - Insufficient Funds',
    'R02 - Account Closed',
    'R03 - No Account / Unable to Locate',
    'R04 - Invalid Account Number',
    'R07 - Authorization Revoked',
    'R08 - Payment Stopped',
    'R10 - Customer Not Authorized',
    'R16 - Account Frozen',
    'R20 - Non-Transaction Account',
    'Other (specify reason)',
  ];
  const selected = prompt(`Select return reason:\\n${returnCodes.map((c,i) => `${i+1}. ${c}`).join('\\n')}\\n\\nEnter number (1-${returnCodes.length}):`);
  if (!selected) return;

  const idx = parseInt(selected) - 1;
  let returnCode = null;
  let reason = '';

  if (idx >= 0 && idx < returnCodes.length - 1) {
    returnCode = returnCodes[idx].split(' - ')[0];
    reason = returnCodes[idx];
  } else {
    reason = prompt('Enter failure reason:') || 'Payment failed';
  }

  try {
    const data = await api(`/external-transfers/${id}/return`, {
      method: 'POST',
      body: JSON.stringify({ return_code: returnCode, reason })
    });
    showToast(data.message || 'Payment returned — funds refunded', 'warning');
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

// --- Payment Files ---

async function loadPaymentFiles() {
  try {
    const files = await api('/external-transfers/files');
    let html = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
        <h3 style="margin:0">📁 Payment Files (NACHA / Wire)</h3>
        <button class="btn" onclick="loadPayments()">← Back to Payments</button>
      </div>
      <table>
        <thead><tr>
          <th>File</th><th>Type</th><th>Transfer</th><th>Status</th><th>Created</th><th>Actions</th>
        </tr></thead><tbody>`;

    if (!files || files.length === 0) {
      html += '<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-secondary)">No payment files generated yet. Process an ACH or Wire payment to generate files.</td></tr>';
    } else {
      for (const f of files) {
        const typeBadge = f.file_type === 'nacha' ? 'badge-approved' : 'badge-reversed';
        const statusBadge = f.status === 'submitted' ? 'badge-approved' : f.status === 'generated' ? 'badge-frozen' : '';
        html += `<tr>
          <td><strong>${f.filename}</strong></td>
          <td><span class="badge ${typeBadge}">${f.file_type.toUpperCase()}</span></td>
          <td>${f.transfer_number || f.batch_id || '—'}</td>
          <td><span class="badge ${statusBadge}">${f.status}</span></td>
          <td>${formatDate(f.created_at)}</td>
          <td>
            <button class="btn btn-sm btn-primary" onclick="downloadPaymentFile(${f.id})">⬇ Download</button>
            <button class="btn btn-sm" onclick="viewPaymentFile(${f.id})">👁 View</button>
            ${f.status === 'generated' ? `<button class="btn btn-sm btn-success" onclick="markFileSubmitted(${f.id})">✓ Mark Submitted</button>` : ''}
          </td>
        </tr>`;
      }
    }
    html += '</tbody></table>';
    document.getElementById('payments-table').innerHTML = html;
  } catch (err) {
    showToast(`Error loading files: ${err.message}`, 'error');
  }
}

async function downloadPaymentFile(fileId) {
  try {
    const resp = await fetch(`/api/external-transfers/files/${fileId}/download`);
    if (!resp.ok) throw new Error('Download failed');
    const blob = await resp.blob();
    const filename = resp.headers.get('content-disposition')?.match(/filename="(.+)"/)?.[1] || 'payment-file.txt';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    showToast(`Downloaded: ${filename}`);
  } catch (err) { showToast(err.message, 'error'); }
}

async function viewPaymentFile(fileId) {
  try {
    const file = await api(`/external-transfers/files/${fileId}/content`);
    const html = `
      <div class="modal-backdrop" id="view-file-modal" onclick="if(event.target===this)hideModal('view-file-modal')">
        <div class="modal" style="max-width:700px;max-height:80vh;overflow:auto">
          <div class="modal-header">
            <h3>${file.filename}</h3>
            <button class="modal-close" onclick="hideModal('view-file-modal')">×</button>
          </div>
          <div style="padding:16px">
            <div style="display:flex;gap:12px;margin-bottom:12px">
              <span class="badge badge-approved">${file.file_type.toUpperCase()}</span>
              <span class="badge">${file.status}</span>
            </div>
            ${file.metadata ? `<pre style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;font-size:0.8rem;overflow:auto;max-height:200px">${JSON.stringify(file.metadata, null, 2)}</pre>` : ''}
            <h4 style="margin-top:12px">File Content:</h4>
            <pre style="background:#1e293b;color:#e2e8f0;border-radius:6px;padding:12px;font-size:0.75rem;overflow:auto;max-height:300px;white-space:pre-wrap">${file.content}</pre>
            <button class="btn btn-primary" onclick="downloadPaymentFile(${fileId})" style="margin-top:12px">⬇ Download File</button>
          </div>
        </div>
      </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
  } catch (err) { showToast(err.message, 'error'); }
}

async function markFileSubmitted(fileId) {
  if (!confirm('Mark this file as submitted to the bank?')) return;
  try {
    await api(`/external-transfers/files/${fileId}/mark-submitted`, { method: 'POST' });
    showToast('File marked as submitted — linked transfers moved to "sent" status');
    loadPaymentFiles();
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

async function initializeGL() {
  if (!confirm('Post opening balance journal entries from current banking and fixed income balances? This will create a journal entry to initialize the General Ledger.')) return;
  try {
    showToast('Initializing GL with opening balances...', 'info');
    const data = await api('/trust-accounting/initialize-gl', { method: 'POST', body: JSON.stringify({}) });
    showToast(`GL initialized: ${data.line_count} lines posted (${data.total_debit_usd})`, 'success');
    loadAccountingDashboard();
  } catch (err) {
    showToast(err.message || 'GL initialization failed', 'error');
  }
}

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

// --- Fixed Income / Private Placement Bonds ---

async function loadFixedIncome() {
  try {
    const [summary, bonds] = await Promise.all([
      api('/fixed-income/private-placements/summary').catch(() => ({ active_bonds: 0, total_par_value: '0.00', total_interest_paid: '0.00', by_series: [] })),
      loadPrivatePlacements(),
    ]);
    const metricsEl = document.getElementById('fi-metrics');
    metricsEl.innerHTML = `
      <div class="metric-card"><div class="metric-value">${summary.active_bonds}</div><div class="metric-label">Active Bonds</div></div>
      <div class="metric-card"><div class="metric-value">$${Number(summary.total_par_value).toLocaleString()}</div><div class="metric-label">Total Par Value</div></div>
      <div class="metric-card"><div class="metric-value">$${Number(summary.total_interest_paid).toLocaleString()}</div><div class="metric-label">Total Interest Paid</div></div>
      <div class="metric-card"><div class="metric-value">${summary.by_series?.length || 0}</div><div class="metric-label">Bond Series</div></div>
    `;
    loadPendingCouponsStatus();
  } catch (err) { showToast(err.message, 'error'); }
}

async function loadPrivatePlacements() {
  try {
    const filter = document.getElementById('fi-filter')?.value || '';
    const qs = filter ? `?status=${filter}` : '';
    const data = await api(`/fixed-income/private-placements${qs}`);
    const bonds = data.bonds || [];
    const tableEl = document.getElementById('fi-bonds-table');
    let html = `<table><thead><tr>
      <th>Bond</th><th>Series</th><th>Par Value</th><th>Coupon</th><th>Maturity</th><th>Issuing Trust</th><th>Status</th><th>Actions</th>
    </tr></thead><tbody>`;
    if (bonds.length === 0) {
      html += '<tr><td colspan="8" style="text-align:center;color:var(--text-secondary);padding:40px">No private placement bonds recorded yet. Click "+ Record Private Placement Bond" to add one.</td></tr>';
    } else {
      for (const b of bonds) {
        const statusBadge = b.is_active ? '<span class="badge badge-active">active</span>' : '<span class="badge badge-failed">redeemed</span>';
        html += `<tr>
          <td><strong>${b.security_name}</strong></td>
          <td>${b.bond_series}</td>
          <td>$${Number(b.par_value).toLocaleString()}</td>
          <td>${b.coupon_rate}%</td>
          <td>${b.maturity_date}</td>
          <td>${b.issuing_trust}</td>
          <td>${statusBadge}</td>
          <td>
            ${b.is_active ? `<button class="btn btn-sm" onclick="recordBondPayment(${b.id})">Record Payment</button> <button class="btn btn-sm" onclick="redeemBond(${b.id})" style="color:var(--accent-red)">Redeem</button>` : ''}
          </td>
        </tr>`;
      }
    }
    html += '</tbody></table>';
    tableEl.innerHTML = html;
    return data;
  } catch (err) {
    showToast(err.message, 'error');
    return { bonds: [], total: 0 };
  }
}

// --- Process Coupons → On-Chain (Auto-tokenize cashflow) ---
async function processCouponsToChain() {
  if (!confirm('Process all due coupon payments? This will:\n\n1. Mark due coupons as received\n2. Credit your trust account\n3. Mint DLBT tokens on Polygon\n4. Add to liquidity pool (if USDC available)\n\nContinue?')) return;

  showToast('Processing coupons → tokenizing on-chain...', 'info');
  try {
    const result = await api('/fixed-income/coupons/process-all', { method: 'POST' });
    if (result.processed === 0) {
      showToast('No coupons due for processing', 'info');
    } else {
      const poolMsg = result.pool_funded ? ` | Pool funded: $${result.pool_funded.dlbt_added} DLBT + $${result.pool_funded.usdc_added} USDC` : '';
      showToast(`${result.processed} coupons processed → $${result.total_minted} DLBT minted${poolMsg}`, 'success');
    }
    loadPrivatePlacements();
    loadPendingCouponsStatus();
  } catch (err) {
    showToast(`Coupon processing failed: ${err.message}`, 'error');
  }
}

// --- Fund Liquidity Pool from Interest ---
async function fundPoolFromInterest() {
  if (!confirm('Fund the DLBT/USDC liquidity pool?\n\nThis will swap your available POL → USDC and pair it with DLBT in the pool.\nThe USDC in the pool allows beneficiaries to swap DLBT for real USDC.\n\nContinue?')) return;

  showToast('Swapping POL → USDC → funding pool...', 'info');
  try {
    const result = await api('/fixed-income/coupons/fund-pool', { method: 'POST' });
    if (result.success && result.auto_fund_result && result.auto_fund_result.poolFunded) {
      showToast(`Pool funded! ${result.auto_fund_result.totalUSDC} USDC added to pool`, 'success');
    } else if (result.auto_fund_result && result.auto_fund_result.steps) {
      const lastStep = result.auto_fund_result.steps[result.auto_fund_result.steps.length - 1];
      showToast(`Pool funding: ${lastStep.status} — ${lastStep.step}`, 'info');
    } else {
      showToast(result.message || 'Pool funding attempted', 'info');
    }
    loadPendingCouponsStatus();
  } catch (err) {
    showToast(`Pool funding failed: ${err.message}`, 'error');
  }
}

// Load pending coupon status for the tokenization banner
async function loadPendingCouponsStatus() {
  try {
    const data = await api('/fixed-income/coupons');
    const el = document.getElementById('fi-pending-coupons');
    if (el && data.coupons) {
      if (data.coupons.length === 0) {
        // No coupons exist — auto-generate them
        el.innerHTML = '<span style="color:#f59e0b">Generating coupon schedule...</span>';
        const genResult = await api('/fixed-income/coupons/generate', { method: 'POST' });
        if (genResult.total_generated > 0) {
          el.innerHTML = `<span style="color:#10b981">${genResult.total_generated} coupons generated!</span>`;
          // Reload to show the generated coupons
          setTimeout(() => loadPendingCouponsStatus(), 500);
          return;
        }
      }
      const today = new Date().toISOString().split('T')[0];
      const due = data.coupons.filter(c => c.payment_date <= today && c.status === 'scheduled');
      const totalDue = due.reduce((s, c) => s + c.amount_cents, 0);
      const received = data.coupons.filter(c => c.status === 'received');
      const totalReceived = received.reduce((s, c) => s + c.amount_cents, 0);
      if (due.length > 0) {
        el.innerHTML = `<span style="color:#7c3aed;font-weight:600">${due.length} coupon(s) due</span><br>$${(totalDue/100).toLocaleString()} ready to tokenize` +
          (received.length > 0 ? `<br><span style="color:#10b981">${received.length} received ($${(totalReceived/100).toLocaleString()})</span>` : '');
      } else if (received.length > 0) {
        el.innerHTML = `<span style="color:#10b981">${received.length} received ($${(totalReceived/100).toLocaleString()})</span><br>${data.coupons.length - received.length} upcoming`;
      } else {
        el.innerHTML = `<span style="color:var(--text-muted)">${data.coupons.length} scheduled</span><br>None due yet`;
      }
    }
  } catch (_) {}
}

function showPrivatePlacementForm() {
  document.getElementById('pp-bond-form').reset();
  document.getElementById('pp-bond-modal').classList.remove('hidden');
}

async function submitPrivatePlacement(e) {
  e.preventDefault();
  try {
    const form = e.target;
    const fd = new FormData(form);
    const body = {};
    for (const [k, v] of fd.entries()) { body[k] = v; }
    // Handle checkboxes (unchecked won't appear in FormData)
    body.secured = form.querySelector('[name="secured"]').checked;
    body.accredited_investors_only = form.querySelector('[name="accredited_investors_only"]').checked;
    body.restricted_transfer = form.querySelector('[name="restricted_transfer"]').checked;
    body.prudent_investor_compliant = form.querySelector('[name="prudent_investor_compliant"]').checked;

    const data = await api('/fixed-income/private-placements', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    showToast(data.message || 'Private placement bond recorded');
    hideModal('pp-bond-modal');
    loadFixedIncome();
  } catch (err) { showToast(err.message, 'error'); }
}

async function recordBondPayment(id) {
  const amount = prompt('Enter payment amount ($):');
  if (!amount) return;
  try {
    const data = await api(`/fixed-income/private-placements/${id}/record-payment`, {
      method: 'POST',
      body: JSON.stringify({ amount, payment_type: 'interest' }),
    });
    showToast(data.message || 'Payment recorded');
    loadFixedIncome();
  } catch (err) { showToast(err.message, 'error'); }
}

async function redeemBond(id) {
  if (!confirm('Redeem this bond? This marks it as matured/redeemed.')) return;
  const reason = prompt('Redemption reason (optional):', 'Maturity');
  try {
    const data = await api(`/fixed-income/private-placements/${id}/redeem`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    showToast(data.message || 'Bond redeemed');
    loadFixedIncome();
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

    // Connection status + Provider selector
    const netInfo = d.network || {};
    const isPrivate = d.provider === 'private';
    const providerLabel = isPrivate ? 'Private Stack (Direct RPC)' : 'Circle API';
    const providerColor = isPrivate ? 'var(--accent-primary)' : '#F7931A';
    const envLabel = (d.environment || 'testnet').toUpperCase();
    const connLabel = d.connected ? 'Connected' : 'Not Connected';
    const connColor = d.connected ? 'var(--success)' : 'var(--danger)';

    $('#chain-connection-status').innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px">
        <div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <select id="chain-provider-select" onchange="switchProvider(this.value)" style="padding:5px 10px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;color:var(--text-primary);font-size:0.8rem;font-weight:600">
            <option value="private" ${isPrivate ? 'selected' : ''}>Private Stack (No API Key)</option>
            <option value="circle" ${!isPrivate ? 'selected' : ''}>Circle API (Fallback)</option>
          </select>
          <span class="badge badge-${d.environment === 'mainnet' ? 'active' : 'pending'}">${envLabel}</span>
          <span style="font-size:0.85rem;color:var(--text-muted)">Network: <strong style="color:var(--text-primary)">${netInfo.name || d.blockchain}</strong></span>
          <span style="font-size:0.85rem">Status: <strong style="color:${connColor}">${connLabel}</strong></span>
          ${isPrivate ? `<span style="font-size:0.75rem;color:var(--text-muted)">USDC: <code style="font-size:0.7rem">${(d.usdcContract || '').slice(0,6)}...${(d.usdcContract || '').slice(-4)}</code></span>` : ''}
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          ${isPrivate ? `<button class="btn" onclick="pingRpc()" style="font-size:0.75rem;padding:3px 8px">Test RPC</button>` : ''}
          <span style="font-size:0.8rem;color:var(--text-muted)">Daily Limit: $${parseFloat(d.dailyLimit).toLocaleString()}</span>
          <span style="font-size:0.8rem;color:var(--text-muted)">Approval ≥ $${parseFloat(d.approvalThreshold).toLocaleString()}</span>
          <button class="btn" onclick="showChainConfig()" style="font-size:0.8rem;padding:4px 10px">Configure</button>
        </div>
      </div>
    `;

    // Wallets grid
    const walletsHtml = wallets.wallets.length === 0
      ? '<p style="color:var(--text-muted);text-align:center;padding:20px">No wallets yet. Click "+ New Wallet" to create one.</p>'
      : wallets.wallets.map(w => {
        const wProvider = (w.circle_wallet_id || '').startsWith('private_') ? 'private' : 'circle';
        const provBadge = wProvider === 'private'
          ? '<span style="background:var(--accent-primary);color:#fff;padding:2px 6px;border-radius:4px;font-size:0.65rem;font-weight:600">PRIVATE</span>'
          : '<span style="background:#F7931A;color:#fff;padding:2px 6px;border-radius:4px;font-size:0.65rem;font-weight:600">CIRCLE</span>';
        return `
        <div style="background:var(--bg-main);border:1px solid var(--border);border-radius:10px;padding:16px">
          <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px">
            <div>
              <strong style="font-size:0.95rem">${w.wallet_name}</strong>
              <span class="badge badge-${w.status === 'active' ? 'active' : 'frozen'}" style="margin-left:6px;font-size:0.7rem">${w.status}</span>
              ${provBadge}
            </div>
            <span class="badge" style="font-size:0.7rem">${w.wallet_type_label || w.wallet_type}</span>
          </div>
          <div style="font-size:1.3rem;font-weight:600;color:var(--accent-primary);margin:8px 0">$${parseFloat(w.usdc_balance).toLocaleString('en-US', {minimumFractionDigits: 2})} <span style="font-size:0.75rem;color:var(--text-muted)">USDC</span></div>
          <div style="font-size:0.75rem;color:var(--text-muted);font-family:monospace;margin-bottom:4px;display:flex;align-items:center;gap:4px">
            <span>${w.address_masked || '—'}</span>
            ${w.address ? `<button onclick="copyAddress('${w.address}')" style="background:none;border:1px solid var(--border);border-radius:4px;cursor:pointer;padding:1px 6px;font-size:0.65rem;color:var(--text-muted)" title="Copy full address">Copy</button>` : ''}
          </div>
          <div style="font-size:0.75rem;color:var(--text-muted);margin-bottom:8px">${(w.blockchain_info && w.blockchain_info.name) || w.blockchain} ${w.address ? `<a href="https://${w.blockchain === 'MATIC' ? '' : 'amoy.'}polygonscan.com/address/${w.address}" target="_blank" style="color:var(--accent-primary);font-size:0.7rem">View on Explorer</a>` : ''}</div>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <button class="btn" onclick="syncWallet(${w.id})" style="font-size:0.75rem;padding:3px 8px">Sync</button>
            <button class="btn" onclick="showReceiveForWallet(${w.id}, '${w.wallet_name}', '${w.address}')" style="font-size:0.75rem;padding:3px 8px;color:#00897b">Receive</button>
            <button class="btn" onclick="showSendFromWallet(${w.id})" style="font-size:0.75rem;padding:3px 8px;color:var(--accent-primary)">Send</button>
            ${w.status === 'active'
              ? `<button class="btn" onclick="freezeWallet(${w.id})" style="font-size:0.75rem;padding:3px 8px;color:var(--warning)">Freeze</button>`
              : `<button class="btn" onclick="unfreezeWallet(${w.id})" style="font-size:0.75rem;padding:3px 8px;color:var(--success)">Unfreeze</button>`
            }
          </div>
        </div>
      `}).join('');
    $('#chain-wallets-grid').innerHTML = walletsHtml;

    // Load transactions, fiat orders, and bridge orders
    loadBlockchainTransactions();
    loadFiatOrders();
    loadBridgeOrders();
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

// --- Banking ↔ Crypto Bridge ---

async function showBridgeModal(direction) {
  const modal = document.getElementById('bridge-modal');
  const dirInput = document.getElementById('bridge-direction');
  dirInput.value = direction;

  // Reset form
  document.getElementById('bridge-form').reset();
  document.getElementById('bridge-result').innerHTML = '';
  document.getElementById('bridge-quote-panel').style.display = 'none';

  if (direction === 'bank_to_crypto') {
    document.getElementById('bridge-modal-title').textContent = 'Fund Wallet from Banking';
    document.getElementById('bridge-modal-desc').textContent = 'Convert banking balance to real USDC via MoonPay on Polygon';
    document.getElementById('bridge-submit-btn').textContent = 'Convert to USDC';
    document.getElementById('bridge-amount-label').textContent = 'Amount (USD) *';

    // Source = bank accounts, Dest = wallets
    document.getElementById('bridge-source-section').innerHTML = `
      <label>Source Banking Account *</label>
      <select id="bridge-source-account" required style="width:100%;padding:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;color:var(--text-primary)">
        <option value="">Loading accounts...</option>
      </select>
    `;
    document.getElementById('bridge-dest-section').innerHTML = `
      <label>Destination Wallet *</label>
      <select id="bridge-dest-wallet" required style="width:100%;padding:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;color:var(--text-primary)">
        <option value="">Loading wallets...</option>
      </select>
    `;
  } else {
    document.getElementById('bridge-modal-title').textContent = 'Sweep Crypto to Banking';
    document.getElementById('bridge-modal-desc').textContent = 'Convert USDC back to USD and credit your banking account';
    document.getElementById('bridge-submit-btn').textContent = 'Sweep to Bank';
    document.getElementById('bridge-amount-label').textContent = 'Amount (USDC) *';

    // Source = wallets, Dest = bank accounts
    document.getElementById('bridge-source-section').innerHTML = `
      <label>Source Wallet *</label>
      <select id="bridge-source-wallet" required style="width:100%;padding:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;color:var(--text-primary)">
        <option value="">Loading wallets...</option>
      </select>
    `;
    document.getElementById('bridge-dest-section').innerHTML = `
      <label>Destination Banking Account *</label>
      <select id="bridge-dest-account" required style="width:100%;padding:10px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px;color:var(--text-primary)">
        <option value="">Loading accounts...</option>
      </select>
    `;
  }

  modal.classList.remove('hidden');

  // Load bridge dashboard data for dropdowns
  try {
    const data = await api('/bridge/dashboard');

    if (direction === 'bank_to_crypto') {
      const accountSelect = document.getElementById('bridge-source-account');
      accountSelect.innerHTML = '<option value="">— Select Account —</option>' +
        data.accounts.map(a => `<option value="${a.id}">${a.account_name} ($${parseFloat(a.available_usd).toLocaleString('en-US', {minimumFractionDigits: 2})} available)</option>`).join('');

      const walletSelect = document.getElementById('bridge-dest-wallet');
      walletSelect.innerHTML = '<option value="">— Select Wallet —</option>' +
        data.wallets.map(w => `<option value="${w.id}">${w.wallet_name} (${parseFloat(w.usdc_balance).toFixed(2)} USDC)</option>`).join('');
    } else {
      const walletSelect = document.getElementById('bridge-source-wallet');
      walletSelect.innerHTML = '<option value="">— Select Wallet —</option>' +
        data.wallets.map(w => `<option value="${w.id}">${w.wallet_name} (${parseFloat(w.usdc_balance).toFixed(2)} USDC)</option>`).join('');

      const accountSelect = document.getElementById('bridge-dest-account');
      accountSelect.innerHTML = '<option value="">— Select Account —</option>' +
        data.accounts.map(a => `<option value="${a.id}">${a.account_name} ($${parseFloat(a.available_usd).toLocaleString('en-US', {minimumFractionDigits: 2})})</option>`).join('');
    }

    // Show MoonPay status
    const statusEl = document.getElementById('bridge-moonpay-status');
    if (statusEl) statusEl.textContent = data.moonpay_configured ? 'MoonPay: Live' : 'Mode: Ledger-Only (1:1)';
  } catch (err) {
    console.error('Failed to load bridge data:', err);
  }
}

// Show quote when amount changes
document.addEventListener('input', function(e) {
  if (e.target.id === 'bridge-amount') {
    const amt = parseFloat(e.target.value);
    const panel = document.getElementById('bridge-quote-panel');
    if (amt > 0) {
      panel.style.display = 'block';
      document.getElementById('bridge-receive-value').textContent = `~${amt.toLocaleString('en-US', {minimumFractionDigits: 2})} USDC`;
    } else {
      panel.style.display = 'none';
    }
  }
});

async function executeBridge(e) {
  e.preventDefault();
  const direction = document.getElementById('bridge-direction').value;
  const amount = document.getElementById('bridge-amount').value;
  const notes = document.getElementById('bridge-notes').value;
  const btn = document.getElementById('bridge-submit-btn');
  const resultEl = document.getElementById('bridge-result');

  btn.disabled = true;
  btn.textContent = 'Processing...';
  resultEl.innerHTML = '';

  try {
    let body, endpoint;
    if (direction === 'bank_to_crypto') {
      const sourceAccountId = document.getElementById('bridge-source-account').value;
      const destWalletId = document.getElementById('bridge-dest-wallet').value;
      if (!sourceAccountId || !destWalletId) throw new Error('Select both source account and destination wallet');
      endpoint = '/bridge/bank-to-crypto';
      body = { source_account_id: sourceAccountId, destination_wallet_id: destWalletId, amount, notes };
    } else {
      const sourceWalletId = document.getElementById('bridge-source-wallet').value;
      const destAccountId = document.getElementById('bridge-dest-account').value;
      if (!sourceWalletId || !destAccountId) throw new Error('Select both source wallet and destination account');
      endpoint = '/bridge/crypto-to-bank';
      body = { source_wallet_id: sourceWalletId, destination_account_id: destAccountId, amount, notes };
    }

    const result = await api(endpoint, { method: 'POST', body: JSON.stringify(body) });

    const order = result.order || {};
    resultEl.innerHTML = `
      <div style="background:rgba(0,200,83,0.1);border:1px solid #00C853;border-radius:8px;padding:12px;margin-top:8px">
        <strong style="color:#00C853">Conversion Successful</strong>
        <div style="margin-top:8px;font-size:0.85rem">
          <div>Order: <code>${order.order_number || 'N/A'}</code></div>
          <div>Amount: $${parseFloat(amount).toLocaleString('en-US', {minimumFractionDigits: 2})}</div>
          <div>Status: <span class="badge badge-active">${order.status || 'completed'}</span></div>
          ${order.moonpay_widget_url ? `<div style="margin-top:8px"><a href="${order.moonpay_widget_url}" target="_blank" class="btn btn-primary" style="font-size:0.8rem;padding:6px 12px">Complete on MoonPay →</a></div>` : ''}
        </div>
      </div>
    `;
    showToast(result.message || 'Bridge conversion completed', 'success');
    loadBlockchain(); // Refresh balances
    loadBridgeOrders(); // Refresh bridge orders table
  } catch (err) {
    resultEl.innerHTML = `<div style="color:var(--danger);font-size:0.85rem;margin-top:8px">${err.message}</div>`;
    showToast(`Bridge failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = direction === 'bank_to_crypto' ? 'Convert to USDC' : 'Sweep to Bank';
  }
}

async function loadBridgeOrders() {
  try {
    const data = await api('/bridge/orders?limit=10');
    const el = document.getElementById('bridge-orders-table');
    if (!el) return;

    if (!data.orders || data.orders.length === 0) {
      el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:12px">No bridge orders yet. Use "Fund Wallet" or "Sweep to Bank" to convert between banking and crypto.</p>';
      return;
    }

    const rows = data.orders.map(o => `
      <tr>
        <td style="font-family:monospace;font-size:0.8rem">${o.order_number}</td>
        <td><span class="badge badge-${o.direction === 'bank_to_crypto' ? 'active' : 'pending'}">${o.direction === 'bank_to_crypto' ? 'Bank → Crypto' : 'Crypto → Bank'}</span></td>
        <td style="font-weight:600">$${(o.fiat_amount_cents / 100).toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
        <td>${o.crypto_amount ? `${parseFloat(o.crypto_amount).toFixed(2)} USDC` : '—'}</td>
        <td>${badge(o.status)}</td>
        <td style="font-size:0.8rem">${o.moonpay_transaction_id ? 'MoonPay' : 'Ledger'}</td>
        <td style="font-size:0.8rem">${formatTime(o.created_at)}</td>
        <td>
          ${o.status === 'pending_approval' ? `<button class="btn" onclick="approveBridgeOrder(${o.id})" style="font-size:0.75rem;padding:2px 8px;color:var(--success)">Approve</button>` : ''}
          ${!['completed','cancelled'].includes(o.status) ? `<button class="btn" onclick="cancelBridgeOrder(${o.id})" style="font-size:0.75rem;padding:2px 8px;color:var(--danger)">Cancel</button>` : ''}
          ${o.moonpay_widget_url ? `<a href="${o.moonpay_widget_url}" target="_blank" style="font-size:0.75rem;color:var(--accent-primary)">MoonPay</a>` : ''}
        </td>
      </tr>
    `).join('');

    el.innerHTML = `
      <table><thead><tr>
        <th>Order #</th><th>Direction</th><th>Amount</th><th>USDC</th><th>Status</th><th>Provider</th><th>Date</th><th>Actions</th>
      </tr></thead><tbody>${rows}</tbody></table>
    `;
  } catch (err) {
    console.error('Failed to load bridge orders:', err);
  }
}

async function approveBridgeOrder(id) {
  try {
    await api(`/bridge/orders/${id}/approve`, { method: 'POST', body: JSON.stringify({ approved_by: 'trustee' }) });
    showToast('Bridge order approved', 'success');
    loadBridgeOrders();
  } catch (err) {
    showToast(`Approval failed: ${err.message}`, 'error');
  }
}

async function cancelBridgeOrder(id) {
  if (!confirm('Cancel this bridge order? Funds will be returned.')) return;
  try {
    await api(`/bridge/orders/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'Cancelled by user' }) });
    showToast('Bridge order cancelled', 'success');
    loadBridgeOrders();
  } catch (err) {
    showToast(`Cancel failed: ${err.message}`, 'error');
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

// --- Copy address helper ---
function copyAddress(addr) {
  navigator.clipboard.writeText(addr).then(() => showToast('Address copied!', 'success')).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = addr;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showToast('Address copied!', 'success');
  });
}

// --- Receive Payment ---
let _receiveWallets = [];

async function showReceiveModal() {
  document.getElementById('receive-modal').classList.remove('hidden');
  document.getElementById('recv-address-display').style.display = 'none';
  try {
    const data = await api('/blockchain/wallets?status=active');
    _receiveWallets = data.wallets || [];
    const sel = document.getElementById('recv-wallet');
    sel.innerHTML = '<option value="">Select wallet...</option>' +
      _receiveWallets.map(w => `<option value="${w.id}" data-address="${w.address}">${w.wallet_name} (${w.address ? w.address.slice(0,10) + '...' : 'no addr'})</option>`).join('');
  } catch (err) { showToast('Failed to load wallets', 'error'); }
}

function showReceiveForWallet(walletId, walletName, address) {
  document.getElementById('receive-modal').classList.remove('hidden');
  document.getElementById('recv-address-display').style.display = 'block';
  document.getElementById('recv-address').textContent = address;
  generateReceiveQR(address);
  document.getElementById('recv-balances').innerHTML = '<span style="color:var(--text-muted)">Loading balances...</span>';

  // Load balances
  api(`/blockchain/wallets/${walletId}/balances`).then(data => {
    const b = data.balances || {};
    document.getElementById('recv-balances').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div><strong>${parseFloat(b.pol || 0).toFixed(4)}</strong> <span style="color:var(--text-muted)">POL</span></div>
        <div><strong>$${parseFloat(b.usdc || 0).toFixed(2)}</strong> <span style="color:var(--text-muted)">USDC</span></div>
        <div><strong>${parseFloat(b.dlbt || 0).toFixed(2)}</strong> <span style="color:var(--text-muted)">DLBT</span></div>
      </div>
    `;
  }).catch(() => {
    document.getElementById('recv-balances').innerHTML = '<span style="color:var(--text-muted)">Could not load balances</span>';
  });

  // Also populate the dropdown
  api('/blockchain/wallets?status=active').then(data => {
    _receiveWallets = data.wallets || [];
    const sel = document.getElementById('recv-wallet');
    sel.innerHTML = '<option value="">Select wallet...</option>' +
      _receiveWallets.map(w => `<option value="${w.id}" data-address="${w.address}" ${w.id === walletId ? 'selected' : ''}>${w.wallet_name} (${w.address ? w.address.slice(0,10) + '...' : 'no addr'})</option>`).join('');
  }).catch(() => {});
}

function updateReceiveAddress() {
  const sel = document.getElementById('recv-wallet');
  const opt = sel.options[sel.selectedIndex];
  const display = document.getElementById('recv-address-display');
  if (!sel.value) { display.style.display = 'none'; return; }

  const addr = opt.getAttribute('data-address');
  display.style.display = 'block';
  document.getElementById('recv-address').textContent = addr || 'No address';
  generateReceiveQR(addr);
  document.getElementById('recv-balances').innerHTML = '<span style="color:var(--text-muted)">Loading balances...</span>';

  api(`/blockchain/wallets/${sel.value}/balances`).then(data => {
    const b = data.balances || {};
    document.getElementById('recv-balances').innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div><strong>${parseFloat(b.pol || 0).toFixed(4)}</strong> <span style="color:var(--text-muted)">POL</span></div>
        <div><strong>$${parseFloat(b.usdc || 0).toFixed(2)}</strong> <span style="color:var(--text-muted)">USDC</span></div>
        <div><strong>${parseFloat(b.dlbt || 0).toFixed(2)}</strong> <span style="color:var(--text-muted)">DLBT</span></div>
      </div>
    `;
  }).catch(() => {});
}

function copyReceiveAddress() {
  const addr = document.getElementById('recv-address').textContent;
  copyAddress(addr);
}

// --- QR Code Generation (Receive) ---
function generateReceiveQR(address) {
  const canvas = document.getElementById('recv-qr-canvas');
  if (!canvas || !address || !window.QRCode) return;
  QRCode.toCanvas(canvas, address, {
    width: 200,
    margin: 2,
    color: { dark: '#000000', light: '#ffffff' }
  }, function(err) {
    if (err) console.error('QR generation error:', err);
  });
}

// --- QR Scanner (Send) ---
let _qrScanner = null;
let _qrTargetFieldId = null;

function startQrScan(targetFieldId) {
  _qrTargetFieldId = targetFieldId;
  document.getElementById('qr-scanner-modal').classList.remove('hidden');
  document.getElementById('qr-scan-result').style.display = 'none';

  const readerEl = document.getElementById('qr-reader');
  readerEl.innerHTML = '';

  if (!window.Html5Qrcode) {
    showToast('QR scanner library not loaded', 'error');
    return;
  }

  _qrScanner = new Html5Qrcode('qr-reader');
  _qrScanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: { width: 250, height: 250 } },
    (decodedText) => {
      // Extract address from various QR formats (ethereum:0x..., polygon:0x..., or plain 0x...)
      let address = decodedText.trim();
      if (address.includes(':')) {
        const parts = address.split(':');
        address = parts[parts.length - 1].split('?')[0].split('@')[0];
      }
      // Validate it looks like an Ethereum address
      if (/^0x[a-fA-F0-9]{40}$/.test(address)) {
        document.getElementById(_qrTargetFieldId).value = address;
        document.getElementById('qr-scan-value').textContent = address;
        document.getElementById('qr-scan-result').style.display = 'block';
        showToast('Address scanned!', 'success');
        setTimeout(() => stopQrScan(), 800);
      } else {
        // Try raw text anyway
        document.getElementById(_qrTargetFieldId).value = decodedText;
        document.getElementById('qr-scan-value').textContent = decodedText;
        document.getElementById('qr-scan-result').style.display = 'block';
        showToast('QR code scanned', 'success');
        setTimeout(() => stopQrScan(), 800);
      }
    },
    (errorMessage) => { /* scanning in progress, ignore frame errors */ }
  ).catch((err) => {
    console.error('QR scanner start error:', err);
    readerEl.innerHTML = `
      <div style="padding:24px;text-align:center;color:var(--text-muted)">
        <p style="font-size:2rem;margin-bottom:8px">📷</p>
        <p style="font-size:0.85rem">Camera access denied or not available.</p>
        <p style="font-size:0.8rem;color:var(--text-muted)">Grant camera permission or paste the address manually.</p>
      </div>
    `;
  });
}

function stopQrScan() {
  if (_qrScanner) {
    _qrScanner.stop().then(() => {
      _qrScanner.clear();
      _qrScanner = null;
    }).catch(() => { _qrScanner = null; });
  }
  document.getElementById('qr-scanner-modal').classList.add('hidden');
}

// --- Send DLBT ---
async function showSendTokenModal(token) {
  document.getElementById('send-dlbt-modal').classList.remove('hidden');
  try {
    const data = await api('/blockchain/wallets?status=active');
    const sel = document.getElementById('sd-from-wallet');
    sel.innerHTML = '<option value="">Select wallet...</option>' +
      (data.wallets || []).map(w => `<option value="${w.id}">${w.wallet_name} (${w.address ? w.address.slice(0,10) + '...' : 'no addr'})</option>`).join('');
  } catch (err) { showToast('Failed to load wallets', 'error'); }
}

function showSendFromWallet(walletId) {
  showSendUsdcModal();
  setTimeout(() => { document.getElementById('su-from-wallet').value = walletId; }, 300);
}

async function sendDlbt(e) {
  e.preventDefault();
  try {
    const result = await api('/blockchain/send', {
      method: 'POST',
      body: JSON.stringify({
        from_wallet_id: parseInt($('#sd-from-wallet').value),
        to_address: $('#sd-to-address').value,
        amount: $('#sd-amount').value,
        token: 'DLBT',
        transfer_type: $('#sd-type').value,
        description: $('#sd-description').value || undefined,
      }),
    });
    hideModal('send-dlbt-modal');
    const msg = result.requires_approval
      ? `Transfer of ${$('#sd-amount').value} DLBT requires approval`
      : `Transfer of ${$('#sd-amount').value} DLBT ${result.on_chain_submitted ? 'sent on-chain' : 'queued'}`;
    showToast(msg, 'success');
    loadBlockchain();
  } catch (err) {
    showToast(`Failed: ${err.message}`, 'error');
  }
}

// Swap POL → USDC

async function showSwapModal() {
  document.getElementById('swap-modal').classList.remove('hidden');
  document.getElementById('swap-quote-display').style.display = 'none';
  document.getElementById('swap-status').style.display = 'none';
  document.getElementById('swap-amount').value = '';

  // Populate wallet dropdown (private wallets only)
  try {
    const data = await api('/blockchain/wallets');
    const select = document.getElementById('swap-wallet');
    select.innerHTML = '<option value="">Select wallet...</option>';
    (data.wallets || []).filter(w => w.circle_wallet_id && w.circle_wallet_id.startsWith('private_')).forEach(w => {
      select.innerHTML += `<option value="${w.id}">${w.wallet_name} (${w.address ? w.address.slice(0,8) + '...' : 'no address'})</option>`;
    });
  } catch (err) {
    showToast('Failed to load wallets', 'error');
  }
}

async function getSwapQuote() {
  const amount = document.getElementById('swap-amount').value;
  if (!amount || parseFloat(amount) <= 0) {
    showToast('Enter a POL amount first', 'error');
    return;
  }

  const quoteDisplay = document.getElementById('swap-quote-display');
  const quoteValue = document.getElementById('swap-quote-value');
  quoteDisplay.style.display = 'block';
  quoteValue.textContent = 'Loading...';

  try {
    const data = await api(`/blockchain/swap/quote?amount=${encodeURIComponent(amount)}`);
    if (data.estimatedUsdcOut) {
      quoteValue.textContent = `~${parseFloat(data.estimatedUsdcOut).toFixed(2)} USDC`;
    } else if (data.error) {
      quoteValue.textContent = 'Quote unavailable';
    } else {
      quoteValue.textContent = 'DEX not available on this network';
    }
  } catch (err) {
    quoteValue.textContent = 'Error getting quote';
  }
}

async function executeSwap(e) {
  e.preventDefault();
  const walletId = document.getElementById('swap-wallet').value;
  const amount = document.getElementById('swap-amount').value;
  if (!walletId || !amount) return;

  const statusEl = document.getElementById('swap-status');
  statusEl.style.display = 'block';
  statusEl.style.background = 'rgba(139,92,246,0.1)';
  statusEl.style.border = '1px solid rgba(139,92,246,0.3)';
  statusEl.style.color = '#8b5cf6';
  statusEl.textContent = 'Executing swap: Wrapping POL → Approving router → Swapping via QuickSwap...';
  document.getElementById('swap-submit-btn').disabled = true;

  try {
    const result = await api('/blockchain/swap', {
      method: 'POST',
      body: JSON.stringify({
        wallet_id: parseInt(walletId),
        amount_pol: amount,
      }),
    });
    hideModal('swap-modal');
    const msg = `Swapped ${result.swap.amountPolIn} POL → ${parseFloat(result.swap.usdcBalanceAfter).toFixed(2)} USDC`;
    showToast(msg, 'success');
    if (result.explorerUrl) {
      showToast(`View on explorer: ${result.explorerUrl}`, 'info');
    }
    loadBlockchain();
  } catch (err) {
    statusEl.style.background = 'rgba(244,67,54,0.1)';
    statusEl.style.border = '1px solid rgba(244,67,54,0.3)';
    statusEl.style.color = 'var(--danger)';
    statusEl.textContent = `Swap failed: ${err.message}`;
  } finally {
    document.getElementById('swap-submit-btn').disabled = false;
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

// --- Private Stack Functions ---

async function switchProvider(provider) {
  try {
    await api('/blockchain/provider', { method: 'POST', body: JSON.stringify({ provider }) });
    showToast(`Provider switched to ${provider === 'private' ? 'Private Stack' : 'Circle API'}`, 'success');
    loadBlockchain();
  } catch (err) {
    showToast(`Failed to switch provider: ${err.message}`, 'error');
  }
}

async function pingRpc() {
  try {
    showToast('Testing RPC connection...', 'info');
    const result = await api('/blockchain/rpc/ping');
    if (result.connected) {
      showToast(`RPC Connected — Block #${result.blockNumber}, Gas: ${result.gasPrice?.gasPrice || '?'} Gwei`, 'success');
    } else {
      showToast(`RPC Failed: ${result.error || 'Unknown error'}`, 'error');
    }
  } catch (err) {
    showToast(`RPC Ping failed: ${err.message}`, 'error');
  }
}

// --- Cash Management ---

async function loadCashManagement() {
  try {
    const [position, forecast, reconciliation, alerts, income] = await Promise.all([
      api('/cash-management/position'),
      api('/cash-management/forecast'),
      api('/cash-management/reconciliation'),
      api('/cash-management/alerts'),
      api('/cash-management/income-summary'),
    ]);

    const p = position.position || position;
    const s = p.summary || {};
    $('#cms-metrics').innerHTML = `
      <div class="metric-card primary"><span class="metric-label">Total Assets</span><span class="metric-value">${formatUSD(s.total_assets_cents || 0)}</span></div>
      <div class="metric-card"><span class="metric-label">Total Liquid</span><span class="metric-value">${formatUSD(s.total_liquid_cents || 0)}</span></div>
      <div class="metric-card"><span class="metric-label">Fixed Income</span><span class="metric-value">${formatUSD(s.fixed_income_market_cents || s.total_fixed_income_market_cents || 0)}</span></div>
      <div class="metric-card"><span class="metric-label">Crypto (USDC)</span><span class="metric-value">${formatUSD(s.crypto_balance_cents || s.total_crypto_cents || 0)}</span></div>
      <div class="metric-card"><span class="metric-label">Pending Activity</span><span class="metric-value">${formatUSD(s.net_pending_cents || s.total_pending_cents || 0)}</span></div>
      <div class="metric-card ${(alerts.alerts || []).length > 0 ? 'warn' : ''}"><span class="metric-label">Alerts</span><span class="metric-value">${(alerts.alerts || []).length}</span></div>
    `;

    // Flatten bank_accounts, crypto_wallets, fixed_income into a single detail array
    const details = p.detail || [
      ...((p.bank_accounts?.items || []).map(i => ({ source: 'Banking', name: i.name, type: i.type, balance_cents: i.balance_cents }))),
      ...((p.crypto_wallets?.items || []).map(i => ({ source: 'Crypto', name: i.name, type: i.type || 'wallet', balance_cents: i.usdc_balance_cents }))),
      ...((p.fixed_income?.items || []).map(i => ({ source: 'Fixed Income', name: i.name, type: i.type, balance_cents: i.market_value_cents || i.par_value_cents }))),
    ];
    $('#cms-position-table').innerHTML = details.length ? `<table><thead><tr><th>Source</th><th>Name</th><th>Type</th><th>Balance</th></tr></thead><tbody>${details.map(d =>
      `<tr><td>${d.source}</td><td>${d.name}</td><td>${badge(d.type)}</td><td>${formatUSD(d.balance_cents)}</td></tr>`
    ).join('')}</tbody></table>` : '<p>No position data</p>';

    const periods = forecast.periods || forecast.forecast || [];
    $('#cms-forecast-table').innerHTML = periods.length ? `<table><thead><tr><th>Period</th><th>Start</th><th>End</th><th>Inflows</th><th>Outflows</th><th>Net</th></tr></thead><tbody>${periods.map(f =>
      `<tr><td>${f.period_number || f.period}</td><td>${f.start_date || '—'}</td><td>${f.end_date || '—'}</td><td>${formatUSD(f.total_inflow_cents || f.inflows_cents || 0)}</td><td>${formatUSD(f.total_outflow_cents || f.outflows_cents || 0)}</td><td>${formatUSD(f.net_flow_cents || f.net_cents || 0)}</td></tr>`
    ).join('')}</tbody></table>` : '<p>No forecast data</p>';

    const checks = reconciliation.items || reconciliation.checks || reconciliation.reconciliation || [];
    $('#cms-reconciliation').innerHTML = checks.length ? checks.map(c =>
      `<div class="alert alert-${c.status === 'matched' ? 'success' : c.status === 'mismatch' ? 'danger' : 'info'}" style="margin-bottom:8px;padding:12px;border-radius:8px;border:1px solid var(--border)">
        <strong>${c.check}</strong>: ${badge(c.status)} ${c.difference_cents !== undefined ? `(Δ ${formatUSD(c.difference_cents)})` : ''}
      </div>`
    ).join('') : '<p>No reconciliation data — click "Run Reconciliation"</p>';

    const alertList = alerts.alerts || [];
    $('#cms-alerts').innerHTML = alertList.length ? alertList.map(a =>
      `<div style="padding:8px;border-bottom:1px solid var(--border)"><strong>${a.type}</strong>: ${a.message} ${badge(a.severity)}</div>`
    ).join('') : '<p>No active alerts</p>';

    const inc = income.summary || income;
    $('#cms-income-summary').innerHTML = `<p>Projected Annual Income: <strong>${formatUSD(inc.projected_annual_income_cents || 0)}</strong> | YTD Expenses: <strong>${formatUSD(inc.ytd_expenses_cents || 0)}</strong></p>`;
  } catch (err) {
    console.error('CMS load error:', err);
  }
}

async function runCMSReconciliation() {
  try {
    showToast('Running reconciliation...', 'info');
    await api('/cash-management/reconciliation');
    await loadCashManagement();
    showToast('Reconciliation complete', 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

async function saveCMSSnapshot() {
  try {
    const result = await api('/cash-management/snapshot', { method: 'POST' });
    showToast(`Snapshot saved (ID: ${result.snapshot_id || result.id || '?'})`, 'success');
  } catch (err) { showToast(err.message, 'error'); }
}

// --- Documents ---

async function loadDocuments() {
  try {
    const data = await api('/documents');
    const docs = data.documents || [];
    const stats = data.stats || {};

    $('#doc-metrics').innerHTML = `
      <div class="metric-card primary"><span class="metric-label">Total Documents</span><span class="metric-value">${stats.total || docs.length}</span></div>
      <div class="metric-card"><span class="metric-label">Active</span><span class="metric-value">${stats.active || 0}</span></div>
      <div class="metric-card"><span class="metric-label">Draft</span><span class="metric-value">${stats.draft || 0}</span></div>
      <div class="metric-card"><span class="metric-label">Archived</span><span class="metric-value">${stats.archived || 0}</span></div>
    `;

    $('#doc-table').innerHTML = docs.length ? `<table><thead><tr><th>Title</th><th>Category</th><th>Status</th><th>Created</th></tr></thead><tbody>${docs.map(d =>
      `<tr><td>${d.title}</td><td>${d.category}</td><td>${badge(d.status)}</td><td>${formatDate(d.created_at)}</td></tr>`
    ).join('')}</tbody></table>` : '<p>No documents yet — click "+ Upload Document" to add one</p>';
  } catch (err) {
    console.error('Documents load error:', err);
  }
}

function showUploadDocument() {
  const modal = $('#upload-doc-modal');
  if (modal) modal.classList.remove('hidden');
}

async function uploadDocument(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    await api('/documents', {
      method: 'POST',
      body: JSON.stringify({
        title: form.get('title'),
        category: form.get('category'),
        description: form.get('description'),
      }),
    });
    hideModal('upload-doc-modal');
    event.target.reset();
    showToast('Document uploaded', 'success');
    loadDocuments();
  } catch (err) { showToast(err.message, 'error'); }
}

// --- AI Agent ---

async function loadAIAgent() {
  try {
    const data = await api('/agent/conversations');
    const convos = data.conversations || [];
    const history = data.task_history || [];

    if (!$('#agent-chat').innerHTML || $('#agent-chat').innerHTML.trim() === '') {
      $('#agent-chat').innerHTML = '<p style="color:var(--text-secondary)">Ask me anything — "run reconciliation", "list accounts", "generate forecast", "save snapshot"...</p>';
    }

    $('#agent-task-history').innerHTML = history.length ? history.slice(0, 10).map(t =>
      `<div style="padding:6px;border-bottom:1px solid var(--border);font-size:13px"><strong>${t.intent || t.task}</strong> — ${badge(t.status)} <span style="color:var(--text-secondary)">${t.duration_ms ? t.duration_ms + 'ms' : ''}</span></div>`
    ).join('') : '<p style="font-size:13px;color:var(--text-secondary)">No tasks yet</p>';
  } catch (err) {
    console.error('AI Agent load error:', err);
  }
}

async function sendAgentMessage(event) {
  event.preventDefault();
  const input = $('#agent-input');
  const message = input.value.trim();
  if (!message) return;

  const chat = $('#agent-chat');
  chat.innerHTML += `<div style="margin:8px 0;padding:8px 12px;background:var(--primary);color:#fff;border-radius:12px 12px 4px 12px;display:inline-block;float:right;clear:both;max-width:80%">${message}</div><div style="clear:both"></div>`;
  input.value = '';

  try {
    const result = await api('/agent/chat', { method: 'POST', body: JSON.stringify({ prompt: message }) });
    const response = result.response || result.message || JSON.stringify(result);
    chat.innerHTML += `<div style="margin:8px 0;padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:12px 12px 12px 4px;display:inline-block;clear:both;max-width:80%;white-space:pre-wrap">${response}</div><div style="clear:both"></div>`;
    chat.scrollTop = chat.scrollHeight;
    showToast('Task completed', 'success');
  } catch (err) {
    chat.innerHTML += `<div style="margin:8px 0;padding:8px 12px;background:#fee;border:1px solid #fcc;border-radius:12px;display:inline-block;clear:both">${err.message}</div><div style="clear:both"></div>`;
  }
}

async function agentQuickAction(prompt) {
  $('#agent-input').value = prompt;
  const form = $('#agent-form');
  form.dispatchEvent(new Event('submit'));
}

// --- Integration ---

async function loadIntegration() {
  try {
    const [status, dataMap, events, executions] = await Promise.all([
      api('/integration/status'),
      api('/integration/data-map'),
      api('/integration/events'),
      api('/integration/executions'),
    ]);

    // Metrics
    const engines = status.engines || [];
    const connected = engines.filter(e => e.status === 'connected').length;
    const total = engines.length;
    const pipelineCount = status.total_executions || 0;
    const recentFailed = status.recent_failed || 0;

    $('#integration-metrics').innerHTML = `
      <div class="metric-card primary"><span class="metric-label">Engines Connected</span><span class="metric-value">${connected}/${total}</span></div>
      <div class="metric-card"><span class="metric-label">Pipelines Available</span><span class="metric-value">${(status.pipelines || []).length}</span></div>
      <div class="metric-card"><span class="metric-label">Total Executions</span><span class="metric-value">${pipelineCount}</span></div>
      <div class="metric-card ${recentFailed > 0 ? 'warn' : ''}"><span class="metric-label">Recent Failures</span><span class="metric-value">${recentFailed}</span></div>
    `;

    // Engine Status Table
    $('#integration-engine-status').innerHTML = `<table><thead><tr><th>Engine</th><th>Status</th><th>Records</th></tr></thead><tbody>${engines.map(e =>
      `<tr><td>${e.name}</td><td>${badge(e.status)}</td><td>${e.records}</td></tr>`
    ).join('')}</tbody></table>`;

    // Data Flow Map
    const flows = dataMap.flows || [];
    $('#integration-data-map').innerHTML = `
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:16px">${(dataMap.engines || []).map(e =>
        `<div style="padding:8px 12px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:13px">
          <strong>${e.name}</strong><br>
          ${(e.tables || []).map(t => `<span style="color:var(--text-secondary);font-size:11px">${typeof t === 'object' ? `${t.name} (${t.records})` : t}</span>`).join(', ')}
        </div>`
      ).join('')}</div>
      <h4>Data Flows</h4>
      <div style="max-height:200px;overflow-y:auto">${flows.map(f =>
        `<div style="padding:4px 0;font-size:13px;border-bottom:1px solid var(--border)">
          <strong>${f.from}</strong> → <strong>${f.to}</strong> <span style="color:var(--text-secondary)">(${f.trigger})</span>: ${f.data}
        </div>`
      ).join('')}</div>
    `;

    // Recent Events
    const eventList = events.events || [];
    $('#integration-events').innerHTML = eventList.length ? eventList.slice(-20).reverse().map(e =>
      `<div style="padding:4px 0;font-size:12px;border-bottom:1px solid var(--border)">
        <strong>${e.event}</strong><br><span style="color:var(--text-secondary)">${e.timestamp}</span>
      </div>`
    ).join('') : '<p style="font-size:13px;color:var(--text-secondary)">No events yet — execute a pipeline to see events</p>';

    // Execution Log
    const execs = executions.executions || [];
    $('#integration-execution-log').innerHTML = execs.length ? `<table><thead><tr><th>ID</th><th>Pipeline</th><th>Trigger</th><th>Status</th><th>Started</th><th>Duration</th></tr></thead><tbody>${execs.map(e => {
      const duration = e.started_at && e.completed_at ? ((new Date(e.completed_at) - new Date(e.started_at))) + 'ms' : '—';
      return `<tr><td style="font-size:11px">${e.execution_id || e.id}</td><td>${e.pipeline}</td><td>${e.trigger_type || '—'}</td><td>${badge(e.status)}</td><td>${formatTime(e.started_at)}</td><td>${duration}</td></tr>`;
    }).join('')}</tbody></table>` : '<p>No pipeline executions yet</p>';

  } catch (err) {
    console.error('Integration load error:', err);
    $('#integration-metrics').innerHTML = '<div class="metric-card warn"><span class="metric-label">Error</span><span class="metric-value">' + err.message + '</span></div>';
  }
}

// Integration Modal helpers

function showIntegrationModal(type) {
  const modalMap = {
    'coupon': 'integration-coupon-modal',
    'internal-transfer': 'integration-transfer-modal',
    'external-payment': 'integration-payment-modal',
    'crypto-send': 'integration-crypto-modal',
    'dex-swap': 'integration-swap-modal',
  };
  const modalId = modalMap[type];
  if (!modalId) return;

  // Pre-populate dropdowns for transfer/payment modals
  if (type === 'internal-transfer' || type === 'external-payment') {
    loadAccountDropdowns();
  }
  if (type === 'crypto-send' || type === 'dex-swap') {
    loadWalletDropdowns();
  }

  const modal = $(`#${modalId}`);
  if (modal) modal.classList.remove('hidden');
}

async function loadAccountDropdowns() {
  try {
    const data = await api('/accounts');
    const accounts = (data.accounts || []).filter(a => a.status === 'active');
    const options = accounts.map(a => `<option value="${a.id}">${a.account_name} (${formatUSD(a.balance_cents)})</option>`).join('');
    const selectors = ['#int-from-acct', '#int-to-acct', '#int-pay-from-acct'];
    selectors.forEach(sel => { const el = $(sel); if (el) el.innerHTML = options; });
  } catch (err) { console.error('Account dropdown error:', err); }
}

async function loadWalletDropdowns() {
  try {
    const data = await api('/blockchain/wallets');
    const wallets = (data.wallets || []).filter(w => w.wallet_type === 'private');
    const options = wallets.map(w => `<option value="${w.id}">${w.wallet_name || w.address} (${w.usdc_balance || '0'} USDC)</option>`).join('');
    const selectors = ['#int-wallet', '#int-swap-wallet'];
    selectors.forEach(sel => { const el = $(sel); if (el) el.innerHTML = options; });
  } catch (err) { console.error('Wallet dropdown error:', err); }
}

async function executeCouponPipeline(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    showToast('Executing Coupon → Cash pipeline...', 'info');
    const result = await api('/integration/coupon-to-cash', {
      method: 'POST',
      body: JSON.stringify({
        bond_id: parseInt(form.get('bond_id')),
        coupon_id: form.get('coupon_id') ? parseInt(form.get('coupon_id')) : null,
        amount_cents: parseInt(form.get('amount_cents')),
      }),
    });
    hideModal('integration-coupon-modal');
    showToast(`Pipeline ${result.status}: ${(result.results?.steps || []).length} steps`, 'success');
    loadIntegration();
  } catch (err) { showToast(err.message, 'error'); }
}

async function executeTransferPipeline(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    showToast('Executing Internal Transfer pipeline...', 'info');
    const result = await api('/integration/internal-transfer', {
      method: 'POST',
      body: JSON.stringify({
        from_account_id: parseInt(form.get('from_account_id')),
        to_account_id: parseInt(form.get('to_account_id')),
        amount_cents: parseInt(form.get('amount_cents')),
        transfer_type: form.get('transfer_type'),
        description: form.get('description'),
      }),
    });
    hideModal('integration-transfer-modal');
    showToast(`Transfer ${result.status}: ${result.results?.steps?.[1]?.transfer_number || ''}`, 'success');
    loadIntegration();
  } catch (err) { showToast(err.message, 'error'); }
}

async function executePaymentPipeline(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    showToast('Executing External Payment pipeline...', 'info');
    const result = await api('/integration/external-payment', {
      method: 'POST',
      body: JSON.stringify({
        from_account_id: parseInt(form.get('from_account_id')),
        amount_cents: parseInt(form.get('amount_cents')),
        rail: form.get('rail'),
        description: form.get('description'),
      }),
    });
    hideModal('integration-payment-modal');
    const railInfo = result.results?.steps?.find(s => s.step === 'process_payment_rail');
    showToast(`Payment ${result.status} via ${railInfo?.rail || 'ACH'} — ${railInfo?.settlement_time || ''}`, 'success');
    loadIntegration();
  } catch (err) { showToast(err.message, 'error'); }
}

async function executeCryptoPipeline(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    showToast('Executing USDC Send pipeline...', 'info');
    const result = await api('/integration/crypto-send', {
      method: 'POST',
      body: JSON.stringify({
        wallet_id: parseInt(form.get('wallet_id')),
        to_address: form.get('to_address'),
        amount_usd: parseFloat(form.get('amount_usd')),
      }),
    });
    hideModal('integration-crypto-modal');
    showToast(`USDC Send ${result.status}`, 'success');
    loadIntegration();
  } catch (err) { showToast(err.message, 'error'); }
}

async function executeSwapPipeline(event) {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    showToast('Executing DEX Swap pipeline...', 'info');
    const result = await api('/integration/dex-swap', {
      method: 'POST',
      body: JSON.stringify({
        wallet_id: parseInt(form.get('wallet_id')),
        amount_pol: parseFloat(form.get('amount_pol')),
        slippage_bps: parseInt(form.get('slippage_bps')) || 100,
      }),
    });
    hideModal('integration-swap-modal');
    showToast(`Swap ${result.status}`, 'success');
    loadIntegration();
  } catch (err) { showToast(err.message, 'error'); }
}

async function runIntegrationReconciliation() {
  try {
    showToast('Running full system reconciliation...', 'info');
    const result = await api('/integration/reconcile', { method: 'POST' });
    showToast(`Reconciliation ${result.status}: ${result.results?.matched || 0}/${result.results?.total_checks || 0} matched`, 'success');
    loadIntegration();
  } catch (err) { showToast(err.message, 'error'); }
}

async function runDailySweep() {
  try {
    showToast('Executing daily sweep...', 'info');
    const result = await api('/integration/daily-sweep', { method: 'POST' });
    const sweeps = result.results?.sweeps || [];
    showToast(`Sweep ${result.status}: ${sweeps.length} sweep(s) executed`, 'success');
    loadIntegration();
  } catch (err) { showToast(err.message, 'error'); }
}

// --- Reports (Document Generation) ---

let reportTypesCache = null;

async function loadReports() {
  try {
    // Fetch report types
    const typesData = await api('/document-generation/report-types');
    reportTypesCache = typesData.report_types || [];

    // Fetch generation log
    const logData = await api('/document-generation/log');
    const log = logData.log || [];

    // Update metrics
    $('#reports-generated-count').textContent = log.length;
    $('#reports-template-count').textContent = reportTypesCache.length;
    $('#reports-last-generated').textContent = log.length > 0
      ? formatTime(log[0].started_at) : 'Never';

    // Render template cards
    const grid = $('#report-templates-grid');
    grid.innerHTML = reportTypesCache.map(t => `
      <div class="report-template-card" onclick="quickGenerate('${t.id}')">
        <h4>${t.name}</h4>
        <p>${t.description}</p>
        <div class="template-meta">
          <span class="badge badge-active">${t.category}</span>
          <span class="data-sources">${(t.data_sources || []).join(', ')}</span>
        </div>
      </div>
    `).join('');

    // Render log
    const tbody = $('#report-log-body');
    if (log.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#999;">No reports generated yet. Click a template above or use "Generate Report" button.</td></tr>';
    } else {
      tbody.innerHTML = log.map(entry => `
        <tr>
          <td>${entry.report_type}</td>
          <td>${badge(entry.status)}</td>
          <td>${entry.document_id ? `<a href="/api/document-generation/preview/${entry.document_id}" target="_blank">#${entry.document_id}</a>` : '—'}</td>
          <td>${entry.duration_ms ? entry.duration_ms + 'ms' : '—'}</td>
          <td>${formatTime(entry.started_at)}</td>
        </tr>
      `).join('');
    }
  } catch (err) {
    showToast('Failed to load reports: ' + err.message, 'error');
  }
}

function openGenerateModal() {
  const select = $('#gen-report-type');
  select.innerHTML = '<option value="">— Select Report Type —</option>';
  if (reportTypesCache) {
    reportTypesCache.forEach(t => {
      select.innerHTML += `<option value="${t.id}">${t.name}</option>`;
    });
  }
  $('#gen-report-desc-wrap').style.display = 'none';
  $('#gen-report-sources-wrap').style.display = 'none';
  $('#gen-report-result').style.display = 'none';
  $('#gen-report-btn').disabled = false;
  $('#gen-report-btn').textContent = 'Generate';
  $('#generate-report-modal').style.display = 'flex';
}

function closeGenerateModal() {
  $('#generate-report-modal').style.display = 'none';
}

function updateReportDescription() {
  const selected = $('#gen-report-type').value;
  if (!selected || !reportTypesCache) {
    $('#gen-report-desc-wrap').style.display = 'none';
    $('#gen-report-sources-wrap').style.display = 'none';
    return;
  }
  const template = reportTypesCache.find(t => t.id === selected);
  if (template) {
    $('#gen-report-desc').textContent = template.description;
    $('#gen-report-desc-wrap').style.display = 'block';
    $('#gen-report-sources').textContent = (template.data_sources || []).join(', ');
    $('#gen-report-sources-wrap').style.display = 'block';
  }
}

async function executeGenerateReport() {
  const reportType = $('#gen-report-type').value;
  if (!reportType) { showToast('Please select a report type', 'error'); return; }

  const btn = $('#gen-report-btn');
  btn.disabled = true;
  btn.textContent = 'Generating...';
  $('#gen-report-result').style.display = 'none';

  try {
    const result = await api('/document-generation/generate', {
      method: 'POST',
      body: JSON.stringify({ report_type: reportType, params: {} }),
    });

    btn.textContent = 'Done!';
    const resultDiv = $('#gen-report-result');
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = `
      <div class="alert alert-success">
        <strong>${result.report_name}</strong> generated successfully!<br>
        Document ID: #${result.document_id} | Duration: ${result.duration_ms}ms<br>
        <a href="/api/document-generation/preview/${result.document_id}" target="_blank" class="btn btn-sm btn-primary" style="margin-top:8px;">Preview Document</a>
      </div>
    `;

    showToast(`${result.report_name} generated (ID: ${result.document_id})`, 'success');
    loadReports();
  } catch (err) {
    btn.textContent = 'Generate';
    btn.disabled = false;
    showToast('Generation failed: ' + err.message, 'error');
  }
}

async function quickGenerate(reportType) {
  showToast('Generating report...', 'info');
  try {
    const result = await api('/document-generation/generate', {
      method: 'POST',
      body: JSON.stringify({ report_type: reportType, params: {} }),
    });
    showToast(`${result.report_name} generated — Document #${result.document_id}`, 'success');
    loadReports();
    // Open preview in new tab
    window.open(`/api/document-generation/preview/${result.document_id}`, '_blank');
  } catch (err) {
    showToast('Generation failed: ' + err.message, 'error');
  }
}

// --- Fineract Banking ---

async function loadFineract() {
  try {
    const [status, payments, batches, log] = await Promise.all([
      api('/fineract/status'),
      api('/fineract/payments'),
      api('/fineract/ach/batches'),
      api('/fineract/settlement-log'),
    ]);

    // Metrics
    $('#fin-total').textContent = status.stats.total;
    $('#fin-pending').textContent = status.stats.pending;
    $('#fin-settled').textContent = status.stats.settled;
    $('#fin-failed').textContent = status.stats.failed;
    $('#fin-volume').textContent = `$${(status.stats.volume_today_cents / 100).toLocaleString()}`;
    $('#fin-mode').textContent = status.mode.charAt(0).toUpperCase() + status.mode.slice(1);

    // Rails table
    const railsBody = $('#fineract-rails-body');
    railsBody.innerHTML = status.available_rails.map(r => `
      <tr>
        <td><strong>${r.code}</strong></td>
        <td>${r.name}</td>
        <td>${r.fee}</td>
        <td>${r.settlement}</td>
        <td>${r.max_amount || 'No limit'}</td>
        <td>${r.batch_eligible ? 'Yes' : 'No'}</td>
      </tr>
    `).join('');

    // Payments table
    const paymentsBody = $('#fineract-payments-body');
    paymentsBody.innerHTML = payments.length ? payments.map(p => `
      <tr>
        <td><code>${p.payment_number}</code></td>
        <td><span class="badge badge-${p.rail === 'WIRE' ? 'warning' : p.rail === 'RTP' ? 'success' : 'info'}">${p.rail}</span></td>
        <td>$${(p.amount_cents / 100).toLocaleString()}</td>
        <td>$${(p.fee_cents / 100).toFixed(2)}</td>
        <td>${p.to_beneficiary_name || '—'}</td>
        <td><span class="badge badge-${p.status === 'settled' ? 'success' : p.status === 'failed' ? 'danger' : 'warning'}">${p.status}</span></td>
        <td>${p.settlement_date || '—'}</td>
        <td>${new Date(p.created_at).toLocaleDateString()}</td>
      </tr>
    `).join('') : '<tr><td colspan="8" style="text-align:center;color:#666">No payments yet. Click "+ New Payment" to initiate.</td></tr>';

    // Batches table
    const batchesBody = $('#fineract-batches-body');
    batchesBody.innerHTML = batches.length ? batches.map(b => `
      <tr>
        <td><code>${b.batch_number}</code></td>
        <td>${b.batch_type}</td>
        <td>${b.entry_count}</td>
        <td>$${(b.total_debit_cents / 100).toLocaleString()}</td>
        <td><span class="badge badge-${b.status === 'settled' ? 'success' : 'warning'}">${b.status}</span></td>
        <td>${b.effective_date || '—'}</td>
        <td>${b.status !== 'settled' ? `<button class="btn btn-sm btn-primary" onclick="fineractSettleBatch(${b.id})">Settle</button>` : '—'}</td>
      </tr>
    `).join('') : '<tr><td colspan="7" style="text-align:center;color:#666">No ACH batches</td></tr>';

    // Settlement log
    const logBody = $('#fineract-log-body');
    logBody.innerHTML = log.slice(0, 20).map(l => `
      <tr>
        <td><code>${l.payment_number}</code></td>
        <td>${l.rail}</td>
        <td>${l.from_status}</td>
        <td>${l.to_status}</td>
        <td>${l.event_type}</td>
        <td>${new Date(l.created_at).toLocaleString()}</td>
      </tr>
    `).join('') || '<tr><td colspan="6" style="text-align:center;color:#666">No settlement events</td></tr>';
  } catch (err) {
    showToast('Failed to load Fineract: ' + err.message, 'error');
  }
}

function showFineractPaymentModal() {
  document.getElementById('fineract-payment-modal').style.display = 'flex';
  // Load accounts into dropdown
  api('/accounts').then(data => {
    const accounts = Array.isArray(data) ? data : (data.accounts || []);
    const sel = document.getElementById('fin-from-account');
    sel.innerHTML = accounts.filter(a => a.status === 'active').map(a =>
      `<option value="${a.id}">${a.account_name} ($${(a.balance_cents / 100).toLocaleString()})</option>`
    ).join('');
  });
}

function closeFineractPaymentModal() {
  document.getElementById('fineract-payment-modal').style.display = 'none';
}

function updateRailInfo() {}

async function submitFineractPayment(e) {
  e.preventDefault();
  const payload = {
    from_account_id: parseInt(document.getElementById('fin-from-account').value),
    rail: document.getElementById('fin-rail').value,
    amount_cents: Math.round(parseFloat(document.getElementById('fin-amount').value) * 100),
    to_routing_number: document.getElementById('fin-routing').value,
    to_account_number: document.getElementById('fin-account-num').value,
    to_bank_name: document.getElementById('fin-bank-name').value,
    to_beneficiary_name: document.getElementById('fin-beneficiary').value,
    to_beneficiary_address: document.getElementById('fin-address').value,
    memo: document.getElementById('fin-memo').value,
    description: document.getElementById('fin-memo').value,
  };

  try {
    const result = await api('/fineract/payments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    showToast(`Payment initiated: ${result.payment_number} (${result.rail}, ${result.estimated_settlement})`, 'success');
    closeFineractPaymentModal();
    loadFineract();
  } catch (err) {
    showToast('Payment failed: ' + err.message, 'error');
  }
}

async function fineractSync() {
  try {
    const result = await api('/fineract/sync', { method: 'POST' });
    showToast(`Sync complete: ${result.synced} new accounts linked`, 'success');
    loadFineract();
  } catch (err) {
    showToast('Sync failed: ' + err.message, 'error');
  }
}

async function fineractProcessSettlements() {
  try {
    const result = await api('/fineract/settlements/process', { method: 'POST' });
    showToast(`Settled ${result.processed} payments. ${result.remaining_clearing} still in clearing.`, 'success');
    loadFineract();
  } catch (err) {
    showToast('Settlement processing failed: ' + err.message, 'error');
  }
}

async function fineractCreateBatch() {
  try {
    const result = await api('/fineract/ach/batch', { method: 'POST' });
    if (!result.batch_id) {
      showToast('No pending ACH payments to batch', 'info');
    } else {
      showToast(`ACH Batch ${result.batch_number} created with ${result.entry_count} entries`, 'success');
    }
    loadFineract();
  } catch (err) {
    showToast('Batch creation failed: ' + err.message, 'error');
  }
}

async function fineractSettleBatch(batchId) {
  try {
    const result = await api(`/fineract/ach/batch/${batchId}/settle`, { method: 'POST' });
    showToast(`Batch settled: ${result.settled_count} payments`, 'success');
    loadFineract();
  } catch (err) {
    showToast('Batch settlement failed: ' + err.message, 'error');
  }
}

// ==================== Polygon CDK Appchain ==================================

async function loadCDK() {
  try {
    const data = await api('/cdk/dashboard');

    // Metrics
    const supply = data.token_info ? parseFloat(data.token_info.totalSupply || '0') : 0;
    const mintedCents = data.stats?.mints_total_cents || 0;
    const burnedCents = data.stats?.burns_total_cents || 0;
    const totalOps = data.stats?.total || 0;

    document.getElementById('cdk-total-supply').textContent = '$' + supply.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('cdk-total-minted').textContent = formatUSD(mintedCents);
    document.getElementById('cdk-total-burned').textContent = formatUSD(burnedCents);
    document.getElementById('cdk-operations-count').textContent = totalOps;

    // Token contract info
    const tokenInfoDiv = document.getElementById('cdk-token-info');
    const deployActions = document.getElementById('cdk-deploy-actions');

    if (data.token_contract && data.token_info && !data.token_info.error) {
      tokenInfoDiv.innerHTML = `
        <div class="info-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;">
          <div><strong>Name:</strong> ${data.token_info.name}</div>
          <div><strong>Symbol:</strong> ${data.token_info.symbol}</div>
          <div><strong>Decimals:</strong> ${data.token_info.decimals}</div>
          <div><strong>Total Supply:</strong> ${parseFloat(data.token_info.totalSupply).toLocaleString('en-US', {minimumFractionDigits: 2})} DLBT</div>
          <div><strong>Owner:</strong> <code style="font-size:0.8rem;">${data.token_info.owner}</code></div>
          <div><strong>Paused:</strong> ${data.token_info.paused ? 'Yes' : 'No'}</div>
          <div style="grid-column:span 2;"><strong>Contract:</strong> <a href="https://polygonscan.com/address/${data.token_contract.contract_address}" target="_blank"><code style="font-size:0.8rem;">${data.token_contract.contract_address}</code></a></div>
          <div style="grid-column:span 2;"><strong>TX:</strong> <a href="https://polygonscan.com/tx/${data.token_contract.tx_hash}" target="_blank">${data.token_contract.tx_hash ? data.token_contract.tx_hash.slice(0, 20) + '...' : '—'}</a></div>
        </div>
      `;
      deployActions.style.display = 'none';
    } else if (data.token_contract && data.token_info && data.token_info.error) {
      tokenInfoDiv.innerHTML = `
        <p>Token deployed at <code>${data.token_contract.contract_address}</code> but unable to read on-chain info: ${data.token_info.error}</p>
      `;
      deployActions.style.display = 'none';
    } else {
      tokenInfoDiv.innerHTML = `<p>No token deployed. Click <strong>Deploy DLBT Token</strong> to create the trust-backed ERC-20 token on Polygon mainnet.</p>`;
      deployActions.style.display = 'flex';
    }

    // Populate dropdowns
    const accounts = data.accounts || [];
    const wallets  = data.wallets  || [];

    const mintAccountSel = document.getElementById('cdk-mint-account');
    const burnAccountSel = document.getElementById('cdk-burn-account');
    const mintWalletSel  = document.getElementById('cdk-mint-wallet');
    const burnWalletSel  = document.getElementById('cdk-burn-wallet');
    const deployerSel    = document.getElementById('cdk-deployer-wallet');

    const accountOpts = accounts.map(a => `<option value="${a.id}">${a.account_name} ($${a.balance_usd})</option>`).join('');
    const walletOpts  = wallets.map(w => `<option value="${w.id}">${w.wallet_name} (${w.address ? w.address.slice(0,10) + '...' : 'no addr'})</option>`).join('');

    mintAccountSel.innerHTML = '<option value="">Select account...</option>' + accountOpts;
    burnAccountSel.innerHTML = '<option value="">Select account...</option>' + accountOpts;
    mintWalletSel.innerHTML  = '<option value="">Select wallet...</option>' + walletOpts;
    burnWalletSel.innerHTML  = '<option value="">Select wallet...</option>' + walletOpts;
    deployerSel.innerHTML    = '<option value="">Select deployer wallet...</option>' + walletOpts;

    // Operations table
    const ops = data.recent_operations || [];
    const opsDiv = document.getElementById('cdk-operations-table');
    if (ops.length) {
      opsDiv.innerHTML = `
        <table>
          <thead><tr><th>Operation</th><th>Type</th><th>Amount</th><th>TX Hash</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>${ops.map(o => `
            <tr>
              <td><code style="font-size:0.8rem;">${o.operation_number}</code></td>
              <td>${badge(o.operation_type)}</td>
              <td>${formatUSD(o.amount_cents)}</td>
              <td>${o.tx_hash ? `<a href="https://polygonscan.com/tx/${o.tx_hash}" target="_blank">${o.tx_hash.slice(0, 12)}...</a>` : '—'}</td>
              <td>${badge(o.status)}</td>
              <td>${formatTime(o.created_at)}</td>
            </tr>
          `).join('')}</tbody>
        </table>
      `;
    } else {
      opsDiv.innerHTML = '<p style="color:#888;">No token operations yet. Deploy the DLBT token and start minting.</p>';
    }

    // Pool info
    const poolInfoDiv = document.getElementById('cdk-pool-info');
    const poolActions = document.getElementById('cdk-pool-actions');
    const poolForms   = document.getElementById('cdk-pool-forms');

    if (data.pool_info && data.pool_info.exists) {
      poolInfoDiv.innerHTML = `
        <div class="info-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:0.5rem;">
          <div><strong>DEX:</strong> ${data.pool_info.dex || 'QuickSwap V3'}</div>
          <div><strong>Fee:</strong> ${data.pool_info.fee ? (data.pool_info.fee / 10000).toFixed(2) + '%' : '—'}</div>
          <div><strong>DLBT in Pool:</strong> ${parseFloat(data.pool_info.dlbtInPool || 0).toLocaleString('en-US', {minimumFractionDigits:2})} DLBT</div>
          <div><strong>USDC in Pool:</strong> $${parseFloat(data.pool_info.usdcInPool || 0).toLocaleString('en-US', {minimumFractionDigits:2})}</div>
          <div style="grid-column:span 2;"><strong>Pool:</strong> <a href="${data.pool_info.explorerUrl}" target="_blank"><code style="font-size:0.8rem;">${data.pool_info.poolAddress}</code></a></div>
        </div>
      `;
      poolActions.style.display = 'none';
      if (poolForms) poolForms.style.display = 'grid';
    } else if (data.token_contract) {
      poolInfoDiv.innerHTML = '<p>No liquidity pool created yet. Click <strong>Create Pool</strong> to set up DLBT/USDC trading on QuickSwap V3.</p>';
      poolActions.style.display = 'flex';
      if (poolForms) poolForms.style.display = 'none';
    } else {
      poolInfoDiv.innerHTML = '<p style="color:#888;">Deploy the DLBT token first, then create a liquidity pool.</p>';
      poolActions.style.display = 'none';
      if (poolForms) poolForms.style.display = 'none';
    }

    // Encryption key warning
    if (!data.has_encryption_key) {
      showToast('WALLET_ENCRYPTION_KEY not set — cannot sign transactions', 'error');
    }
  } catch (err) {
    showToast('Failed to load CDK dashboard: ' + err.message, 'error');
  }
}

async function deployDLBTToken() {
  const walletId = document.getElementById('cdk-deployer-wallet').value;
  if (!walletId) { showToast('Select a deployer wallet first', 'error'); return; }

  const btn = document.querySelector('#cdk-deploy-actions .btn-primary');
  btn.disabled = true;
  btn.textContent = 'Deploying...';

  try {
    const result = await api('/cdk/deploy-token', {
      method: 'POST',
      body: JSON.stringify({ wallet_id: walletId }),
    });
    showToast(`DLBT Token deployed at ${result.contract_address}`, 'success');
    loadCDK();
  } catch (err) {
    showToast('Deploy failed: ' + (err.error || err.message), 'error');
    btn.disabled = false;
    btn.textContent = 'Deploy DLBT Token';
  }
}

async function mintDLBT() {
  const fromAccount = document.getElementById('cdk-mint-account').value;
  const toWallet    = document.getElementById('cdk-mint-wallet').value;
  const amount      = document.getElementById('cdk-mint-amount').value;

  if (!fromAccount || !toWallet || !amount) { showToast('Fill all fields', 'error'); return; }

  const btn = document.getElementById('cdk-mint-btn');
  btn.disabled = true;
  btn.textContent = 'Minting...';

  try {
    const result = await api('/cdk/mint', {
      method: 'POST',
      body: JSON.stringify({ from_account_id: parseInt(fromAccount), to_wallet_id: parseInt(toWallet), amount }),
    });
    showToast(`Minted ${amount} DLBT — TX: ${result.txHash ? result.txHash.slice(0, 16) + '...' : 'pending'}`, 'success');
    loadCDK();
  } catch (err) {
    showToast('Mint failed: ' + (err.error || err.message), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Mint DLBT';
  }
}

async function burnDLBT() {
  const fromWallet = document.getElementById('cdk-burn-wallet').value;
  const toAccount  = document.getElementById('cdk-burn-account').value;
  const amount     = document.getElementById('cdk-burn-amount').value;

  if (!fromWallet || !toAccount || !amount) { showToast('Fill all fields', 'error'); return; }

  const btn = document.getElementById('cdk-burn-btn');
  btn.disabled = true;
  btn.textContent = 'Burning...';

  try {
    const result = await api('/cdk/burn', {
      method: 'POST',
      body: JSON.stringify({ from_wallet_id: parseInt(fromWallet), to_account_id: parseInt(toAccount), amount }),
    });
    showToast(`Burned ${amount} DLBT — credited to account`, 'success');
    loadCDK();
  } catch (err) {
    showToast('Burn failed: ' + (err.error || err.message), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Burn DLBT';
  }
}

async function createPool() {
  const btn = document.getElementById('cdk-create-pool-btn');
  btn.disabled = true;
  btn.textContent = 'Creating Pool...';

  try {
    const result = await api('/cdk/pool/create', { method: 'POST', body: JSON.stringify({}) });
    if (result.alreadyExists) {
      showToast('Pool already exists at ' + result.poolAddress, 'info');
    } else {
      showToast('DLBT/USDC pool created on QuickSwap V3!', 'success');
    }
    loadCDK();
  } catch (err) {
    showToast('Pool creation failed: ' + (err.error || err.message), 'error');
    btn.disabled = false;
    btn.textContent = 'Create DLBT/USDC Pool';
  }
}

async function addLiquidity() {
  const dlbtAmt = document.getElementById('cdk-lp-dlbt-amount').value;
  const usdcAmt = document.getElementById('cdk-lp-usdc-amount').value;
  if (!dlbtAmt || !usdcAmt) { showToast('Enter both DLBT and USDC amounts', 'error'); return; }

  const btn = document.getElementById('cdk-add-liq-btn');
  btn.disabled = true;
  btn.textContent = 'Adding Liquidity...';

  try {
    const result = await api('/cdk/pool/add-liquidity', {
      method: 'POST',
      body: JSON.stringify({ dlbt_amount: dlbtAmt, usdc_amount: usdcAmt }),
    });
    showToast(`Liquidity added: ${dlbtAmt} DLBT + ${usdcAmt} USDC — TX: ${result.txHash ? result.txHash.slice(0, 16) + '...' : 'done'}`, 'success');
    loadCDK();
  } catch (err) {
    showToast('Add liquidity failed: ' + (err.error || err.message), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add Liquidity';
  }
}

async function swapTokens() {
  const direction = document.getElementById('cdk-swap-direction').value;
  const amount    = document.getElementById('cdk-swap-amount').value;
  if (!amount) { showToast('Enter an amount to swap', 'error'); return; }

  const btn = document.getElementById('cdk-swap-btn');
  btn.disabled = true;
  btn.textContent = 'Swapping...';

  try {
    const result = await api('/cdk/pool/swap', {
      method: 'POST',
      body: JSON.stringify({ direction, amount }),
    });
    const label = direction === 'dlbt_to_usdc' ? `${amount} DLBT → USDC` : `${amount} USDC → DLBT`;
    showToast(`Swap completed: ${label} — TX: ${result.txHash ? result.txHash.slice(0, 16) + '...' : 'done'}`, 'success');
    loadCDK();
  } catch (err) {
    showToast('Swap failed: ' + (err.error || err.message), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Swap';
  }
}

// --- Auto-Fund Pool (POL → USDC → Liquidity) ---
async function autoFundPool() {
  const amount = document.getElementById('cdk-autofund-amount').value;
  if (!amount || parseFloat(amount) <= 0) { showToast('Enter a USD amount to fund', 'error'); return; }

  if (!confirm(`Auto-Fund Pool with $${amount}?\n\nThis will:\n1. Swap POL → USDC via QuickSwap\n2. Mint matching DLBT tokens\n3. Add both to the liquidity pool\n\nUses POL from your deployer wallet.`)) return;

  const btn = document.getElementById('cdk-autofund-btn');
  const statusEl = document.getElementById('cdk-autofund-status');
  btn.disabled = true;
  btn.textContent = 'Funding...';
  statusEl.innerHTML = '<span style="color:#7c3aed">⏳ Processing: wrapping POL → swapping to USDC → adding liquidity...</span>';

  try {
    const result = await api('/cdk/pool/auto-fund', {
      method: 'POST',
      body: JSON.stringify({ amount_usd: parseFloat(amount) }),
    });
    if (result.poolFunded) {
      statusEl.innerHTML = `<span style="color:#10b981">✓ Pool funded! USDC received: $${result.totalUSDC}</span>`;
      showToast(`Pool auto-funded with $${result.totalUSDC} USDC + matching DLBT`, 'success');
    } else {
      const lastStep = result.steps?.[result.steps.length - 1];
      statusEl.innerHTML = `<span style="color:#f59e0b">⚠ Incomplete: ${lastStep?.status === 'insufficient' ? 'Not enough POL — need ~' + lastStep.polNeeded + ' POL' : JSON.stringify(lastStep)}</span>`;
      showToast('Auto-fund incomplete — check status below', 'info');
    }
    loadCDK();
  } catch (err) {
    statusEl.innerHTML = `<span style="color:#ef4444">✗ Failed: ${err.error || err.message}</span>`;
    showToast('Auto-fund failed: ' + (err.error || err.message), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Auto-Fund';
  }
}

// --- Virtual Accounts ---

async function loadVirtualAccounts() {
  try {
    const [vaData, gatewayStatus] = await Promise.all([
      api('/virtual-accounts'),
      api('/gateway/status').catch(() => null),
    ]);

    const accounts = vaData.accounts || [];

    // Metrics
    const summary = await api('/virtual-accounts/summary').catch(() => ({
      active_accounts: accounts.length,
      total_sent_usd: '0.00',
      total_received_usd: '0.00',
      total_transactions: 0,
    }));

    document.getElementById('va-metrics').innerHTML = `
      <div class="metric-card primary">
        <span class="metric-label">Active Virtual Accounts</span>
        <span class="metric-value">${summary.active_accounts}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Total Sent</span>
        <span class="metric-value">$${Number(summary.total_sent_usd).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Total Received</span>
        <span class="metric-value">$${Number(summary.total_received_usd).toLocaleString('en-US', { minimumFractionDigits: 2 })}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Transactions</span>
        <span class="metric-value">${summary.total_transactions}</span>
      </div>
      <div class="metric-card primary">
        <span class="metric-label">Master Bank</span>
        <span class="metric-value" style="font-size:0.7rem">${vaData.platform_bank || 'DLB Trust Banking System'}</span>
      </div>
      <div class="metric-card">
        <span class="metric-label">Settlement Bank</span>
        <span class="metric-value" style="font-size:0.7rem">${vaData.settlement_bank || 'Eaton Family CU'}</span>
      </div>
    `;

    // Gateway status panel
    if (gatewayStatus) {
      let gwHtml = '<div style="padding:16px;background:var(--card-bg);border-radius:8px;border:1px solid var(--border-color)">';
      gwHtml += '<h4 style="margin:0 0 10px 0;font-size:0.95rem">⚡ Payment Gateway Status</h4>';
      gwHtml += '<div style="display:flex;gap:10px;flex-wrap:wrap">';
      for (const ch of (gatewayStatus.channels || [])) {
        const color = ch.status === 'active' ? 'var(--success)' : ch.status === 'not_configured' ? 'var(--warning)' : 'var(--text-secondary)';
        gwHtml += `<span style="padding:4px 10px;border-radius:4px;border:1px solid ${color};font-size:0.8rem">${ch.label}: <strong style="color:${color}">${ch.status.toUpperCase()}</strong></span>`;
      }
      gwHtml += '</div>';
      if (gatewayStatus.api_keys) {
        gwHtml += `<div style="font-size:0.8rem;color:var(--text-secondary);margin-top:8px">API Keys: ${gatewayStatus.api_keys.active} active | Self-issued, no external dependencies</div>`;
      }
      gwHtml += '</div>';
      document.getElementById('va-gateway-status').innerHTML = gwHtml;
    }

    // Virtual accounts table
    let html = `<table>
      <thead><tr>
        <th>Account Name</th><th>Virtual Account #</th><th>Master Account</th><th>Type</th><th>Capabilities</th><th>Sent</th><th>Received</th><th>Status</th><th>Actions</th>
      </tr></thead><tbody>`;

    if (accounts.length === 0) {
      html += '<tr><td colspan="9" style="text-align:center;color:var(--text-secondary);padding:40px">No virtual accounts yet. Click "Generate for All Accounts" to create virtual accounts for all existing platform accounts.</td></tr>';
    } else {
      for (const va of accounts) {
        const caps = (va.capabilities || []).slice(0, 3).map(c => c.replace(/_/g, ' ')).join(', ');
        html += `<tr>
          <td><strong>${va.account_name}</strong><br><small style="color:var(--text-secondary)">${va.owner_name}</small></td>
          <td style="font-family:monospace;font-weight:600">${va.account_number}</td>
          <td style="font-size:0.8rem">Core Banking #${va.platform_account_id}<br><small style="color:var(--text-secondary)">${va.bank_name}</small></td>
          <td><span class="badge badge-approved">${va.account_type}</span></td>
          <td style="font-size:0.8rem">${caps}${(va.capabilities||[]).length > 3 ? '...' : ''}</td>
          <td>$${(va.total_sent_cents / 100).toFixed(2)}</td>
          <td>$${(va.total_received_cents / 100).toFixed(2)}</td>
          <td>${va.status === 'active' ? '<span class="badge badge-approved">Active</span>' : '<span class="badge badge-frozen">' + va.status + '</span>'}</td>
          <td><button class="btn btn-sm btn-primary" onclick="showVASendModalFor('${va.id}')">💸 Send</button></td>
        </tr>`;
      }
    }
    html += '</tbody></table>';
    document.getElementById('va-list').innerHTML = html;

  } catch (err) {
    document.getElementById('va-list').innerHTML = `<p style="padding:20px;color:var(--danger)">Error: ${err.message}</p>`;
  }
}

async function backfillVirtualAccounts() {
  try {
    const result = await api('/virtual-accounts/backfill', { method: 'POST' });
    showToast(`Generated ${result.backfilled} virtual accounts`, 'success');
    loadVirtualAccounts();
  } catch (err) {
    showToast('Backfill failed: ' + err.message, 'error');
  }
}

async function showVASendModal() {
  try {
    const vaData = await api('/virtual-accounts');
    const select = document.getElementById('va-send-from');
    select.innerHTML = (vaData.accounts || [])
      .filter(a => a.status === 'active' && (a.capabilities || []).includes('ach_send'))
      .map(a => `<option value="${a.id}">${a.account_name} (${a.account_number})</option>`)
      .join('');
    document.getElementById('va-send-modal').classList.remove('hidden');
  } catch (err) {
    showToast('Failed to load virtual accounts: ' + err.message, 'error');
  }
}

function showVASendModalFor(vaId) {
  showVASendModal().then(() => {
    document.getElementById('va-send-from').value = vaId;
  });
}

async function vaSendPayment(e) {
  e.preventDefault();
  const form = e.target;
  const vaId = form.virtual_account_id.value;
  const body = {
    recipient_name: form.recipient_name.value,
    routing_number: form.routing_number.value,
    account_number: form.account_number.value,
    account_type: form.account_type.value,
    amount: form.amount.value,
    type: form.type.value,
    description: form.description.value,
    reference: form.reference.value,
  };

  try {
    const result = await api(`/virtual-accounts/${vaId}/send`, { method: 'POST', body });
    if (result.success) {
      showToast(`Payment sent! Status: ${result.delivery.status} via ${result.delivery.method}`, 'success');
      closeModal('va-send-modal');
      loadVirtualAccounts();
    } else {
      showToast('Payment failed: ' + (result.error || 'Unknown error'), 'error');
    }
  } catch (err) {
    showToast('Payment error: ' + err.message, 'error');
  }
}

// --- Trustee Approval ---

async function loadApproval() {
  try {
    const [stats, policies, requests, auditLog, retentionStats, backups] = await Promise.all([
      api('/approval/stats').catch(() => ({ pending: 0, approved: 0, rejected: 0, expired: 0, total: 0, recent_pending: [] })),
      api('/approval/policies').catch(() => ({ policies: [] })),
      api('/approval/requests?status=pending').catch(() => ({ requests: [] })),
      api('/approval/audit-log?limit=20').catch(() => ({ entries: [] })),
      api('/approval/retention/stats').catch(() => null),
      api('/approval/retention/backups').catch(() => ({ backups: [] })),
    ]);

    // Stats cards
    const statsEl = $('#approval-stats');
    if (statsEl) {
      statsEl.innerHTML = `
        <div class="stat-card" style="background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.3);border-radius:12px;padding:16px;text-align:center">
          <div style="font-size:2rem;font-weight:700;color:#f59e0b">${stats.pending}</div>
          <div style="font-size:0.8rem;color:var(--text-secondary)">Pending</div>
        </div>
        <div class="stat-card" style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:12px;padding:16px;text-align:center">
          <div style="font-size:2rem;font-weight:700;color:#22c55e">${stats.approved}</div>
          <div style="font-size:0.8rem;color:var(--text-secondary)">Approved</div>
        </div>
        <div class="stat-card" style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:12px;padding:16px;text-align:center">
          <div style="font-size:2rem;font-weight:700;color:#ef4444">${stats.rejected}</div>
          <div style="font-size:0.8rem;color:var(--text-secondary)">Rejected</div>
        </div>
        <div class="stat-card" style="background:rgba(107,114,128,0.1);border:1px solid rgba(107,114,128,0.3);border-radius:12px;padding:16px;text-align:center">
          <div style="font-size:2rem;font-weight:700;color:#6b7280">${stats.expired}</div>
          <div style="font-size:0.8rem;color:var(--text-secondary)">Expired</div>
        </div>
        <div class="stat-card" style="background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:12px;padding:16px;text-align:center">
          <div style="font-size:2rem;font-weight:700;color:#6366f1">${stats.total}</div>
          <div style="font-size:0.8rem;color:var(--text-secondary)">Total</div>
        </div>
      `;
    }

    // Policies table
    const policiesEl = $('#approval-policies');
    if (policiesEl) {
      const pols = policies.policies || [];
      policiesEl.innerHTML = pols.length ? `<table><thead><tr>
        <th>Entity</th><th>Action</th><th>Tier</th><th>Min Approvers</th><th>Auto Below</th><th>Active</th>
      </tr></thead><tbody>${pols.map(p => `<tr>
        <td>${p.entity_type}</td><td>${p.action}</td><td><span class="badge badge-${p.approval_tier === 'auto' ? 'success' : 'warning'}">${p.approval_tier}</span></td>
        <td>${p.min_approvers}</td><td>${p.auto_approve_below_cents ? '$' + (p.auto_approve_below_cents / 100).toLocaleString() : '—'}</td>
        <td>${p.is_active ? 'Yes' : 'No'}</td>
      </tr>`).join('')}</tbody></table>` : '<p style="color:var(--text-secondary)">No policies configured</p>';
    }

    // Pending requests
    const reqsEl = $('#approval-requests');
    if (reqsEl) {
      const reqs = requests.requests || stats.recent_pending || [];
      reqsEl.innerHTML = reqs.length ? `<table><thead><tr>
        <th>Request #</th><th>Type</th><th>Action</th><th>Summary</th><th>Amount</th><th>Submitted</th><th>Actions</th>
      </tr></thead><tbody>${reqs.map(r => `<tr>
        <td>${r.request_number}</td><td>${r.entity_type}</td><td>${r.action}</td>
        <td>${r.summary || '—'}</td><td>${r.amount_cents ? '$' + (r.amount_cents / 100).toLocaleString() : '—'}</td>
        <td>${new Date(r.submitted_at || r.created_at).toLocaleString()}</td>
        <td>
          <button class="btn btn-primary btn-sm" onclick="approveRequest(${r.id})" style="font-size:0.75rem;padding:4px 8px">Approve</button>
          <button class="btn btn-danger btn-sm" onclick="rejectRequest(${r.id})" style="font-size:0.75rem;padding:4px 8px;margin-left:4px">Reject</button>
        </td>
      </tr>`).join('')}</tbody></table>` : '<p style="color:var(--text-secondary)">No pending requests</p>';
    }

    // Audit log
    const auditEl = $('#approval-audit');
    if (auditEl) {
      const entries = auditLog.entries || [];
      auditEl.innerHTML = entries.length ? `<table><thead><tr>
        <th>Time</th><th>Event</th><th>Actor</th><th>Details</th>
      </tr></thead><tbody>${entries.map(e => `<tr>
        <td>${new Date(e.created_at).toLocaleString()}</td>
        <td><span class="badge badge-${e.event_type === 'approved' ? 'success' : e.event_type === 'rejected' ? 'danger' : 'info'}">${e.event_type}</span></td>
        <td>${e.actor}</td><td style="max-width:300px;overflow:hidden;text-overflow:ellipsis">${e.details || '—'}</td>
      </tr>`).join('')}</tbody></table>` : '<p style="color:var(--text-secondary)">No audit entries</p>';
    }

    // Retention stats
    const retEl = $('#retention-stats');
    if (retEl && retentionStats) {
      retEl.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px">
          <div style="background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:12px;padding:16px;text-align:center">
            <div style="font-size:1.5rem;font-weight:700;color:#6366f1">${retentionStats.backups_total}</div>
            <div style="font-size:0.8rem;color:var(--text-secondary)">Backups</div>
          </div>
          <div style="background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);border-radius:12px;padding:16px;text-align:center">
            <div style="font-size:1.5rem;font-weight:700;color:#22c55e">${retentionStats.migrations_applied}</div>
            <div style="font-size:0.8rem;color:var(--text-secondary)">Migrations</div>
          </div>
          <div style="background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:12px;padding:16px;text-align:center">
            <div style="font-size:1.5rem;font-weight:700;color:#6366f1">${retentionStats.tables || 0}</div>
            <div style="font-size:0.8rem;color:var(--text-secondary)">Tables</div>
          </div>
          <div style="background:${retentionStats.data_integrity === 'healthy' ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)'};border:1px solid ${retentionStats.data_integrity === 'healthy' ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'};border-radius:12px;padding:16px;text-align:center">
            <div style="font-size:1.5rem;font-weight:700;color:${retentionStats.data_integrity === 'healthy' ? '#22c55e' : '#ef4444'}">${retentionStats.data_integrity === 'healthy' ? 'Healthy' : 'Issues'}</div>
            <div style="font-size:0.8rem;color:var(--text-secondary)">Integrity</div>
          </div>
        </div>
      `;
    }

    // Backups table
    const backupsEl = $('#retention-backups');
    if (backupsEl) {
      const bks = backups.backups || [];
      backupsEl.innerHTML = bks.length ? `<table><thead><tr>
        <th>Backup ID</th><th>Type</th><th>Size</th><th>Checksum</th><th>Created</th><th>Status</th>
      </tr></thead><tbody>${bks.map(b => `<tr>
        <td style="font-family:monospace;font-size:0.8rem">${b.backup_id}</td><td>${b.backup_type}</td>
        <td>${b.file_size_bytes ? (b.file_size_bytes / 1024).toFixed(1) + ' KB' : '—'}</td>
        <td style="font-family:monospace;font-size:0.75rem;max-width:120px;overflow:hidden;text-overflow:ellipsis">${b.checksum ? b.checksum.slice(0, 16) + '...' : '—'}</td>
        <td>${new Date(b.created_at).toLocaleString()}</td>
        <td><span class="badge badge-${b.status === 'completed' ? 'success' : 'warning'}">${b.status}</span></td>
      </tr>`).join('')}</tbody></table>` : '<p style="color:var(--text-secondary)">No backups yet</p>';
    }
  } catch (err) {
    console.error('Failed to load approval dashboard:', err);
  }
}

async function approveRequest(id) {
  if (!confirm('Approve this request? This will execute the pending action.')) return;
  try {
    const result = await api(`/approval/requests/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decided_by: 'trustee', decided_role: 'trustee', reason: 'Approved by trustee' }),
    });
    alert(result.message || 'Request approved');
    loadApproval();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

async function rejectRequest(id) {
  const reason = prompt('Reason for rejection:');
  if (!reason) return;
  try {
    const result = await api(`/approval/requests/${id}/reject`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decided_by: 'trustee', decided_role: 'trustee', reason }),
    });
    alert(result.message || 'Request rejected');
    loadApproval();
  } catch (err) {
    alert('Failed: ' + err.message);
  }
}

async function createManualBackup() {
  try {
    const result = await api('/approval/retention/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggered_by: 'trustee', notes: 'Manual backup from dashboard' }),
    });
    alert(`Backup created: ${result.backup_id || 'Success'}`);
    loadApproval();
  } catch (err) {
    alert('Backup failed: ' + err.message);
  }
}

async function runIntegrityCheck() {
  try {
    const result = await api('/approval/retention/integrity');
    alert(`Integrity: ${result.healthy ? 'HEALTHY' : 'ISSUES FOUND'}\nTables: ${result.tables}\nRows: ${result.total_rows}`);
  } catch (err) {
    alert('Check failed: ' + err.message);
  }
}

async function runMigrations() {
  try {
    const result = await api('/approval/retention/migrate', { method: 'POST' });
    alert(`Migrations: ${result.applied} applied, ${result.skipped} skipped`);
    loadApproval();
  } catch (err) {
    alert('Migration failed: ' + err.message);
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
