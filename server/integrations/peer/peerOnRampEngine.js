'use strict';

const { getConfig } = require('../dapp/config');

// In-memory store for intents; persists per process. Fly machines keep process state.
const intentStore = new Map();

function env(name, def = '') { return process.env[name] || def; }

async function loadDeps() {
  const [sdk, viem, chains, accounts] = await Promise.all([
    import('@zkp2p/sdk'),
    import('viem'),
    import('viem/chains'),
    import('viem/accounts'),
  ]);
  return {
    OfframpClient: sdk.OfframpClient,
    Currency: sdk.Currency,
    apiGetPayeeDetails: sdk.apiGetPayeeDetails,
    createWalletClient: viem.createWalletClient,
    createPublicClient: viem.createPublicClient,
    http: viem.http,
    parseAbi: viem.parseAbi,
    parseEventLogs: viem.parseEventLogs,
    base: chains.base,
    mainnet: chains.mainnet,
    privateKeyToAccount: accounts.privateKeyToAccount,
  };
}

function getOperatorAccount(deps) {
  const cfg = getConfig();
  const pk = cfg.privateKey;
  if (!pk) throw new Error('DAPP_PRIVATE_KEY not configured');
  const normalized = pk.startsWith('0x') ? pk : `0x${pk}`;
  return deps.privateKeyToAccount(normalized);
}

function getClientConfig() {
  const cfg = getConfig();
  return {
    apiKey: env('PEER_API_KEY'),
    baseApiUrl: env('PEER_BASE_API_URL', 'https://api.zkp2p.xyz'),
    baseRpcUrl: env('PEER_BASE_RPC_URL', 'https://mainnet.base.org'),
    baseUsdc: env('PEER_BASE_USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'),
    operatorAddress: cfg.operatorAddress,
    destinationChainId: 8453,
  };
}

async function getClient() {
  const deps = await loadDeps();
  const cfg = getClientConfig();
  if (!cfg.apiKey) throw new Error('PEER_API_KEY not configured');
  const account = getOperatorAccount(deps);
  const walletClient = deps.createWalletClient({
    account,
    chain: deps.base,
    transport: deps.http(cfg.baseRpcUrl),
  });
  const publicClient = deps.createPublicClient({
    chain: deps.base,
    transport: deps.http(cfg.baseRpcUrl),
  });
  const client = new deps.OfframpClient({
    walletClient,
    chainId: cfg.destinationChainId,
    runtimeEnv: 'production',
    apiKey: cfg.apiKey,
    baseApiUrl: cfg.baseApiUrl,
  });
  return { client, publicClient, account, deps, cfg };
}

function normalizePlatform(platform) {
  const p = String(platform || 'cashapp').toLowerCase().replace(/^@/, '').replace(/\s/g, '');
  return ['cashapp', 'venmo', 'wise', 'revolut', 'paypal', 'zelle'].includes(p) ? p : 'cashapp';
}

class PeerOnRampEngine {
  static async getQuote({ platform = 'cashapp', fiatCurrency = 'USD', amountUsdc = 10, recipient } = {}) {
    const { client, account, cfg, deps } = await getClient();
    const p = normalizePlatform(platform);
    const fiat = (deps.Currency[fiatCurrency.toUpperCase()] || fiatCurrency.toUpperCase());
    const amountCents = Math.round(Number(amountUsdc) * 1000000).toString(); // USDC 6 decimals
    const toAddress = recipient || cfg.operatorAddress;

    const quote = await client.getQuote({
      paymentPlatforms: [p],
      fiatCurrency: fiat,
      user: toAddress,
      recipient: toAddress,
      destinationChainId: cfg.destinationChainId,
      destinationToken: cfg.baseUsdc,
      amount: amountCents,
      isExactFiat: false,
      includeNearbyQuotes: true,
      nearbyQuotesCount: 5,
    });

    const suggestion = quote.responseObject?.nearbySuggestions?.below?.[0] ||
                       quote.responseObject?.nearbySuggestions?.above?.[0] ||
                       (quote.responseObject?.quotes?.length ? { quote: quote.responseObject.quotes[0] } : null);
    const selected = suggestion?.quote;
    if (!selected) {
      return { available: false, quote: quote.responseObject, message: 'No Peer on-ramp quote available for this platform/amount right now.' };
    }

    const intent = selected.intent;
    let paymentInstructions = null;
    try {
      const payee = await deps.apiGetPayeeDetails(
        { processorName: intent.processorName, hashedOnchainId: intent.payeeDetails },
        cfg.baseApiUrl,
        30000
      );
      paymentInstructions = payee?.responseObject || null;
    } catch (e) {
      console.warn('[PeerOnRamp] payee lookup failed:', e.message);
    }

    return {
      available: true,
      platform: p,
      fiatCurrency: fiat,
      fiatAmount: selected.fiatAmountFormatted,
      tokenAmount: selected.tokenAmountFormatted,
      signalIntentAmount: selected.signalIntentAmountFormatted,
      totalFee: selected.totalFeeAmountFormatted,
      conversionRate: selected.conversionRate,
      paymentInstructions,
      intent: this._serialize(intent),
      selected: this._serialize(selected),
    };
  }

  static _serialize(obj) {
    return JSON.parse(JSON.stringify(obj, (k, v) => typeof v === 'bigint' ? v.toString() : v));
  }

  static async prepareSignal({ depositId, amount, toAddress, processorName, payeeDetails, fiatCurrencyCode, conversionRate, escrowAddress } = {}) {
    const { client, cfg, account } = await getClient();
    if (!depositId || !amount || !processorName || !payeeDetails || !conversionRate) {
      throw new Error('depositId, amount, processorName, payeeDetails, conversionRate required');
    }
    const prepared = await client.signalIntent.prepare({
      depositId: BigInt(depositId),
      amount: BigInt(amount),
      toAddress: toAddress || cfg.operatorAddress,
      processorName,
      payeeDetails,
      fiatCurrencyCode: fiatCurrencyCode || 'USD',
      conversionRate: BigInt(conversionRate),
      escrowAddress,
    });
    return { available: true, prepared: this._serialize(prepared), network: 'base', chainId: 8453 };
  }

  static async executeSignal({ depositId, amount, toAddress, processorName, payeeDetails, fiatCurrencyCode, conversionRate, escrowAddress } = {}) {
    const { client, publicClient, deps, cfg } = await getClient();
    const txHash = await client.signalIntent({
      depositId: BigInt(depositId),
      amount: BigInt(amount),
      toAddress: toAddress || cfg.operatorAddress,
      processorName,
      payeeDetails,
      fiatCurrencyCode: fiatCurrencyCode || 'USD',
      conversionRate: BigInt(conversionRate),
      escrowAddress,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    const intentSignaledAbi = deps.parseAbi([
      'event IntentSignaled(bytes32 indexed intentHash, address indexed escrow, uint256 indexed depositId, bytes32 paymentMethod, address owner, address to, uint256 amount, bytes32 fiatCurrency, uint256 conversionRate, uint256 timestamp)',
    ]);
    const logs = deps.parseEventLogs({ abi: intentSignaledAbi, logs: receipt.logs, eventName: 'IntentSignaled' });
    const intentHash = logs[0]?.args?.intentHash || null;

    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      txHash,
      intentHash,
      status: 'signaled',
      createdAt: new Date().toISOString(),
      depositId: String(depositId),
      amount: String(amount),
      toAddress: toAddress || cfg.operatorAddress,
      processorName,
      fiatCurrencyCode: fiatCurrencyCode || 'USD',
    };
    if (intentHash) intentStore.set(intentHash, record);
    return { success: true, txHash, intentHash, receipt: { blockNumber: Number(receipt.blockNumber), gasUsed: receipt.gasUsed?.toString?.() || String(receipt.gasUsed), status: receipt.status }, record };
  }

  static async getIntentStatus(intentHash) {
    const record = intentStore.get(intentHash);
    if (!record) throw new Error('Intent not found');
    const { publicClient, client } = await getClient();
    let fulfilled = false;
    try {
      const intent = await client.getIntent(intentHash);
      fulfilled = intent && (intent.status === 'fulfilled' || intent.fulfilled);
      if (fulfilled) record.status = 'fulfilled';
    } catch (e) { /* ignore */ }
    return { record, fulfilled };
  }

  static async listIntents() {
    return Array.from(intentStore.values());
  }

  // Bridge USDC from Base to Ethereum mainnet via Circle CCTP (or placeholder until implemented)
  static async bridgeToMainnet({ amount, recipient }) {
    throw new Error('Circle CCTP bridge from Base to Ethereum mainnet is not yet implemented. Receive USDC on Base and bridge manually or fund the Base operator wallet to continue using Peer.');
  }
}

module.exports = { PeerOnRampEngine };
