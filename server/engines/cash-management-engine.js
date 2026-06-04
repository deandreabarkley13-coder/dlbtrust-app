/**
 * Cash Management System Engine
 * DEANDREA LAVAR BARKLEY TRUST — Treasury & Liquidity Management
 *
 * Unified cash position aggregation across all engines:
 *   - Banking accounts (trust_accounts)
 *   - Blockchain wallets (USDC + native balances)
 *   - Fixed Income (bond cashflows: coupons, maturities)
 *   - Trust Accounting (GL balances, reconciliation)
 *
 * Read-only layer (Phase 1):
 *   1. Unified cash position — single view of all liquid assets
 *   2. Cash flow forecasting — 30/60/90/360-day projections
 *   3. Cross-engine reconciliation — detect discrepancies
 *   4. Alerts — low balance, upcoming maturities, recon mismatches
 */

'use strict';

const { bus, EVENTS } = require('./event-bus');

// --- Cash Position Categories -----------------------------------------------

const POSITION_CATEGORIES = {
  BANK_ACCOUNTS:    'bank_accounts',
  CRYPTO_WALLETS:   'crypto_wallets',
  FIXED_INCOME:     'fixed_income',
  PENDING_INFLOWS:  'pending_inflows',
  PENDING_OUTFLOWS: 'pending_outflows',
};

const ALERT_TYPES = [
  'low_balance',           // Account/wallet below threshold
  'high_concentration',    // Too much in one account/wallet
  'upcoming_maturity',     // Bond maturing within N days
  'recon_mismatch',        // Discrepancy between engines
  'large_pending',         // Large pending transfer/transaction
  'forecast_shortfall',    // Projected negative balance
  'idle_cash',             // Cash sitting idle above threshold
];

const ALERT_SEVERITIES = ['info', 'warning', 'critical'];

const RECON_STATUSES = ['matched', 'mismatch', 'unmatched', 'pending_review'];

// --- Unified Cash Position --------------------------------------------------

function buildCashPosition(data) {
  const { accounts = [], wallets = [], holdings = [], pendingTransfers = [], pendingBlockchainTxns = [] } = data;
  const now = new Date().toISOString();

  // 1. Bank accounts
  const bankPosition = {
    category: POSITION_CATEGORIES.BANK_ACCOUNTS,
    items: accounts.filter(a => a.status === 'active').map(a => ({
      id: a.id,
      name: a.account_name,
      type: a.account_type,
      balance_cents: a.balance_cents || 0,
      available_cents: a.available_cents || 0,
      hold_cents: a.hold_cents || 0,
      currency: a.currency || 'USD',
      interest_rate_bps: a.interest_rate_bps || 0,
      source: 'banking',
    })),
  };
  bankPosition.total_balance_cents = bankPosition.items.reduce((s, i) => s + i.balance_cents, 0);
  bankPosition.total_available_cents = bankPosition.items.reduce((s, i) => s + i.available_cents, 0);

  // 2. Crypto wallets (USDC balance → cents)
  const cryptoPosition = {
    category: POSITION_CATEGORIES.CRYPTO_WALLETS,
    items: wallets.filter(w => w.status === 'active').map(w => {
      const usdcCents = Math.round(parseFloat(w.usdc_balance || '0') * 100);
      const nativeBal = parseFloat(w.native_balance || '0');
      return {
        id: w.id,
        name: w.wallet_name,
        type: w.wallet_type,
        address: w.address,
        blockchain: w.blockchain,
        provider: w.provider,
        usdc_balance_cents: usdcCents,
        native_balance: nativeBal,
        currency: 'USDC',
        source: 'blockchain',
      };
    }),
  };
  cryptoPosition.total_usdc_cents = cryptoPosition.items.reduce((s, i) => s + i.usdc_balance_cents, 0);

  // 3. Fixed income (par value of active holdings)
  const activeHoldings = holdings.filter(h => h.status === 'active');
  const fixedIncomePosition = {
    category: POSITION_CATEGORIES.FIXED_INCOME,
    items: activeHoldings.map(h => ({
      id: h.id,
      name: h.security_name,
      type: h.security_type,
      par_value_cents: h.par_value_cents || 0,
      market_value_cents: h.market_value_cents || h.par_value_cents || 0,
      coupon_rate: h.coupon_rate || 0,
      maturity_date: h.maturity_date,
      accrued_interest_cents: h.accrued_interest_cents || 0,
      source: 'fixed_income',
    })),
  };
  fixedIncomePosition.total_par_cents = fixedIncomePosition.items.reduce((s, i) => s + i.par_value_cents, 0);
  fixedIncomePosition.total_market_cents = fixedIncomePosition.items.reduce((s, i) => s + i.market_value_cents, 0);
  fixedIncomePosition.total_accrued_cents = fixedIncomePosition.items.reduce((s, i) => s + i.accrued_interest_cents, 0);

  // 4. Pending inflows/outflows
  const inflows = pendingTransfers.filter(t => ['pending', 'approved'].includes(t.status));
  const pendingInflowCents = inflows
    .filter(t => t.transfer_type === 'distribution' || t.transfer_type === 'receipt')
    .reduce((s, t) => s + (t.amount_cents || 0), 0);

  const pendingOutflowCents = inflows
    .filter(t => t.transfer_type !== 'distribution' && t.transfer_type !== 'receipt')
    .reduce((s, t) => s + (t.amount_cents || 0), 0);

  const pendingBlockchainInCents = pendingBlockchainTxns
    .filter(tx => ['pending_approval', 'initiated'].includes(tx.status) && tx.transfer_type === 'internal')
    .reduce((s, tx) => s + (tx.amount_cents || 0), 0);

  const pendingBlockchainOutCents = pendingBlockchainTxns
    .filter(tx => ['pending_approval', 'initiated'].includes(tx.status) && tx.transfer_type !== 'internal')
    .reduce((s, tx) => s + (tx.amount_cents || 0), 0);

  // Summary
  const totalLiquidCents = bankPosition.total_balance_cents + cryptoPosition.total_usdc_cents;
  const totalAssetsCents = totalLiquidCents + fixedIncomePosition.total_market_cents;
  const netPendingCents = (pendingInflowCents + pendingBlockchainInCents) - (pendingOutflowCents + pendingBlockchainOutCents);

  return {
    snapshot_time: now,
    bank_accounts: bankPosition,
    crypto_wallets: cryptoPosition,
    fixed_income: fixedIncomePosition,
    pending: {
      inflow_cents: pendingInflowCents + pendingBlockchainInCents,
      outflow_cents: pendingOutflowCents + pendingBlockchainOutCents,
      net_cents: netPendingCents,
    },
    summary: {
      total_liquid_cents: totalLiquidCents,
      total_liquid_usd: totalLiquidCents / 100,
      total_assets_cents: totalAssetsCents,
      total_assets_usd: totalAssetsCents / 100,
      bank_balance_cents: bankPosition.total_balance_cents,
      bank_balance_usd: bankPosition.total_balance_cents / 100,
      crypto_balance_cents: cryptoPosition.total_usdc_cents,
      crypto_balance_usd: cryptoPosition.total_usdc_cents / 100,
      fixed_income_market_cents: fixedIncomePosition.total_market_cents,
      fixed_income_market_usd: fixedIncomePosition.total_market_cents / 100,
      accrued_interest_cents: fixedIncomePosition.total_accrued_cents,
      accrued_interest_usd: fixedIncomePosition.total_accrued_cents / 100,
      net_pending_cents: netPendingCents,
      net_pending_usd: netPendingCents / 100,
      account_count: bankPosition.items.length,
      wallet_count: cryptoPosition.items.length,
      holding_count: fixedIncomePosition.items.length,
    },
  };
}

// --- Cash Flow Forecasting --------------------------------------------------

function buildForecast(data, horizonDays = 90) {
  const {
    accounts = [],
    holdings = [],
    scheduledPayments = [],
    recurringTransfers = [],
    wallets = [],
  } = data;

  const now = new Date();
  const periods = [];

  // Generate daily buckets → grouped by 30-day periods
  const periodCount = Math.ceil(horizonDays / 30);

  for (let p = 0; p < periodCount; p++) {
    const periodStart = new Date(now);
    periodStart.setDate(periodStart.getDate() + p * 30);
    const periodEnd = new Date(now);
    periodEnd.setDate(periodEnd.getDate() + (p + 1) * 30);

    const startStr = periodStart.toISOString().split('T')[0];
    const endStr = periodEnd.toISOString().split('T')[0];

    const period = {
      period_number: p + 1,
      start_date: startStr,
      end_date: endStr,
      label: `${startStr} to ${endStr}`,
      inflows: {
        coupon_income_cents: 0,
        interest_income_cents: 0,
        maturity_proceeds_cents: 0,
        other_inflows_cents: 0,
      },
      outflows: {
        scheduled_payments_cents: 0,
        recurring_transfers_cents: 0,
        other_outflows_cents: 0,
      },
      net_flow_cents: 0,
    };

    // Coupon income from fixed income holdings
    for (const h of holdings) {
      if (h.status !== 'active') continue;
      const ppy = _periodsPerYear(h.coupon_frequency);
      if (ppy <= 0) continue;

      const couponAmount = Math.round((h.par_value_cents * h.coupon_rate) / ppy);
      const couponMonths = 12 / ppy;

      // Generate coupon dates in this period
      const maturity = new Date(h.maturity_date);
      let d = new Date(h.purchase_date || h.created_at);
      while (d <= maturity) {
        const dStr = d.toISOString().split('T')[0];
        if (dStr >= startStr && dStr < endStr) {
          period.inflows.coupon_income_cents += couponAmount;
        }
        d.setMonth(d.getMonth() + couponMonths);
      }

      // Maturity in this period
      const matStr = h.maturity_date;
      if (matStr >= startStr && matStr < endStr) {
        period.inflows.maturity_proceeds_cents += h.par_value_cents;
      }
    }

    // Interest income from bank accounts
    for (const a of accounts) {
      if (a.status !== 'active' || !a.interest_rate_bps) continue;
      const dailyInterest = Math.round((a.balance_cents * a.interest_rate_bps) / (10000 * 365));
      period.inflows.interest_income_cents += dailyInterest * 30;
    }

    // Scheduled payments (outflows)
    for (const pmt of scheduledPayments) {
      if (pmt.status !== 'scheduled') continue;
      const pmtDate = pmt.due_date || pmt.scheduled_date;
      if (pmtDate >= startStr && pmtDate < endStr) {
        period.outflows.scheduled_payments_cents += pmt.amount_cents || 0;
      }
    }

    // Recurring transfers
    for (const rt of recurringTransfers) {
      if (rt.status !== 'active') continue;
      period.outflows.recurring_transfers_cents += rt.amount_cents || 0;
    }

    // Net flow
    const totalIn = period.inflows.coupon_income_cents
      + period.inflows.interest_income_cents
      + period.inflows.maturity_proceeds_cents
      + period.inflows.other_inflows_cents;

    const totalOut = period.outflows.scheduled_payments_cents
      + period.outflows.recurring_transfers_cents
      + period.outflows.other_outflows_cents;

    period.net_flow_cents = totalIn - totalOut;
    period.total_inflow_cents = totalIn;
    period.total_inflow_usd = totalIn / 100;
    period.total_outflow_cents = totalOut;
    period.total_outflow_usd = totalOut / 100;
    period.net_flow_usd = period.net_flow_cents / 100;

    periods.push(period);
  }

  // Running balance projection
  const currentLiquid = accounts.reduce((s, a) => s + (a.status === 'active' ? (a.balance_cents || 0) : 0), 0)
    + wallets.reduce((s, w) => s + Math.round(parseFloat(w.usdc_balance || '0') * 100), 0);

  let runningBalance = currentLiquid;
  for (const p of periods) {
    runningBalance += p.net_flow_cents;
    p.projected_balance_cents = runningBalance;
    p.projected_balance_usd = runningBalance / 100;
  }

  // Totals
  const totalInflow = periods.reduce((s, p) => s + p.total_inflow_cents, 0);
  const totalOutflow = periods.reduce((s, p) => s + p.total_outflow_cents, 0);

  return {
    generated_at: now.toISOString(),
    horizon_days: horizonDays,
    current_liquid_cents: currentLiquid,
    current_liquid_usd: currentLiquid / 100,
    periods,
    summary: {
      total_projected_inflow_cents: totalInflow,
      total_projected_inflow_usd: totalInflow / 100,
      total_projected_outflow_cents: totalOutflow,
      total_projected_outflow_usd: totalOutflow / 100,
      net_projected_cents: totalInflow - totalOutflow,
      net_projected_usd: (totalInflow - totalOutflow) / 100,
      ending_projected_balance_cents: periods.length > 0 ? periods[periods.length - 1].projected_balance_cents : currentLiquid,
      ending_projected_balance_usd: periods.length > 0 ? periods[periods.length - 1].projected_balance_usd : currentLiquid / 100,
      shortfall_periods: periods.filter(p => p.projected_balance_cents < 0).length,
    },
  };
}

// --- Cross-Engine Reconciliation --------------------------------------------

function reconcile(data) {
  const { accounts = [], wallets = [], glBalances = [], transfers = [], blockchainTxns = [] } = data;
  const now = new Date().toISOString();
  const items = [];

  // 1. Bank account balances vs GL asset balances
  const totalBankCents = accounts
    .filter(a => a.status === 'active')
    .reduce((s, a) => s + (a.balance_cents || 0), 0);

  // GL cash/asset totals
  const glCashAssets = glBalances
    .filter(gl => gl.account_type === 'asset' && (gl.sub_type === 'cash' || gl.account_code?.startsWith('1')))
    .reduce((s, gl) => s + (gl.balance_cents || 0), 0);

  if (glCashAssets > 0 || totalBankCents > 0) {
    const diff = totalBankCents - glCashAssets;
    items.push({
      check: 'bank_vs_gl',
      description: 'Bank account balances vs GL cash/asset accounts',
      bank_total_cents: totalBankCents,
      bank_total_usd: totalBankCents / 100,
      gl_total_cents: glCashAssets,
      gl_total_usd: glCashAssets / 100,
      difference_cents: diff,
      difference_usd: diff / 100,
      status: Math.abs(diff) === 0 ? 'matched' : Math.abs(diff) < 100 ? 'pending_review' : 'mismatch',
      severity: Math.abs(diff) === 0 ? 'info' : Math.abs(diff) < 10000 ? 'warning' : 'critical',
    });
  }

  // 2. Crypto wallet USDC totals vs recorded blockchain transaction net
  const totalCryptoCents = wallets
    .filter(w => w.status === 'active')
    .reduce((s, w) => s + Math.round(parseFloat(w.usdc_balance || '0') * 100), 0);

  const completedTxnNet = blockchainTxns
    .filter(tx => tx.status === 'completed')
    .reduce((s, tx) => {
      if (tx.transfer_type === 'internal') return s;
      return s + (tx.amount_cents || 0);
    }, 0);

  if (totalCryptoCents > 0 || completedTxnNet > 0) {
    items.push({
      check: 'crypto_wallet_balance',
      description: 'On-chain wallet balances (last synced)',
      wallet_total_cents: totalCryptoCents,
      wallet_total_usd: totalCryptoCents / 100,
      status: totalCryptoCents >= 0 ? 'matched' : 'mismatch',
      severity: 'info',
      note: 'Wallet balances reflect last RPC sync. Sync wallets for real-time data.',
    });
  }

  // 3. Pending transfer count check
  const pendingTransferCount = transfers.filter(t => ['pending', 'approved', 'executing'].includes(t.status)).length;
  const pendingBlockchainCount = blockchainTxns.filter(tx => ['pending_approval', 'initiated', 'submitted'].includes(tx.status)).length;

  items.push({
    check: 'pending_items',
    description: 'Unresolved pending transfers and blockchain transactions',
    pending_transfers: pendingTransferCount,
    pending_blockchain_txns: pendingBlockchainCount,
    total_pending: pendingTransferCount + pendingBlockchainCount,
    status: (pendingTransferCount + pendingBlockchainCount) === 0 ? 'matched' : 'pending_review',
    severity: (pendingTransferCount + pendingBlockchainCount) > 10 ? 'warning' : 'info',
  });

  // 4. Interest accrual check — accrued but not yet credited
  const totalAccrued = accounts.reduce((s, a) => s + (a.interest_accrued_cents || 0), 0);
  if (totalAccrued > 0) {
    items.push({
      check: 'accrued_interest',
      description: 'Interest accrued but not yet credited to accounts',
      accrued_cents: totalAccrued,
      accrued_usd: totalAccrued / 100,
      status: totalAccrued > 100000 ? 'pending_review' : 'matched',
      severity: totalAccrued > 100000 ? 'warning' : 'info',
    });
  }

  // Summary
  const matchedCount = items.filter(i => i.status === 'matched').length;
  const mismatchCount = items.filter(i => i.status === 'mismatch').length;
  const reviewCount = items.filter(i => i.status === 'pending_review').length;

  return {
    reconciliation_time: now,
    items,
    summary: {
      total_checks: items.length,
      matched: matchedCount,
      mismatched: mismatchCount,
      pending_review: reviewCount,
      overall_status: mismatchCount > 0 ? 'mismatch' : reviewCount > 0 ? 'pending_review' : 'matched',
    },
  };
}

// --- Alert Generation -------------------------------------------------------

function generateAlerts(position, forecast, recon) {
  const alerts = [];
  const now = new Date().toISOString();

  // Low liquid balance alert
  if (position.summary.total_liquid_cents < 1000000) { // < $10,000
    alerts.push({
      type: 'low_balance',
      severity: position.summary.total_liquid_cents < 100000 ? 'critical' : 'warning',
      message: `Total liquid balance is ${_formatUSD(position.summary.total_liquid_cents)} — below $10,000 threshold`,
      value_cents: position.summary.total_liquid_cents,
      created_at: now,
    });
  }

  // Concentration alert — single account > 80% of total
  if (position.summary.total_liquid_cents > 0) {
    for (const item of position.bank_accounts.items) {
      const pct = item.balance_cents / position.summary.total_liquid_cents;
      if (pct > 0.8 && position.bank_accounts.items.length > 1) {
        alerts.push({
          type: 'high_concentration',
          severity: 'warning',
          message: `"${item.name}" holds ${Math.round(pct * 100)}% of total liquid assets`,
          account_id: item.id,
          percentage: Math.round(pct * 100),
          created_at: now,
        });
      }
    }
  }

  // Upcoming maturities (within 30 days)
  const thirtyDaysOut = new Date();
  thirtyDaysOut.setDate(thirtyDaysOut.getDate() + 30);
  const thirtyStr = thirtyDaysOut.toISOString().split('T')[0];

  for (const item of position.fixed_income.items) {
    if (item.maturity_date && item.maturity_date <= thirtyStr) {
      alerts.push({
        type: 'upcoming_maturity',
        severity: 'info',
        message: `"${item.name}" matures on ${item.maturity_date} (par: ${_formatUSD(item.par_value_cents)})`,
        holding_id: item.id,
        maturity_date: item.maturity_date,
        par_value_cents: item.par_value_cents,
        created_at: now,
      });
    }
  }

  // Forecast shortfall
  if (forecast && forecast.summary.shortfall_periods > 0) {
    const firstShortfall = forecast.periods.find(p => p.projected_balance_cents < 0);
    alerts.push({
      type: 'forecast_shortfall',
      severity: 'critical',
      message: `Projected cash shortfall starting ${firstShortfall ? firstShortfall.start_date : 'soon'} — ${forecast.summary.shortfall_periods} period(s) below zero`,
      shortfall_periods: forecast.summary.shortfall_periods,
      created_at: now,
    });
  }

  // Recon mismatches
  if (recon && recon.summary.mismatched > 0) {
    const mismatches = recon.items.filter(i => i.status === 'mismatch');
    for (const m of mismatches) {
      alerts.push({
        type: 'recon_mismatch',
        severity: m.severity || 'warning',
        message: `Reconciliation mismatch: ${m.description} — difference: ${_formatUSD(Math.abs(m.difference_cents || 0))}`,
        check: m.check,
        difference_cents: m.difference_cents,
        created_at: now,
      });
    }
  }

  // Idle cash (bank accounts with >$50K and 0% interest)
  for (const item of position.bank_accounts.items) {
    if (item.balance_cents > 5000000 && item.interest_rate_bps === 0) {
      alerts.push({
        type: 'idle_cash',
        severity: 'info',
        message: `"${item.name}" has ${_formatUSD(item.balance_cents)} earning 0% interest — consider sweep or investment`,
        account_id: item.id,
        balance_cents: item.balance_cents,
        created_at: now,
      });
    }
  }

  return alerts;
}

// --- Income vs Expense Summary (for dashboard) ------------------------------

function buildIncomeExpenseSummary(data) {
  const { holdings = [], accounts = [], payments = [] } = data;
  const now = new Date();
  const yearStart = `${now.getFullYear()}-01-01`;

  // Projected annual coupon income
  let annualCouponCents = 0;
  for (const h of holdings) {
    if (h.status !== 'active') continue;
    const ppy = _periodsPerYear(h.coupon_frequency);
    if (ppy > 0) {
      annualCouponCents += Math.round(h.par_value_cents * h.coupon_rate);
    }
  }

  // Projected annual interest income from accounts
  let annualInterestCents = 0;
  for (const a of accounts) {
    if (a.status !== 'active' || !a.interest_rate_bps) continue;
    annualInterestCents += Math.round((a.balance_cents * a.interest_rate_bps) / 10000);
  }

  // Payments year-to-date
  const ytdPayments = payments.filter(p => p.created_at >= yearStart && p.status === 'completed');
  const ytdPaymentCents = ytdPayments.reduce((s, p) => s + (p.amount_cents || 0), 0);

  return {
    projected_annual_income_cents: annualCouponCents + annualInterestCents,
    projected_annual_income_usd: (annualCouponCents + annualInterestCents) / 100,
    coupon_income_cents: annualCouponCents,
    coupon_income_usd: annualCouponCents / 100,
    interest_income_cents: annualInterestCents,
    interest_income_usd: annualInterestCents / 100,
    ytd_expenses_cents: ytdPaymentCents,
    ytd_expenses_usd: ytdPaymentCents / 100,
    net_projected_cents: (annualCouponCents + annualInterestCents) - ytdPaymentCents,
    net_projected_usd: ((annualCouponCents + annualInterestCents) - ytdPaymentCents) / 100,
  };
}

// --- Helpers ----------------------------------------------------------------

function _periodsPerYear(frequency) {
  switch (frequency) {
    case 'monthly':     return 12;
    case 'quarterly':   return 4;
    case 'semi-annual': return 2;
    case 'annual':      return 1;
    case 'zero':        return 0;
    default:            return 2;
  }
}

function _formatUSD(cents) {
  return '$' + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// --- Exports ----------------------------------------------------------------

module.exports = {
  buildCashPosition,
  buildForecast,
  reconcile,
  generateAlerts,
  buildIncomeExpenseSummary,
  POSITION_CATEGORIES,
  ALERT_TYPES,
  ALERT_SEVERITIES,
  RECON_STATUSES,
};
