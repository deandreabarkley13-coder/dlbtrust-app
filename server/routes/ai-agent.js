/**
 * AI Agent Routes
 * DEANDREA LAVAR BARKLEY TRUST
 *
 * REST API for the platform AI assistant.
 */

'use strict';

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

// --- Database & Schema Setup ------------------------------------------------

function getDb(req) {
  return req.app.locals && req.app.locals.db ? req.app.locals.db : require('better-sqlite3')(
    process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'dlbtrust.db')
  );
}

function ensureSchema(db) {
  const schemaPath = path.join(__dirname, '..', 'db', 'migrations', 'ai-agent-schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
}

let schemaInitialized = false;

function initDb(req) {
  const db = getDb(req);
  if (!schemaInitialized) {
    ensureSchema(db);
    schemaInitialized = true;
  }
  return db;
}

// --- Engine -----------------------------------------------------------------

const agentEngine = require('../engines/ai-agent-engine');

// --- Routes -----------------------------------------------------------------

// POST /api/agent/chat — main chat endpoint (send a prompt, get a response)
router.post('/chat', async (req, res) => {
  try {
    const db = initDb(req);
    const { prompt } = req.body;

    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    // Save user message
    agentEngine.saveConversation(db, 'user', prompt);

    // Parse intent
    const parsedIntent = agentEngine.parseIntent(prompt);

    // Execute task
    const result = await agentEngine.executeTask(db, parsedIntent, prompt);

    // Save agent response
    agentEngine.saveConversation(db, 'agent', result.summary, result.task_id);

    res.json({
      response: result.summary,
      intent: parsedIntent.intent,
      confidence: parsedIntent.confidence,
      task_id: result.task_id,
      status: result.status,
      data: result.data,
      execution_time_ms: result.execution_time_ms,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agent/conversation — get conversation history
router.get('/conversation', (req, res) => {
  try {
    const db = initDb(req);
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    const history = agentEngine.getConversationHistory(db, limit);
    res.json({ messages: history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agent/tasks — get task execution history
router.get('/tasks', (req, res) => {
  try {
    const db = initDb(req);
    const limit = req.query.limit ? Number(req.query.limit) : 20;
    const tasks = agentEngine.getTaskHistory(db, limit);
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/agent/capabilities — list what the agent can do
router.get('/capabilities', (req, res) => {
  const capabilities = agentEngine.INTENT_REGISTRY.map(entry => ({
    intent: entry.intent,
    description: entry.description,
    engine: entry.engine,
    example_phrases: entry.patterns.slice(0, 2).map(p => p.source.replace(/[\\^$.*+?()[\]{}|/]/g, '')),
  }));
  res.json({ capabilities });
});

// GET /api/agent/scheduled — list scheduled tasks
router.get('/scheduled', (req, res) => {
  try {
    const db = initDb(req);
    const tasks = agentEngine.listScheduledTasks(db);
    res.json({ tasks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent/scheduled — create a scheduled task
router.post('/scheduled', (req, res) => {
  try {
    const db = initDb(req);
    const { name, task_type, schedule_cron, parameters } = req.body;

    if (!name || !task_type || !schedule_cron) {
      return res.status(400).json({ error: 'name, task_type, and schedule_cron are required' });
    }

    const result = agentEngine.createScheduledTask(db, { name, task_type, schedule_cron, parameters });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/agent/scheduled/:id — toggle scheduled task
router.patch('/scheduled/:id', (req, res) => {
  try {
    const db = initDb(req);
    const { is_active } = req.body;
    agentEngine.toggleScheduledTask(db, Number(req.params.id), is_active);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
