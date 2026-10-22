'use strict';

/** Optional Google Drive upload of backups (needs GOOGLE_CLIENT_ID/SECRET on the server). */

const fs = require('fs');
const config = require('./config');
const { settings: settingsStore } = require('./db');
const backups = require('./backups');
const { badRequest } = require('./text');

const FOLDER_NAME = 'WebWriter Backups';

function redirectUri(req) {
  const base = config.baseUrl || `${req.protocol}://${req.get('host')}`;
  return `${base}/backups/google/callback`;
}

function oauthClient(redirect) {
  if (!config.google.enabled) throw badRequest('Google Drive is not configured on this server.');
  const { auth } = require('@googleapis/drive');
  return new auth.OAuth2(config.google.clientId, config.google.clientSecret, redirect);
}

function authUrl(req, state) {
  return oauthClient(redirectUri(req)).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.file'],
    state
  });
}

async function finishAuth(req, userId, code) {
  const client = oauthClient(redirectUri(req));
  const { tokens } = await client.getToken(code);
  settingsStore.update(userId, { drive_tokens: JSON.stringify(tokens), drive_folder_id: null });
}

function isConnected(userId) {
  return Boolean(settingsStore.get(userId).drive_tokens);
}

function disconnect(userId) {
  settingsStore.update(userId, { drive_tokens: null, drive_folder_id: null, drive_auto_upload: 0 });
}

function driveFor(userId) {
  const s = settingsStore.get(userId);
  if (!s.drive_tokens) throw badRequest('Google Drive is not connected.');
  const client = oauthClient();
  client.setCredentials(JSON.parse(s.drive_tokens));
  // Persist refreshed tokens; Google only sends the refresh token once.
  client.on('tokens', tokens => {
    const current = JSON.parse(settingsStore.get(userId).drive_tokens || '{}');
    settingsStore.update(userId, { drive_tokens: JSON.stringify({ ...current, ...tokens }) });
  });
  const { drive } = require('@googleapis/drive');
  return drive({ version: 'v3', auth: client });
}

async function ensureFolder(userId, api) {
  const s = settingsStore.get(userId);
  if (s.drive_folder_id) {
    try {
      const res = await api.files.get({ fileId: s.drive_folder_id, fields: 'id, trashed' });
      if (!res.data.trashed) return s.drive_folder_id;
    } catch {
      // folder deleted, create a new one
    }
  }
  const res = await api.files.create({
    requestBody: { name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id'
  });
  settingsStore.update(userId, { drive_folder_id: res.data.id });
  return res.data.id;
}

async function upload(userId, name) {
  const file = backups.backupPath(userId, name);
  if (!fs.existsSync(file)) throw badRequest('Backup not found.');
  const api = driveFor(userId);
  try {
    const folder = await ensureFolder(userId, api);
    await api.files.create({
      requestBody: { name, parents: [folder] },
      media: { mimeType: 'application/zip', body: fs.createReadStream(file) },
      fields: 'id'
    });
  } catch (err) {
    if (err.response && (err.response.status === 401 || err.response.data?.error === 'invalid_grant')) {
      disconnect(userId);
      throw badRequest('Google Drive access was revoked. Please connect it again.');
    }
    throw badRequest(`Upload to Google Drive failed: ${err.message}`);
  }
}

module.exports = { authUrl, finishAuth, isConnected, disconnect, upload };
