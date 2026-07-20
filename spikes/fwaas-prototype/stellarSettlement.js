'use strict';

/**
 * USDC-on-Stellar settlement rail (testnet) for the FWaaS spike.
 *
 * Demonstrates self-custodied, bank-free, near-instant (~3-5s) settlement:
 *   issuer (mints test USDC)  ──►  distributor (the trust's wallet)  ──►  beneficiary
 *
 * On mainnet the only change is the asset issuer (Circle's real USDC issuer
 * GA5Z…) and the Horizon URL; the flow is identical and still self-custodied.
 * Fiat on/off-ramp (USD⇄USDC) is the only step that touches a regulated party.
 */

const {
  Keypair, Horizon, TransactionBuilder, Networks, Operation, Asset, BASE_FEE,
} = require('@stellar/stellar-sdk');

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = process.env.FRIENDBOT_URL || 'https://friendbot.stellar.org';
const NETWORK = process.env.STELLAR_NETWORK_PASSPHRASE || Networks.TESTNET;
const USDC_CODE = process.env.USDC_CODE || 'USDC';

function centsToUnits(cents) {
  // USDC/Stellar amounts are decimal strings; 2dp is enough for USD cents.
  return (BigInt(cents) / 100n).toString() + '.' + String(Number(cents) % 100).padStart(2, '0');
}

async function friendbot(pubkey) {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(pubkey)}`);
  if (!res.ok) throw new Error(`friendbot funding failed for ${pubkey}: ${res.status}`);
  return res.json();
}

class StellarSettlement {
  constructor() {
    this.server = new Horizon.Server(HORIZON_URL);
  }

  /**
   * Provision issuer/distributor/beneficiary, fund them, open trustlines, and
   * seed the distributor with `seedCents` of test USDC.
   */
  async provision({ seedCents }) {
    this.issuer = Keypair.random();
    this.distributor = Keypair.random();
    this.beneficiary = Keypair.random();
    this.usdc = new Asset(USDC_CODE, this.issuer.publicKey());

    await Promise.all([
      friendbot(this.issuer.publicKey()),
      friendbot(this.distributor.publicKey()),
      friendbot(this.beneficiary.publicKey()),
    ]);

    // Trustlines: distributor + beneficiary must trust the USDC asset.
    await this._trust(this.distributor);
    await this._trust(this.beneficiary);

    // Issue seed USDC to the distributor (the trust's on-chain balance).
    await this._payment(this.issuer, this.distributor.publicKey(), centsToUnits(seedCents));

    return {
      issuer: this.issuer.publicKey(),
      distributor: this.distributor.publicKey(),
      beneficiary: this.beneficiary.publicKey(),
      asset: `${USDC_CODE}:${this.issuer.publicKey()}`,
    };
  }

  async _trust(kp) {
    const account = await this.server.loadAccount(kp.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.changeTrust({ asset: this.usdc }))
      .setTimeout(60)
      .build();
    tx.sign(kp);
    return this.server.submitTransaction(tx);
  }

  async _payment(fromKp, toPub, amount) {
    const account = await this.server.loadAccount(fromKp.publicKey());
    const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: NETWORK })
      .addOperation(Operation.payment({ destination: toPub, asset: this.usdc, amount }))
      .setTimeout(60)
      .build();
    tx.sign(fromKp);
    return this.server.submitTransaction(tx);
  }

  /**
   * Settle a distribution: pay `amountCents` USDC distributor → beneficiary.
   * Returns tx hash, ledger sequence, and measured submit→confirmed latency.
   */
  async settle({ amountCents, memo }) {
    const amount = centsToUnits(amountCents);
    const start = Date.now();
    const res = await this._payment(this.distributor, this.beneficiary.publicKey(), amount);
    const latencyMs = Date.now() - start;
    return {
      hash: res.hash,
      ledger: res.ledger,
      amount,
      memo: memo || null,
      latencyMs,
      explorer: `https://stellar.expert/explorer/testnet/tx/${res.hash}`,
    };
  }

  async usdcBalance(pub) {
    const account = await this.server.loadAccount(pub);
    const line = account.balances.find(
      b => b.asset_code === USDC_CODE && b.asset_issuer === this.issuer.publicKey()
    );
    return line ? line.balance : '0';
  }
}

module.exports = { StellarSettlement, centsToUnits };
