'use strict';

const express = require('express');
const { users, settings, meta } = require('../lib/db');
const auth = require('../lib/auth');
const legacy = require('../lib/legacy');

const router = express.Router();

function safeNext(next) {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/library';
}

function validTimezone(tz) {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return '';
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return tz;
  } catch {
    return '';
  }
}

router.get('/', (req, res) => res.redirect(req.user ? '/library' : '/login'));

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/library');
  res.render('auth/login', { title: 'Sign in', error: null, username: '', next: safeNext(req.query.next) });
});

router.post('/login', async (req, res) => {
  const { username = '', password = '' } = req.body;
  const next = safeNext(req.body.next);
  const fail = (error, status = 401) => res.status(status).render('auth/login', { title: 'Sign in', error, username, next });

  if (auth.isLimited(req, username)) return fail('Too many failed attempts. Please wait 15 minutes and try again.', 429);
  const user = users.byName(username);
  const ok = user && (await auth.verifyPassword(password, user.password_hash));
  if (!ok) {
    auth.recordFailure(req, username);
    return fail('That username and password combination is not right.');
  }
  if (user.disabled) return fail('This account has been disabled. Ask your administrator.', 403);
  auth.clearFailures(req, username);

  // The 1.x default was admin/admin – make sure nobody keeps it around.
  if (password.toLowerCase() === user.username.toLowerCase() || password === 'admin') {
    users.update(user.id, { must_change_password: 1 });
  }
  const tz = validTimezone(req.body.tz);
  if (tz && !settings.get(user.id).timezone) settings.update(user.id, { timezone: tz });

  await auth.startSession(req, users.byId(user.id));
  res.redirect(next);
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('webwriter.sid');
    res.redirect('/login');
  });
});

/* -------------------------------------------------------------- first run */

router.get('/setup', (req, res) => {
  if (users.count() > 0) return res.redirect('/login');
  res.render('auth/setup', { title: 'Welcome', error: null, username: '', hasLegacy: legacy.hasLegacyNovels() });
});

router.post('/setup', async (req, res) => {
  if (users.count() > 0) return res.redirect('/login');
  const { username = '', password = '', confirm = '' } = req.body;
  try {
    const name = auth.checkUsername(username);
    auth.checkPassword(password, confirm);
    const user = users.create({ username: name, passwordHash: await auth.hashPassword(password), role: 'admin' });
    const tz = validTimezone(req.body.tz);
    if (tz) settings.update(user.id, { timezone: tz });
    legacy.migrateFiles(user.id);
    meta.set('legacy_migrated', new Date().toISOString());
    await auth.startSession(req, user);
    req.flash('success', 'Welcome to WebWriter! Your administrator account is ready.');
    res.redirect('/library');
  } catch (err) {
    if (!err.expose) throw err;
    res.status(400).render('auth/setup', { title: 'Welcome', error: err.message, username, hasLegacy: legacy.hasLegacyNovels() });
  }
});

/* ---------------------------------------------------------------- invites */

router.get('/join/:token', (req, res) => {
  const invite = auth.invites.find(req.params.token);
  res.status(invite ? 200 : 410).render('auth/join', { title: 'Join', invite, token: req.params.token, error: null, username: '' });
});

router.post('/join/:token', async (req, res) => {
  const invite = auth.invites.find(req.params.token);
  const { username = '', password = '', confirm = '' } = req.body;
  const render = (error, status = 400) => res.status(status).render('auth/join', { title: 'Join', invite, token: req.params.token, error, username });
  if (!invite) return render(null, 410);
  try {
    const name = auth.checkUsername(username);
    auth.checkPassword(password, confirm);
    if (users.byName(name)) return render('That username is already taken.');
    const user = users.create({ username: name, passwordHash: await auth.hashPassword(password), role: invite.role });
    auth.invites.consume(invite.id, user.id);
    const tz = validTimezone(req.body.tz);
    if (tz) settings.update(user.id, { timezone: tz });
    await auth.startSession(req, user);
    req.flash('success', `Welcome, ${user.username}! Create your first novel to get started.`);
    res.redirect('/library');
  } catch (err) {
    if (!err.expose) throw err;
    render(err.message);
  }
});

/* -------------------------------------------- forced password change page */

router.get('/account/password', auth.requireUser, (req, res) => {
  res.render('auth/password', { title: 'Choose a new password', error: null, forced: Boolean(req.user.must_change_password) });
});

router.post('/account/password', auth.requireUser, async (req, res) => {
  const { current = '', password = '', confirm = '' } = req.body;
  const forced = Boolean(req.user.must_change_password);
  try {
    if (!(await auth.verifyPassword(current, req.user.password_hash))) {
      return res.status(400).render('auth/password', { title: 'Choose a new password', error: 'Your current password is not right.', forced });
    }
    auth.checkPassword(password, confirm);
    if (password === current) throw Object.assign(new Error('Please choose a different password.'), { expose: true });
    users.update(req.user.id, { password_hash: await auth.hashPassword(password), must_change_password: 0 });
    const sv = users.bumpSessionVersion(req.user.id);
    req.session.sv = sv;
    req.flash('success', 'Your password has been changed. Other devices have been signed out.');
    res.redirect('/library');
  } catch (err) {
    if (!err.expose) throw err;
    res.status(400).render('auth/password', { title: 'Choose a new password', error: err.message, forced });
  }
});

module.exports = router;
