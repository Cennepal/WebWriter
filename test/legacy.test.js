'use strict';

/* Migration from WebWriter 1.x: users.db + data/novels + data/backups. */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

test('1.x installations are migrated on first start', async () => {
  // Build a fake 1.x checkout next to a copy of the app.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webwriter-legacy-'));
  const appRoot = path.join(__dirname, '..');
  for (const dir of ['lib', 'routes', 'views', 'public']) fs.cpSync(path.join(appRoot, dir), path.join(root, dir), { recursive: true });
  fs.copyFileSync(path.join(appRoot, 'package.json'), path.join(root, 'package.json'));

  const Database = require('better-sqlite3');
  const bcrypt = require('bcryptjs');
  fs.mkdirSync(path.join(root, 'database'));
  const legacy = new Database(path.join(root, 'database', 'users.db'));
  legacy.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE user_settings (user_id INTEGER PRIMARY KEY, theme TEXT DEFAULT 'dark', backup_schedule TEXT DEFAULT 'daily', google_drive_token TEXT, google_drive_refresh_token TEXT,
      litewriter_enabled INTEGER DEFAULT 0, litewriter_url TEXT DEFAULT '', litewriter_username TEXT DEFAULT '', litewriter_password TEXT DEFAULT '',
      background_enabled INTEGER DEFAULT 0, background_url TEXT DEFAULT '', background_opacity REAL DEFAULT 0.3, background_editor_enabled INTEGER DEFAULT 0, cloud_backup_schedule TEXT DEFAULT 'manual');`);
  legacy.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run('admin', bcrypt.hashSync('admin', 4));
  legacy.prepare(`INSERT INTO user_settings (user_id, theme, litewriter_enabled, litewriter_url, background_enabled, background_url) VALUES (1, 'light', 1, 'http://phone:8080', 1, '/backgrounds/bg-1.jpg')`).run();
  legacy.close();

  const novel = path.join(root, 'data', 'novels', '1730000000000');
  fs.mkdirSync(path.join(novel, 'Main'), { recursive: true });
  fs.writeFileSync(path.join(novel, 'meta.json'), JSON.stringify({ title: 'Old Novel', cover: '/data/novels/1730000000000/cover.png', created: '2024-01-01T00:00:00.000Z' }));
  fs.writeFileSync(path.join(novel, 'cover.png'), 'png');
  fs.writeFileSync(path.join(novel, 'Main', 'Synopsis.md'), 'Old synopsis');
  fs.writeFileSync(path.join(novel, 'Main', 'Chapter One.md'), 'Old words are here.');
  fs.mkdirSync(path.join(root, 'data', 'backups'));
  fs.writeFileSync(path.join(root, 'data', 'backups', 'backup-2024.zip'), 'zip');
  fs.mkdirSync(path.join(root, 'public', 'backgrounds'), { recursive: true });
  fs.writeFileSync(path.join(root, 'public', 'backgrounds', 'bg-1.jpg'), 'jpg');

  // Load the copied app with its own module cache, resolving dependencies from the real node_modules.
  delete process.env.DATA_DIR;
  process.env.SESSION_SECRET = 'x';
  process.env.NODE_PATH = path.join(appRoot, 'node_modules');
  Module._initPaths();
  const { createApp } = require(path.join(root, 'lib', 'app'));
  const app = createApp();
  const request = require('supertest');
  const { csrfFrom } = require('./helpers');

  const agent = request.agent(app);
  const login = await agent.get('/login');
  const res = await agent.post('/login').type('form').send({ _csrf: csrfFrom(login.text), username: 'admin', password: 'admin' });
  assert.equal(res.status, 302);
  const forced = await agent.get('/library');
  assert.equal(forced.headers.location, '/account/password', 'admin/admin must be changed');

  const libDir = path.join(root, 'data', 'users', '1', 'library', '1730000000000');
  assert.ok(fs.existsSync(path.join(libDir, 'Main', 'Chapter One.md')), 'novel moved into the owner library');
  assert.ok(fs.existsSync(path.join(root, 'data', 'users', '1', 'backups', 'legacy-backup-2024.zip')));
  assert.ok(fs.existsSync(path.join(root, 'data', 'uploads', 'backgrounds', 'bg-1.jpg')));

  const library = require(path.join(root, 'lib', 'library'));
  const { novel: n } = await library.getNovel(1, '1730000000000');
  assert.equal(n.title, 'Old Novel');
  assert.equal(n.words, 4);
  assert.ok(n.hasCover, 'legacy cover path is understood');

  const { settings } = require(path.join(root, 'lib', 'db'));
  const s = settings.get(1);
  assert.equal(s.theme, 'light');
  assert.equal(s.litewriter_url, 'http://phone:8080');
  assert.equal(s.background_url, '/uploads/backgrounds/bg-1.jpg');
  assert.equal(s.backup_schedule, 'daily');
});
