'use strict';

const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const config = require('../lib/config');
const { requireUser } = require('../lib/auth');
const backups = require('../lib/backups');
const drive = require('../lib/drive');
const litewriter = require('../lib/litewriter');
const { settings } = require('../lib/db');
const { badRequest } = require('../lib/text');

const router = express.Router();
router.use(requireUser);

const upload = multer({ dest: config.tmpDir, limits: { fileSize: config.backupUploadLimitBytes, files: 1 } });

router.get('/', async (req, res) => {
  const s = settings.get(req.user.id);
  res.render('backups', {
    title: 'Backups',
    backups: await backups.list(req.user.id),
    s,
    driveAvailable: config.google.enabled,
    driveConnected: Boolean(s.drive_tokens),
    remoteConfigured: litewriter.isConfigured(s)
  });
});

router.post('/', async (req, res) => {
  const backup = await backups.create(req.user.id, { kind: 'manual', includeRemote: req.body.includeRemote === true });
  const note = backup.manifest.remote && backup.manifest.remote.error ? ` (LiteWriter novels skipped: ${backup.manifest.remote.error})` : '';
  res.status(201).json({ ok: true, name: backup.name, message: `Backup created${note}.` });
});

router.post('/schedule', (req, res) => {
  const b = req.body;
  const schedule = ['off', 'daily', 'weekly'].includes(b.schedule) ? b.schedule : 'off';
  const keep = Math.min(100, Math.max(1, Number(b.keep) || 10));
  settings.update(req.user.id, {
    backup_schedule: schedule,
    backup_keep: keep,
    backup_include_remote: b.includeRemote === true,
    drive_auto_upload: b.driveAutoUpload === true
  });
  res.json({ ok: true, message: schedule === 'off' ? 'Automatic backups turned off.' : `Automatic ${schedule} backups are on.` });
});

router.post('/upload', upload.single('backup'), async (req, res) => {
  try {
    if (!req.file) throw badRequest('Choose a backup file first.');
    const name = await backups.importUpload(req.user.id, req.file.path, req.file.originalname);
    res.status(201).json({ ok: true, name, message: 'Backup uploaded. You can restore it from the list.' });
  } finally {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
  }
});

router.get('/file/:name', (req, res) => {
  const file = backups.backupPath(req.user.id, req.params.name);
  if (!fs.existsSync(file)) return res.status(404).render('error', { title: 'Not found', status: 404, message: 'Backup not found.' });
  res.download(file, req.params.name);
});

router.delete('/file/:name', async (req, res) => {
  await backups.remove(req.user.id, req.params.name);
  res.json({ ok: true });
});

router.post('/file/:name/restore', async (req, res) => {
  const mode = req.body.mode === 'replace' ? 'replace' : 'merge';
  const result = await backups.restore(req.user.id, req.params.name, { mode });
  res.json({
    ok: true,
    message: `Restored ${result.restored} novel${result.restored === 1 ? '' : 's'}. A safety backup of your previous library was saved first.`
  });
});

router.post('/file/:name/drive', async (req, res) => {
  await drive.upload(req.user.id, req.params.name);
  res.json({ ok: true, message: 'Uploaded to Google Drive.' });
});

/* ------------------------------------------------------------ Google OAuth */

router.get('/google/connect', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;
  res.redirect(drive.authUrl(req, state));
});

router.get('/google/callback', async (req, res) => {
  const expected = req.session.oauthState;
  delete req.session.oauthState;
  if (!expected || req.query.state !== expected || !req.query.code) {
    req.flash('error', 'Google Drive could not be connected (the request expired). Please try again.');
    return res.redirect('/backups');
  }
  try {
    await drive.finishAuth(req, req.user.id, String(req.query.code));
    req.flash('success', 'Google Drive connected.');
  } catch (err) {
    console.error('[drive] OAuth callback failed:', err.message);
    req.flash('error', 'Google Drive could not be connected.');
  }
  res.redirect('/backups');
});

router.post('/google/disconnect', (req, res) => {
  drive.disconnect(req.user.id);
  res.json({ ok: true, message: 'Google Drive disconnected.' });
});

module.exports = router;
