import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { query } from './db.js';
import { getInstallConfig } from './config.js';
import { requirePermission } from './access.js';

const COOKIE_NAME = 'school_erp_session';
const SESSION_SECONDS = 60 * 60 * 8;
const fakeHash = '$2a$12$JKZa3TDmbJhIiLnCzKZc0uqqqydr9GvtyKaVX6zT0iUxgJbW8zKn2';

export const loginSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128),
});

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_SECONDS * 1000,
  };
}

async function sessionSecret() {
  const config = await getInstallConfig();
  return config.sessionSecret;
}

export async function issueSession(res, user) {
  const token = jwt.sign({ schoolId: user.school_id }, await sessionSecret(), {
    subject: user.id,
    expiresIn: SESSION_SECONDS,
    issuer: 'school-erp',
    audience: 'school-erp-web',
  });
  res.cookie(COOKIE_NAME, token, sessionCookieOptions());
}

export function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { ...sessionCookieOptions(), maxAge: undefined });
}

export async function authenticate(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Please sign in to continue.' });
  try {
    const decoded = jwt.verify(token, await sessionSecret(), {
      issuer: 'school-erp',
      audience: 'school-erp-web',
    });
    const result = await query(
      `SELECT u.id, u.school_id, u.email, u.full_name, u.phone, u.avatar_url, u.status,
              s.name AS school_name, s.slug AS school_slug,
              COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
       FROM users u
       JOIN schools s ON s.id = u.school_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = u.school_id
       LEFT JOIN roles r ON r.id = ur.role_id AND r.school_id = ur.school_id
       WHERE u.id = $1 AND u.school_id = $2 AND u.archived_at IS NULL
       GROUP BY u.id, s.id`,
      [decoded.sub, decoded.schoolId],
    );
    if (!result.rowCount || result.rows[0].status !== 'active') {
      clearSession(res);
      return res.status(401).json({ error: 'Your session is no longer active. Please sign in again.' });
    }
    req.user = result.rows[0];
    return next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      clearSession(res);
      return res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
    }
    return res.status(500).json({ error: 'Unable to verify your session right now.' });
  }
}

export async function login(req, res) {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Enter a valid email and password.' });
  const email = parsed.data.email.toLowerCase();
  try {
    const result = await query(
      `SELECT u.id, u.school_id, u.email, u.full_name, u.phone, u.avatar_url, u.status, u.password_hash,
              s.name AS school_name, s.slug AS school_slug,
              COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
       FROM users u
       JOIN schools s ON s.id = u.school_id
       LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.school_id = u.school_id
       LEFT JOIN roles r ON r.id = ur.role_id AND r.school_id = ur.school_id
       WHERE lower(u.email) = $1 AND u.archived_at IS NULL
       GROUP BY u.id, s.id`,
      [email],
    );
    const user = result.rows[0];
    const passwordMatches = await bcrypt.compare(parsed.data.password, user?.password_hash || fakeHash);
    if (!user || !passwordMatches || user.status !== 'active') {
      return res.status(401).json({ error: 'Email or password is incorrect.' });
    }
    await query('UPDATE users SET last_login_at = now() WHERE id = $1 AND school_id = $2', [user.id, user.school_id]);
    const { password_hash: _passwordHash, ...safeUser } = user;
    await issueSession(res, safeUser);
    return res.json({ user: safeUser });
  } catch {
    return res.status(500).json({ error: 'Sign in is temporarily unavailable. Please try again.' });
  }
}

export function authRoutes(router) {
  router.post('/auth/login', login);
  router.post('/auth/logout', (req, res) => {
    clearSession(res);
    res.json({ success: true });
  });
  router.get('/auth/me', authenticate, (req, res) => res.json({ user: req.user }));
  router.get('/auth/permissions', authenticate, async (req, res) => {
    try {
      const result = await query(
        `SELECT DISTINCT p.code FROM user_roles ur
         JOIN role_permissions rp ON rp.role_id = ur.role_id AND rp.school_id = ur.school_id
         JOIN permissions p ON p.id = rp.permission_id
         WHERE ur.user_id = $1 AND ur.school_id = $2`,
        [req.user.id, req.user.school_id],
      );
      const permissions = result.rows.map(({ code }) => code);
      if (req.user.roles.includes('school_admin') || req.user.roles.includes('super_admin')) {
        const all = await query('SELECT code FROM permissions');
        return res.json({ permissions: all.rows.map(({ code }) => code) });
      }
      return res.json({ permissions });
    } catch {
      return res.status(500).json({ error: 'Unable to load your access permissions.' });
    }
  });
  router.post('/auth/change-password', authenticate, async (req, res) => {
    const schema = z.object({ currentPassword: z.string().min(1), newPassword: strongPasswordSchema });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Use a password with at least 12 characters, including uppercase, lowercase, and a number.' });
    try {
      const result = await query('SELECT password_hash FROM users WHERE id = $1 AND school_id = $2', [req.user.id, req.user.school_id]);
      if (!result.rowCount || !(await bcrypt.compare(parsed.data.currentPassword, result.rows[0].password_hash))) {
        return res.status(400).json({ error: 'Current password is incorrect.' });
      }
      const hash = await bcrypt.hash(parsed.data.newPassword, 12);
      await query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2 AND school_id = $3', [hash, req.user.id, req.user.school_id]);
      clearSession(res);
      return res.json({ success: true, signedOut: true });
    } catch {
      return res.status(500).json({ error: 'Unable to update your password.' });
    }
  });
  return router;
}

export const strongPasswordSchema = z.string()
  .min(12, 'Use at least 12 characters.')
  .max(128)
  .regex(/[a-z]/, 'Include a lowercase letter.')
  .regex(/[A-Z]/, 'Include an uppercase letter.')
  .regex(/[0-9]/, 'Include a number.');

export { requirePermission };
