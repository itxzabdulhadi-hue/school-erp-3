import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { getDatabaseUrl, getInstallConfig, getStorageDir } from './config.js';
import { initializeFromConfiguration, getPool, explainDatabaseError } from './db.js';
import { authRoutes, authenticate } from './auth.js';
import { apiErrorHandler, notFoundHandler } from './http.js';
import setupRoutes from './routes/setup.js';
import peopleRoutes from './routes/people.js';
import coreRoutes from './routes/core.js';
import academicRoutes from './routes/academics.js';
import financeRoutes from './routes/finance.js';
import communityRoutes from './routes/community.js';
import resourceRoutes from './routes/resources.js';
import { uploadRoutes, brandingUploadsDir } from './routes/uploads.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 3001);

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
      fontSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '1mb', strict: true }));
app.use(parseCookies);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Wait a few minutes and try again.' },
});
const setupLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many setup attempts. Please wait a few minutes and try again.' },
});

app.get('/healthz', async (_req, res) => {
  try {
    await getPool().query('SELECT 1');
    res.json({ ok: true, database: 'connected' });
  } catch {
    res.status(503).json({ ok: false, database: 'unavailable' });
  }
});

app.use('/uploads/branding', express.static(brandingUploadsDir, {
  fallthrough: false,
  immutable: true,
  maxAge: '1y',
  setHeaders(res) { res.setHeader('X-Content-Type-Options', 'nosniff'); },
}));

const authRouter = express.Router();
authRouter.post('/auth/login', loginLimiter);
authRoutes(authRouter);
app.use('/api', authRouter);

const installRouter = express.Router();
installRouter.use('/setup', setupLimiter);
installRouter.use(setupRoutes);
app.use('/api', installRouter);

const protectedRoutes = express.Router();
protectedRoutes.use(authenticate);
protectedRoutes.use(peopleRoutes);
protectedRoutes.use(coreRoutes);
protectedRoutes.use(academicRoutes);
protectedRoutes.use(financeRoutes);
protectedRoutes.use(communityRoutes);
protectedRoutes.use(resourceRoutes);
protectedRoutes.use(uploadRoutes);
app.use('/api', protectedRoutes);

app.use('/api', notFoundHandler);
app.use('/api', apiErrorHandler);

const distDir = path.resolve(here, '../dist');
try {
  await fs.access(distDir);
  app.use(express.static(distDir, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));
  app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
} catch {
  app.get('/', (_req, res) => res.status(200).type('text').send('School ERP API is running. Start the Vite development server to open the application.'));
  app.get('*', (_req, res) => res.status(404).json({ error: 'Page not found.' }));
}

function parseCookies(req, _res, next) {
  const parsed = {};
  const raw = req.headers.cookie;
  if (raw) {
    for (const item of raw.split(';')) {
      const separator = item.indexOf('=');
      if (separator < 0) continue;
      const key = item.slice(0, separator).trim();
      const value = item.slice(separator + 1).trim();
      try { parsed[key] = decodeURIComponent(value); } catch { parsed[key] = ''; }
    }
  }
  req.cookies = parsed;
  next();
}

await getInstallConfig();
const databaseUrl = await getDatabaseUrl();
if (databaseUrl) {
  try {
    await initializeFromConfiguration(databaseUrl);
    console.info('School ERP database health check passed.');
  } catch (error) {
    console.warn(`School ERP database is not reachable: ${explainDatabaseError(error)}`);
  }
}
await fs.mkdir(brandingUploadsDir, { recursive: true, mode: 0o700 });
await fs.mkdir(path.join(getStorageDir(), 'private'), { recursive: true, mode: 0o700 });

app.listen(port, '0.0.0.0', () => {
  console.info(`School ERP API listening on port ${port}.`);
});
