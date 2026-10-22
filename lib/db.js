'use strict';

const Database = require('better-sqlite3');
const config = require('./config');

const db = new Database(config.dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

// Each entry upgrades the schema by one version. Never edit an existing entry,
// only append new ones.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    disabled INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 0,
    session_version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    last_login_at TEXT
  );

  CREATE TABLE user_settings (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    theme TEXT NOT NULL DEFAULT 'system',
    accent TEXT NOT NULL DEFAULT 'ember',
    timezone TEXT NOT NULL DEFAULT '',
    background_enabled INTEGER NOT NULL DEFAULT 0,
    background_url TEXT NOT NULL DEFAULT '',
    background_dim REAL NOT NULL DEFAULT 0.7,
    background_in_editor INTEGER NOT NULL DEFAULT 0,
    editor_font TEXT NOT NULL DEFAULT 'serif',
    editor_size INTEGER NOT NULL DEFAULT 19,
    editor_width INTEGER NOT NULL DEFAULT 42,
    editor_line_height REAL NOT NULL DEFAULT 1.8,
    editor_spellcheck INTEGER NOT NULL DEFAULT 1,
    editor_typewriter INTEGER NOT NULL DEFAULT 0,
    daily_goal INTEGER NOT NULL DEFAULT 0,
    litewriter_enabled INTEGER NOT NULL DEFAULT 0,
    litewriter_url TEXT NOT NULL DEFAULT '',
    litewriter_username TEXT NOT NULL DEFAULT '',
    litewriter_password TEXT NOT NULL DEFAULT '',
    backup_schedule TEXT NOT NULL DEFAULT 'off',
    backup_keep INTEGER NOT NULL DEFAULT 10,
    backup_include_remote INTEGER NOT NULL DEFAULT 0,
    last_auto_backup_at TEXT,
    drive_tokens TEXT,
    drive_auto_upload INTEGER NOT NULL DEFAULT 0,
    drive_folder_id TEXT
  );

  CREATE TABLE invites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    note TEXT NOT NULL DEFAULT '',
    max_uses INTEGER NOT NULL DEFAULT 1,
    uses INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    expires_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE invite_uses (
    invite_id INTEGER NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    used_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE writing_log (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    novel_key TEXT NOT NULL,
    novel_title TEXT NOT NULL DEFAULT '',
    words_added INTEGER NOT NULL DEFAULT 0,
    words_removed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, day, novel_key)
  );

  CREATE TABLE remote_file_cache (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    version TEXT NOT NULL,
    words INTEGER NOT NULL,
    PRIMARY KEY (user_id, path)
  );

  CREATE TABLE app_meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  `
];

function migrate() {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

migrate();

const SETTINGS_COLUMNS = new Set(
  db.prepare('PRAGMA table_info(user_settings)').all().map(c => c.name).filter(n => n !== 'user_id')
);

const stmts = {
  userById: db.prepare('SELECT * FROM users WHERE id = ?'),
  userByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  userCount: db.prepare('SELECT COUNT(*) AS n FROM users'),
  adminCount: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0"),
  insertUser: db.prepare(`INSERT INTO users (username, password_hash, role, must_change_password)
                          VALUES (@username, @password_hash, @role, @must_change_password)`),
  ensureSettings: db.prepare('INSERT OR IGNORE INTO user_settings (user_id) VALUES (?)'),
  settings: db.prepare('SELECT * FROM user_settings WHERE user_id = ?'),
  getMeta: db.prepare('SELECT value FROM app_meta WHERE key = ?'),
  setMeta: db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
};

const users = {
  count: () => stmts.userCount.get().n,
  adminCount: () => stmts.adminCount.get().n,
  byId: id => stmts.userById.get(id),
  byName: username => stmts.userByName.get(String(username || '').trim()),
  list: () => db.prepare(`SELECT id, username, role, disabled, must_change_password, created_at, last_login_at
                          FROM users ORDER BY created_at, id`).all(),
  create({ username, passwordHash, role = 'user', mustChangePassword = false }) {
    return db.transaction(() => {
      const info = stmts.insertUser.run({
        username: username.trim(),
        password_hash: passwordHash,
        role,
        must_change_password: mustChangePassword ? 1 : 0
      });
      stmts.ensureSettings.run(info.lastInsertRowid);
      return users.byId(info.lastInsertRowid);
    })();
  },
  update(id, fields) {
    const allowed = ['password_hash', 'role', 'disabled', 'must_change_password', 'last_login_at', 'username'];
    const keys = Object.keys(fields).filter(k => allowed.includes(k));
    if (!keys.length) return;
    db.prepare(`UPDATE users SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  },
  bumpSessionVersion(id) {
    db.prepare('UPDATE users SET session_version = session_version + 1 WHERE id = ?').run(id);
    return users.byId(id).session_version;
  },
  remove(id) {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
  }
};

const settings = {
  get(userId) {
    stmts.ensureSettings.run(userId);
    return stmts.settings.get(userId);
  },
  update(userId, fields) {
    const keys = Object.keys(fields).filter(k => SETTINGS_COLUMNS.has(k) && fields[k] !== undefined);
    if (!keys.length) return;
    stmts.ensureSettings.run(userId);
    const values = {};
    for (const k of keys) values[k] = typeof fields[k] === 'boolean' ? (fields[k] ? 1 : 0) : fields[k];
    db.prepare(`UPDATE user_settings SET ${keys.map(k => `${k} = @${k}`).join(', ')} WHERE user_id = @user_id`)
      .run({ ...values, user_id: userId });
  }
};

const meta = {
  get: key => {
    const row = stmts.getMeta.get(key);
    return row ? row.value : null;
  },
  set: (key, value) => stmts.setMeta.run(key, value == null ? null : String(value))
};

module.exports = { db, users, settings, meta };
