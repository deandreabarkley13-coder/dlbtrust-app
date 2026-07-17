import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import fs from 'fs';
import { getDb, closeDb } from './db/index.js';
import authRoutes from './routes/auth.js';
import trustRoutes from './routes/trusts.js';
import beneficiaryRoutes from './routes/beneficiaries.js';
import disbursementRoutes from './routes/disbursements.js';
import auditRoutes from './routes/audit.js';

const PORT = parseInt(process.env.PORT || '3001', 10);
const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

// Initialize database on startup
getDb();

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/trusts', trustRoutes);
app.use('/api/beneficiaries', beneficiaryRoutes);
app.use('/api/disbursements', disbursementRoutes);
app.use('/api/audit', auditRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve static client files in production
const clientDir = path.resolve('dist/client');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

const server = app.listen(PORT, () => {
  console.log(`DLB Trust server running on http://localhost:${PORT}`);
});

process.on('SIGINT', () => {
  closeDb();
  server.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  closeDb();
  server.close();
  process.exit(0);
});

export default app;
