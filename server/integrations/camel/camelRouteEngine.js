'use strict';

/**
 * Apache Camel route engine — the family bank's integration context
 *
 * Camel's value is not the JVM it usually runs on; it is the shape of its
 * contract: a message enters a route as an *exchange*, passes through mediation
 * steps that may transform, filter, choose or fan it out, and either completes
 * or lands in a dead letter channel with its history intact. This engine
 * implements that contract in process, against Postgres, so the family bank has
 * one unified data flow rather than a dozen bespoke callbacks — and so the flow
 * survives a restart, which an in-memory bus does not.
 *
 * What the engine guarantees:
 *
 *   • Durability. An exchange is a row before any step runs. A process that dies
 *     mid-route leaves a claimable exchange, not a lost payment instruction.
 *   • Idempotent consumption. A route may declare a message key, and the same
 *     key on the same route is accepted once: replaying a bank file, a webhook
 *     or an operator's double click mediates once and reports the first result.
 *   • Bounded redelivery. A failing step is retried with exponential backoff up
 *     to the configured limit, then the exchange goes to the dead letter channel
 *     where it can be inspected and re-sent deliberately.
 *   • A readable trace. Every step an exchange took, in order, with what it
 *     decided, is stored on the exchange. This is what makes a routing decision
 *     auditable months later.
 *
 * Steps are declarative, matching the Camel EIPs the family bank actually needs:
 *
 *   { type: 'setHeader', name, value }        header enrichment
 *   { type: 'transform', processor }          message translator
 *   { type: 'process',   processor }          side effect, body unchanged
 *   { type: 'filter',    predicate }          message filter, completes the route
 *   { type: 'choice',    when: [...], otherwise }   content-based router
 *   { type: 'split',     splitter, to }       splitter, one exchange per item
 *   { type: 'to',        route }              send to another route
 *   { type: 'wireTap',   topic }              non-blocking copy to the event bus
 *
 * Processors, predicates and splitters are registered by name so that a route
 * definition stays data — printable, diffable, and renderable as Camel DSL for
 * a JVM runtime (see camelYaml.js).
 */

const crypto = require('crypto');
const pool = require('../bonds/pgPool');
const { getCamelConfig, camelReadiness } = require('./camelConfig');

let KafkaEventBus = null;
try { ({ KafkaEventBus } = require('../events/kafkaEventBus')); } catch { KafkaEventBus = null; }

const STATES = Object.freeze(['pending', 'in_progress', 'completed', 'filtered', 'failed', 'dead_letter']);
const STEP_TYPES = Object.freeze(['setHeader', 'transform', 'process', 'filter', 'choice', 'split', 'to', 'wireTap']);

const routes = new Map();
const processors = new Map();
const predicates = new Map();
const splitters = new Map();

class CamelError extends Error {
  constructor(message, code = 'CAMEL_REFUSED', status = 400) {
    super(message);
    this.name = 'CamelError';
    this.code = code;
    this.status = status;
    this.statusCode = status;
  }
}

function exchangeId() {
  return `EX-${Date.now()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function publicExchange(row) {
  if (!row) return null;
  return {
    exchangeId: row.exchange_id,
    routeId: row.route_id,
    messageKey: row.message_key,
    state: row.state,
    source: row.source,
    body: parseJson(row.body, {}),
    headers: parseJson(row.headers, {}),
    trace: parseJson(row.trace, []),
    attempts: Number(row.attempts || 0),
    nextAttemptAt: row.next_attempt_at,
    error: row.error,
    parentExchangeId: row.parent_exchange_id,
    paymentId: row.payment_id,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function validateSteps(routeId, steps) {
  steps.forEach((step, index) => {
    if (!step || !STEP_TYPES.includes(step.type)) {
      throw new CamelError(`Route ${routeId} step ${index} has unsupported type ${step && step.type}`, 'CAMEL_BAD_STEP');
    }
    if (step.type === 'choice') {
      if (!Array.isArray(step.when) || !step.when.length) {
        throw new CamelError(`Route ${routeId} step ${index} is a choice with no when clause`, 'CAMEL_BAD_STEP');
      }
      step.when.forEach(clause => validateSteps(routeId, clause.steps || []));
      if (step.otherwise) validateSteps(routeId, step.otherwise);
    }
  });
}

class CamelRouteEngine {
  static config() {
    return getCamelConfig();
  }

  static readiness() {
    return camelReadiness();
  }

  // ── Registry ───────────────────────────────────────────────────────────────

  static registerProcessor(name, fn) {
    if (typeof fn !== 'function') throw new CamelError(`Processor ${name} is not a function`, 'CAMEL_BAD_PROCESSOR');
    processors.set(name, fn);
    return name;
  }

  static registerPredicate(name, fn) {
    if (typeof fn !== 'function') throw new CamelError(`Predicate ${name} is not a function`, 'CAMEL_BAD_PREDICATE');
    predicates.set(name, fn);
    return name;
  }

  static registerSplitter(name, fn) {
    if (typeof fn !== 'function') throw new CamelError(`Splitter ${name} is not a function`, 'CAMEL_BAD_SPLITTER');
    splitters.set(name, fn);
    return name;
  }

  static register(definition) {
    const { routeId, from, steps = [] } = definition || {};
    if (!routeId) throw new CamelError('A route needs a routeId', 'CAMEL_BAD_ROUTE');
    if (!from || !from.uri) throw new CamelError(`Route ${routeId} needs a from.uri`, 'CAMEL_BAD_ROUTE');
    validateSteps(routeId, steps);
    routes.set(routeId, Object.freeze({
      routeId,
      description: definition.description || '',
      from: Object.freeze({ ...from }),
      steps,
      // A route that names a message key header consumes idempotently; one that
      // does not accepts every exchange, which is right for timers and taps.
      idempotentKeyHeader: definition.idempotentKeyHeader || null,
      deadLetter: definition.deadLetter !== false,
      maxRedeliveries: definition.maxRedeliveries === undefined ? null : definition.maxRedeliveries,
    }));
    return routes.get(routeId);
  }

  static route(routeId) {
    return routes.get(routeId) || null;
  }

  static routes() {
    return Array.from(routes.values()).map(route => ({
      routeId: route.routeId,
      description: route.description,
      from: route.from,
      idempotentKeyHeader: route.idempotentKeyHeader,
      deadLetter: route.deadLetter,
      steps: route.steps.map(step => describeStep(step)),
    }));
  }

  static reset() {
    routes.clear();
    processors.clear();
    predicates.clear();
    splitters.clear();
  }

  // ── Storage ────────────────────────────────────────────────────────────────

  static async ensureTables() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS camel_exchanges (
        exchange_id        TEXT PRIMARY KEY,
        route_id           TEXT NOT NULL,
        message_key        TEXT,
        state              TEXT NOT NULL DEFAULT 'pending'
                             CHECK (state IN ('pending','in_progress','completed','filtered','failed','dead_letter')),
        source             TEXT,
        body               JSONB NOT NULL DEFAULT '{}',
        headers            JSONB NOT NULL DEFAULT '{}',
        trace              JSONB NOT NULL DEFAULT '[]',
        attempts           INTEGER NOT NULL DEFAULT 0,
        next_attempt_at    TIMESTAMPTZ,
        error              TEXT,
        parent_exchange_id TEXT,
        payment_id         TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at         TIMESTAMPTZ,
        completed_at       TIMESTAMPTZ,
        updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_camel_idempotent ON camel_exchanges (route_id, message_key) WHERE message_key IS NOT NULL`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_camel_due ON camel_exchanges (state, next_attempt_at)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_camel_payment ON camel_exchanges (payment_id)`);
    return true;
  }

  static async get(id) {
    await this.ensureTables();
    const rows = await pool.query('SELECT * FROM camel_exchanges WHERE exchange_id = $1', [id]);
    return publicExchange(rows.rows[0]);
  }

  static async list({ routeId = null, state = null, paymentId = null, limit = 100 } = {}) {
    await this.ensureTables();
    const rows = await pool.query(
      `SELECT * FROM camel_exchanges
        WHERE ($1::text IS NULL OR route_id = $1)
          AND ($2::text IS NULL OR state = $2)
          AND ($3::text IS NULL OR payment_id = $3)
        ORDER BY created_at DESC
        LIMIT $4`,
      [routeId, state, paymentId, Math.min(Math.max(Number(limit) || 100, 1), 500)]
    );
    return rows.rows.map(publicExchange);
  }

  static async _patch(id, patch) {
    const keys = Object.keys(patch);
    if (!keys.length) return this.get(id);
    const sets = keys.map((key, index) => `${key} = $${index + 2}`);
    const rows = await pool.query(
      `UPDATE camel_exchanges SET ${sets.join(', ')}, updated_at = NOW() WHERE exchange_id = $1 RETURNING *`,
      [id, ...keys.map(key => patch[key])]
    );
    return publicExchange(rows.rows[0]);
  }

  // ── Producing ──────────────────────────────────────────────────────────────

  /**
   * Put a message on a route. The exchange is durable before anything runs, and
   * `deliver: 'now'` only decides whether this call also mediates it or leaves
   * it for the next cycle — never whether it is recorded.
   */
  static async send(routeId, body = {}, {
    headers = {},
    messageKey = null,
    source = 'internal',
    parentExchangeId = null,
    paymentId = null,
    deliver = 'now',
  } = {}) {
    await this.ensureTables();
    const route = routes.get(routeId);
    if (!route) throw new CamelError(`Unknown route ${routeId}`, 'CAMEL_UNKNOWN_ROUTE', 404);

    const key = messageKey
      || (route.idempotentKeyHeader ? (headers[route.idempotentKeyHeader] || null) : null);
    const id = exchangeId();
    const inserted = await pool.query(
      `INSERT INTO camel_exchanges (exchange_id, route_id, message_key, source, body, headers, parent_exchange_id, payment_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        id, routeId, key, source, JSON.stringify(body || {}), JSON.stringify(headers || {}),
        parentExchangeId, paymentId || headers.paymentId || (body && body.paymentId) || null,
      ]
    );
    if (!inserted.rows.length) {
      const existing = await pool.query(
        'SELECT * FROM camel_exchanges WHERE route_id = $1 AND message_key = $2',
        [routeId, key]
      );
      return {
        accepted: false,
        replay: true,
        reason: `route ${routeId} has already consumed message key ${key}`,
        exchange: publicExchange(existing.rows[0]),
      };
    }

    let exchange = publicExchange(inserted.rows[0]);
    if (deliver === 'now') {
      exchange = await this._runExchange(exchange, route);
    }
    return { accepted: true, replay: false, exchange };
  }

  // ── Consuming ──────────────────────────────────────────────────────────────

  /**
   * Mediate everything that is due. Claims are optimistic: the UPDATE that moves
   * an exchange to `in_progress` only succeeds for one worker, so two buses
   * running at once share the backlog instead of duplicating it.
   */
  static async drive({ limit = null, routeId = null } = {}) {
    await this.ensureTables();
    const config = getCamelConfig();
    const report = { startedAt: new Date().toISOString(), claimed: 0, completed: 0, filtered: 0, retried: 0, deadLettered: 0, exchanges: [] };
    const due = await pool.query(
      `SELECT * FROM camel_exchanges
        WHERE state = 'pending'
          AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
          AND ($1::text IS NULL OR route_id = $1)
        ORDER BY created_at ASC
        LIMIT $2`,
      [routeId, Math.min(Math.max(Number(limit) || config.batchSize, 1), 500)]
    );

    for (const row of due.rows) {
      const route = routes.get(row.route_id);
      if (!route) {
        await this._patch(row.exchange_id, { state: 'dead_letter', error: `route ${row.route_id} is not registered in this context` });
        report.deadLettered += 1;
        continue;
      }
      const claimed = await pool.query(
        `UPDATE camel_exchanges SET state = 'in_progress', started_at = NOW(), updated_at = NOW()
          WHERE exchange_id = $1 AND state = 'pending' RETURNING *`,
        [row.exchange_id]
      );
      if (!claimed.rows.length) continue;
      report.claimed += 1;
      const result = await this._runExchange(publicExchange(claimed.rows[0]), route, { claimed: true });
      if (result.state === 'completed') report.completed += 1;
      else if (result.state === 'filtered') report.filtered += 1;
      else if (result.state === 'dead_letter') report.deadLettered += 1;
      else report.retried += 1;
      report.exchanges.push({ exchangeId: result.exchangeId, routeId: result.routeId, state: result.state, error: result.error });
    }
    report.finishedAt = new Date().toISOString();
    return report;
  }

  static async _runExchange(exchange, route, { claimed = false } = {}) {
    const config = getCamelConfig();
    if (!claimed) {
      const claim = await pool.query(
        `UPDATE camel_exchanges SET state = 'in_progress', started_at = NOW(), updated_at = NOW()
          WHERE exchange_id = $1 AND state = 'pending' RETURNING *`,
        [exchange.exchangeId]
      );
      if (!claim.rows.length) return this.get(exchange.exchangeId);
    }

    const context = {
      exchangeId: exchange.exchangeId,
      routeId: route.routeId,
      body: exchange.body,
      headers: { ...exchange.headers },
      properties: {},
      trace: Array.isArray(exchange.trace) ? exchange.trace.slice() : [],
    };
    const attempts = exchange.attempts + 1;

    try {
      const outcome = await this._runSteps(route.steps, context, route);
      const state = outcome.filtered ? 'filtered' : 'completed';
      return await this._patch(exchange.exchangeId, {
        state,
        attempts,
        body: JSON.stringify(context.body === undefined ? null : context.body),
        headers: JSON.stringify(context.headers),
        trace: JSON.stringify(context.trace),
        payment_id: context.headers.paymentId || exchange.paymentId || null,
        error: null,
        next_attempt_at: null,
        completed_at: new Date(),
      });
    } catch (err) {
      const limit = route.maxRedeliveries === null ? config.maxRedeliveries : route.maxRedeliveries;
      const exhausted = attempts > limit;
      context.trace.push({ step: 'onException', at: new Date().toISOString(), error: err.message, code: err.code || null, attempt: attempts });
      const delaySeconds = Math.min(
        config.redeliveryDelaySeconds * Math.pow(config.backoffMultiplier, Math.max(attempts - 1, 0)),
        config.maxRedeliveryDelaySeconds
      );
      const patched = await this._patch(exchange.exchangeId, {
        state: exhausted ? (route.deadLetter ? 'dead_letter' : 'failed') : 'pending',
        attempts,
        headers: JSON.stringify(context.headers),
        trace: JSON.stringify(context.trace),
        payment_id: context.headers.paymentId || exchange.paymentId || null,
        error: err.message,
        next_attempt_at: exhausted ? null : new Date(Date.now() + delaySeconds * 1000),
        completed_at: exhausted ? new Date() : null,
      });
      if (exhausted) {
        await this._publish('trust.payment.failed', {
          exchangeId: exchange.exchangeId,
          routeId: route.routeId,
          paymentId: patched.paymentId,
          error: err.message,
        });
      }
      return patched;
    }
  }

  static async _runSteps(steps, context, route) {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index];
      const outcome = await this._runStep(step, context, route, index);
      if (outcome && outcome.filtered) return outcome;
    }
    return { filtered: false };
  }

  static async _runStep(step, context, route, index) {
    const startedAt = new Date().toISOString();
    switch (step.type) {
      case 'setHeader': {
        const value = typeof step.value === 'function' ? await step.value(context) : step.value;
        context.headers[step.name] = value;
        context.trace.push({ step: `setHeader(${step.name})`, at: startedAt });
        return null;
      }
      case 'transform': {
        const fn = this._processor(step.processor, route, index);
        const body = await fn(context);
        context.body = body === undefined ? context.body : body;
        context.trace.push({ step: `transform(${step.processor})`, at: startedAt });
        return null;
      }
      case 'process': {
        const fn = this._processor(step.processor, route, index);
        const result = await fn(context);
        if (result !== undefined && step.updatesBody) context.body = result;
        context.trace.push({ step: `process(${step.processor})`, at: startedAt, note: step.note || null });
        return null;
      }
      case 'filter': {
        const fn = predicates.get(step.predicate);
        if (!fn) throw new CamelError(`Route ${route.routeId} step ${index} names unknown predicate ${step.predicate}`, 'CAMEL_UNKNOWN_PREDICATE');
        const passed = Boolean(await fn(context));
        context.trace.push({ step: `filter(${step.predicate})`, at: startedAt, note: passed ? 'passed' : 'stopped here' });
        return passed ? null : { filtered: true, reason: step.predicate };
      }
      case 'choice': {
        for (const clause of step.when) {
          const fn = predicates.get(clause.predicate);
          if (!fn) throw new CamelError(`Route ${route.routeId} step ${index} names unknown predicate ${clause.predicate}`, 'CAMEL_UNKNOWN_PREDICATE');
          if (await fn(context)) {
            context.trace.push({ step: `choice(when ${clause.predicate})`, at: startedAt });
            return this._runSteps(clause.steps || [], context, route);
          }
        }
        if (step.otherwise) {
          context.trace.push({ step: 'choice(otherwise)', at: startedAt });
          return this._runSteps(step.otherwise, context, route);
        }
        context.trace.push({ step: 'choice(no match)', at: startedAt });
        return { filtered: true, reason: 'no choice clause matched' };
      }
      case 'split': {
        const fn = splitters.get(step.splitter);
        if (!fn) throw new CamelError(`Route ${route.routeId} step ${index} names unknown splitter ${step.splitter}`, 'CAMEL_UNKNOWN_SPLITTER');
        const items = (await fn(context)) || [];
        for (const item of items) {
          await this.send(step.to, item.body === undefined ? item : item.body, {
            headers: { ...context.headers, ...(item.headers || {}) },
            messageKey: item.messageKey || null,
            source: `route:${route.routeId}`,
            parentExchangeId: context.exchangeId,
            // A split child is mediated by the next cycle: fanning out inline
            // would let one large batch hold the bus for an unbounded time.
            deliver: 'later',
          });
        }
        context.trace.push({ step: `split(${step.splitter})`, at: startedAt, note: `${items.length} to ${step.to}` });
        return null;
      }
      case 'to': {
        const result = await this.send(step.route, context.body, {
          headers: { ...context.headers },
          messageKey: step.messageKeyHeader ? context.headers[step.messageKeyHeader] || null : null,
          source: `route:${route.routeId}`,
          parentExchangeId: context.exchangeId,
          deliver: step.deliver || 'now',
        });
        context.trace.push({
          step: `to(${step.route})`,
          at: startedAt,
          note: result.replay ? 'already consumed' : (result.exchange ? result.exchange.state : 'queued'),
        });
        // A downstream route that dead-lettered is a failure of this flow too:
        // reporting the parent as completed would hide a stalled payment.
        if (result.exchange && ['dead_letter', 'failed'].includes(result.exchange.state) && step.propagateFailure !== false) {
          throw new CamelError(`Route ${step.route} could not mediate exchange ${result.exchange.exchangeId}: ${result.exchange.error}`, 'CAMEL_DOWNSTREAM_FAILED');
        }
        return null;
      }
      case 'wireTap': {
        await this._publish(step.topic, {
          exchangeId: context.exchangeId,
          routeId: route.routeId,
          headers: context.headers,
          body: context.body,
        });
        context.trace.push({ step: `wireTap(${step.topic})`, at: startedAt });
        return null;
      }
      default:
        throw new CamelError(`Route ${route.routeId} step ${index} has unsupported type ${step.type}`, 'CAMEL_BAD_STEP');
    }
  }

  static _processor(name, route, index) {
    const fn = processors.get(name);
    if (!fn) throw new CamelError(`Route ${route.routeId} step ${index} names unknown processor ${name}`, 'CAMEL_UNKNOWN_PROCESSOR');
    return fn;
  }

  /** A tap must never fail the flow it copies. */
  static async _publish(topic, payload) {
    const config = getCamelConfig();
    if (!config.publishEvents || !KafkaEventBus || !topic) return false;
    try {
      await KafkaEventBus.publish(topic, payload, { key: payload.paymentId || payload.exchangeId || null });
      return true;
    } catch (err) {
      console.warn('[camel] wire tap could not publish:', err.message);
      return false;
    }
  }

  // ── Dead letter channel ────────────────────────────────────────────────────

  static async deadLetters({ limit = 50 } = {}) {
    return this.list({ state: 'dead_letter', limit });
  }

  /**
   * Re-send a dead letter. The exchange keeps its identity and its trace — the
   * point of the channel is that the whole history is still there — but its
   * attempt count resets, because an operator re-sending it has usually fixed
   * whatever broke.
   */
  static async retryDeadLetter(id, { actor = 'operator' } = {}) {
    await this.ensureTables();
    const exchange = await this.get(id);
    if (!exchange) throw new CamelError(`Unknown exchange ${id}`, 'CAMEL_UNKNOWN_EXCHANGE', 404);
    if (!['dead_letter', 'failed'].includes(exchange.state)) {
      throw new CamelError(`Exchange ${id} is ${exchange.state}; only a dead letter is re-sent`, 'CAMEL_NOT_DEAD_LETTER');
    }
    const route = routes.get(exchange.routeId);
    if (!route) throw new CamelError(`Route ${exchange.routeId} is not registered in this context`, 'CAMEL_UNKNOWN_ROUTE', 409);
    const trace = exchange.trace.concat([{ step: 'deadLetterRetry', at: new Date().toISOString(), note: `re-sent by ${actor}` }]);
    await this._patch(id, { state: 'pending', attempts: 0, error: null, next_attempt_at: null, completed_at: null, trace: JSON.stringify(trace) });
    return this._runExchange(await this.get(id), route);
  }

  // ── Scheduler ──────────────────────────────────────────────────────────────

  static start() {
    const config = getCamelConfig();
    if (this._timer) return { started: false, reason: 'already running' };
    if (!config.enabled) return { started: false, reason: 'CAMEL_BUS_ENABLED is off' };

    const tick = async () => {
      if (this._running) return;
      this._running = true;
      try {
        this._lastReport = await this.drive({});
      } catch (err) {
        console.warn('[camel] cycle failed:', err.message);
      } finally {
        this._running = false;
      }
    };
    this._timer = setInterval(tick, config.intervalSeconds * 1000);
    if (this._timer.unref) this._timer.unref();
    setTimeout(tick, 15000).unref?.();
    return { started: true, intervalSeconds: config.intervalSeconds };
  }

  static stop() {
    if (!this._timer) return { stopped: false };
    clearInterval(this._timer);
    this._timer = null;
    return { stopped: true };
  }

  static async status() {
    await this.ensureTables();
    const [states, byRoute, recent] = await Promise.all([
      pool.query('SELECT state, COUNT(*)::int AS count FROM camel_exchanges GROUP BY state'),
      pool.query(`SELECT route_id, state, COUNT(*)::int AS count FROM camel_exchanges GROUP BY route_id, state`),
      pool.query('SELECT * FROM camel_exchanges ORDER BY created_at DESC LIMIT 20'),
    ]);
    return {
      readiness: camelReadiness(),
      running: Boolean(this._timer),
      config: (() => {
        const config = getCamelConfig();
        return {
          enabled: config.enabled,
          contextName: config.contextName,
          intervalSeconds: config.intervalSeconds,
          batchSize: config.batchSize,
          maxRedeliveries: config.maxRedeliveries,
          redeliveryDelaySeconds: config.redeliveryDelaySeconds,
          bridgeConfigured: Boolean(config.bridgeUrl),
        };
      })(),
      routes: this.routes().map(route => ({ routeId: route.routeId, description: route.description, from: route.from.uri })),
      byState: states.rows.map(row => ({ state: row.state, count: Number(row.count) })),
      byRoute: byRoute.rows.map(row => ({ routeId: row.route_id, state: row.state, count: Number(row.count) })),
      recent: recent.rows.map(publicExchange),
      lastReport: this._lastReport || null,
    };
  }

  /** Prune terminal exchanges. Dead letters are never pruned. */
  static async prune({ days = null } = {}) {
    await this.ensureTables();
    const config = getCamelConfig();
    const retention = Math.max(Number(days) || config.completedRetentionDays, 1);
    const rows = await pool.query(
      `DELETE FROM camel_exchanges
        WHERE state IN ('completed','filtered')
          AND completed_at < NOW() - ($1 || ' days')::interval
        RETURNING exchange_id`,
      [String(retention)]
    );
    return { pruned: rows.rows.length, retentionDays: retention };
  }
}

function describeStep(step) {
  switch (step.type) {
    case 'setHeader': return { type: step.type, name: step.name };
    case 'transform':
    case 'process': return { type: step.type, processor: step.processor, note: step.note || null };
    case 'filter': return { type: step.type, predicate: step.predicate };
    case 'choice': return {
      type: step.type,
      when: step.when.map(clause => ({ predicate: clause.predicate, steps: (clause.steps || []).map(describeStep) })),
      otherwise: step.otherwise ? step.otherwise.map(describeStep) : null,
    };
    case 'split': return { type: step.type, splitter: step.splitter, to: step.to };
    case 'to': return { type: step.type, route: step.route };
    case 'wireTap': return { type: step.type, topic: step.topic };
    default: return { type: step.type };
  }
}

module.exports = { CamelRouteEngine, CamelError, STATES, STEP_TYPES, describeStep };
