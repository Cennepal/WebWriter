'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const config = require('./config');
const { db, users } = require('./db');
const auth = require('./auth');
const view = require('./view');
const legacy = require('./legacy');

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https: http:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  });
  next();
}

function createApp() {
  legacy.run();
  fs.mkdirSync(config.usersDir, { recursive: true });
  fs.mkdirSync(path.join(config.uploadsDir, 'backgrounds'), { recursive: true });
  fs.mkdirSync(config.tmpDir, { recursive: true });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(config.rootDir, 'views'));
  app.locals.appVersion = config.version;
  Object.assign(app.locals, view.helpers);

  app.use(securityHeaders);
  app.use(express.static(path.join(config.rootDir, 'public'), { maxAge: '1h' }));
  app.use('/uploads/backgrounds', express.static(path.join(config.uploadsDir, 'backgrounds'), { maxAge: '7d', fallthrough: false }));

  app.use(
    session({
      name: 'webwriter.sid',
      store: new SqliteStore({ client: db, expired: { clear: true, intervalMs: 15 * 60 * 1000 } }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: { secure: config.cookieSecure, httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 }
    })
  );
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  // sendBeacon() posts JSON as text/plain when leaving the editor.
  app.use(express.text({ type: 'text/plain', limit: '20mb' }));
  app.use((req, res, next) => {
    if (typeof req.body === 'string' && req.is('text/plain')) {
      try {
        req.body = JSON.parse(req.body);
      } catch {
        req.body = {};
      }
    }
    next();
  });

  app.use(auth.loadUser);
  app.use(view.locals);
  app.use(auth.csrfProtection);

  // First run: nobody exists yet, so everything leads to the setup page.
  app.use((req, res, next) => {
    if (users.count() === 0 && !req.path.startsWith('/setup')) return res.redirect('/setup');
    next();
  });

  app.use(require('../routes/auth'));
  app.use('/api', require('../routes/api'));
  app.use(require('../routes/library'));
  app.use('/settings', require('../routes/settings'));
  app.use('/backups', require('../routes/backups'));
  app.use('/stats', require('../routes/stats'));
  app.use('/admin', require('../routes/admin'));

  app.use((req, res) => {
    if (auth.wantsJson(req)) return res.status(404).json({ error: 'Not found' });
    res.status(404).render('error', { title: 'Not found', status: 404, message: 'That page does not exist.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = err.expose ? err.message : 'Something went wrong on our side.';
    if (err.code === 'LIMIT_FILE_SIZE') {
      status = 413;
      message = 'That file is too large.';
    }
    if (err.code === 'REMOTE_ERROR') console.warn(`[litewriter] ${req.method} ${req.originalUrl}: ${err.message}`);
    else if (status >= 500) console.error(`[error] ${req.method} ${req.originalUrl}`, err);
    if (auth.wantsJson(req)) return res.status(status).json({ error: message, code: err.code });
    view.ensureLocals(req, res);
    res.status(status).render('error', { title: 'Error', status, message });
  });

  return app;
}

module.exports = { createApp };
