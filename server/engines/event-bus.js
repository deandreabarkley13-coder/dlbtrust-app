/**
 * Event Bus — Lightweight Pub/Sub for Inter-Engine Communication
 * DEANDREA LAVAR BARKLEY TRUST — Cash Management System
 *
 * Enables engines to emit events (bond paid, transfer completed, USDC sent)
 * that the CMS and other engines can subscribe to.
 */

'use strict';

class EventBus {
  constructor() {
    this.listeners = new Map();
    this.history = [];       // last N events for debugging
    this.maxHistory = 500;
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const cbs = this.listeners.get(event);
    if (cbs) {
      const idx = cbs.indexOf(callback);
      if (idx !== -1) cbs.splice(idx, 1);
    }
  }

  emit(event, data = {}) {
    const entry = {
      event,
      data,
      timestamp: new Date().toISOString(),
    };

    this.history.push(entry);
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    const cbs = this.listeners.get(event) || [];
    const wildcards = this.listeners.get('*') || [];

    for (const cb of [...cbs, ...wildcards]) {
      try {
        cb(entry);
      } catch (err) {
        console.error(`[EventBus] Error in handler for "${event}":`, err.message);
      }
    }
  }

  getHistory(filter = {}) {
    let results = [...this.history];
    if (filter.event) {
      results = results.filter(e => e.event === filter.event);
    }
    if (filter.since) {
      results = results.filter(e => e.timestamp >= filter.since);
    }
    if (filter.limit) {
      results = results.slice(-filter.limit);
    }
    return results;
  }

  clear() {
    this.listeners.clear();
    this.history = [];
  }
}

// Singleton — shared across all engines
const bus = new EventBus();

// Well-known event names
const EVENTS = {
  // Banking
  ACCOUNT_CREATED:     'banking.account.created',
  ACCOUNT_UPDATED:     'banking.account.updated',
  ACCOUNT_FROZEN:      'banking.account.frozen',
  TRANSFER_CREATED:    'banking.transfer.created',
  TRANSFER_COMPLETED:  'banking.transfer.completed',
  TRANSFER_FAILED:     'banking.transfer.failed',
  INTEREST_ACCRUED:    'banking.interest.accrued',

  // Fixed Income
  BOND_PURCHASED:      'fixed_income.bond.purchased',
  COUPON_RECEIVED:     'fixed_income.coupon.received',
  BOND_MATURED:        'fixed_income.bond.matured',
  BOND_CALLED:         'fixed_income.bond.called',

  // Blockchain / Crypto Rails
  WALLET_CREATED:      'blockchain.wallet.created',
  USDC_SENT:           'blockchain.usdc.sent',
  USDC_RECEIVED:       'blockchain.usdc.received',
  SWAP_COMPLETED:      'blockchain.swap.completed',
  BALANCE_SYNCED:      'blockchain.balance.synced',

  // Trust Accounting
  JOURNAL_POSTED:      'accounting.journal.posted',
  PERIOD_CLOSED:       'accounting.period.closed',

  // Cash Management
  POSITION_UPDATED:    'cms.position.updated',
  FORECAST_GENERATED:  'cms.forecast.generated',
  RECON_COMPLETED:     'cms.reconciliation.completed',
  ALERT_CREATED:       'cms.alert.created',
  RULE_TRIGGERED:      'cms.rule.triggered',

  // Document Management
  DOCUMENT_UPLOADED:   'dms.document.uploaded',
  DOCUMENT_VERSIONED:  'dms.document.versioned',
  DOCUMENT_APPROVED:   'dms.document.approved',
  DOCUMENT_ARCHIVED:   'dms.document.archived',

  // AI Agent
  AGENT_TASK_COMPLETED: 'agent.task.completed',
  AGENT_TASK_FAILED:    'agent.task.failed',
  AGENT_SCHEDULED_RUN:  'agent.scheduled.run',
};

module.exports = { bus, EVENTS, EventBus };
