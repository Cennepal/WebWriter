'use strict';

/**
 * Local novel storage.
 *
 * Layout on disk (compatible with WebWriter 1.x):
 *
 *   <data>/users/<userId>/library/<novelId>/
 *     meta.json          title, author, timestamps, ordering
 *     cover.<ext>        optional cover image
 *     Main/Synopsis.md   the synopsis
 *     Main/*.md          chapters of the main book
 *     <Book>/*.md        chapters of further books
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { countWords, naturalCompare, checkName, newName, toFileName, fromFileName, fileNameCandidates, isValidId, notFound, badRequest, conflict } = require('./text');

const MAIN_BOOK = 'Main';
const SYNOPSIS = 'Synopsis';
const COVER_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

function libraryDir(userId) {
  return path.join(config.usersDir, String(userId), 'library');
}

function novelDir(userId, novelId) {
  if (!isValidId(novelId)) throw notFound('Novel not found.');
  return path.join(libraryDir(userId), novelId);
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find an existing book directory or chapter file by its display name. Files we
 * create use safe look-alike characters; files from elsewhere may use the plain
 * ones. Returns null if nothing exists.
 */
async function locate(parent, name, suffix = '') {
  for (const candidate of fileNameCandidates(name)) {
    const p = path.join(parent, candidate + suffix);
    if (await exists(p)) return p;
  }
  return null;
}

/** Where a new book or chapter with this name is created. */
const newPath = (parent, name, suffix = '') => path.join(parent, toFileName(name) + suffix);

async function bookDirOf(dir, rawBook) {
  const book = checkName(rawBook, 'Book name');
  return { book, bookDir: await locate(dir, book) };
}

async function chapterFileOf(dir, rawBook, rawChapter) {
  const { book, bookDir } = await bookDirOf(dir, rawBook);
  const chapter = checkName(rawChapter, 'Chapter name');
  return { book, chapter, bookDir, file: bookDir ? await locate(bookDir, chapter, '.md') : null };
}

async function writeFileAtomic(file, data) {
  const tmp = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

const versionOf = stat => `${Math.floor(stat.mtimeMs)}-${stat.size}`;

// Word counts are cached per file and invalidated by mtime/size, so listing a
// large library does not re-read every chapter on every page load.
const wordCache = new Map();
async function fileWords(file, stat) {
  const key = versionOf(stat);
  const cached = wordCache.get(file);
  if (cached && cached.key === key) return cached.words;
  const words = countWords(await fsp.readFile(file, 'utf8'));
  wordCache.set(file, { key, words });
  return words;
}

async function readMeta(dir) {
  const raw = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
  const meta = {
    title: raw.title || 'Untitled',
    author: raw.author || '',
    language: raw.language || 'en',
    created: raw.created || new Date().toISOString(),
    lastModified: raw.lastModified || raw.created || new Date().toISOString(),
    coverFile: raw.coverFile || null,
    order: raw.order && typeof raw.order === 'object' ? raw.order : { books: [], chapters: {} },
    lastChapter: raw.lastChapter || null,
    // 1.x sometimes kept the synopsis in meta.json only
    legacySynopsis: typeof raw.synopsis === 'string' ? raw.synopsis : ''
  };
  if (!meta.order.books) meta.order.books = [];
  if (!meta.order.chapters) meta.order.chapters = {};
  // WebWriter 1.x stored a public URL like /data/novels/<id>/cover.png
  if (!raw.coverFile && typeof raw.cover === 'string') {
    const m = raw.cover.match(/(cover\.[a-z0-9]+)$/i);
    if (m && (await exists(path.join(dir, m[1])))) meta.coverFile = m[1];
  }
  return meta;
}

async function writeMeta(dir, meta) {
  const { legacySynopsis, ...stored } = meta;
  if (legacySynopsis) stored.synopsis = legacySynopsis;
  await writeFileAtomic(path.join(dir, 'meta.json'), JSON.stringify(stored, null, 2));
}

async function touch(dir, extra = {}) {
  const meta = await readMeta(dir);
  Object.assign(meta, extra, { lastModified: new Date().toISOString() });
  await writeMeta(dir, meta);
  return meta;
}

function sortByOrder(names, order = [], pinned = []) {
  const rank = new Map(order.map((n, i) => [n, i]));
  return [...names].sort((a, b) => {
    const pa = pinned.indexOf(a);
    const pb = pinned.indexOf(b);
    if (pa !== -1 || pb !== -1) return (pa === -1 ? Infinity : pa) - (pb === -1 ? Infinity : pb);
    const ra = rank.has(a) ? rank.get(a) : Infinity;
    const rb = rank.has(b) ? rank.get(b) : Infinity;
    if (ra !== rb) return ra - rb;
    return naturalCompare(a, b);
  });
}

async function readStructure(dir, meta) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const dirs = new Map(entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => [fromFileName(e.name), e.name]));
  const bookNames = sortByOrder([...dirs.keys()], meta.order.books, [MAIN_BOOK]);
  const books = [];
  for (const name of bookNames) {
    const bookDir = path.join(dir, dirs.get(name));
    const files = new Map(
      (await fsp.readdir(bookDir, { withFileTypes: true }))
        .filter(f => f.isFile() && f.name.toLowerCase().endsWith('.md') && !f.name.startsWith('.'))
        .map(f => [fromFileName(f.name.slice(0, -3)), f.name])
    );
    const chapterNames = sortByOrder([...files.keys()], meta.order.chapters[name], name === MAIN_BOOK ? [SYNOPSIS] : []);
    const chapters = [];
    for (const chapterName of chapterNames) {
      const file = path.join(bookDir, files.get(chapterName));
      const stat = await fsp.stat(file);
      chapters.push({
        name: chapterName,
        file: files.get(chapterName),
        words: await fileWords(file, stat),
        updatedAt: stat.mtime.toISOString(),
        isSynopsis: name === MAIN_BOOK && chapterName === SYNOPSIS
      });
    }
    books.push({
      name,
      dir: dirs.get(name),
      isMain: name === MAIN_BOOK,
      chapters,
      words: chapters.reduce((sum, c) => sum + (c.isSynopsis ? 0 : c.words), 0)
    });
  }
  return books;
}

function summarize(id, meta, books, synopsis) {
  const chapters = books.flatMap(b => b.chapters.filter(c => !c.isSynopsis));
  return {
    id,
    source: 'local',
    title: meta.title,
    author: meta.author,
    language: meta.language,
    synopsis,
    hasCover: Boolean(meta.coverFile),
    coverUrl: meta.coverFile ? `/covers/local/${id}?v=${encodeURIComponent(meta.lastModified)}` : null,
    words: books.reduce((s, b) => s + b.words, 0),
    bookCount: books.length,
    chapterCount: chapters.length,
    created: meta.created,
    updatedAt: meta.lastModified,
    lastChapter: meta.lastChapter
  };
}

async function readSynopsis(dir) {
  try {
    return await fsp.readFile(path.join(dir, MAIN_BOOK, `${SYNOPSIS}.md`), 'utf8');
  } catch {
    return '';
  }
}

async function listNovels(userId) {
  const root = libraryDir(userId);
  await fsp.mkdir(root, { recursive: true });
  const entries = await fsp.readdir(root, { withFileTypes: true });
  const novels = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidId(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      const meta = await readMeta(dir);
      const books = await readStructure(dir, meta);
      novels.push(summarize(entry.name, meta, books, (await readSynopsis(dir)) || meta.legacySynopsis));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[library] Skipping unreadable novel ${entry.name}: ${err.message}`);
    }
  }
  novels.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return novels;
}

async function openNovel(userId, novelId) {
  const dir = novelDir(userId, novelId);
  if (!(await exists(path.join(dir, 'meta.json')))) throw notFound('Novel not found.');
  return dir;
}

async function getNovel(userId, novelId) {
  const dir = await openNovel(userId, novelId);
  const meta = await readMeta(dir);
  const books = await readStructure(dir, meta);
  return { novel: summarize(novelId, meta, books, (await readSynopsis(dir)) || meta.legacySynopsis), books };
}

function newNovelId() {
  return Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
}

async function createNovel(userId, { title, synopsis = '', author = '' }) {
  title = String(title || '').trim();
  if (!title) throw badRequest('Please give your novel a title.');
  const id = newNovelId();
  const dir = novelDir(userId, id);
  await fsp.mkdir(path.join(dir, MAIN_BOOK), { recursive: true });
  await fsp.writeFile(path.join(dir, MAIN_BOOK, `${SYNOPSIS}.md`), String(synopsis));
  const now = new Date().toISOString();
  await writeMeta(dir, {
    title: title.slice(0, 200),
    author: String(author).trim().slice(0, 200),
    language: 'en',
    created: now,
    lastModified: now,
    coverFile: null,
    order: { books: [MAIN_BOOK], chapters: {} },
    lastChapter: null
  });
  return id;
}

async function updateNovel(userId, novelId, { title, synopsis, author, language }) {
  const dir = await openNovel(userId, novelId);
  const meta = await readMeta(dir);
  if (title !== undefined) {
    title = String(title).trim();
    if (!title) throw badRequest('The title cannot be empty.');
    meta.title = title.slice(0, 200);
  }
  if (author !== undefined) meta.author = String(author).trim().slice(0, 200);
  if (language !== undefined && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(language)) meta.language = language;
  if (synopsis !== undefined) {
    meta.legacySynopsis = '';
    await fsp.mkdir(path.join(dir, MAIN_BOOK), { recursive: true });
    await writeFileAtomic(path.join(dir, MAIN_BOOK, `${SYNOPSIS}.md`), String(synopsis));
  }
  meta.lastModified = new Date().toISOString();
  await writeMeta(dir, meta);
}

async function setCover(userId, novelId, tmpFile, originalName) {
  const dir = await openNovel(userId, novelId);
  const ext = path.extname(originalName || '').toLowerCase();
  if (!COVER_TYPES[ext]) throw badRequest('Covers must be JPG, PNG, GIF or WebP images.');
  const meta = await readMeta(dir);
  if (meta.coverFile) await fsp.rm(path.join(dir, meta.coverFile), { force: true });
  const coverFile = `cover${ext}`;
  await fsp.copyFile(tmpFile, path.join(dir, coverFile));
  meta.coverFile = coverFile;
  meta.lastModified = new Date().toISOString();
  await writeMeta(dir, meta);
}

async function removeCover(userId, novelId) {
  const dir = await openNovel(userId, novelId);
  const meta = await readMeta(dir);
  if (meta.coverFile) await fsp.rm(path.join(dir, meta.coverFile), { force: true });
  meta.coverFile = null;
  meta.lastModified = new Date().toISOString();
  await writeMeta(dir, meta);
}

async function getCover(userId, novelId) {
  const dir = await openNovel(userId, novelId);
  const meta = await readMeta(dir);
  if (!meta.coverFile) return null;
  const file = path.join(dir, meta.coverFile);
  if (!(await exists(file))) return null;
  return { file, type: COVER_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' };
}

async function deleteNovel(userId, novelId) {
  const dir = await openNovel(userId, novelId);
  await fsp.rm(dir, { recursive: true, force: true });
}

async function createBook(userId, novelId, rawName) {
  const dir = await openNovel(userId, novelId);
  const name = newName(rawName, 'Book name');
  if (await locate(dir, name)) throw conflict(`A book called "${name}" already exists.`);
  await fsp.mkdir(newPath(dir, name));
  const meta = await readMeta(dir);
  meta.order.books = [...meta.order.books.filter(b => b !== name), name];
  meta.lastModified = new Date().toISOString();
  await writeMeta(dir, meta);
  return name;
}

async function renameBook(userId, novelId, rawFrom, rawTo) {
  const dir = await openNovel(userId, novelId);
  const { book: from, bookDir } = await bookDirOf(dir, rawFrom);
  const to = newName(rawTo, 'Book name');
  if (from === MAIN_BOOK) throw badRequest('The main book cannot be renamed.');
  if (to === MAIN_BOOK) throw badRequest('"Main" is reserved for the main book.');
  if (!bookDir) throw notFound('Book not found.');
  if (from === to) return to;
  const target = await locate(dir, to);
  if (target && target !== bookDir) throw conflict(`A book called "${to}" already exists.`);
  await fsp.rename(bookDir, newPath(dir, to));
  const meta = await readMeta(dir);
  meta.order.books = meta.order.books.map(b => (b === from ? to : b));
  if (meta.order.chapters[from]) {
    meta.order.chapters[to] = meta.order.chapters[from];
    delete meta.order.chapters[from];
  }
  if (meta.lastChapter && meta.lastChapter.book === from) meta.lastChapter.book = to;
  meta.lastModified = new Date().toISOString();
  await writeMeta(dir, meta);
  return to;
}

async function deleteBook(userId, novelId, rawName) {
  const dir = await openNovel(userId, novelId);
  const { book: name, bookDir } = await bookDirOf(dir, rawName);
  if (name === MAIN_BOOK) throw badRequest('The main book cannot be deleted.');
  if (!bookDir) throw notFound('Book not found.');
  await fsp.rm(bookDir, { recursive: true, force: true });
  const meta = await readMeta(dir);
  meta.order.books = meta.order.books.filter(b => b !== name);
  delete meta.order.chapters[name];
  if (meta.lastChapter && meta.lastChapter.book === name) meta.lastChapter = null;
  meta.lastModified = new Date().toISOString();
  await writeMeta(dir, meta);
}

async function createChapter(userId, novelId, rawBook, rawName, content = '') {
  const dir = await openNovel(userId, novelId);
  let { book, bookDir } = await bookDirOf(dir, rawBook);
  const name = newName(rawName, 'Chapter name');
  if (!bookDir) {
    if (book !== MAIN_BOOK) throw notFound('Book not found.');
    bookDir = path.join(dir, MAIN_BOOK);
    await fsp.mkdir(bookDir, { recursive: true });
  }
  if (await locate(bookDir, name, '.md')) throw conflict(`A chapter called "${name}" already exists in this book.`);
  await fsp.writeFile(newPath(bookDir, name, '.md'), content);
  const meta = await readMeta(dir);
  const order = meta.order.chapters[book] || [];
  meta.order.chapters[book] = [...order.filter(c => c !== name), name];
  meta.lastModified = new Date().toISOString();
  await writeMeta(dir, meta);
  return name;
}

async function renameChapter(userId, novelId, rawBook, rawFrom, rawTo) {
  const dir = await openNovel(userId, novelId);
  const { book, chapter: from, bookDir, file } = await chapterFileOf(dir, rawBook, rawFrom);
  const to = newName(rawTo, 'Chapter name');
  if (book === MAIN_BOOK && from === SYNOPSIS) throw badRequest('The synopsis cannot be renamed.');
  if (!file) throw notFound('Chapter not found.');
  if (from === to) return to;
  const target = await locate(bookDir, to, '.md');
  if (target && target !== file) throw conflict(`A chapter called "${to}" already exists in this book.`);
  await fsp.rename(file, newPath(bookDir, to, '.md'));
  wordCache.delete(file);
  const meta = await readMeta(dir);
  if (meta.order.chapters[book]) meta.order.chapters[book] = meta.order.chapters[book].map(c => (c === from ? to : c));
  if (meta.lastChapter && meta.lastChapter.book === book && meta.lastChapter.chapter === from) meta.lastChapter.chapter = to;
  meta.lastModified = new Date().toISOString();
  await writeMeta(dir, meta);
  return to;
}

async function deleteChapter(userId, novelId, rawBook, rawName) {
  const dir = await openNovel(userId, novelId);
  const { book, chapter: name, file } = await chapterFileOf(dir, rawBook, rawName);
  if (book === MAIN_BOOK && name === SYNOPSIS) throw badRequest('The synopsis cannot be deleted.');
  if (!file) throw notFound('Chapter not found.');
  await fsp.rm(file);
  wordCache.delete(file);
  const meta = await readMeta(dir);
  if (meta.order.chapters[book]) meta.order.chapters[book] = meta.order.chapters[book].filter(c => c !== name);
  if (meta.lastChapter && meta.lastChapter.book === book && meta.lastChapter.chapter === name) meta.lastChapter = null;
  meta.lastModified = new Date().toISOString();
  await writeMeta(dir, meta);
}

/** Move a chapter to another book (keeps its content). */
async function moveChapter(userId, novelId, rawFromBook, rawName, rawToBook) {
  const dir = await openNovel(userId, novelId);
  const { book: fromBook, chapter: name, file } = await chapterFileOf(dir, rawFromBook, rawName);
  const { book: toBook, bookDir: toDir } = await bookDirOf(dir, rawToBook);
  if (fromBook === toBook) return;
  if (fromBook === MAIN_BOOK && name === SYNOPSIS) throw badRequest('The synopsis cannot be moved.');
  if (!file) throw notFound('Chapter not found.');
  if (!toDir) throw notFound('Target book not found.');
  if (await locate(toDir, name, '.md')) throw conflict(`"${toBook}" already has a chapter called "${name}".`);
  await fsp.rename(file, path.join(toDir, path.basename(file)));
  wordCache.delete(file);
  const meta = await readMeta(dir);
  if (meta.order.chapters[fromBook]) meta.order.chapters[fromBook] = meta.order.chapters[fromBook].filter(c => c !== name);
  meta.order.chapters[toBook] = [...(meta.order.chapters[toBook] || []).filter(c => c !== name), name];
  meta.lastModified = new Date().toISOString();
  await writeMeta(dir, meta);
}

/** Persist a new ordering. Unknown names are ignored, missing ones keep their natural position. */
async function reorder(userId, novelId, { books, chapters }) {
  const dir = await openNovel(userId, novelId);
  const meta = await readMeta(dir);
  if (Array.isArray(books)) meta.order.books = books.map(String);
  if (chapters && typeof chapters === 'object') {
    for (const [book, list] of Object.entries(chapters)) {
      if (Array.isArray(list)) meta.order.chapters[book] = list.map(String);
    }
  }
  await writeMeta(dir, meta);
}

async function readChapter(userId, novelId, book, chapter) {
  const dir = await openNovel(userId, novelId);
  const { file } = await chapterFileOf(dir, book, chapter);
  if (!file) throw notFound('Chapter not found.');
  const stat = await fsp.stat(file);
  const content = await fsp.readFile(file, 'utf8');
  return { content, version: versionOf(stat), words: countWords(content), updatedAt: stat.mtime.toISOString() };
}

/**
 * Save a chapter. If `baseVersion` is given and the file changed since then
 * (e.g. edited in another tab), a 409 is raised unless `force` is set.
 */
async function writeChapter(userId, novelId, book, chapter, content, { baseVersion, force } = {}) {
  const dir = await openNovel(userId, novelId);
  const found = await chapterFileOf(dir, book, chapter);
  if (!found.bookDir) throw notFound('Book not found.');
  // A chapter deleted elsewhere while open is simply recreated.
  const file = found.file || newPath(found.bookDir, found.chapter, '.md');
  let oldContent = '';
  if (found.file) {
    const stat = await fsp.stat(file);
    if (baseVersion && !force && versionOf(stat) !== baseVersion) {
      throw conflict('This chapter was changed somewhere else since you opened it.', { code: 'CONFLICT' });
    }
    oldContent = await fsp.readFile(file, 'utf8');
  }
  await writeFileAtomic(file, content);
  const stat = await fsp.stat(file);
  const words = countWords(content);
  wordCache.set(file, { key: versionOf(stat), words });
  const meta = await touch(dir, { lastChapter: { book, chapter } });
  return { version: versionOf(stat), words, previousWords: countWords(oldContent), title: meta.title };
}

async function rememberLastChapter(userId, novelId, book, chapter) {
  try {
    const dir = await openNovel(userId, novelId);
    const meta = await readMeta(dir);
    meta.lastChapter = { book, chapter };
    await writeMeta(dir, meta);
  } catch {
    // Not important enough to fail a request over.
  }
}

/** Read every chapter (in order) for exports and backups. */
async function loadFullNovel(userId, novelId) {
  const { novel, books } = await getNovel(userId, novelId);
  const dir = novelDir(userId, novelId);
  for (const book of books) {
    for (const ch of book.chapters) {
      ch.content = await fsp.readFile(path.join(dir, book.dir, ch.file), 'utf8');
    }
  }
  const cover = await getCover(userId, novelId);
  return { novel, books, cover: cover ? { data: await fsp.readFile(cover.file), type: cover.type, ext: path.extname(cover.file) } : null };
}

module.exports = {
  MAIN_BOOK,
  SYNOPSIS,
  COVER_TYPES,
  libraryDir,
  novelDir,
  listNovels,
  getNovel,
  createNovel,
  updateNovel,
  setCover,
  removeCover,
  getCover,
  deleteNovel,
  createBook,
  renameBook,
  deleteBook,
  createChapter,
  renameChapter,
  deleteChapter,
  moveChapter,
  reorder,
  readChapter,
  writeChapter,
  rememberLastChapter,
  loadFullNovel,
  readMeta,
  writeMeta,
  newNovelId
};
