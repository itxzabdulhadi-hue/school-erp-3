import { z } from 'zod';
import { explainDatabaseError } from './db.js';

export const asyncRoute = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

export const optionalText = (maximum = 500) => z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().max(maximum).optional(),
);

export function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

export function pagination(queryParams, { limit = 50, maxLimit = 200 } = {}) {
  const take = Math.min(Math.max(Number.parseInt(queryParams.limit, 10) || limit, 1), maxLimit);
  const page = Math.max(Number.parseInt(queryParams.page, 10) || 1, 1);
  return { limit: take, offset: (page - 1) * take, page };
}

export async function audit(client, req, { action, entity, entityId = null, metadata = {} }) {
  await client.query(
    `INSERT INTO audit_logs (school_id, user_id, action, entity, entity_id, metadata, ip_address, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [
      req.user.school_id,
      req.user.id,
      action,
      entity,
      entityId ? String(entityId) : null,
      JSON.stringify(metadata),
      validIp(req.ip),
      String(req.get('user-agent') || '').slice(0, 300) || null,
    ],
  );
}

function validIp(value) {
  if (!value) return null;
  const candidate = String(value).replace(/^::ffff:/, '');
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(candidate) || /^[0-9a-f:]+$/i.test(candidate)) return candidate;
  return null;
}

export function apiErrorHandler(error, _req, res, _next) {
  if (res.headersSent) return;
  const status = error.status || (error.code === '23505' ? 409 : 400);
  res.status(status >= 400 && status < 600 ? status : 500).json({
    error: error.publicMessage || explainDatabaseError(error),
  });
}

export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'The requested resource was not found.' });
}
