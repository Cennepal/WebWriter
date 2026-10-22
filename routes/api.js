'use strict';

const express = require('express');
const fs = require('fs');
const multer = require('multer');
const config = require('../lib/config');
const { requireUser } = require('../lib/auth');
const library = require('../lib/library');
const litewriter = require('../lib/litewriter');
const sources = require('../lib/sources');
const stats = require('../lib/stats');
const { settings } = require('../lib/db');
const { notFound, badRequest } = require('../lib/text');

const router = express.Router();
router.use(requireUser);

const upload = multer({ dest: config.tmpDir, limits: { fileSize: config.uploadLimitBytes, files: 1 } });

/** Run a multer upload and always clean up the temp file afterwards. */
function withUpload(field, handler) {
  return [
    upload.single(field),
    async (req, res) => {
      try {
        await handler(req, res);
      } finally {
        if (req.file) fs.rm(req.file.path, { force: true }, () => {});
      }
    }
  ];
}

function source(req) {
  const s = req.params.source;
  if (s !== 'local' && s !== 'remote') throw notFound();
  return s;
}

function localOnly(req) {
  if (req.params.source && req.params.source !== 'local') sources.ensure('remote', 'edit');
}

const novelUrl = (src, id) => `/novels/${src}/${encodeURIComponent(id)}`;

/* ------------------------------------------------------------ LiteWriter */

router.get('/remote/novels', async (req, res) => {
  if (!litewriter.isConfigured(settings.get(req.user.id))) return res.json({ configured: false, novels: [] });
  const novels = await litewriter.listNovels(req.user.id, { fresh: req.query.fresh === '1' });
  res.json({ configured: true, novels });
});

/* ---------------------------------------------------------------- novels */

router.get('/novels/:source/:id', async (req, res) => {
  res.json(await sources.getNovel(req.user.id, source(req), req.params.id));
});

router.post(
  '/novels',
  ...withUpload('cover', async (req, res) => {
    const id = await library.createNovel(req.user.id, {
      title: req.body.title,
      synopsis: req.body.synopsis,
      author: req.body.author ?? req.user.username
    });
    if (req.file) {
      try {
        await library.setCover(req.user.id, id, req.file.path, req.file.originalname);
      } catch (err) {
        return res.status(201).json({ id, url: novelUrl('local', id), warning: err.message });
      }
    }
    res.status(201).json({ id, url: novelUrl('local', id) });
  })
);

router.patch('/novels/:source/:id', async (req, res) => {
  localOnly(req);
  const { title, synopsis, author, language } = req.body;
  await library.updateNovel(req.user.id, req.params.id, { title, synopsis, author, language });
  res.json({ ok: true });
});

router.post(
  '/novels/:source/:id/cover',
  ...withUpload('cover', async (req, res) => {
    localOnly(req);
    if (!req.file) throw badRequest('Choose an image first.');
    await library.setCover(req.user.id, req.params.id, req.file.path, req.file.originalname);
    res.json({ ok: true });
  })
);

router.delete('/novels/:source/:id/cover', async (req, res) => {
  localOnly(req);
  await library.removeCover(req.user.id, req.params.id);
  res.json({ ok: true });
});

router.delete('/novels/:source/:id', async (req, res) => {
  localOnly(req);
  await library.deleteNovel(req.user.id, req.params.id);
  res.json({ ok: true });
});

router.post('/novels/:source/:id/copy', async (req, res) => {
  const id = await sources.copyToLibrary(req.user.id, source(req), req.params.id);
  res.status(201).json({ id, url: novelUrl('local', id) });
});

router.put('/novels/:source/:id/order', async (req, res) => {
  localOnly(req);
  await library.reorder(req.user.id, req.params.id, req.body || {});
  res.json({ ok: true });
});

/* ----------------------------------------------------------------- books */

router.post('/novels/:source/:id/books', async (req, res) => {
  localOnly(req);
  const name = await library.createBook(req.user.id, req.params.id, req.body.name);
  res.status(201).json({ name });
});

router.patch('/novels/:source/:id/books/:book', async (req, res) => {
  localOnly(req);
  const name = await library.renameBook(req.user.id, req.params.id, req.params.book, req.body.name);
  res.json({ name });
});

router.delete('/novels/:source/:id/books/:book', async (req, res) => {
  localOnly(req);
  await library.deleteBook(req.user.id, req.params.id, req.params.book);
  res.json({ ok: true });
});

/* -------------------------------------------------------------- chapters */

router.post('/novels/:source/:id/books/:book/chapters', async (req, res) => {
  const src = source(req);
  const { id, book } = req.params;
  const name = await sources.createChapter(req.user.id, src, id, book, req.body.name);
  res.status(201).json({ name, url: `/write/${src}/${[id, book, name].map(encodeURIComponent).join('/')}` });
});

router.patch('/novels/:source/:id/books/:book/chapters/:chapter', async (req, res) => {
  localOnly(req);
  const { id, book, chapter } = req.params;
  let name = chapter;
  if (req.body.name !== undefined && req.body.name !== chapter) {
    name = await library.renameChapter(req.user.id, id, book, chapter, req.body.name);
  }
  if (req.body.book && req.body.book !== book) {
    await library.moveChapter(req.user.id, id, book, name, req.body.book);
  }
  res.json({ name });
});

router.delete('/novels/:source/:id/books/:book/chapters/:chapter', async (req, res) => {
  localOnly(req);
  const { id, book, chapter } = req.params;
  await library.deleteChapter(req.user.id, id, book, chapter);
  res.json({ ok: true });
});

router.get('/chapters/:source/:id/:book/:chapter', async (req, res) => {
  const { id, book, chapter } = req.params;
  res.json(await sources.readChapter(req.user.id, source(req), id, book, chapter));
});

async function saveChapter(req, res) {
  const { id, book, chapter } = req.params;
  const body = req.body || {};
  const result = await sources.writeChapter(req.user.id, source(req), id, book, chapter, body.content, {
    baseVersion: body.baseVersion || undefined,
    force: body.force === true
  });
  res.json({ ok: true, version: result.version, words: result.words, wordsToday: stats.wordsToday(req.user.id), savedAt: new Date().toISOString() });
}

router.put('/chapters/:source/:id/:book/:chapter', saveChapter);
// navigator.sendBeacon() can only POST.
router.post('/chapters/:source/:id/:book/:chapter', saveChapter);

module.exports = router;
