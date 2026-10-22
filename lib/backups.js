'use strict';

/**
 * Per-user backups. A backup is a ZIP containing:
 *
 *   manifest.json                 what is inside and when it was made
 *   library/<novelId>/...         the user's local novels, file for file
 *   remote/<Novel>/...            optional snapshot of the LiteWriter novels
 *
 * Restoring only ever touches the local library (never the database and never
 * the LiteWriter device). Backups made by WebWriter 1.x (novels/ + users.db)
 * can be restored as well; their users.db is ignored.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const extract = require('extract-zip');
const config = require('./config');
const library = require('./library');
const litewriter = require('./litewriter');
const { settings: settingsStore } = require('./db');
const { badRequest, notFound, isValidId, slugify } = require('./text');

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,150}\.zip$/;

function backupsDir(userId) {
  return path.join(config.usersDir, String(userId), 'backups');
}

function backupPath(userId, name) {
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.includes('..')) throw notFound('Backup not found.');
  return path.join(backupsDir(userId), name);
}

function kindOf(name) {
  const m = name.match(/^webwriter-(manual|auto|pre-restore)-/);
  if (m) return m[1];
  if (name.startsWith('legacy-')) return 'legacy';
  if (name.startsWith('uploaded-')) return 'uploaded';
  return 'other';
}

async function list(userId) {
  const dir = backupsDir(userId);
  await fsp.mkdir(dir, { recursive: true });
  const out = [];
  for (const name of await fsp.readdir(dir)) {
    if (!NAME_RE.test(name)) continue;
    const stat = await fsp.stat(path.join(dir, name));
    out.push({ name, size: stat.size, created: stat.mtime.toISOString(), kind: kindOf(name) });
  }
  return out.sort((a, b) => b.created.localeCompare(a.created));
}

const stamp = () => new Date().toISOString().replace(/[:]/g, '-').replace(/\..+$/, '');

async function create(userId, { kind = 'manual', includeRemote } = {}) {
  const dir = backupsDir(userId);
  await fsp.mkdir(dir, { recursive: true });
  const s = settingsStore.get(userId);
  if (includeRemote === undefined) includeRemote = Boolean(s.backup_include_remote);
  const name = `webwriter-${kind}-${stamp()}-${crypto.randomBytes(2).toString('hex')}.zip`;
  const target = path.join(dir, name);
  const tmp = `${target}.partial`;

  const manifest = {
    app: 'WebWriter',
    version: config.version,
    format: 2,
    created: new Date().toISOString(),
    kind,
    novels: [],
    remote: null
  };

  const remoteNovels = [];
  if (includeRemote && litewriter.isConfigured(s)) {
    try {
      for (const summary of await litewriter.listNovels(userId, { fresh: true })) {
        remoteNovels.push(await litewriter.loadFullNovel(userId, summary.id));
      }
      manifest.remote = { novels: remoteNovels.map(n => n.novel.id) };
    } catch (err) {
      manifest.remote = { error: err.message };
    }
  }

  const libDir = library.libraryDir(userId);
  await fsp.mkdir(libDir, { recursive: true });
  for (const entry of await fsp.readdir(libDir, { withFileTypes: true })) {
    if (entry.isDirectory() && isValidId(entry.name)) {
      try {
        const meta = await library.readMeta(path.join(libDir, entry.name));
        manifest.novels.push({ id: entry.name, title: meta.title });
      } catch {
        // not a novel
      }
    }
  }

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(tmp);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', err => (err.code === 'ENOENT' ? console.warn('[backup]', err.message) : reject(err)));
    archive.pipe(output);
    archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    for (const n of manifest.novels) archive.directory(path.join(libDir, n.id), `library/${n.id}`);
    for (const full of remoteNovels) {
      const base = `remote/${full.novel.id}`;
      for (const b of full.books) {
        for (const ch of b.chapters) archive.append(ch.content || '', { name: b.isMain ? `${base}/${ch.file}` : `${base}/${b.dir}/${ch.file}` });
      }
      if (full.cover) archive.append(full.cover.data, { name: `${base}/cover${full.cover.ext}` });
    }
    archive.finalize().catch(reject);
  }).catch(async err => {
    await fsp.rm(tmp, { force: true });
    throw err;
  });

  await fsp.rename(tmp, target);
  const stat = await fsp.stat(target);
  return { name, size: stat.size, created: stat.mtime.toISOString(), kind, manifest };
}

async function remove(userId, name) {
  const file = backupPath(userId, name);
  try {
    await fsp.unlink(file);
  } catch {
    throw notFound('Backup not found.');
  }
}

/** Delete old automatic backups, keeping the newest `keep`. */
async function prune(userId, keep) {
  const autos = (await list(userId)).filter(b => b.kind === 'auto' || b.kind === 'pre-restore');
  for (const b of autos.slice(Math.max(1, keep))) await fsp.rm(backupPath(userId, b.name), { force: true });
}

async function findNovelDirs(root) {
  // New format: library/<id>; WebWriter 1.x: novels/<id>
  for (const sub of ['library', 'novels']) {
    const dir = path.join(root, sub);
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      const novels = [];
      for (const e of entries) {
        if (e.isDirectory() && isValidId(e.name) && fs.existsSync(path.join(dir, e.name, 'meta.json'))) novels.push(path.join(dir, e.name));
      }
      if (novels.length) return novels;
    } catch {
      // try next layout
    }
  }
  return [];
}

/**
 * Restore novels from a backup into the library.
 *   mode 'merge'   – novels from the backup replace novels with the same id, everything else is kept
 *   mode 'replace' – the library becomes exactly what is in the backup
 * A safety backup of the current library is always made first.
 */
async function restore(userId, name, { mode = 'merge' } = {}) {
  const file = backupPath(userId, name);
  if (!fs.existsSync(file)) throw notFound('Backup not found.');
  const work = path.join(config.tmpDir, `restore-${userId}-${Date.now()}`);
  await fsp.mkdir(work, { recursive: true });
  try {
    await extract(file, { dir: work });
    const novels = await findNovelDirs(work);
    if (!novels.length) throw badRequest('This backup does not contain any novels.');
    const safety = await create(userId, { kind: 'pre-restore', includeRemote: false });
    const libDir = library.libraryDir(userId);
    await fsp.mkdir(libDir, { recursive: true });
    const restoredIds = new Set(novels.map(n => path.basename(n)));
    if (mode === 'replace') {
      for (const e of await fsp.readdir(libDir, { withFileTypes: true })) {
        if (e.isDirectory() && !restoredIds.has(e.name)) await fsp.rm(path.join(libDir, e.name), { recursive: true, force: true });
      }
    }
    for (const src of novels) {
      const dst = path.join(libDir, path.basename(src));
      await fsp.rm(dst, { recursive: true, force: true });
      await fsp.cp(src, dst, { recursive: true });
    }
    return { restored: novels.length, safetyBackup: safety.name };
  } finally {
    await fsp.rm(work, { recursive: true, force: true });
  }
}

/** Accept an uploaded ZIP into the user's backup list. */
async function importUpload(userId, tmpFile, originalName) {
  const fd = await fsp.open(tmpFile, 'r');
  const sig = Buffer.alloc(4);
  await fd.read(sig, 0, 4, 0);
  await fd.close();
  if (sig.readUInt32LE(0) !== 0x04034b50) throw badRequest('That file is not a ZIP archive.');
  const dir = backupsDir(userId);
  await fsp.mkdir(dir, { recursive: true });
  const base = slugify(path.basename(originalName || 'backup', '.zip'), 'backup');
  const name = `uploaded-${stamp()}-${base}.zip`.slice(0, 150);
  await fsp.copyFile(tmpFile, path.join(dir, name));
  return name;
}

module.exports = { backupsDir, backupPath, list, create, remove, prune, restore, importUpload };
