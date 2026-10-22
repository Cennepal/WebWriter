'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../lib/config');
const auth = require('../lib/auth');
const litewriter = require('../lib/litewriter');
const { users, settings } = require('../lib/db');
const { ACCENTS, EDITOR_FONTS } = require('../lib/view');
const { badRequest } = require('../lib/text');

const router = express.Router();
router.use(auth.requireUser);

const BG_DIR = path.join(config.uploadsDir, 'backgrounds');
const IMAGE_EXT = /^\.(jpe?g|png|gif|webp|avif)$/i;
const upload = multer({
  storage: multer.diskStorage({
    destination: BG_DIR,
    filename: (req, file, cb) => cb(null, `bg-${req.user.id}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`)
  }),
  limits: { fileSize: config.uploadLimitBytes, files: 1 },
  fileFilter: (req, file, cb) => {
    if (IMAGE_EXT.test(path.extname(file.originalname)) && file.mimetype.startsWith('image/')) return cb(null, true);
    cb(badRequest('Backgrounds must be JPG, PNG, GIF, WebP or AVIF images.'));
  }
});

const TABS = ['account', 'appearance', 'writing', 'litewriter'];
const clamp = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const bool = v => v === true || v === 'true' || v === '1' || v === 'on' || v === 1;

router.get('/', (req, res) => res.redirect('/settings/account'));

router.get('/:tab', (req, res, next) => {
  if (!TABS.includes(req.params.tab)) return next();
  const s = settings.get(req.user.id);
  res.render('settings', {
    title: 'Settings',
    tab: req.params.tab,
    s,
    accents: ACCENTS,
    fonts: EDITOR_FONTS,
    hasLitewriterPassword: Boolean(s.litewriter_password),
    timezones: typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : []
  });
});

/* ---------------------------------------------------------------- account */

router.post('/account/password', async (req, res) => {
  const { current, password, confirm } = req.body;
  if (!(await auth.verifyPassword(current, req.user.password_hash))) throw badRequest('Your current password is not right.');
  auth.checkPassword(password, confirm);
  users.update(req.user.id, { password_hash: await auth.hashPassword(password), must_change_password: 0 });
  req.session.sv = users.bumpSessionVersion(req.user.id);
  res.json({ ok: true, message: 'Password changed. Your other devices have been signed out.' });
});

router.post('/account/signout-others', (req, res) => {
  req.session.sv = users.bumpSessionVersion(req.user.id);
  res.json({ ok: true, message: 'All other sessions have been signed out.' });
});

router.post('/account/timezone', (req, res) => {
  const tz = String(req.body.timezone || '');
  if (tz) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
    } catch {
      throw badRequest('Unknown time zone.');
    }
  }
  settings.update(req.user.id, { timezone: tz });
  res.json({ ok: true, message: 'Time zone saved.' });
});

/* ------------------------------------------------------------- appearance */

router.post('/theme', (req, res) => {
  const theme = ['light', 'dark', 'system'].includes(req.body.theme) ? req.body.theme : 'system';
  settings.update(req.user.id, { theme });
  res.json({ ok: true, theme });
});

function removeOwnBackground(userId, url) {
  const prefix = `/uploads/backgrounds/bg-${userId}-`;
  if (url && url.startsWith(prefix)) fs.rm(path.join(BG_DIR, path.basename(url)), { force: true }, () => {});
}

router.post('/appearance', upload.single('background'), (req, res) => {
  const b = req.body;
  const current = settings.get(req.user.id);
  const update = {
    theme: ['light', 'dark', 'system'].includes(b.theme) ? b.theme : current.theme,
    accent: ACCENTS[b.accent] ? b.accent : current.accent,
    background_enabled: bool(b.background_enabled),
    background_dim: clamp(b.background_dim, 0, 0.95, current.background_dim),
    background_in_editor: bool(b.background_in_editor)
  };
  if (req.file) {
    removeOwnBackground(req.user.id, current.background_url);
    update.background_url = `/uploads/backgrounds/${req.file.filename}`;
    update.background_enabled = true;
  } else if (b.background_url !== undefined && b.background_url !== current.background_url) {
    const url = String(b.background_url).trim();
    if (url && !/^https?:\/\/\S+$/i.test(url)) throw badRequest('Background URLs must start with http:// or https://');
    removeOwnBackground(req.user.id, current.background_url);
    update.background_url = url;
  }
  settings.update(req.user.id, update);
  res.json({ ok: true, message: 'Appearance saved.', reload: true });
});

/* ---------------------------------------------------------------- writing */

router.post('/writing', (req, res) => {
  const b = req.body;
  const current = settings.get(req.user.id);
  settings.update(req.user.id, {
    editor_font: EDITOR_FONTS[b.editor_font] ? b.editor_font : current.editor_font,
    editor_size: Math.round(clamp(b.editor_size, 12, 32, current.editor_size)),
    editor_width: Math.round(clamp(b.editor_width, 28, 80, current.editor_width)),
    editor_line_height: clamp(b.editor_line_height, 1.2, 2.4, current.editor_line_height),
    editor_spellcheck: bool(b.editor_spellcheck),
    editor_typewriter: bool(b.editor_typewriter),
    daily_goal: Math.round(clamp(b.daily_goal, 0, 100000, 0))
  });
  res.json({ ok: true, message: 'Writing preferences saved.' });
});

/** Quick tweaks from the editor's own settings panel. */
router.post('/writing/quick', (req, res) => {
  const b = req.body;
  const update = {};
  if (b.editor_font && EDITOR_FONTS[b.editor_font]) update.editor_font = b.editor_font;
  if (b.editor_size !== undefined) update.editor_size = Math.round(clamp(b.editor_size, 12, 32, 19));
  if (b.editor_width !== undefined) update.editor_width = Math.round(clamp(b.editor_width, 28, 80, 42));
  if (b.editor_line_height !== undefined) update.editor_line_height = clamp(b.editor_line_height, 1.2, 2.4, 1.8);
  if (b.editor_typewriter !== undefined) update.editor_typewriter = bool(b.editor_typewriter);
  settings.update(req.user.id, update);
  res.json({ ok: true });
});

/* ------------------------------------------------------------- litewriter */

function litewriterFromBody(req) {
  const b = req.body;
  const current = settings.get(req.user.id);
  const url = litewriter.normalizeUrl(b.url);
  if (url && !/^https?:\/\/[^\s/]+/i.test(url)) throw badRequest('That does not look like a valid address.');
  return {
    litewriter_enabled: bool(b.enabled) ? 1 : 0,
    litewriter_url: url,
    litewriter_username: String(b.username || '').trim(),
    // An empty password field means "keep the saved one" unless explicitly cleared.
    litewriter_password: bool(b.clearPassword) ? '' : b.password ? String(b.password) : current.litewriter_password
  };
}

router.post('/litewriter', (req, res) => {
  const update = litewriterFromBody(req);
  if (update.litewriter_enabled && !update.litewriter_url) throw badRequest('Enter the WebDAV address shown in LiteWriter.');
  const previous = settings.get(req.user.id).litewriter_url;
  settings.update(req.user.id, update);
  if (previous !== update.litewriter_url) litewriter.clearCache(req.user.id);
  else litewriter.invalidate(req.user.id);
  res.json({ ok: true, message: update.litewriter_enabled ? 'LiteWriter connection saved.' : 'LiteWriter disabled.' });
});

router.post('/litewriter/test', async (req, res) => {
  const candidate = litewriterFromBody(req);
  if (!candidate.litewriter_url) throw badRequest('Enter the WebDAV address first.');
  const count = await litewriter.testConnection(candidate);
  res.json({ ok: true, message: `Connected! Found ${count} novel${count === 1 ? '' : 's'} on the device.` });
});

module.exports = router;
