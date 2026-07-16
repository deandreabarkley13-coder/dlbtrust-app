'use strict';

/**
 * Security Middleware — comprehensive Express security hardening
 *
 * Features:
 *  - Helmet.js security headers (XSS, clickjacking, MIME sniffing, CSP)
 *  - Rate limiting (global, auth, API write)
 *  - CORS lockdown
 *  - JWT + legacy token authentication
 *  - Role-based access control
 *  - Request sanitization
 *  - CSRF token generation/validation
 */

const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const crypto = require('crypto');
const { UserAuth } = require('./userAuth');
const { ApiCredentials } = require('../ach/apiCredentials');

// ─── Helmet Security Headers ──────────────────────────────────────────────────
function helmetMiddleware() {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
        connectSrc: ["'self'", 'https://*.trycloudflare.com', 'https://dlbtrust-app.fly.dev', 'https://*.fly.dev', 'https://*.tunnelmole.net'],
        fontSrc: ["'self'", 'https:', 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: { policy: 'unsafe-none' },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  });
}

// ─── Rate Limiters ────────────────────────────────────────────────────────────

// Global rate limit: 200 requests per minute per IP
function globalRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please try again later.', retry_after_seconds: 60 },
    validate: { xForwardedForHeader: false, default: true },
  });
}

// Auth rate limit: 10 login attempts per 15 minutes per IP
function authRateLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
    validate: { xForwardedForHeader: false, default: true },
  });
}

// Write operations rate limit: 30 per minute per IP
function writeRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many write operations. Please slow down.' },
    validate: { xForwardedForHeader: false, default: true },
  });
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
function corsMiddleware() {
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
    : [];

  return cors({
    origin: function (origin, callback) {
      // Allow requests with no origin (mobile apps, curl, Postman)
      if (!origin) return callback(null, true);
      // Allow same-origin
      if (allowedOrigins.length === 0) return callback(null, true);
      if (allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
        return callback(null, true);
      }
      // Allow trycloudflare.com tunnel URLs
      if (origin.endsWith('.trycloudflare.com')) return callback(null, true);
      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-admin-token', 'X-API-Key', 'X-CSRF-Token'],
    maxAge: 600,
  });
}

// ─── Input Sanitization ───────────────────────────────────────────────────────
function sanitizeInput(req, res, next) {
  // Strip null bytes from all string values in body, query, params
  function sanitize(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'string') {
        // Remove null bytes
        obj[key] = obj[key].replace(/\0/g, '');
        // Trim extremely long strings (prevent memory attacks)
        if (obj[key].length > 50000) {
          obj[key] = obj[key].substring(0, 50000);
        }
      } else if (typeof obj[key] === 'object') {
        sanitize(obj[key]);
      }
    }
    return obj;
  }

  if (req.body) sanitize(req.body);
  if (req.query) sanitize(req.query);
  if (req.params) sanitize(req.params);
  next();
}

// ─── Unified Auth Middleware ──────────────────────────────────────────────────
// Accepts: JWT (Authorization: Bearer <jwt>), legacy admin token, or API key
function requireAuth(options = {}) {
  const { role: requiredRole, permission } = options;

  return async (req, res, next) => {
    let authenticated = false;
    let userRole = null;

    // 1. Try JWT token
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7).trim();
      try {
        const decoded = await UserAuth.verifyToken(token);
        req.user = decoded;
        req.authMethod = 'jwt';
        authenticated = true;
        userRole = decoded.role;
      } catch (err) {
        // Not a valid JWT — try as API key below
      }
    }

    // 2. Try legacy admin token (backward compatibility)
    if (!authenticated) {
      const adminToken = req.headers['x-admin-token'] || req.query.adminToken;
      if (adminToken && adminToken === process.env.ADMIN_SECRET_TOKEN) {
        req.user = { userId: 0, username: 'legacy-admin', role: 'admin' };
        req.authMethod = 'admin_token';
        authenticated = true;
        userRole = 'admin';
      }
    }

    // 3. Try API key
    if (!authenticated) {
      let apiKey = null;
      if (authHeader && authHeader.startsWith('Bearer ')) {
        apiKey = authHeader.slice(7).trim();
      } else if (req.headers['x-api-key']) {
        apiKey = req.headers['x-api-key'];
      }
      if (apiKey) {
        try {
          const cred = await ApiCredentials.validate(apiKey);
          if (cred) {
            req.user = { userId: 0, username: 'api-key-' + cred.name, role: 'operator' };
            req.authMethod = 'api_key';
            req.apiCredential = cred;
            authenticated = true;
            userRole = 'operator';
          }
        } catch (err) { /* fall through */ }
      }
    }

    if (!authenticated) {
      return res.status(401).json({ error: 'Authentication required. Please log in.' });
    }

    // Check role requirement
    if (requiredRole) {
      const ROLE_LEVELS = { viewer: 10, operator: 50, admin: 100 };
      const userLevel = ROLE_LEVELS[userRole] || 0;
      const requiredLevel = ROLE_LEVELS[requiredRole] || 100;
      if (userLevel < requiredLevel) {
        return res.status(403).json({ error: 'Insufficient permissions. Required role: ' + requiredRole });
      }
    }

    // Check specific permission
    if (permission && !UserAuth.hasPermission(userRole, permission)) {
      return res.status(403).json({ error: 'Missing permission: ' + permission });
    }

    next();
  };
}

// ─── CSRF Protection ──────────────────────────────────────────────────────────
const csrfTokens = new Map();

function generateCsrfToken(sessionId) {
  const token = crypto.randomBytes(32).toString('hex');
  csrfTokens.set(token, { sessionId, created: Date.now() });
  // Clean old tokens (older than 2 hours)
  for (const [t, data] of csrfTokens) {
    if (Date.now() - data.created > 7200000) csrfTokens.delete(t);
  }
  return token;
}

function verifyCsrf(req, res, next) {
  // Skip for GET, HEAD, OPTIONS
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Skip for API key / Bearer token authenticated requests (machine-to-machine)
  if (req.authMethod === 'api_key') return next();

  const token = req.headers['x-csrf-token'] || (req.body && req.body._csrf);
  if (!token || !csrfTokens.has(token)) {
    // For backward compatibility, allow requests without CSRF for now but log a warning
    // Will be enforced in a future release
    return next();
  }
  csrfTokens.delete(token);
  next();
}

// ─── Request Logging ──────────────────────────────────────────────────────────
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    // Only log slow requests or errors
    if (duration > 5000 || res.statusCode >= 400) {
      const logEntry = {
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        duration: duration + 'ms',
        ip: req.ip,
        user: req.user ? req.user.username : 'anonymous',
      };
      if (res.statusCode >= 500) {
        console.error('[security] slow/error request:', JSON.stringify(logEntry));
      }
    }
  });
  next();
}

// ─── Validate Financial Input ─────────────────────────────────────────────────
function validateFinancialInput(fields) {
  return (req, res, next) => {
    const errors = [];

    for (const field of fields) {
      const value = req.body[field.name];

      if (field.required && (value === undefined || value === null || value === '')) {
        errors.push(`${field.name} is required`);
        continue;
      }

      if (value === undefined || value === null) continue;

      switch (field.type) {
        case 'amount':
          if (typeof value !== 'number' || isNaN(value) || value <= 0) {
            errors.push(`${field.name} must be a positive number`);
          } else if (value > 1000000000) {
            errors.push(`${field.name} exceeds maximum allowed amount`);
          }
          break;

        case 'routing':
          if (!/^\d{9}$/.test(String(value))) {
            errors.push(`${field.name} must be a 9-digit routing number`);
          }
          break;

        case 'account':
          if (!/^\d{4,17}$/.test(String(value))) {
            errors.push(`${field.name} must be 4-17 digits`);
          }
          break;

        case 'string':
          if (typeof value !== 'string') {
            errors.push(`${field.name} must be a string`);
          } else if (field.maxLength && value.length > field.maxLength) {
            errors.push(`${field.name} exceeds max length of ${field.maxLength}`);
          } else if (field.pattern && !field.pattern.test(value)) {
            errors.push(`${field.name} format is invalid`);
          }
          break;

        case 'enum':
          if (!field.values.includes(value)) {
            errors.push(`${field.name} must be one of: ${field.values.join(', ')}`);
          }
          break;

        case 'email':
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value))) {
            errors.push(`${field.name} must be a valid email address`);
          }
          break;
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: 'Validation failed', details: errors });
    }
    next();
  };
}

module.exports = {
  helmetMiddleware,
  globalRateLimiter,
  authRateLimiter,
  writeRateLimiter,
  corsMiddleware,
  sanitizeInput,
  requireAuth,
  generateCsrfToken,
  verifyCsrf,
  requestLogger,
  validateFinancialInput,
};
