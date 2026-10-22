'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, users } = require('./db');
const { AppError, badRequest } = require('./text');

const BCRYPT_ROUNDS = 12;

const hashPassword = password => bcrypt.hash(password, BCRYPT_ROUNDS);
const verifyPassword = (password, hash) => bcrypt.compare(String(password || ''), hash || '');

function checkUsername(raw) {
  const username = String(raw || '').trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username)) {
    throw badRequest('Usernames are 3–32 characters: letters, numbers, dots, dashes and underscores.');
  }
  return username;
}

function checkPassword(password, confirm) {
  if (typeof password !== 'string' || password.length < 8) throw badRequest('Passwords need at least 8 characters.');
  if (password.length > 200) throw badRequest('That password is too long.');
  if (confirm !== undefined && password !== confirm) throw badRequest('The passwords do not match.');
  return password;
}

/* ---------------------------------------------------------------- sessions */

function startSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate(err => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.sv = user.session_version;
      req.session.csrf = crypto.randomBytes(24).toString('base64url');
      users.update(user.id, { last_login_at: new Date().toISOString() });
      req.session.save(e => (e ? reject(e) : resolve()));
    });
  });
}

/** Loads the current user on every request; kicks out disabled/deleted users and revoked sessions. */
function loadUser(req, res, next) {
  res.locals.user = null;
  const id = req.session && req.session.userId;
  if (!id) return next();
  const user = users.byId(id);
  if (!user || user.disabled || user.session_version !== req.session.sv) {
    return req.session.destroy(() => next());
  }
  req.user = user;
  res.locals.user = { id: user.id, username: user.username, role: user.role, isAdmin: user.role === 'admin' };
  next();
}

function wantsJson(req) {
  return req.xhr || req.path.startsWith('/api/') || (req.get('accept') || '').includes('application/json') || req.is('application/json');
}

function requireUser(req, res, next) {
  if (!req.user) {
    if (wantsJson(req)) return res.status(401).json({ error: 'Your session has ended. Please sign in again.' });
    const back = req.method === 'GET' ? `?next=${encodeURIComponent(req.originalUrl)}` : '';
    return res.redirect(`/login${back}`);
  }
  // Users with a temporary password must pick a new one before anything else.
  if (req.user.must_change_password && !req.path.startsWith('/account/password') && req.method === 'GET' && !wantsJson(req)) {
    return res.redirect('/account/password');
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') throw new AppError(403, 'Only administrators can do that.');
  next();
}

/* -------------------------------------------------------------------- CSRF */

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url');
  return req.session.csrf;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** Double-checks every state-changing request against the session token (header or form field). */
function csrfProtection(req, res, next) {
  res.locals.csrfToken = () => csrfToken(req);
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.get('x-csrf-token') || (req.body && req.body._csrf) || req.query._csrf;
  if (!req.session.csrf || !safeEqual(sent, req.session.csrf)) {
    throw new AppError(403, 'Your form expired. Please reload the page and try again.', { code: 'CSRF' });
  }
  next();
}

/* ------------------------------------------------------------ rate limiting */

const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function limiterKey(req, username) {
  return `${req.ip}|${String(username || '').toLowerCase()}`;
}

function isLimited(req, username) {
  const entry = attempts.get(limiterKey(req, username));
  return Boolean(entry && entry.count >= MAX_ATTEMPTS && Date.now() - entry.first < WINDOW_MS);
}

function recordFailure(req, username) {
  const key = limiterKey(req, username);
  const entry = attempts.get(key);
  if (!entry || Date.now() - entry.first > WINDOW_MS) attempts.set(key, { first: Date.now(), count: 1 });
  else entry.count++;
  if (attempts.size > 5000) attempts.delete(attempts.keys().next().value);
}

function clearFailures(req, username) {
  attempts.delete(limiterKey(req, username));
}

/* ----------------------------------------------------------------- invites */

const hashToken = token => crypto.createHash('sha256').update(String(token)).digest('hex');

const invites = {
  create({ createdBy, role = 'user', note = '', maxUses = 1, expiresInDays = 7 }) {
    const token = crypto.randomBytes(18).toString('base64url');
    const expiresAt = expiresInDays > 0 ? new Date(Date.now() + expiresInDays * 864e5).toISOString() : null;
    db.prepare(`INSERT INTO invites (token_hash, role, note, max_uses, created_by, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(hashToken(token), role, String(note).slice(0, 200), Math.max(1, maxUses | 0), createdBy, expiresAt);
    return token;
  },
  list() {
    return db
      .prepare(`SELECT i.*, u.username AS created_by_name,
                  (SELECT GROUP_CONCAT(x.username, ', ') FROM invite_uses iu LEFT JOIN users x ON x.id = iu.user_id WHERE iu.invite_id = i.id) AS used_by
                FROM invites i LEFT JOIN users u ON u.id = i.created_by
                ORDER BY i.created_at DESC`)
      .all()
      .map(i => ({ ...i, status: inviteStatus(i) }));
  },
  find(token) {
    if (!token) return null;
    const invite = db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(hashToken(token));
    return invite && inviteStatus(invite) === 'active' ? invite : null;
  },
  consume(inviteId, userId) {
    db.prepare('UPDATE invites SET uses = uses + 1 WHERE id = ?').run(inviteId);
    db.prepare('INSERT INTO invite_uses (invite_id, user_id) VALUES (?, ?)').run(inviteId, userId);
  },
  revoke(id) {
    db.prepare("UPDATE invites SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND revoked_at IS NULL").run(id);
  },
  remove(id) {
    db.prepare('DELETE FROM invites WHERE id = ?').run(id);
  }
};

function inviteStatus(i) {
  if (i.revoked_at) return 'revoked';
  if (i.uses >= i.max_uses) return 'used';
  if (i.expires_at && Date.parse(i.expires_at) < Date.now()) return 'expired';
  return 'active';
}

module.exports = {
  hashPassword,
  verifyPassword,
  checkUsername,
  checkPassword,
  startSession,
  loadUser,
  requireUser,
  requireAdmin,
  csrfProtection,
  csrfToken,
  wantsJson,
  isLimited,
  recordFailure,
  clearFailures,
  invites
};
