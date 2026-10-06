import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { getDatabaseUrl, saveDatabaseUrl } from '../config.js';
import { configurePool, explainDatabaseError, getPool, runMigrations, testConnection, validateDatabaseUrl } from '../db.js';
import { issueSession, strongPasswordSchema } from '../auth.js';
import { seedRolesAndPermissions } from '../access.js';
import { asyncRoute, optionalText, slugify } from '../http.js';

const router = Router();
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const optionalUrl = z.preprocess((value) => value === '' ? undefined : value, z.string().url().max(500).optional());

const databaseSchema = z.object({ databaseUrl: z.string().trim().optional() });
const schoolSchema = z.object({
  name: z.string().trim().min(2).max(160),
  motto: optionalText(240),
  logoUrl: optionalUrl,
  faviconUrl: optionalUrl,
  address: optionalText(300),
  city: optionalText(100),
  country: optionalText(100),
  phone: optionalText(40),
  email: z.preprocess((value) => value === '' ? undefined : value, z.string().email().max(254).optional()),
  website: optionalUrl,
  principalName: optionalText(160),
  registrationInfo: optionalText(200),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  timezone: z.string().trim().min(1).max(100),
  primaryColor: colorSchema,
  secondaryColor: colorSchema,
  accentColor: colorSchema,
  academicYear: z.string().trim().min(3).max(40),
  academicStart: z.string().date(),
  academicEnd: z.string().date(),
  currentTerm: z.string().trim().min(2).max(40),
  termStart: z.string().date(),
  termEnd: z.string().date(),
}).refine((value) => value.academicEnd > value.academicStart, {
  path: ['academicEnd'], message: 'The academic year end date must be after the start date.',
}).refine((value) => value.termEnd >= value.termStart, {
  path: ['termEnd'], message: 'The term end date must be on or after its start date.',
});

const adminSchema = z.object({
  fullName: z.string().trim().min(2).max(160),
  email: z.string().trim().email().max(254),
  password: strongPasswordSchema,
  confirmPassword: z.string().min(1),
}).refine((value) => value.password === value.confirmPassword, {
  path: ['confirmPassword'], message: 'Passwords do not match.',
});

async function installerSnapshot() {
  const configuredUrl = await getDatabaseUrl();
  if (!configuredUrl) {
    return {
      initialized: false,
      step: 'database',
      database: { configured: false, connected: false },
      school: null,
    };
  }
  try {
    configurePool(configuredUrl);
    const pool = getPool();
    await pool.query('SELECT 1');
    const migrationTable = await pool.query("SELECT to_regclass('public.schema_migrations') AS table_name");
    if (!migrationTable.rows[0]?.table_name) {
      return { initialized: false, step: 'database', database: { configured: true, connected: true }, school: null };
    }
    const stateTable = await pool.query("SELECT to_regclass('public.installation_state') AS table_name");
    if (!stateTable.rows[0]?.table_name) {
      return { initialized: false, step: 'database', database: { configured: true, connected: true }, school: null };
    }
    const result = await pool.query(
      `SELECT i.state, i.school_id, s.name, s.logo_url, s.favicon_url, s.primary_color,
              s.secondary_color, s.accent_color, s.currency, s.timezone, s.motto
       FROM installation_state i LEFT JOIN schools s ON s.id = i.school_id
       WHERE i.singleton = true`,
    );
    const install = result.rows[0];
    if (!install || install.state === 'database_ready') {
      return { initialized: false, step: 'school', database: { configured: true, connected: true }, school: null };
    }
    if (install.state === 'school_ready') {
      return { initialized: false, step: 'administrator', database: { configured: true, connected: true }, school: publicSchool(install) };
    }
    return { initialized: true, step: 'login', database: { configured: true, connected: true }, school: publicSchool(install) };
  } catch (error) {
    return {
      initialized: false,
      step: 'database',
      database: {
        configured: true,
        connected: false,
        error: explainDatabaseError(error),
      },
      school: null,
    };
  }
}

function publicSchool(row) {
  if (!row?.school_id) return null;
  return {
    id: row.school_id,
    name: row.name,
    logoUrl: row.logo_url,
    faviconUrl: row.favicon_url,
    motto: row.motto,
    primaryColor: row.primary_color,
    secondaryColor: row.secondary_color,
    accentColor: row.accent_color,
    currency: row.currency,
    timezone: row.timezone,
  };
}

router.get('/setup/status', asyncRoute(async (_req, res) => {
  res.json(await installerSnapshot());
}));

router.get('/public/config', asyncRoute(async (_req, res) => {
  const snapshot = await installerSnapshot();
  res.json({ school: snapshot.initialized ? snapshot.school : null });
}));

router.post('/setup/test-connection', asyncRoute(async (req, res) => {
  const parsed = databaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a PostgreSQL connection URL to continue.' });
  try {
    const savedUrl = process.env.DATABASE_URL || parsed.data.databaseUrl || await getDatabaseUrl();
    validateDatabaseUrl(savedUrl);
    await testConnection(savedUrl);
    res.json({ success: true, message: 'Connection verified. The database is ready for installation.' });
  } catch (error) {
    res.status(400).json({ error: explainDatabaseError(error) });
  }
}));

router.post('/setup/database', asyncRoute(async (req, res) => {
  const parsed = databaseSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid PostgreSQL connection URL.' });
  const url = process.env.DATABASE_URL || parsed.data.databaseUrl || await getDatabaseUrl();
  try {
    validateDatabaseUrl(url);
    await testConnection(url);
    await runMigrations(url);
    const pool = configurePool(url);
    await pool.query(
      `INSERT INTO installation_state (singleton, state) VALUES (true, 'database_ready')
       ON CONFLICT (singleton) DO NOTHING`,
    );
    if (!process.env.DATABASE_URL) await saveDatabaseUrl(url);
    res.json({ success: true, step: 'school', message: 'Database connected and the ERP schema is ready.' });
  } catch (error) {
    res.status(400).json({ error: explainDatabaseError(error, 'migration') });
  }
}));

router.post('/setup/school', asyncRoute(async (req, res) => {
  const parsed = schoolSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'Review the school details and try again.' });
  const data = parsed.data;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stateResult = await client.query('SELECT state FROM installation_state WHERE singleton = true FOR UPDATE');
    if (!stateResult.rowCount || stateResult.rows[0].state !== 'database_ready') {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'School details have already been saved. Refresh the setup wizard to continue.' });
    }
    const baseSlug = slugify(data.name) || 'school';
    const slug = `${baseSlug}-${Math.random().toString(36).slice(2, 7)}`;
    const schoolResult = await client.query(
      `INSERT INTO schools
       (slug, name, motto, logo_url, favicon_url, address, city, country, phone, email, website,
        principal_name, registration_info, currency, timezone, primary_color, secondary_color, accent_color)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING id, name, logo_url, favicon_url, motto, primary_color, secondary_color, accent_color, currency, timezone`,
      [slug, data.name, data.motto, data.logoUrl, data.faviconUrl, data.address, data.city, data.country,
        data.phone, data.email, data.website, data.principalName, data.registrationInfo, data.currency,
        data.timezone, data.primaryColor, data.secondaryColor, data.accentColor],
    );
    const school = schoolResult.rows[0];
    await client.query('INSERT INTO school_settings (school_id) VALUES ($1)', [school.id]);
    const year = await client.query(
      `INSERT INTO academic_years (school_id, name, start_date, end_date, is_current)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [school.id, data.academicYear, data.academicStart, data.academicEnd],
    );
    await client.query(
      `INSERT INTO terms (school_id, academic_year_id, name, start_date, end_date, is_current)
       VALUES ($1, $2, $3, $4, $5, true)`,
      [school.id, year.rows[0].id, data.currentTerm, data.termStart, data.termEnd],
    );
    await seedRolesAndPermissions(client, school.id);
    const feeDefaults = [
      ['Tuition', 'TUITION', true], ['Admission', 'ADMISSION', false], ['Examination', 'EXAM', false],
      ['Transport', 'TRANSPORT', true], ['Library', 'LIBRARY', false], ['Lab', 'LAB', false],
    ];
    for (const [name, code, isRecurring] of feeDefaults) {
      await client.query(
        'INSERT INTO fee_types (school_id, name, code, is_recurring) VALUES ($1, $2, $3, $4)',
        [school.id, name, code, isRecurring],
      );
    }
    const grades = [
      ['A+', 90, 100, 4.0], ['A', 80, 89.99, 3.7], ['B', 70, 79.99, 3.0],
      ['C', 60, 69.99, 2.0], ['D', 50, 59.99, 1.0], ['F', 0, 49.99, 0.0],
    ];
    for (const [grade, min, max, gpa] of grades) {
      await client.query(
        `INSERT INTO grade_scales (school_id, name, min_percentage, max_percentage, grade, gpa)
         VALUES ($1, 'Default', $2, $3, $4, $5)`,
        [school.id, min, max, grade, gpa],
      );
    }
    await client.query(
      `UPDATE installation_state SET state = 'school_ready', school_id = $1, updated_at = now() WHERE singleton = true`,
      [school.id],
    );
    await client.query('COMMIT');
    res.json({ success: true, step: 'administrator', school: publicSchool({ ...school, school_id: school.id }) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(error.code === '23505' ? 409 : 400).json({ error: explainDatabaseError(error) });
  } finally {
    client.release();
  }
}));

router.post('/setup/administrator', asyncRoute(async (req, res) => {
  const parsed = adminSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return res.status(400).json({ error: issue?.message || 'Review the administrator details and try again.', field: issue?.path?.[0] });
  }
  const data = parsed.data;
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const stateResult = await client.query(
      `SELECT i.state, i.school_id, r.id AS role_id
       FROM installation_state i
       LEFT JOIN roles r ON r.school_id = i.school_id AND r.code = 'school_admin'
       WHERE i.singleton = true FOR UPDATE OF i`,
    );
    const state = stateResult.rows[0];
    if (!state || state.state !== 'school_ready' || !state.role_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'School setup is not ready for an administrator yet.' });
    }
    const passwordHash = await bcrypt.hash(data.password, 12);
    const created = await client.query(
      `INSERT INTO users (school_id, email, password_hash, full_name)
       VALUES ($1, $2, $3, $4) RETURNING id, school_id, email, full_name, status`,
      [state.school_id, data.email.toLowerCase(), passwordHash, data.fullName],
    );
    const user = created.rows[0];
    await client.query('INSERT INTO user_roles (school_id, user_id, role_id) VALUES ($1, $2, $3)', [state.school_id, user.id, state.role_id]);
    await client.query(
      `UPDATE installation_state SET state = 'initialized', initialized_at = now(), updated_at = now()
       WHERE singleton = true`,
    );
    await client.query(
      `INSERT INTO audit_logs (school_id, user_id, action, entity, entity_id, metadata)
       VALUES ($1, $2, 'created', 'administrator', $3, jsonb_build_object('source', 'first_run_setup'))`,
      [state.school_id, user.id, user.id],
    );
    await client.query('COMMIT');
    await issueSession(res, { id: user.id, school_id: user.school_id });
    res.status(201).json({ success: true, initialized: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(error.code === '23505' ? 409 : 400).json({
      error: error.code === '23505' ? 'An account already exists with that email.' : explainDatabaseError(error),
      field: error.code === '23505' ? 'email' : undefined,
    });
  } finally {
    client.release();
  }
}));

export default router;
