/**
 * PM2 Ecosystem Configuration — DLB Trust Treasury Management System
 *
 * Provides:
 * - Auto-restart on crash (max 10 restarts in 60s window, then stops to prevent loop)
 * - Memory limit auto-restart (if process exceeds 512MB, restart before OOM)
 * - Log rotation
 * - Graceful shutdown (SIGINT → save state → exit)
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 restart dlbtrust-api
 *   pm2 logs dlbtrust-api
 *   pm2 monit
 */

module.exports = {
  apps: [
    {
      name: 'dlbtrust-api',
      script: 'server/server-3002.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '512M',
      kill_timeout: 10000,         // 10s for graceful shutdown
      listen_timeout: 8000,
      restart_delay: 2000,         // 2s between restart attempts
      max_restarts: 10,            // max 10 restarts
      min_uptime: 5000,            // must run 5s to count as "started"
      autorestart: true,
      env: {
        NODE_ENV: 'production',
        PORT: 3002,
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
    {
      name: 'dlbtrust-watchdog',
      script: 'server/integrations/backup/watchdog.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      max_memory_restart: '128M',
      restart_delay: 5000,
      max_restarts: 5,
      autorestart: true,
      env: {
        WATCHDOG_INTERVAL: 30000,
        WATCHDOG_FAILURES_THRESHOLD: 3,
        API_PORT: 3002,
      },
      error_file: './logs/watchdog-error.log',
      out_file: './logs/watchdog-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
