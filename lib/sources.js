'use strict';

/**
 * One interface over the two places novels live: the local library and the
 * LiteWriter device. Routes talk to this module and never need to care which
 * one they are dealing with.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const library = require('./library');
const litewriter = require('./litewriter');
const stats = require('./stats');
const { notFound, badRequest } = require('./text');

const SOURCES = { local: library, remote: litewriter };

function pick(source) {
  const impl = SOURCES[source];
  if (!impl) throw notFound();
  return impl;
}

function supports(source, action) {
  if (source === 'local') return true;
  return ['read', 'write', 'createChapter', 'export', 'copy'].includes(action);
}

function ensure(source, action) {
  if (!supports(source, action)) throw badRequest('This is not possible for LiteWriter novels. Copy the novel to your library first.');
}

async function getNovel(userId, source, id) {
  return pick(source).getNovel(userId, id);
}

async function readChapter(userId, source, id, book, chapter) {
  const result = await pick(source).readChapter(userId, id, book, chapter);
  if (source === 'local') library.rememberLastChapter(userId, id, book, chapter);
  return result;
}

async function writeChapter(userId, source, id, book, chapter, content, options) {
  if (typeof content !== 'string') throw badRequest('Missing chapter content.');
  const result = await pick(source).writeChapter(userId, id, book, chapter, content, options);
  stats.recordSave(userId, { source, novelId: id, title: result.title, previousWords: result.previousWords, words: result.words });
  return result;
}

async function createChapter(userId, source, id, book, name) {
  return pick(source).createChapter(userId, id, book, name);
}

async function loadFullNovel(userId, source, id) {
  return pick(source).loadFullNovel(userId, id);
}

async function getCover(userId, source, id) {
  if (source === 'local') {
    const cover = await library.getCover(userId, id);
    return cover ? { file: cover.file, type: cover.type } : null;
  }
  const cover = await litewriter.getCover(userId, id);
  return cover ? { data: cover.data, type: cover.type } : null;
}

/** Copy a LiteWriter novel (or a local one) into the local library as a new novel. */
async function copyToLibrary(userId, source, id) {
  const full = await loadFullNovel(userId, source, id);
  return importFullNovel(userId, full);
}

async function importFullNovel(userId, full, { titleSuffix = '' } = {}) {
  const synopsis = full.books.flatMap(b => b.chapters).find(c => c.isSynopsis);
  const newId = await library.createNovel(userId, {
    title: `${full.novel.title}${titleSuffix}`,
    author: full.novel.author || '',
    synopsis: synopsis ? synopsis.content : ''
  });
  for (const book of full.books) {
    if (!book.isMain) await library.createBook(userId, newId, book.name);
    for (const ch of book.chapters) {
      if (ch.isSynopsis) continue;
      await library.createChapter(userId, newId, book.isMain ? library.MAIN_BOOK : book.name, ch.name, ch.content || '');
    }
  }
  if (full.cover) {
    const tmp = path.join(os.tmpdir(), `ww-cover-${newId}${full.cover.ext}`);
    fs.writeFileSync(tmp, full.cover.data);
    try {
      await library.setCover(userId, newId, tmp, `cover${full.cover.ext}`);
    } catch {
      // Unsupported cover formats (e.g. SVG) are simply skipped.
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
  return newId;
}

module.exports = {
  supports,
  ensure,
  getNovel,
  readChapter,
  writeChapter,
  createChapter,
  loadFullNovel,
  getCover,
  copyToLibrary,
  importFullNovel
};
