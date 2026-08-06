'use strict';

/**
 * BitPayEngine
 *
 * Integrates the BitPay JSON Payment Protocol v2 so a logged-in dApp user
 * can scan a BitPay invoice QR and pay it from their system wallet.
 *
 * Supported chains: Ethereum (ETH) mainnet / testnet.
 * Supported currencies: ETH, DAI, USDC and any ERC-20 BitPay lists on ETH.
 *
 * Payment flow:
 *   1. GET invoice URL with Accept: application/payment-options
 *   2. POST invoice URL with Content-Type: application/payment-request {chain,currency}
 *   3. Sign and broadcast each instruction transaction from the user's wallet.
 *   4. POST the signed transactions to BitPay's payment URL.
 *   5. Debit the internal wallet ledger for the invoiced amount.
 */

const { getConfig } = require('./config');
const { WalletEngine } = require('./walletEngine');

let viem, chains;
try { viem = require('viem'); chains = require('viem/chains'); } catch (e) { viem = null; chains = null; }
let accountFns;
try { accountFns = require('viem/accounts'); } catch (e) { accountFns = null; }

function assetSupported(asset) {
  if (!asset) return false;
  const a = String(asset).toUpperCase();
  return ['ETH','DAI','USDC','USDT','GUSD','PAX','BUSD','WBTC','SIT','DLBUSD'].includes(a);
}

function toSmallestUnits(amount, decimals) {
  if (!viem) throw new Error('viem not installed');
  const s = Number(amount).toFixed(decimals);
  return viem.parseUnits(s, decimals).toString();
}

class BitPayEngine {
  static normalizeInvoiceUrl(text) {
    if (!text) return null;
    const t = String(text).trim();
    // BitPay invoice QR may be a raw https URL, a BIP21 r= param, or ethereum:?r=
    const match = t.match(/(https?:\/\/[^\s\?]+\/i\/[A-Za-z0-9]+)/);
    if (match) return match[1];
    const r = t.match(/[?&]r=([^\s&]+)/);
    if (r) return decodeURIComponent(r[1]);
    return null;
  }

  static async request(url, opts = {}) {
    const headers = {
      'Accept': opts.accept || 'application/json',
      'X-Paypro-Version': '2',
      ...(opts.headers || {}),
    };
    if (opts.body && !opts.isRaw) {
      headers['Content-Type'] = opts.contentType || 'application/json';
    }
    const res = await fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      const err = (data && (data.message || data.error || data.detail || JSON.stringify(data))) || `HTTP ${res.status}`;
      throw new Error(`BitPay request failed: ${err}`);
    }
    return data;
  }

  static async getPaymentOptions(invoiceUrl) {
    return this.request(invoiceUrl, { accept: 'application/payment-options' });
  }

  static async getPaymentRequest(invoiceUrl, chain, currency) {
    return this.request(invoiceUrl, {
      method: 'POST',
      accept: 'application/payment-request',
      contentType: 'application/payment-request',
      body: { chain, currency },
    });
  }

  static async postPayment(paymentUrl, { chain, currency, transactions }) {
    // transactions: array of { tx: rawHex, weightedSize? }
    return this.request(paymentUrl, {
      method: 'POST',
      accept: 'application/payment',
      contentType: 'application/payment',
      body: { chain, currency, transactions },
    });
  }

  static async payInvoice({ fromWalletId, invoiceUrl, asset }) {
    if (!viem) throw new Error('viem not installed');
    if (!accountFns) throw new Error('viem/accounts not installed');
    if (!fromWalletId) throw new Error('fromWalletId required');
    const selectedAsset = String(asset || 'ETH').toUpperCase();

    const url = this.normalizeInvoiceUrl(invoiceUrl);
    if (!url) throw new Error('Invalid BitPay invoice URL');

    const options = await this.getPaymentOptions(url);
    if (!options || !options.paymentOptions) throw new Error('No payment options from BitPay');

    const option = options.paymentOptions.find(o =>
      String(o.chain).toUpperCase() === 'ETH' &&
      String(o.currency).toUpperCase() === selectedAsset
    );
    if (!option) {
      const supported = options.paymentOptions.map(o => `${o.chain}/${o.currency}`).join(', ');
      throw new Error(`Asset ${selectedAsset} not available on ETH for this invoice. Options: ${supported}`);
    }

    const request = await this.getPaymentRequest(url, option.chain, option.currency);
    if (!request || !request.instructions || !request.instructions.length) {
      throw new Error('No payment instructions from BitPay');
    }
    if (request.expires && new Date(request.expires) < new Date()) {
      throw new Error('BitPay invoice has expired');
    }

    const wallet = await WalletEngine.getWallet(fromWalletId);
    if (!wallet) throw new Error('Wallet not found');
    if (wallet.type !== 'internal' || !wallet.private_key_encrypted) {
      throw new Error('Only internal system wallets can pay BitPay invoices');
    }

    const privateKey = WalletEngine._decrypt(wallet.private_key_encrypted);
    const account = accountFns.privateKeyToAccount(privateKey);

    const cfg = getConfig();
    if (!cfg.rpcUrl) throw new Error('DAPP_RPC_URL not configured');
    const chain = cfg.chainId === 11155111 ? chains.sepolia : chains.mainnet;
    const publicClient = viem.createPublicClient({ chain, transport: viem.http(cfg.rpcUrl) });

    const fees = cfg.getFees ? cfg.getFees() : { maxFeePerGas: viem.parseGwei('3'), maxPriorityFeePerGas: viem.parseGwei('0.1') };
    const baseNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'pending' });

    const hashes = [];
    const raws = [];
    let i = 0;
    for (const instruction of request.instructions) {
      const to = instruction.to;
      const value = BigInt(instruction.value || 0);
      const data = instruction.data || '0x';
      if (!viem.isAddress(to)) throw new Error(`Invalid instruction recipient: ${to}`);

      const estimated = await publicClient.estimateGas({
        account: account.address,
        to,
        value,
        data,
        ...fees,
      }).catch(() => 100000n);
      const gas = (estimated * 120n) / 100n; // 20% buffer

      const tx = {
        to,
        value,
        data,
        gas,
        ...fees,
        nonce: baseNonce + i,
        chainId: BigInt(cfg.chainId || 1),
        type: 'eip1559',
      };

      const raw = await account.signTransaction(tx);
      const hash = await publicClient.sendRawTransaction({ serializedTransaction: raw });
      hashes.push(hash);
      raws.push({ tx: raw, weightedSize: Math.floor((raw.length - 2) / 2) });
      i++;
    }

    // Wait for all receipts
    for (const hash of hashes) {
      try { await publicClient.waitForTransactionReceipt({ hash, timeout: 120000 }); } catch (e) { /* continue; may still confirm */ }
    }

    // Notify BitPay
    let bitpayAck = null;
    try {
      bitpayAck = await this.postPayment(request.paymentUrl || url, { chain: 'ETH', currency: option.currency, transactions: raws });
    } catch (e) {
      console.warn('[BitPayEngine] post-payment notification failed:', e.message);
    }

    // Debit internal ledger in the same smallest units used by WalletEngine for this asset
    const decimals = Number(option.decimals) || 18;
    const humanAmount = Number(option.estimatedAmount) / Math.pow(10, decimals);
    const smallest = toSmallestUnits(humanAmount, decimals);

    const internalBalance = await WalletEngine._ensureBalance(fromWalletId, selectedAsset);
    if (BigInt(internalBalance.balance_cents || 0) < BigInt(smallest)) {
      throw new Error(`Insufficient internal ${selectedAsset} balance for BitPay payment`);
    }
    await WalletEngine._debit(fromWalletId, selectedAsset, smallest, {
      memo: `BitPay invoice ${request.paymentId || ''}`,
      tx_hash: hashes.join(','),
      bitpay: { invoiceUrl: url, currency: option.currency, hashes, bitpayAck },
    });

    return {
      success: true,
      invoiceId: request.paymentId,
      currency: option.currency,
      amount: humanAmount,
      smallestUnits: smallest,
      hashes,
      bitpayAck,
      balance: await WalletEngine.getBalance(fromWalletId),
    };
  }
}

module.exports = { BitPayEngine };
