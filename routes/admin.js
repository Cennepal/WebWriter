'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../lib/config');
const auth = require('../lib/auth');
const library = require('../lib/library');
const { users, db } = require('../lib/db');
const { badRequest, notFound } = require('../lib/text');

const router = express.Router();
router.use(auth.requireUser, auth.requireAdmin);

function dirSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch {
    // missing directory
  }
  return total;
}

function baseUrl(req) {
  return config.baseUrl || `${req.protocol}://${req.get('host')}`;
}

function target(req) {
  const user = users.byId(Number(req.params.id));
  if (!user) throw notFound('User not found.');
  return user;
}

/** Refuse anything that would leave the instance without an active admin. */
function guardLastAdmin(user, change) {
  if (user.role === 'admin' && !user.disabled && users.adminCount() <= 1 && change) {
    throw badRequest('This is the only administrator. Promote someone else first.');
  }
}

router.get('/', (req, res) => res.redirect('/admin/users'));

router.get('/users', async (req, res) => {
  const list = await Promise.all(
    users.list().map(async u => {
      let novels = 0;
      try {
        novels = fs.readdirSync(library.libraryDir(u.id)).length;
      } catch {
        novels = 0;
      }
      return { ...u, novels, storage: dirSize(path.join(config.usersDir, String(u.id))) };
    })
  );
  const words30 = db
    .prepare(`SELECT user_id, SUM(words_added - words_removed) AS net FROM writing_log
              WHERE day >= date('now', '-30 days') GROUP BY user_id`)
    .all();
  const wordsBy = new Map(words30.map(r => [r.user_id, Math.max(0, r.net)]));
  res.render('admin', {
    title: 'Users',
    users: list.map(u => ({ ...u, words30: wordsBy.get(u.id) || 0 })),
    invites: auth.invites.list()
  });
});

router.post('/invites', (req, res) => {
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  const token = auth.invites.create({
    createdBy: req.user.id,
    role,
    note: req.body.note || '',
    maxUses: Math.min(100, Math.max(1, Number(req.body.maxUses) || 1)),
    expiresInDays: Math.min(365, Math.max(0, Number(req.body.expiresInDays ?? 7)))
  });
  const link = `${baseUrl(req)}/join/${token}`;
  res.status(201).json({ ok: true, link });
});

router.post('/invites/:id/revoke', (req, res) => {
  auth.invites.revoke(Number(req.params.id));
  res.json({ ok: true });
});

router.delete('/invites/:id', (req, res) => {
  auth.invites.remove(Number(req.params.id));
  res.json({ ok: true });
});

router.post('/users/:id/role', (req, res) => {
  const user = target(req);
  const role = req.body.role === 'admin' ? 'admin' : 'user';
  if (role === 'user') guardLastAdmin(user, true);
  users.update(user.id, { role });
  res.json({ ok: true, message: `${user.username} is now ${role === 'admin' ? 'an administrator' : 'a regular user'}.` });
});

router.post('/users/:id/disabled', (req, res) => {
  const user = target(req);
  const disabled = req.body.disabled === true;
  if (user.id === req.user.id && disabled) throw badRequest('You cannot disable your own account.');
  if (disabled) guardLastAdmin(user, true);
  users.update(user.id, { disabled: disabled ? 1 : 0 });
  if (disabled) users.bumpSessionVersion(user.id);
  res.json({ ok: true, message: disabled ? `${user.username} has been disabled and signed out.` : `${user.username} can sign in again.` });
});

router.post('/users/:id/reset-password', async (req, res) => {
  const user = target(req);
  if (user.id === req.user.id) throw badRequest('Use Settings → Account to change your own password.');
  const temp = crypto.randomBytes(9).toString('base64url');
  users.update(user.id, { password_hash: await auth.hashPassword(temp), must_change_password: 1 });
  users.bumpSessionVersion(user.id);
  res.json({ ok: true, password: temp, message: `Temporary password for ${user.username}: ${temp}` });
});

router.delete('/users/:id', async (req, res) => {
  const user = target(req);
  if (user.id === req.user.id) throw badRequest('You cannot delete your own account.');
  guardLastAdmin(user, true);
  if (req.body.confirm !== user.username) throw badRequest('Type the username to confirm.');
  users.remove(user.id);
  await fs.promises.rm(path.join(config.usersDir, String(user.id)), { recursive: true, force: true });
  res.json({ ok: true, message: `${user.username} and all of their novels have been deleted.` });
});

module.exports = router;
