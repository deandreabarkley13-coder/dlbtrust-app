#!/usr/bin/env node
'use strict';

/**
 * Unified Value Workflow Smoke Test
 *
 * Exercises the end-to-end "move real value" workflow against a running server:
 *
 *   email OTP verify -> smart-wallet provision -> SIWE wallet login
 *   -> ramp quote (fee shown) -> propose -> approve -> execute (shadow)
 *   -> document anchor (hash + shadow storage URI)
 *   -> chain transfer reconciliation into the canonical event outbox
 *
 * Everything runs in shadow mode. No *_LIVE flag is set or required by this
 * script: ramp execution, account abstraction, and document pinning all stay
 * disabled unless the corresponding live env flags are explicitly turned on, so
 * this smoke test never moves real value.
 *
 * Usage:
 *   node server/scripts/valueWorkflowSmokeTest.js
 *   VALUE_TEST_BASE_URL=http://localhost:3002 ADMIN_SECRET_TOKEN=dlb-admin-2026-trust \
 *     node server/scripts/valueWorkflowSmokeTest.js
 */

const { getTrusteeByRole } = require('../integrations/dapp/trustees');

const BASE_URL = (process.env.VALUE_TEST_BASE_URL || 'http://localhost:3002').replace(/\/$/, '');
const TOKEN = process.env.ADMIN_SECRET_TOKEN || 'dlb-admin-2026-trust';
const VERBOSE = process.env.VALUE_TEST_VERBOSE !== 'false';
const EMAIL = process.env.VALUE_TEST_EMAIL || `smoke+${Date.now()}@dlbtrust.test`;

const results = [];
let failed = false;

async function call(method, path, body, headers = {}) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'x-admin-token': TOKEN, ...headers },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch { /* non-JSON response */ }
  return { status: res.status, ok: res.ok, body: json || text };
}

function log(step, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${step}`);
  if (VERBOSE && detail !== undefined) {
    const printable = typeof detail === 'object' ? JSON.stringify(detail, null, 2) : String(detail);
    console.log(printable.split('\n').map((l) => `    ${l}`).join('\n'));
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

async function runStep(name, fn) {
  try {
    const detail = await fn();
    log(name, true, detail);
    results.push({ name, ok: true });
    return detail;
  } catch (err) {
    failed = true;
    log(name, false, err.message);
    results.push({ name, ok: false, error: err.message });
    return null;
  }
}

const state = {};

async function main() {
  console.log(`Unified Value Workflow Smoke Test — ${BASE_URL}`);
  console.log(`Test user: ${EMAIL} (shadow mode; no live value movement)`);
  console.log('-'.repeat(70));

  // ── 1. Email OTP verify provisions a smart account ────────────────────────
  await runStep('auth: send OTP code', async () => {
    const { ok, body } = await call('POST', '/api/dapp/auth/send-code', { email: EMAIL });
    assert(ok, (body && body.error) || `status ${body}`);
    state.otp = (body.data && (body.data.code || body.data.otp || body.data.pin)) || process.env.VALUE_TEST_OTP;
    return { sent: true, codeReturned: Boolean(state.otp) };
  });

  await runStep('auth: verify OTP provisions a deterministic smart account', async () => {
    assert(state.otp, 'OTP code unavailable: run the server with DAPP_OTP_ALWAYS_SHOW_CODE=true (non-production) or set VALUE_TEST_OTP');
    const { ok, body } = await call('POST', '/api/dapp/auth/verify', { email: EMAIL, code: state.otp });
    assert(ok, body && body.error);
    const data = body.data || {};
    state.token = data.token;
    state.smartAccount = data.smartAccount;
    assert(data.smartAccount && data.smartAccount.address, 'no smart account returned from verify');
    assert(/^0x[0-9a-fA-F]{40}$/.test(data.smartAccount.address), 'smart account address malformed');
    assert(data.smartAccount.provider, 'smart account did not report its wallet provider');
    // Shadow is the only acceptable mode here: a live mode would mean the
    // provider was contacted and an account could be deployed.
    assert(data.smartAccount.mode === 'shadow', `expected a shadow smart account, got ${data.smartAccount.mode}`);
    return data.smartAccount;
  });

  await runStep('auth/me: exposes the predicted smart-account address', async () => {
    assert(state.token, 'no session token from verify');
    const { ok, body } = await call('GET', '/api/dapp/auth/me', undefined, { Authorization: `Bearer ${state.token}` });
    assert(ok, body && body.error);
    const sa = body.data && body.data.smartAccount;
    assert(sa && sa.address, '/auth/me did not expose a smart account');
    assert(sa.address === state.smartAccount.address, 'smart-account address is not deterministic across calls');
    return { address: sa.address, provider: sa.provider, mode: sa.mode, whitelisted: sa.whitelisted };
  });

  // ── 1b. thirdweb sponsorship policy (the trust's server verifier) ─────────
  await runStep('sponsorship: policy is described and not enforcing in shadow', async () => {
    const { ok, body } = await call('GET', '/api/dapp/thirdweb/sponsorship/policy');
    assert(ok, body && body.error);
    const policy = (body.data && body.data.policy) || {};
    assert(policy.enforcing === false, 'sponsorship policy reports it is enforcing: gas would be spent');
    return policy;
  });

  await runStep('sponsorship: verifier refuses unauthenticated callers', async () => {
    const { status, body } = await call('POST', '/api/dapp/thirdweb/sponsorship/verify', {
      clientId: 'smoke',
      chainId: 1,
      userOp: { sender: state.smartAccount && state.smartAccount.address, targets: [], gasLimit: '500000', gasPrice: '1000000000' },
    });
    assert(status === 401, `expected 401 without the verifier secret, got ${status}`);
    assert(body && body.isAllowed === false, 'unauthenticated verifier call did not deny sponsorship');
    return { status, isAllowed: body.isAllowed, reason: body.reason };
  });

  // ── 2. SIWE wallet-only login ─────────────────────────────────────────────
  await runStep('siwe: nonce + signature authenticates a connected wallet', async () => {
    const { privateKeyToAccount } = require('viem/accounts');
    const account = privateKeyToAccount(process.env.VALUE_TEST_SIWE_KEY
      || '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

    const nonceRes = await call('POST', '/api/dapp/auth/siwe/nonce', { address: account.address });
    assert(nonceRes.ok, nonceRes.body && nonceRes.body.error);
    const message = nonceRes.body.data.message;
    assert(message, 'nonce endpoint returned no message to sign');

    const signature = await account.signMessage({ message });
    const verifyRes = await call('POST', '/api/dapp/auth/siwe/verify', { message, signature });
    assert(verifyRes.ok, verifyRes.body && verifyRes.body.error);
    const data = verifyRes.body.data;
    assert(data.token, 'no session token issued for the wallet');
    assert(data.address.toLowerCase() === account.address.toLowerCase(), 'recovered address mismatch');
    state.walletToken = data.token;
    return { address: data.address, smartAccount: data.smartAccount && data.smartAccount.address };
  });

  // ── 3. Ramp quote -> propose -> approve -> execute (shadow) ───────────────
  await runStep('ramp: quote includes the configured bps fee', async () => {
    const { ok, body } = await call('POST', '/api/finops/ramps/quote', {
      direction: 'onramp', sourceAsset: 'USD', targetAsset: 'USDC', amount: '1000',
    });
    assert(ok, body && body.error);
    const q = body.data || {};
    assert(q.fee, 'quote did not include a fee breakdown');
    assert(q.fee.grossAmount === 1000, 'fee gross amount mismatch');
    assert(q.fee.feeAmount === Math.round(1000 * (q.fee.feeBps / 10000) * 100) / 100, 'fee math mismatch');
    state.quoteFee = q.fee;
    return q.fee;
  });

  await runStep('ramp: propose carries the quoted fee into the proposal', async () => {
    const { ok, body } = await call('POST', '/api/finops/ramps/requests', {
      direction: 'onramp', sourceAsset: 'USD', targetAsset: 'USDC', amount: '1000',
      provider: 'trust_shadow', createdBy: 'value-workflow-smoke',
    });
    assert(ok, body && body.error);
    state.proposalId = body.data && body.data.proposalId;
    assert(state.proposalId, 'no proposalId returned');
    return { proposalId: state.proposalId, fee: body.data.fee };
  });

  await runStep('ramp: approve + execute in shadow and book the fee', async () => {
    assert(state.proposalId, 'no proposal to approve');
    const proposalRes = await call('GET', `/api/finops/ramps/requests/${state.proposalId}`);
    assert(proposalRes.ok, proposalRes.body && proposalRes.body.error);
    const roles = (proposalRes.body.data && proposalRes.body.data.required_roles) || [];
    assert(roles.length, 'proposal declared no required approval roles');

    // Each consensus role can only be signed by its trustee of record. The
    // consensus engine executes as soon as the threshold is met, so the last
    // approval response already carries the execution result.
    const approvals = [];
    let executed = null;
    for (const role of roles) {
      const trustee = getTrusteeByRole(role);
      assert(trustee, `no trustee of record for role ${role}`);
      const approve = await call('POST', `/api/finops/ramps/requests/${state.proposalId}/approve`, {
        approverEmail: trustee.email,
        role,
      });
      assert(approve.ok, approve.body && approve.body.error);
      const data = approve.body.data || {};
      approvals.push({ role, status: data.status });
      if (data.status === 'executed') { executed = data; break; }
      if (data.status === 'approved') break;
    }

    if (!executed) {
      const exec = await call('POST', `/api/finops/ramps/requests/${state.proposalId}/execute`, {});
      assert(exec.ok, exec.body && exec.body.error);
      executed = exec.body.data || {};
    }
    // Execution can legitimately report a provider-side "not configured" state
    // in shadow mode; the fee bookkeeping is what this step verifies.
    const result = executed.result || executed;
    const fee = result.fee || null;
    if (state.quoteFee && state.quoteFee.feeBps > 0) {
      assert(fee, 'execution returned no fee record');
      assert(['booked', 'already_booked'].includes(fee.status), `fee not booked: ${fee.status} ${fee.error || ''}`);
    }
    return { approvals, fee: fee || 'no fee configured (RAMP_FEE_BPS=0)' };
  });

  // ── 4. Document anchoring ─────────────────────────────────────────────────
  await runStep('documents: creation hashes content and records a storage URI', async () => {
    const content = `Tokenized bond receipt ${Date.now()}`;
    const { ok, body } = await call('POST', '/api/dapp/documents', {
      documentName: 'Value Workflow Smoke Receipt',
      documentType: 'receipt',
      category: 'general',
      content,
      contentType: 'text/plain',
    }, { Authorization: `Bearer ${state.token}` });
    assert(ok, body && body.error);
    const doc = body.data || {};
    assert(doc.content_hash && doc.content_hash.startsWith('sha256:'), 'no content hash stored on the document');
    assert(doc.storage_uri, 'no storage URI stored on the document');
    assert(doc.storage_uri.startsWith('shadow://'), `expected a shadow storage URI, got ${doc.storage_uri}`);
    return { documentId: doc.document_id, contentHash: doc.content_hash, storageUri: doc.storage_uri };
  });

  // ── 5. Chain transfer reconciliation ──────────────────────────────────────
  await runStep('reconciler: status reports the canonical topic', async () => {
    const { ok, body } = await call('GET', '/api/dapp/events/chain-reconciler/status');
    assert(ok, body && body.error);
    assert(body.data.topic === 'trust.chain.transfer.reconciled', 'unexpected canonical topic');
    return body.data;
  });

  await runStep('reconciler: confirmed transfers land in the canonical outbox once', async () => {
    const address = '0x3e53028cf69949f3B961ce786Baf2D4D75166562';
    const transfers = [{
      hash: `0xsmoke${Date.now().toString(16)}`,
      direction: 'in', asset: 'USDC', value: 12.5,
      from: '0x0000000000000000000000000000000000000001', to: address,
      timestamp: new Date().toISOString(), category: 'erc20',
    }];
    const first = await call('POST', '/api/dapp/events/chain-reconciler/run', { address, transfers });
    assert(first.ok, first.body && first.body.error);
    assert(first.body.data.reconciled === 1, `expected 1 reconciled, got ${first.body.data.reconciled}`);

    const second = await call('POST', '/api/dapp/events/chain-reconciler/run', { address, transfers });
    assert(second.ok, second.body && second.body.error);
    assert(second.body.data.reconciled === 0 && second.body.data.duplicates === 1, 'reconciler is not idempotent');
    return { first: first.body.data.events, duplicatesOnRerun: second.body.data.duplicates };
  });

  console.log('-'.repeat(70));
  const passed = results.filter((r) => r.ok).length;
  console.log(`Results: ${passed}/${results.length} passed`);
  if (failed) {
    console.error('SMOKE TEST FAILED');
    process.exit(1);
  }
  console.log('SMOKE TEST PASSED (shadow mode — no live value moved)');
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});
