'use strict';

/**
 * One-time migration from WebWriter 1.x:
 *   database/users.db       -> users and settings in data/webwriter.db (password hashes are kept)
 *   data/novels/<id>        -> data/users/<owner>/library/<id>
 *   data/backups/*.zip      -> data/users/<owner>/backups/legacy-*.zip
 *   public/backgrounds/*    -> data/uploads/backgrounds/*
 * Nothing is deleted; the old users.db stays where it is.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');
const { db, users, settings, meta } = require('./db');

const LEGACY_DB = path.join(config.rootDir, 'database', 'users.db');
const LEGACY_NOVELS = path.join(config.rootDir, 'data', 'novels');
const LEGACY_BACKUPS = path.join(config.rootDir, 'data', 'backups');
const LEGACY_BACKGROUNDS = path.join(config.rootDir, 'public', 'backgrounds');

function move(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(src, dst, { recursive: true });
    fs.rmSync(src, { recursive: true, force: true });
  }
}

function importUsers() {
  if (!fs.existsSync(LEGACY_DB) || users.count() > 0) return null;
  const legacy = new Database(LEGACY_DB, { readonly: true, fileMustExist: true });
  try {
    const rows = legacy.prepare('SELECT * FROM users ORDER BY id').all();
    if (!rows.length) return null;
    let settingsRows = [];
    try {
      settingsRows = legacy.prepare('SELECT * FROM user_settings').all();
    } catch {
      settingsRows = [];
    }
    const bySettings = new Map(settingsRows.map(r => [r.user_id, r]));
    const owner = rows.find(r => r.username === 'admin') || rows[0];

    db.transaction(() => {
      for (const r of rows) {
        db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)`).run(
          r.id,
          r.username,
          r.password,
          r === owner ? 'admin' : 'user',
          r.created_at ? new Date(`${r.created_at.replace(' ', 'T')}Z`).toISOString() : new Date().toISOString()
        );
        db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)').run(r.id);
        const s = bySettings.get(r.id);
        if (!s) continue;
        let bg = s.background_url || '';
        if (bg.startsWith('/backgrounds/')) bg = `/uploads${bg}`;
        settings.update(r.id, {
          theme: ['light', 'dark'].includes(s.theme) ? s.theme : 'system',
          background_enabled: s.background_enabled ? 1 : 0,
          background_url: bg,
          background_dim: s.background_opacity != null ? Math.min(0.95, Math.max(0, 1 - Number(s.background_opacity))) : 0.7,
          background_in_editor: s.background_editor_enabled ? 1 : 0,
          litewriter_enabled: s.litewriter_enabled ? 1 : 0,
          litewriter_url: s.litewriter_url || '',
          litewriter_username: s.litewriter_username || '',
          litewriter_password: s.litewriter_password || '',
          backup_schedule: ['daily', 'weekly'].includes(s.backup_schedule) ? s.backup_schedule : 'off',
          drive_tokens: s.google_drive_token || null,
          drive_auto_upload: s.cloud_backup_schedule && s.cloud_backup_schedule !== 'manual' ? 1 : 0
        });
      }
    })();
    console.log(`[migrate] Imported ${rows.length} user(s) from WebWriter 1.x`);
    return owner.id;
  } finally {
    legacy.close();
  }
}

/** Move legacy files to their new home, owned by `ownerId`. Safe to call repeatedly. */
function migrateFiles(ownerId) {
  if (!ownerId) return;
  if (fs.existsSync(LEGACY_NOVELS)) {
    const target = path.join(config.usersDir, String(ownerId), 'library');
    fs.mkdirSync(target, { recursive: true });
    let count = 0;
    for (const e of fs.readdirSync(LEGACY_NOVELS, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const dst = path.join(target, e.name);
      if (fs.existsSync(dst)) continue;
      move(path.join(LEGACY_NOVELS, e.name), dst);
      count++;
    }
    if (count) console.log(`[migrate] Moved ${count} novel(s) into the library of user ${ownerId}`);
    try {
      fs.rmdirSync(LEGACY_NOVELS);
    } catch {
      // not empty, leave it
    }
  }
  if (fs.existsSync(LEGACY_BACKUPS) && path.resolve(LEGACY_BACKUPS) !== path.resolve(config.usersDir)) {
    const target = path.join(config.usersDir, String(ownerId), 'backups');
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(LEGACY_BACKUPS)) {
      if (!name.endsWith('.zip')) continue;
      const dst = path.join(target, `legacy-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`);
      if (!fs.existsSync(dst)) move(path.join(LEGACY_BACKUPS, name), dst);
    }
  }
  if (fs.existsSync(LEGACY_BACKGROUNDS)) {
    const target = path.join(config.uploadsDir, 'backgrounds');
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(LEGACY_BACKGROUNDS)) {
      const dst = path.join(target, name);
      if (!fs.existsSync(dst)) fs.copyFileSync(path.join(LEGACY_BACKGROUNDS, name), dst);
    }
  }
}

function hasLegacyNovels() {
  try {
    return fs.readdirSync(LEGACY_NOVELS).length > 0;
  } catch {
    return false;
  }
}

function run() {
  if (meta.get('legacy_migrated')) return;
  const owner = importUsers();
  if (owner) migrateFiles(owner);
  // Without users yet, files are adopted by the first admin during setup.
  if (users.count() > 0) meta.set('legacy_migrated', new Date().toISOString());
}

module.exports = { run, migrateFiles, hasLegacyNovels };
