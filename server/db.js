import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Pool } = pg;
const here = path.dirname(fileURLToPath(import.meta.url));
let activePool = null;
let activeUrl = null;

export class DatabaseSetupError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DatabaseSetupError';
    this.code = code;
  }
}

export function validateDatabaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DatabaseSetupError('INVALID_URL', 'Enter a PostgreSQL connection URL to continue.');
  }
  let parsed;
  try { parsed = new URL(value.trim()); } catch {
    throw new DatabaseSetupError('INVALID_URL', 'That does not look like a valid database URL. Check the format and try again.');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || !parsed.pathname || parsed.pathname === '/') {
    throw new DatabaseSetupError('INVALID_URL', 'Use a PostgreSQL URL such as postgresql://user:password@host:5432/database.');
  }
  return value.trim();
}

function createPool(connectionString) {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_SIZE || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 8_000,
    application_name: 'school-erp',
    keepAlive: true,
  });
  pool.on('error', () => {
    // Do not log connection configuration or database-provided details.
    console.warn('A pooled PostgreSQL connection ended unexpectedly.');
  });
  return pool;
}

export function explainDatabaseError(error, during = 'connect') {
  const code = String(error?.code || '');
  if (error instanceof DatabaseSetupError) return error.message;
  if (code === '28P01' || code === '28000') return 'The database rejected these credentials. Check the username and password.';
  if (code === '3D000') return 'That database does not exist. Create it in PostgreSQL, then try again.';
  if (code === '42501' || code === '3F000') return 'The database user does not have permission to create the ERP schema. Grant CREATE access and try again.';
  if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return 'Could not reach the PostgreSQL server. Check the host, port, firewall, and that PostgreSQL is running.';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'The database host could not be found. Check the hostname in your connection URL.';
  if (code === 'ECONNRESET' || code === '57P01') return 'The database connection was interrupted. Please try again.';
  if (code === '23505') return 'A record with those details already exists.';
  if (code === '23503') return 'This record cannot be changed because related school records depend on it.';
  if (code === '23514' || code === '22P02' || code === '22007' || code === '22008') return 'Some of the provided values are invalid. Review the form and try again.';
  if (during === 'migration') return 'The database was reached, but the ERP could not prepare its schema. Verify that the database user can create tables, indexes, functions, and triggers.';
  return 'The database request could not be completed. Please check the information and try again.';
}

export async function testConnection(connectionString) {
  const url = validateDatabaseUrl(connectionString);
  const pool = createPool(url);
  try {
    const client = await pool.connect();
    try {
      const permissions = await client.query(`
        SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema,
               has_database_privilege(current_user, current_database(), 'CONNECT') AS can_connect
      `);
      await client.query('CREATE TEMP TABLE erp_connection_check (id integer) ON COMMIT DROP');
      if (!permissions.rows[0]?.can_connect) {
        throw new DatabaseSetupError('NO_CONNECT_PERMISSION', 'The selected database user is not allowed to connect to this database.');
      }
      if (!permissions.rows[0]?.can_create_schema) {
        throw new DatabaseSetupError('NO_SCHEMA_PERMISSION', 'The database user needs CREATE permission on the public schema to install the ERP.');
      }
      return { success: true };
    } finally {
      client.release();
    }
  } catch (error) {
    throw new DatabaseSetupError(error.code || 'CONNECTION_FAILED', explainDatabaseError(error));
  } finally {
    await pool.end();
  }
}

export function configurePool(connectionString) {
  const url = validateDatabaseUrl(connectionString);
  if (activePool && activeUrl === url) return activePool;
  if (activePool) activePool.end().catch(() => {});
  activeUrl = url;
  activePool = createPool(url);
  return activePool;
}

export async function initializeFromConfiguration(connectionString) {
  if (!connectionString) return null;
  const pool = configurePool(connectionString);
  await pool.query('SELECT 1');
  return pool;
}

export function getPool() {
  if (!activePool) throw new DatabaseSetupError('NOT_CONFIGURED', 'The database has not been configured yet.');
  return activePool;
}

export function query(...args) {
  return getPool().query(...args);
}

export async function runMigrations(connectionString) {
  const pool = createPool(validateDatabaseUrl(connectionString));
  const client = await pool.connect().catch((error) => {
    pool.end().catch(() => {});
    throw new DatabaseSetupError(error.code || 'CONNECTION_FAILED', explainDatabaseError(error));
  });
  try {
    await client.query('SELECT pg_advisory_lock(820241, 1904)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((row) => row.name));
    const migrationsDir = path.join(here, 'migrations');
    const files = (await fs.readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort();
    for (const name of files) {
      if (applied.has(name)) continue;
      const sql = await fs.readFile(path.join(migrationsDir, name), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new DatabaseSetupError(error.code || 'MIGRATION_FAILED', explainDatabaseError(error, 'migration'));
      }
    }
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(820241, 1904)'); } catch {}
    client.release();
    await pool.end();
  }
  configurePool(connectionString);
}
