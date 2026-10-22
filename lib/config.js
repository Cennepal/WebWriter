'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.resolve(ROOT_DIR, process.env.DATA_DIR || 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

/**
 * The session secret is read from the environment. If none is configured we
 * generate one once and persist it in the data directory, so sessions survive
 * restarts without anyone having to think about it.
 */
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretFile = path.join(DATA_DIR, '.session-secret');
  try {
    return fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(secretFile, secret, { mode: 0o600 });
    return secret;
  }
}

function parseTrustProxy(value) {
  if (value === undefined || value === '') return 'loopback, linklocal, uniquelocal';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

const baseUrl = (process.env.BASE_URL || '').replace(/\/+$/, '');

module.exports = {
  version: require('../package.json').version,
  rootDir: ROOT_DIR,
  dataDir: DATA_DIR,
  dbFile: path.join(DATA_DIR, 'webwriter.db'),
  usersDir: path.join(DATA_DIR, 'users'),
  uploadsDir: path.join(DATA_DIR, 'uploads'),
  tmpDir: path.join(DATA_DIR, 'tmp'),
  port: Number(process.env.PORT) || 3000,
  host: process.env.HOST || '0.0.0.0',
  baseUrl,
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  // 'auto' marks the cookie secure whenever the request came in over HTTPS
  // (directly or via a trusted proxy), which works for both setups.
  cookieSecure: process.env.COOKIE_SECURE === 'true' ? true : process.env.COOKIE_SECURE === 'false' ? false : 'auto',
  sessionSecret: loadSessionSecret(),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    get enabled() {
      return Boolean(this.clientId && this.clientSecret);
    }
  },
  litewriter: {
    // A phone on Wi-Fi/Tailscale can be slow; give single requests some room,
    // but never let them hang forever.
    timeoutMs: Number(process.env.LITEWRITER_TIMEOUT_MS) || 15000,
    concurrency: Number(process.env.LITEWRITER_CONCURRENCY) || 4,
    listCacheMs: Number(process.env.LITEWRITER_CACHE_MS) || 60000
  },
  uploadLimitBytes: 15 * 1024 * 1024,
  backupUploadLimitBytes: 500 * 1024 * 1024
};
