'use strict';

/**
 * LiteWriter (Android app) integration over WebDAV.
 *
 * How LiteWriter lays out its files on the WebDAV share:
 *
 *   /<Novel_Name>/                  one directory per novel ("_" shows as a space)
 *     cover.jpg|png|webp|svg       optional cover image
 *     Synopsis.md (or Intro.md)    the synopsis
 *     *.md, *.txt                  chapters of the main book
 *     <Book>/*.md, *.txt           chapters of further books
 *
 * Talking to a phone is slow and unreliable, so everything here is built to
 * never block a page: requests time out, run with bounded concurrency over
 * keep-alive connections, directory listings are cached briefly and word
 * counts are cached per file (keyed on etag/mtime/size) in the database, so
 * only files that actually changed are downloaded again.
 */

const http = require('http');
const https = require('https');
const path = require('path').posix;
const { createClient } = require('webdav');
const config = require('./config');
const { db, settings: settingsStore } = require('./db');
const { AppError, countWords, naturalCompare, checkName, newName, toFileName, fromFileName, fileNameCandidates, notFound, conflict, mapLimit } = require('./text');

const MAIN_BOOK = 'Main';
const SYNOPSIS_FILES = ['Synopsis.md', 'Intro.md'];
const TEXT_RE = /\.(md|txt)$/i;
const COVER_RE = /cover\.(jpg|jpeg|png|svg|webp|gif)$/i;
const COVER_TYPES = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
};

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 });

const clients = new Map(); // userId -> { key, client }
const listCache = new Map(); // userId -> { at, data, promise }
const coverCache = new Map(); // `${userId}:${path}` -> { version, data, type }

class NotConfiguredError extends AppError {
  constructor() {
    super(400, 'LiteWriter is not set up yet. Add your device in Settings → LiteWriter.', { code: 'NOT_CONFIGURED' });
  }
}

function isConfigured(s) {
  return Boolean(s && s.litewriter_enabled && s.litewriter_url);
}

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
  return u.replace(/\/+$/, '');
}

function getClient(userId, overrideSettings) {
  const s = overrideSettings || settingsStore.get(userId);
  if (!isConfigured(s)) throw new NotConfiguredError();
  const url = normalizeUrl(s.litewriter_url);
  const key = `${url}\n${s.litewriter_username}\n${s.litewriter_password}`;
  if (!overrideSettings) {
    const cached = clients.get(userId);
    if (cached && cached.key === key) return cached.client;
  }
  const client = createClient(url, {
    username: s.litewriter_username || undefined,
    password: s.litewriter_password || undefined,
    httpAgent,
    httpsAgent,
    maxContentLength: 64 * 1024 * 1024,
    maxBodyLength: 64 * 1024 * 1024
  });
  if (!overrideSettings) {
    clients.set(userId, { key, client });
    listCache.delete(userId);
  }
  return client;
}

const opts = (extra = {}) => ({ signal: AbortSignal.timeout(config.litewriter.timeoutMs), ...extra });

/** Turn low-level network/WebDAV errors into something a person can act on. */
function friendlyError(err) {
  if (err instanceof AppError) return err;
  const status = err.status || (err.response && err.response.status);
  const code = err.code || (err.cause && err.cause.code);
  let message;
  if (status === 401 || status === 403) message = 'The device rejected the username or password.';
  else if (status === 404) message = 'That file or folder no longer exists on the device.';
  else if (code === 'ECONNREFUSED') message = 'The device refused the connection. Is the WebDAV server running in LiteWriter?';
  else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    message = 'The device could not be reached. Check that it is online and on the same network (or Tailscale).';
  } else if (err.name === 'AbortError' || err.name === 'TimeoutError' || code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ERR_CANCELED') {
    message = 'The device took too long to answer. It may be asleep or the WebDAV server may have stopped.';
  } else if (code === 'ECONNRESET') message = 'The connection to the device was interrupted.';
  else message = `LiteWriter error: ${err.message || err}`;
  return new AppError(status === 404 ? 404 : 502, message, { code: 'REMOTE_ERROR' });
}

async function remote(fn) {
  try {
    return await fn();
  } catch (err) {
    throw friendlyError(err);
  }
}

const versionOf = stat => stat.etag || `${stat.lastmod}|${stat.size}`;
const isHidden = name => name.startsWith('.');

function titleFromDir(dirName) {
  let title = dirName;
  try {
    title = decodeURIComponent(dirName);
  } catch {
    // keep as is
  }
  return title.replace(/_/g, ' ');
}

function novelPath(novelId) {
  const name = String(novelId || '');
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') throw notFound('Novel not found.');
  return `/${name}`;
}

const statusOf = err => err.status || (err.response && err.response.status);

/** stat() that returns null for missing files instead of throwing. */
async function statOrNull(client, p) {
  try {
    return await client.stat(p, opts());
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
}

/**
 * Find a book folder by its display name. LiteWriter's own folders may use
 * characters like ":" literally; folders we create use safe look-alikes.
 */
async function resolveBookPath(client, novelId, rawBook) {
  const book = checkName(rawBook, 'Book name');
  if (book === MAIN_BOOK) return novelPath(novelId);
  for (const candidate of fileNameCandidates(book)) {
    const p = path.join(novelPath(novelId), candidate);
    const stat = await statOrNull(client, p);
    if (stat && stat.type === 'directory') return p;
  }
  throw notFound('Book not found on the device.');
}

const cacheGet = db.prepare('SELECT version, words FROM remote_file_cache WHERE user_id = ? AND path = ?');
const cachePut = db.prepare(`INSERT INTO remote_file_cache (user_id, path, version, words) VALUES (?, ?, ?, ?)
  ON CONFLICT(user_id, path) DO UPDATE SET version = excluded.version, words = excluded.words`);

async function wordsFor(client, userId, stat) {
  const version = versionOf(stat);
  const cached = cacheGet.get(userId, stat.filename);
  if (cached && cached.version === version) return cached.words;
  const text = await client.getFileContents(stat.filename, opts({ format: 'text' }));
  const words = countWords(String(text));
  cachePut.run(userId, stat.filename, version, words);
  return words;
}

async function listDir(client, dir) {
  const items = await client.getDirectoryContents(dir, opts());
  return items.filter(i => !isHidden(i.basename));
}

function pickCover(files) {
  return files.find(f => /^cover\./i.test(f.basename) && COVER_RE.test(f.basename)) || files.find(f => COVER_RE.test(f.basename)) || null;
}

function sortChapters(stats) {
  return [...stats].sort((a, b) => naturalCompare(a.basename, b.basename));
}

/**
 * Read a novel's structure. With `withWords` the word count of each chapter is
 * resolved (from cache where possible).
 */
async function readNovel(client, userId, dirStat, { withWords = true } = {}) {
  const id = dirStat.basename;
  const root = novelPath(id);
  const contents = await listDir(client, root);
  const files = contents.filter(c => c.type === 'file');
  const subdirs = contents.filter(c => c.type === 'directory').sort((a, b) => naturalCompare(a.basename, b.basename));

  const synopsisStat = SYNOPSIS_FILES.map(n => files.find(f => f.basename === n)).find(Boolean) || null;
  const rootTexts = sortChapters(files.filter(f => TEXT_RE.test(f.basename) && f !== synopsisStat));

  const bookStats = [];
  if (synopsisStat || rootTexts.length || !subdirs.length) {
    bookStats.push({ name: MAIN_BOOK, dir: '', files: synopsisStat ? [synopsisStat, ...rootTexts] : rootTexts });
  }
  const subLists = await mapLimit(subdirs, config.litewriter.concurrency, async sub => {
    const items = await listDir(client, sub.filename);
    return { name: fromFileName(sub.basename), dir: sub.basename, files: sortChapters(items.filter(i => i.type === 'file' && TEXT_RE.test(i.basename))) };
  });
  bookStats.push(...subLists);

  const allFiles = bookStats.flatMap(b => b.files);
  const words = withWords
    ? new Map(await mapLimit(allFiles, config.litewriter.concurrency, async f => [f.filename, await wordsFor(client, userId, f)]))
    : new Map();

  let latest = dirStat.lastmod ? new Date(dirStat.lastmod) : new Date(0);
  const books = bookStats.map(b => {
    const chapters = b.files.map(f => {
      const updated = f.lastmod ? new Date(f.lastmod) : null;
      if (updated && updated > latest) latest = updated;
      return {
        name: fromFileName(f.basename.replace(TEXT_RE, '')),
        file: f.basename,
        words: words.get(f.filename) || 0,
        updatedAt: updated ? updated.toISOString() : null,
        isSynopsis: f === synopsisStat
      };
    });
    return {
      name: b.name,
      dir: b.dir,
      isMain: b.name === MAIN_BOOK,
      chapters,
      words: chapters.reduce((s, c) => s + (c.isSynopsis ? 0 : c.words), 0)
    };
  });

  const coverStat = pickCover(files);
  return {
    id,
    books,
    paths: allFiles.map(f => f.filename),
    synopsisStat,
    coverStat,
    summary: {
      id,
      source: 'remote',
      title: titleFromDir(id),
      author: '',
      language: 'en',
      synopsis: '',
      hasCover: Boolean(coverStat),
      coverUrl: coverStat ? `/covers/remote/${encodeURIComponent(id)}?v=${encodeURIComponent(versionOf(coverStat))}` : null,
      words: books.reduce((s, b) => s + b.words, 0),
      bookCount: books.length,
      chapterCount: books.reduce((s, b) => s + b.chapters.filter(c => !c.isSynopsis).length, 0),
      updatedAt: latest.getTime() ? latest.toISOString() : null
    }
  };
}

async function readSynopsis(client, stat) {
  if (!stat) return '';
  try {
    return String(await client.getFileContents(stat.filename, opts({ format: 'text' })));
  } catch {
    return '';
  }
}

const cachePaths = db.prepare('SELECT path FROM remote_file_cache WHERE user_id = ?');
const cacheDelete = db.prepare('DELETE FROM remote_file_cache WHERE user_id = ? AND path = ?');

async function fetchNovels(userId) {
  const client = getClient(userId);
  const root = await listDir(client, '/');
  const dirs = root.filter(i => i.type === 'directory');
  let complete = true;
  const results = await mapLimit(dirs, config.litewriter.concurrency, async dir => {
    try {
      const n = await readNovel(client, userId, dir);
      n.summary.synopsis = await readSynopsis(client, n.synopsisStat);
      return n;
    } catch (err) {
      complete = false;
      console.warn(`[litewriter] Could not read novel "${dir.basename}": ${err.message}`);
      return null;
    }
  });
  const novels = results.filter(Boolean);
  // Forget cached word counts of files that no longer exist on the device.
  if (complete) {
    const seen = new Set(novels.flatMap(n => n.paths));
    db.transaction(() => {
      for (const { path: p } of cachePaths.all(userId)) if (!seen.has(p)) cacheDelete.run(userId, p);
    })();
  }
  return novels.map(n => n.summary).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function clearCache(userId) {
  db.prepare('DELETE FROM remote_file_cache WHERE user_id = ?').run(userId);
  listCache.delete(userId);
}

/**
 * List remote novels. Results are cached for a short while and concurrent
 * callers share one in-flight request.
 */
async function listNovels(userId, { fresh = false } = {}) {
  const entry = listCache.get(userId);
  if (entry && entry.promise) return entry.promise;
  if (!fresh && entry && entry.data && Date.now() - entry.at < config.litewriter.listCacheMs) {
    return entry.data;
  }
  const promise = remote(() => fetchNovels(userId))
    .then(data => {
      listCache.set(userId, { at: Date.now(), data });
      return data;
    })
    .catch(err => {
      listCache.set(userId, entry && entry.data ? { at: entry.at, data: entry.data } : {});
      throw err;
    });
  listCache.set(userId, { ...(entry || {}), promise });
  return promise;
}

function invalidate(userId) {
  const entry = listCache.get(userId);
  if (entry && !entry.promise) listCache.delete(userId);
}

async function getNovel(userId, novelId) {
  return remote(async () => {
    const client = getClient(userId);
    const root = novelPath(novelId);
    let dirStat;
    try {
      dirStat = await client.stat(root, opts());
    } catch (err) {
      if ((err.status || (err.response && err.response.status)) === 404) throw notFound('Novel not found on the device.');
      throw err;
    }
    if (dirStat.type !== 'directory') throw notFound('Novel not found on the device.');
    dirStat.basename = dirStat.basename || novelId;
    const n = await readNovel(client, userId, { ...dirStat, basename: novelId });
    n.summary.synopsis = await readSynopsis(client, n.synopsisStat);
    return { novel: n.summary, books: n.books };
  });
}

async function resolveChapter(client, novelId, book, chapter) {
  const name = checkName(chapter, 'Chapter name');
  const dir = await resolveBookPath(client, novelId, book);
  // Try the name exactly as LiteWriter would write it first, then our safe variant.
  const candidates = fileNameCandidates(name).reverse();
  for (const candidate of candidates) {
    for (const ext of ['.md', '.txt']) {
      const p = path.join(dir, candidate + ext);
      const stat = await statOrNull(client, p);
      if (stat && stat.type === 'file') return { path: p, stat, dir };
    }
  }
  return { path: path.join(dir, `${toFileName(name)}.md`), stat: null, dir };
}

async function readChapter(userId, novelId, book, chapter) {
  return remote(async () => {
    const client = getClient(userId);
    const { path: p, stat } = await resolveChapter(client, novelId, book, chapter);
    if (!stat) throw notFound('Chapter not found on the device.');
    const content = String(await client.getFileContents(p, opts({ format: 'text' })));
    const words = countWords(content);
    cachePut.run(userId, p, versionOf(stat), words);
    return { content, version: versionOf(stat), words, updatedAt: stat.lastmod ? new Date(stat.lastmod).toISOString() : null };
  });
}

async function writeChapter(userId, novelId, book, chapter, content, { baseVersion, force } = {}) {
  return remote(async () => {
    const client = getClient(userId);
    const { path: p, stat } = await resolveChapter(client, novelId, book, chapter);
    let previousWords = 0;
    if (stat) {
      const current = versionOf(stat);
      if (baseVersion && !force && current !== baseVersion) {
        throw conflict('This chapter was changed on your device since you opened it.', { code: 'CONFLICT' });
      }
      try {
        previousWords = await wordsFor(client, userId, stat);
      } catch {
        previousWords = 0;
      }
    }
    await client.putFileContents(p, content, opts({ overwrite: true, contentLength: Buffer.byteLength(content) }));
    let version = null;
    try {
      version = versionOf(await client.stat(p, opts()));
    } catch {
      // Some servers are slow to report new metadata; the next save will simply skip the check.
    }
    const words = countWords(content);
    if (version) cachePut.run(userId, p, version, words);
    invalidate(userId);
    return { version, words, previousWords, title: titleFromDir(novelId) };
  });
}

async function createChapter(userId, novelId, book, rawName) {
  return remote(async () => {
    const client = getClient(userId);
    const name = newName(rawName, 'Chapter name');
    const existing = await resolveChapter(client, novelId, book, name);
    if (existing.stat) throw conflict(`A chapter called "${name}" already exists in this book.`);
    // Prefer the plain name like LiteWriter itself would; if the phone's storage
    // refuses characters such as ":" or "?", fall back to safe look-alikes.
    const [safe, literal] = fileNameCandidates(name);
    try {
      await client.putFileContents(path.join(existing.dir, `${literal || safe}.md`), '', opts({ overwrite: false }));
    } catch (err) {
      if (!literal) throw err;
      await client.putFileContents(path.join(existing.dir, `${safe}.md`), '', opts({ overwrite: false }));
    }
    invalidate(userId);
    return name;
  });
}

async function getCover(userId, novelId) {
  return remote(async () => {
    const client = getClient(userId);
    const files = (await listDir(client, novelPath(novelId))).filter(f => f.type === 'file');
    const stat = pickCover(files);
    if (!stat) return null;
    const key = `${userId}:${stat.filename}`;
    const version = versionOf(stat);
    const cached = coverCache.get(key);
    if (cached && cached.version === version) return cached;
    const data = Buffer.from(await client.getFileContents(stat.filename, opts({ format: 'binary' })));
    const ext = stat.basename.split('.').pop().toLowerCase();
    const entry = { version, data, type: COVER_TYPES[ext] || 'application/octet-stream', ext: `.${ext}` };
    coverCache.set(key, entry);
    if (coverCache.size > 200) coverCache.delete(coverCache.keys().next().value);
    return entry;
  });
}

/** Read every chapter (in order) for exports, backups and copying. */
async function loadFullNovel(userId, novelId) {
  const { novel, books } = await getNovel(userId, novelId);
  await remote(async () => {
    const client = getClient(userId);
    const jobs = [];
    for (const book of books) {
      for (const ch of book.chapters) jobs.push({ ch, p: path.join(novelPath(novelId), book.dir, ch.file) });
    }
    await mapLimit(jobs, config.litewriter.concurrency, async ({ ch, p }) => {
      ch.content = String(await client.getFileContents(p, opts({ format: 'text' })));
    });
  });
  let cover = null;
  try {
    const c = await getCover(userId, novelId);
    if (c && c.type !== 'image/svg+xml') cover = { data: c.data, type: c.type, ext: c.ext };
  } catch {
    cover = null;
  }
  return { novel, books, cover };
}

/** Check a connection without saving it. Returns the number of novels found. */
async function testConnection(candidate) {
  return remote(async () => {
    const client = getClient(null, { ...candidate, litewriter_enabled: 1 });
    const items = await client.getDirectoryContents('/', opts());
    return items.filter(i => i.type === 'directory' && !isHidden(i.basename)).length;
  });
}

module.exports = {
  MAIN_BOOK,
  titleFromDir,
  clearCache,
  isConfigured,
  normalizeUrl,
  listNovels,
  invalidate,
  getNovel,
  readChapter,
  writeChapter,
  createChapter,
  getCover,
  loadFullNovel,
  testConnection,
  friendlyError
};
