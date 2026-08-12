'use strict';

/**
 * PtcPortalEngine — Private Trust Company portal orchestration for the
 * DeAndrea LaVar Barkley Family Trust.
 *
 * 2 trustees (maker + checker) and 3 beneficiaries. Principal and coupon
 * income from the bond/fixed-income engines drive the source of truth.
 */

const pool = require('../bonds/pgPool');
const { PrivateTrustCompanyEngine } = require('./privateTrustCompanyEngine');

let TaxEngine, CrmEngine, CashEngine, WalletEngine, WireOriginationEngine, PushToCardEngine, PayoutCenterEngine, PaymentBlockchainEngine, VendorPaymentEngine, TrustAccountingEngine, StripeTreasuryEngine, CustomerIdentificationEngine;
const CIP_REQUIRED_FOR_STRIPE = process.env.STRIPE_TREASURY_CIP_REQUIRED === 'true';
function loadDeps() {
  try { ({ TaxEngine } = require('../tax/taxEngine')); } catch (e) { TaxEngine = null; }
  try { ({ CrmEngine } = require('../crm/crmEngine')); } catch (e) { CrmEngine = null; }
  try { ({ CashEngine } = require('../cash/cashEngine')); } catch (e) { CashEngine = null; }
  try { ({ WalletEngine } = require('./walletEngine')); } catch (e) { WalletEngine = null; }
  try { ({ WireOriginationEngine } = require('./wireOriginationEngine')); } catch (e) { WireOriginationEngine = null; }
  try { ({ PushToCardEngine } = require('../payments/pushToCardEngine')); } catch (e) { PushToCardEngine = null; }
  try { ({ PayoutCenterEngine } = require('./payoutCenterEngine')); } catch (e) { PayoutCenterEngine = null; }
  try { ({ PaymentBlockchainEngine } = require('./paymentBlockchainEngine')); } catch (e) { PaymentBlockchainEngine = null; }
  try { ({ VendorPaymentEngine } = require('./vendorPaymentEngine')); } catch (e) { VendorPaymentEngine = null; }
  try { ({ TrustAccountingEngine } = require('../accounting/trustAccountingEngine')); } catch (e) { TrustAccountingEngine = null; }
  try { ({ StripeTreasuryEngine } = require('../payments/stripeTreasuryEngine')); } catch (e) { StripeTreasuryEngine = null; }
  try { ({ CustomerIdentificationEngine } = require('../compliance/customerIdentificationEngine')); } catch (e) { CustomerIdentificationEngine = null; }
}

function id(prefix = 'PTC') {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}
function toCents(amount) {
  return Math.round((Number(amount) || 0) * 100);
}
function safeJson(o) {
  try { return JSON.stringify(o || {}); } catch { return '{}'; }
}
async function query(text, params) {
  if (!pool) throw new Error('Database pool not available');
  return pool.query(text, params);
}

const DEFAULT_MEMBERS = [
  // Trustees
  { email: 'barkley420lavar@gmail.com', name: 'Malissa Robinson', type: 'trustee,beneficiary', role: 'maker', roles: ['trustee_maker', 'beneficiary'], allocation: 0, crmContactId: 'CRM-BEN-1782927155850' },
  { email: 'dbarkley1130@gmail.com', name: 'DeAndrea Barkley', type: 'trustee,beneficiary', role: 'checker', roles: ['trustee_checker', 'beneficiary'], allocation: 0, crmContactId: 'CRM-BEN-1782927036064' },
  // Beneficiaries
  { email: 'deandreabarkley13@gmail.com', name: 'DeAndrea L Barkley', type: 'beneficiary', role: 'beneficiary', roles: ['beneficiary'], allocation: 34, crmContactId: 'CRM-BEN-1782927036064' },
  { email: 'annrobinson9800@yahoo.com', name: 'Malissa A Robinson', type: 'beneficiary', role: 'beneficiary', roles: ['beneficiary'], allocation: 33, crmContactId: 'CRM-BEN-1782927155850' },
  { email: 'robinsonjeremy22a@gmail.com', name: 'Jeremy N Robinson', type: 'beneficiary', role: 'beneficiary', roles: ['beneficiary'], allocation: 33, crmContactId: 'CRM-BEN-1782927793173' },
];

class PtcPortalEngine {
  static async ensureTables() {
    loadDeps();
    await PrivateTrustCompanyEngine.ensureTables();

    await query(`
      CREATE TABLE IF NOT EXISTS ptc_members (
        member_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('trustee','beneficiary','trustee,beneficiary')),
        role TEXT NOT NULL DEFAULT 'beneficiary',
        roles JSONB DEFAULT '[]',
        crm_contact_id TEXT,
        support_account_id TEXT,
        token_account_id TEXT,
        cash_account_id TEXT,
        trust_account_code TEXT,
        wallet_id TEXT,
        allocation_percent NUMERIC(5,2) DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS ptc_requests (
        request_id TEXT PRIMARY KEY,
        member_id TEXT NOT NULL,
        amount_cents BIGINT NOT NULL,
        purpose TEXT,
        rail_preference TEXT,
        recipient_details TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','completed','failed')),
        approvals JSONB DEFAULT '[]',
        payout_id TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`
      CREATE TABLE IF NOT EXISTS ptc_payouts (
        payout_id TEXT PRIMARY KEY,
        request_id TEXT,
        member_id TEXT,
        amount_cents BIGINT NOT NULL,
        rail TEXT,
        engine TEXT,
        engine_id TEXT,
        status TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await query(`ALTER TABLE ptc_members ADD COLUMN IF NOT EXISTS cash_account_id TEXT`);
    await query(`ALTER TABLE ptc_members ADD COLUMN IF NOT EXISTS trust_account_code TEXT`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ptc_members_email ON ptc_members(email)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ptc_requests_member ON ptc_requests(member_id)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ptc_requests_status ON ptc_requests(status)`);
    await query(`CREATE INDEX IF NOT EXISTS idx_ptc_payouts_request ON ptc_payouts(request_id)`);
  }

  static async ensureMembers() {
    loadDeps();
    await this.ensureTables();
    const pool = (await query("SELECT * FROM ptc_support_pools WHERE status = 'active' ORDER BY created_at DESC LIMIT 1")).rows[0];
    const poolId = pool ? pool.pool_id : null;
    const results = [];
    for (const m of DEFAULT_MEMBERS) {
      const existing = (await query('SELECT * FROM ptc_members WHERE LOWER(email) = LOWER($1)', [m.email])).rows[0];
      const memberId = existing ? existing.member_id : id('PTC-MEMBER');
      const supportAccountId = `PTC-SUPPORT-${memberId}`;
      const tokenAccountId = `PTC-TOKEN-${memberId}`;
      const cashAccountId = `CA-PTC-MEMBER-${memberId}`;
      const trustAccountCode = `PTC-MEMBER-${memberId}`;
      const rolesJson = safeJson(m.roles);
      if (!existing) {
        await query(`
          INSERT INTO ptc_members (member_id, name, email, type, role, roles, crm_contact_id, support_account_id, token_account_id, cash_account_id, trust_account_code, allocation_percent, status, metadata)
          VALUES ($1,$2,LOWER($3),$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,'active',$13::jsonb)
        `, [memberId, m.name, m.email, m.type, m.role, rolesJson, m.crmContactId || null, supportAccountId, tokenAccountId, cashAccountId, trustAccountCode, m.allocation || 0, { source: 'seed' }]);
      } else {
        await query(`
          UPDATE ptc_members SET name=$1, type=$2, role=$3, roles=$4::jsonb, crm_contact_id=$5, support_account_id=$6, token_account_id=$7, cash_account_id=$8, trust_account_code=$9, allocation_percent=$10, updated_at=NOW()
          WHERE member_id=$11
        `, [m.name, m.type, m.role, rolesJson, m.crmContactId || null, supportAccountId, tokenAccountId, cashAccountId, trustAccountCode, m.allocation || 0, memberId]);
      }

      await this.ensureMemberAccounts(memberId, m, cashAccountId, trustAccountCode);

      // Ensure a support-balance row exists for ledger form
      const bal = (await query('SELECT * FROM ptc_support_balances WHERE beneficiary_id = $1 AND form = $2', [memberId, 'ledger'])).rows[0];
      if (!bal) {
        await query(`INSERT INTO ptc_support_balances (balance_id, beneficiary_id, form, asset_code, balance_cents) VALUES ($1,$2,'ledger','DLB-PTC-SUPPORT',0)`, [id('PTC-BAL'), memberId]);
      }

      // Also keep ptc_beneficiaries in sync for members who are beneficiaries
      if ((m.type === 'beneficiary' || String(m.type).includes('beneficiary')) && poolId) {
        const b = (await query('SELECT * FROM ptc_beneficiaries WHERE beneficiary_id = $1', [memberId])).rows[0];
        if (!b) {
          await query(`
            INSERT INTO ptc_beneficiaries (beneficiary_id, pool_id, first_name, last_name, email, support_account_id, token_account_id, allocation_percent, metadata)
            VALUES ($1, $2, $3, $4, LOWER($5), $6, $7, $8, $9::jsonb)
          `, [memberId, poolId, m.name.split(' ')[0], m.name.split(' ').slice(1).join(' '), m.email, supportAccountId, tokenAccountId, m.allocation || 0, { source: 'ptc_member' }]);
        } else {
          await query(`UPDATE ptc_beneficiaries SET first_name=$1, last_name=$2, email=LOWER($3), support_account_id=$4, token_account_id=$5, allocation_percent=$6 WHERE beneficiary_id=$7`, [m.name.split(' ')[0], m.name.split(' ').slice(1).join(' '), m.email, supportAccountId, tokenAccountId, m.allocation || 0, memberId]);
        }
      }
      results.push({ memberId, ...m });
    }
    return results;
  }

  static async ensureMemberAccounts(memberId, m, cashAccountId, trustAccountCode) {
    loadDeps();
    // Core-banking cash account for this member
    if (CashEngine) {
      try {
        const existingCash = (await query('SELECT * FROM cash_accounts WHERE account_id = $1', [cashAccountId])).rows[0];
        if (!existingCash) {
          const cashType = (m.type === 'beneficiary' || String(m.type).includes('beneficiary')) ? 'distribution' : 'operating';
          await CashEngine.createAccount({ accountId: cashAccountId, accountName: `PTC Member — ${m.name}`, accountType: cashType, notes: `Cash sub-account for PTC member ${memberId}` });
        }
      } catch (e) { console.warn('[PtcPortalEngine] cash account create failed:', e.message); }
    }
    // Trust accounting ledger account for this member
    if (TrustAccountingEngine) {
      try {
        const existingTrust = (await query('SELECT * FROM trust_accounts WHERE account_code = $1', [trustAccountCode])).rows[0];
        if (!existingTrust) {
          await TrustAccountingEngine.createAccount({
            accountCode: trustAccountCode,
            accountName: `PTC Member Trust — ${m.name}`,
            accountType: 'asset',
            subType: 'cash',
            linkedCashAccount: cashAccountId,
            description: `Trust sub-account for PTC member ${memberId}`,
          });
        }
      } catch (e) { console.warn('[PtcPortalEngine] trust account create failed:', e.message); }
    }
  }

  static async getMemberByEmail(email) {
    if (!email) return null;
    const res = await query('SELECT * FROM ptc_members WHERE LOWER(email) = LOWER($1)', [email]);
    return res.rows[0] || null;
  }

  static async listMembers() {
    await this.ensureTables();
    const res = await query('SELECT * FROM ptc_members ORDER BY type, name');
    return res.rows.map(r => ({ ...r, roles: typeof r.roles === 'string' ? JSON.parse(r.roles) : r.roles }));
  }

  static async getSourceOfTruth() {
    loadDeps();
    const ptcSot = await PrivateTrustCompanyEngine.getSourceOfTruth().catch(() => ({}));
    let taxSnapshot = {};
    if (TaxEngine && TaxEngine.computeTrustIncomeTax) {
      try { taxSnapshot = await TaxEngine.computeTrustIncomeTax(); } catch (e) { taxSnapshot = { error: e.message }; }
    }
    let crmContacts = [];
    if (CrmEngine && CrmEngine.listContacts) {
      try { crmContacts = await CrmEngine.listContacts({ status: 'active' }); } catch (e) { crmContacts = []; }
    }
    return {
      ...ptcSot,
      netWorth: ptcSot.netWorth || ptcSot.totalAssets || 0,
      principal: ptcSot.principal || 0,
      interest: ptcSot.interest || 0,
      trustAccounts: ptcSot.trustAccounts || ptcSot.accounts || [],
      bonds: ptcSot.bonds || ptcSot.bondMetrics || [],
      taxSnapshot,
      crmContacts: crmContacts.slice(0, 20),
    };
  }

  static async getMemberStatement(memberId) {
    await this.ensureTables();
    const member = (await query('SELECT * FROM ptc_members WHERE member_id = $1', [memberId])).rows[0];
    if (!member) throw new Error('Member not found');
    const balances = (await query('SELECT * FROM ptc_support_balances WHERE beneficiary_id = $1', [memberId])).rows;
    const distributions = (await query('SELECT * FROM ptc_distributions WHERE distribution_id IN (SELECT distribution_id FROM ptc_distribution_lines WHERE beneficiary_id = $1) ORDER BY created_at DESC LIMIT 20', [memberId])).rows;
    return { member, balances, distributions };
  }

  static async getDashboard(email) {
    await this.ensureMembers();
    const me = email ? await this.getMemberByEmail(email) : null;
    const sourceOfTruth = await this.getSourceOfTruth();
    const members = await this.listMembers();
    const pendingRequests = (await query("SELECT r.*, m.name as member_name, m.email as member_email FROM ptc_requests r JOIN ptc_members m ON r.member_id = m.member_id WHERE r.status = 'pending' OR r.status = 'approved' ORDER BY r.created_at DESC LIMIT 50")).rows;
    const recentPayouts = (await query('SELECT p.*, m.name as member_name, m.email as member_email FROM ptc_payouts p JOIN ptc_members m ON p.member_id = m.member_id ORDER BY p.created_at DESC LIMIT 20')).rows;
    let myStatement = null;
    if (me) myStatement = await this.getMemberStatement(me.member_id);
    return { sourceOfTruth, members, pendingRequests, recentPayouts, myStatement };
  }

  static async requestDistribution({ email, amount, purpose, railPreference, recipientDetails }) {
    if (!email) throw new Error('email required');
    const member = await this.getMemberByEmail(email);
    if (!member) throw new Error('Not a recognized PTC member');
    if (member.type === 'trustee' && !String(member.type).includes('beneficiary')) throw new Error('Only beneficiaries may request distributions');
    const cents = toCents(amount);
    if (cents <= 0) throw new Error('amount must be positive');
    const requestId = id('REQ');
    await query(`
      INSERT INTO ptc_requests (request_id, member_id, amount_cents, purpose, rail_preference, recipient_details, status, approvals, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,'pending','[]'::jsonb,$7::jsonb)
    `, [requestId, member.member_id, cents, purpose || null, railPreference || 'wire', recipientDetails || null, { requestedBy: email }]);
    return { requestId, status: 'pending' };
  }

  static async approveRequest({ requestId, email }) {
    if (!requestId || !email) throw new Error('requestId and email required');
    const member = await this.getMemberByEmail(email);
    if (!member || !String(member.type).includes('trustee')) throw new Error('Only trustees can approve');
    const req = (await query('SELECT * FROM ptc_requests WHERE request_id = $1', [requestId])).rows[0];
    if (!req) throw new Error('Request not found');
    if (req.status !== 'pending' && req.status !== 'approved') throw new Error(`Cannot approve request in status ${req.status}`);
    let approvals = typeof req.approvals === 'string' ? JSON.parse(req.approvals) : (req.approvals || []);
    if (approvals.some(a => a.member_id === member.member_id)) throw new Error('You already approved this request');
    approvals.push({ member_id: member.member_id, name: member.name, role: member.role, at: new Date().toISOString() });
    const status = approvals.length >= 2 ? 'approved' : 'pending';
    await query('UPDATE ptc_requests SET approvals = $1::jsonb, status = $2, updated_at = NOW() WHERE request_id = $3', [safeJson(approvals), status, requestId]);
    return { requestId, status, approvals };
  }

  static async executeRequest({ requestId, rail, recipientIdentifier, options = {}, initiatedBy }) {
    loadDeps();
    if (!requestId || !rail) throw new Error('requestId and rail required');
    const req = (await query('SELECT r.*, m.name as member_name, m.email as member_email, m.support_account_id FROM ptc_requests r JOIN ptc_members m ON r.member_id = m.member_id WHERE r.request_id = $1', [requestId])).rows[0];
    if (!req) throw new Error('Request not found');
    if (req.status !== 'approved') throw new Error(`Request must be approved before execution (status: ${req.status})`);
    if (req.payout_id) {
      const existing = (await query('SELECT * FROM ptc_payouts WHERE payout_id = $1', [req.payout_id])).rows[0];
      if (existing) return { requestId, payoutId: req.payout_id, status: existing.status, reference: existing.engine_id, alreadyExecuted: true };
    }

    const amount = Number(req.amount_cents) / 100;
    const memberId = req.member_id;
    const supportAccountId = req.support_account_id;

    // 1. Issue support from coupon/principal income ledger (4000 = interest income)
    const alloc = [{ beneficiary_id: memberId, allocation_percent: 100 }];
    const dist = await PrivateTrustCompanyEngine.createDistribution({
      totalCents: req.amount_cents,
      type: 'support',
      sourceAccountCode: '4000',
      beneficiaryAllocations: alloc,
      description: `PTC support request ${requestId} for ${req.member_name}`,
    });

    // 2. Redeem that support into trust cash (1000)
    const redemption = await PrivateTrustCompanyEngine.redeemSupport({
      beneficiaryId: memberId,
      amount,
      targetCashAccountId: '1000',
      form: 'ledger',
    });

    // 3. Execute the payout rail from the operational cash account
    const sourceAccountId = 'CA-OPERATING';
    let result = { status: 'pending', reference: null };
    const payoutId = id('PTP');
    const railNorm = (rail || '').toLowerCase();

    // Stripe Treasury requires a cleared CIP record before fiat payout.
    if (CIP_REQUIRED_FOR_STRIPE && railNorm.startsWith('stripe_')) {
      if (!CustomerIdentificationEngine) throw new Error('CustomerIdentificationEngine not available');
      const cip = await CustomerIdentificationEngine.validatePayoutRecipient({
        fullName: options.fullName || options.recipientName || req.member_name,
        email: options.email || req.member_email,
        requireClear: true,
      });
      if (!cip.valid) {
        throw new Error(`CIP required for Stripe Treasury payout: ${cip.reason}`);
      }
    }

    if (railNorm.startsWith('stripe_')) {
      if (!PayoutCenterEngine) throw new Error('PayoutCenterEngine not available');
      const prefund = StripeTreasuryEngine
        ? await StripeTreasuryEngine.prefundFromPtc({ amount, sourceCashAccountId: sourceAccountId, financialAccountId: options.financialAccountId || process.env.STRIPE_TREASURY_FINANCIAL_ACCOUNT_ID, description: `PTC prefund for ${requestId}` })
        : { prefunded: false, mode: 'skipped' };
      if (prefund.prefunded === false && prefund.mode !== 'skipped') {
        throw new Error(prefund.instruction || 'Unable to prefund Stripe Treasury from PTC');
      }
      const pc = await PayoutCenterEngine.createPayment({
        sourceType: 'cash',
        sourceAccountId,
        recipientType: 'external',
        recipientIdentifier,
        amount,
        asset: 'USD',
        rail: railNorm,
        description: `PTC payout ${requestId}`,
        railOptions: { ...options, ptc_request_id: requestId, initiatedBy: initiatedBy || req.member_name },
      });
      const stripeError = pc.result && pc.result.response && pc.result.response.error && pc.result.response.error.message;
      result = {
        status: pc.status || 'pending',
        reference: pc.id,
        engineId: pc.id,
        txHash: pc.tx_hash,
        destinationLast4: pc.result && pc.result.destination_last4,
        error: stripeError || (pc.result && pc.result.error),
        prefund,
      };
    } else if (railNorm === 'wire' || railNorm === 'ach' || railNorm === 'vendor') {
      if (!WireOriginationEngine) throw new Error('WireOriginationEngine not available');
      const opts = { ...options };
      const payout = await WireOriginationEngine.createPayout({
        sourceType: 'cash',
        sourceAccountId,
        amount,
        beneficiaryName: opts.beneficiaryName || req.member_name,
        beneficiaryRouting: opts.routing || opts.routingNumber || recipientIdentifier,
        beneficiaryAccount: opts.account || opts.accountNumber,
        beneficiaryBankName: opts.bankName,
        beneficiaryAddress: opts.address,
        paymentType: railNorm === 'vendor' ? 'vendor_payment' : railNorm,
        purpose: req.purpose,
        description: `PTC payout ${requestId}`,
        adapter: railNorm === 'ach' ? 'ach' : 'wire',
        initiatedBy: initiatedBy || req.member_name,
        metadata: { ptc_request_id: requestId },
      });
      const send = await WireOriginationEngine.sendPayout(payout.payout_id);
      result = { status: send.status || 'sent', reference: payout.wire_id || payout.payout_id, engineId: payout.payout_id };
    } else if (railNorm === 'push_to_card') {
      if (!PushToCardEngine) throw new Error('PushToCardEngine not available');
      const opts = { ...options };
      const payment = await PushToCardEngine.createPayment({
        sourceType: 'cash',
        sourceAccountId,
        amount,
        cardholderName: opts.cardholderName || req.member_name,
        cardLast4: opts.cardLast4 || opts.cardLastFour || '0000',
        cardNetwork: opts.cardNetwork || 'Visa',
        recipientName: opts.recipientName || req.member_name,
        memo: req.purpose || `PTC payout ${requestId}`,
        metadata: { ptc_request_id: requestId },
      });
      const exec = await PushToCardEngine.executePayment(payment.payment_id, opts);
      result = { status: exec.status || 'reserved', reference: payment.payment_id, engineId: payment.payment_id };
    } else if (railNorm === 'wallet' || railNorm === 'blockchain') {
      if (!PaymentBlockchainEngine) throw new Error('PaymentBlockchainEngine not available');
      const opts = { ...options };
      const payment = await PaymentBlockchainEngine.createPayment({
        rail: 'wallet',
        sourceType: 'cash',
        sourceAccountId,
        fromWalletId: opts.fromWalletId || process.env.PTC_PAYOUT_WALLET_ID || null,
        to: recipientIdentifier,
        asset: opts.asset || 'SIT',
        amount,
        memo: req.purpose || `PTC payout ${requestId}`,
        metadata: { ptc_request_id: requestId },
      });
      const exec = await PaymentBlockchainEngine.executePayment(payment.payment_id);
      result = { status: exec.status || 'completed', reference: payment.payment_id, engineId: payment.payment_id };
    } else {
      if (!PayoutCenterEngine) throw new Error('PayoutCenterEngine not available');
      const pc = await PayoutCenterEngine.createPayment({
        sourceType: 'cash',
        sourceAccountId,
        recipientType: 'address',
        recipientIdentifier,
        amount,
        asset: 'USD',
        rail: railNorm,
        description: `PTC payout ${requestId}`,
        railOptions: { ...options, ptc_request_id: requestId, initiatedBy: initiatedBy || req.member_name },
      });
      result = { status: pc.status || 'pending', reference: pc.id, engineId: pc.id };
    }

    const requestStatus = result.status === 'completed' ? 'completed' : (result.status === 'sent' ? 'completed' : (result.status === 'failed' ? 'failed' : 'approved'));

    await query(`
      INSERT INTO ptc_payouts (payout_id, request_id, member_id, amount_cents, rail, engine, engine_id, status, metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
    `, [payoutId, requestId, memberId, req.amount_cents, rail, railNorm, result.engineId || payoutId, result.status, safeJson(result)]);

    await query('UPDATE ptc_requests SET status = $1, payout_id = $2, updated_at = NOW() WHERE request_id = $3', [requestStatus, payoutId, requestId]);

    if (result.status === 'failed') {
      const err = new Error(result.error || `Payout failed on ${rail}`);
      err.code = 'PAYOUT_FAILED';
      err.payoutId = payoutId;
      throw err;
    }

    return { requestId, payoutId, status: result.status, reference: result.reference, distribution: dist, redemption, result };
  }
}

module.exports = { PtcPortalEngine };
