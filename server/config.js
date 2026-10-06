import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const storageDir = path.resolve(process.env.STORAGE_DIR || './storage');
const configPath = path.join(storageDir, 'installation.json');
let cached;

async function ensureStorage() {
  await fs.mkdir(storageDir, { recursive: true, mode: 0o700 });
  try { await fs.chmod(storageDir, 0o700); } catch {}
}

async function readConfig() {
  if (cached) return cached;
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    cached = JSON.parse(raw);
    return cached;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('The server installation configuration could not be read.');
    cached = {};
    return cached;
  }
}

async function writeConfig(next) {
  await ensureStorage();
  const temporaryPath = `${configPath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.chmod(temporaryPath, 0o600);
  await fs.rename(temporaryPath, configPath);
  try { await fs.chmod(configPath, 0o600); } catch {}
  cached = next;
}

export async function getInstallConfig() {
  const stored = await readConfig();
  if (process.env.SESSION_SECRET) return { ...stored, sessionSecret: process.env.SESSION_SECRET };
  if (!stored.sessionSecret) {
    stored.sessionSecret = crypto.randomBytes(48).toString('base64url');
    await writeConfig(stored);
  }
  return stored;
}

export async function getDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const config = await readConfig();
  return config.databaseUrl || null;
}

export async function saveDatabaseUrl(databaseUrl) {
  const config = await readConfig();
  await writeConfig({ ...config, databaseUrl });
}

export function getStorageDir() {
  return storageDir;
}
