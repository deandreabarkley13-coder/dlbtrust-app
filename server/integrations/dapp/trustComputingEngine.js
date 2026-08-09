'use strict';

const fs = require('fs');
const path = require('path');
const { TrustAccountingEngine } = require('../accounting/trustAccountingEngine');
const { CrossChainConversionEngine } = require('./crossChainConversionEngine');

function dataDir() {
  if (process.env.PERSISTENT_DATA_DIR && fs.existsSync(process.env.PERSISTENT_DATA_DIR)) return process.env.PERSISTENT_DATA_DIR;
  if (fs.existsSync('/data')) return '/data';
  return path.join(process.cwd(), 'data');
}

function jobsPath() { return path.join(dataDir(), 'trust-computing-jobs.json'); }

function ensureDir() {
  const dir = dataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJobs() {
  ensureDir();
  try { if (fs.existsSync(jobsPath())) return JSON.parse(fs.readFileSync(jobsPath(), 'utf8')); } catch (e) { console.warn('[TrustComputingEngine] load jobs failed:', e.message); }
  return [];
}

function saveJobs(jobs) {
  ensureDir();
  try { fs.writeFileSync(jobsPath(), JSON.stringify(jobs.slice(0, 1000), null, 2)); } catch (e) { console.warn('[TrustComputingEngine] save jobs failed:', e.message); }
}

function generateId() {
  return `COMP-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function today() { return new Date().toISOString().split('T')[0]; }

class TrustComputingEngine {
  static listFunctions() {
    return [
      { id: 'dashboard_summary', name: 'Dashboard Summary', description: 'High-level trust accounting snapshot.', params: [] },
      { id: 'balance_sheet', name: 'Balance Sheet', description: 'Assets, liabilities, equity as of a date.', params: [{ name: 'asOfDate', type: 'date', optional: true }] },
      { id: 'income_statement', name: 'Income Statement', description: 'Income and expenses over a period.', params: [{ name: 'fromDate', type: 'date', optional: true }, { name: 'toDate', type: 'date', optional: true }] },
      { id: 'cashflow_statement', name: 'Cashflow Statement', description: 'Operating, investing and financing cash flows.', params: [{ name: 'fromDate', type: 'date', optional: true }, { name: 'toDate', type: 'date', optional: true }] },
      { id: 'bond_yield', name: 'Bond Yield (YTM approximation)', description: 'Approximate yield-to-maturity from price, par, coupon and term.', params: [{ name: 'price', type: 'number', required: true }, { name: 'par', type: 'number', default: 100 }, { name: 'couponRate', type: 'number', required: true }, { name: 'years', type: 'number', required: true }, { name: 'frequency', type: 'number', default: 1 }] },
      { id: 'interest_accrual', name: 'Interest Accrual', description: 'Simple interest accrual: principal * rate * days / 365.', params: [{ name: 'principal', type: 'number', required: true }, { name: 'rate', type: 'number', required: true }, { name: 'days', type: 'number', required: true }] },
      { id: 'conversion_quote', name: 'Canonical Conversion Quote', description: 'Quote conversion routes from a trust token or ledger source to a canonical stablecoin.', params: [{ name: 'sourceToken', type: 'string', required: true }, { name: 'amount', type: 'number', required: true }, { name: 'targetAsset', type: 'string', default: 'USDC' }] },
    ];
  }

  static getFunction(id) {
    return this.listFunctions().find(f => f.id === id);
  }

  static async listJobs({ limit = 50 } = {}) {
    const jobs = loadJobs();
    return jobs.slice(0, Number(limit) || 50);
  }

  static async getJob(jobId) {
    const jobs = loadJobs();
    return jobs.find(j => j.id === jobId) || null;
  }

  static async compute({ functionId, params = {}, createdBy = 'operator' } = {}) {
    const fn = this.getFunction(functionId);
    if (!fn) throw new Error(`Unknown compute function: ${functionId}`);

    const job = {
      id: generateId(),
      functionId,
      functionName: fn.name,
      params,
      status: 'running',
      result: null,
      error: null,
      createdBy,
      createdAt: new Date().toISOString(),
      completedAt: null,
    };

    const jobs = loadJobs();
    jobs.unshift(job);
    saveJobs(jobs);

    try {
      const result = await this._runFunction(functionId, params);
      job.status = 'completed';
      job.result = result;
      job.completedAt = new Date().toISOString();
    } catch (err) {
      job.status = 'failed';
      job.error = err.message || String(err);
      job.completedAt = new Date().toISOString();
    }

    const updated = loadJobs();
    const idx = updated.findIndex(j => j.id === job.id);
    if (idx >= 0) updated[idx] = job; else updated.unshift(job);
    saveJobs(updated);
    return job;
  }

  static async _runFunction(functionId, params) {
    switch (functionId) {
      case 'dashboard_summary': {
        const summary = await TrustAccountingEngine.getDashboard();
        return { summary };
      }
      case 'balance_sheet': {
        const sheet = await TrustAccountingEngine.getBalanceSheet({ asOfDate: params.asOfDate || today() });
        return { balanceSheet: sheet };
      }
      case 'income_statement': {
        const stmt = await TrustAccountingEngine.getIncomeStatement({ fromDate: params.fromDate, toDate: params.toDate || today() });
        return { incomeStatement: stmt };
      }
      case 'cashflow_statement': {
        const stmt = await TrustAccountingEngine.getCashflowStatement({ fromDate: params.fromDate, toDate: params.toDate || today() });
        return { cashflowStatement: stmt };
      }
      case 'bond_yield': {
        const price = num(params.price);
        const par = num(params.par, 100);
        const couponRate = num(params.couponRate);
        const years = num(params.years);
        const frequency = Math.max(1, num(params.frequency, 1));
        if (price <= 0 || par <= 0 || years <= 0) throw new Error('price, par and years must be positive');
        const couponPayment = (par * (couponRate / 100)) / frequency;
        const periods = Math.round(years * frequency);
        // Approximate YTM: (annual coupon + (par - price)/years) / ((par + price)/2)
        const annualCoupon = par * (couponRate / 100);
        const approxYtm = (annualCoupon + ((par - price) / years)) / ((par + price) / 2);
        return {
          price, par, couponRate, years, frequency, periods, couponPayment,
          approximateYtm: Math.round(approxYtm * 10000) / 10000,
          approximateYtmPercent: Math.round(approxYtm * 10000) / 100,
        };
      }
      case 'interest_accrual': {
        const principal = num(params.principal);
        const rate = num(params.rate);
        const days = num(params.days);
        if (principal <= 0 || days <= 0) throw new Error('principal and days must be positive');
        const interest = principal * (rate / 100) * (days / 365);
        return { principal, rate, days, interest: Math.round(interest * 100) / 100, total: Math.round((principal + interest) * 100) / 100 };
      }
      case 'conversion_quote': {
        const sourceToken = String(params.sourceToken || '');
        const amount = num(params.amount);
        const targetAsset = String(params.targetAsset || 'USDC').toUpperCase();
        if (!sourceToken || amount <= 0) throw new Error('sourceToken and positive amount required');
        const quote = await CrossChainConversionEngine.quote({ sourceToken, amount: String(amount), targetAsset });
        return { sourceToken, amount, targetAsset, quote };
      }
      default:
        throw new Error(`Unhandled compute function: ${functionId}`);
    }
  }
}

module.exports = { TrustComputingEngine };
