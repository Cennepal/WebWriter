'use strict';

const express = require('express');
const fs = require('fs');
const { requireUser } = require('../lib/auth');
const library = require('../lib/library');
const litewriter = require('../lib/litewriter');
const sources = require('../lib/sources');
const exporter = require('../lib/exporter');
const stats = require('../lib/stats');
const { settings } = require('../lib/db');
const { notFound } = require('../lib/text');

const router = express.Router();
router.use(['/library', '/novels', '/write', '/covers', '/export', '/editor'], requireUser);

function checkSource(source) {
  if (source !== 'local' && source !== 'remote') throw notFound();
  return source;
}

router.get('/library', async (req, res) => {
  const novels = await library.listNovels(req.user.id);
  const remoteConfigured = litewriter.isConfigured(settings.get(req.user.id));
  res.render('library', {
    title: 'Library',
    novels,
    remoteConfigured,
    wordsToday: stats.wordsToday(req.user.id)
  });
});

router.get('/novels/:source/:id', async (req, res) => {
  const source = checkSource(req.params.source);
  if (source === 'remote' && !litewriter.isConfigured(settings.get(req.user.id))) return res.redirect('/settings/litewriter');
  const { novel, books } = await sources.getNovel(req.user.id, source, req.params.id);
  res.render('novel', {
    title: novel.title,
    source,
    novel,
    books,
    formats: exporter.FORMATS,
    canEdit: source === 'local'
  });
});

router.get('/write/:source/:id/:book/:chapter', async (req, res) => {
  const source = checkSource(req.params.source);
  const { id, book, chapter } = req.params;
  const data = await sources.readChapter(req.user.id, source, id, book, chapter);
  // The editor only needs the title; for LiteWriter that avoids listing the whole novel on the phone.
  const novel = source === 'remote' ? { id, title: litewriter.titleFromDir(id) } : (await sources.getNovel(req.user.id, source, id)).novel;
  res.render('editor', {
    title: `${chapter} · ${novel.title}`,
    source,
    novel,
    book,
    chapter,
    content: data.content,
    version: data.version,
    wordsToday: stats.wordsToday(req.user.id)
  });
});

router.get('/covers/:source/:id', async (req, res) => {
  const source = checkSource(req.params.source);
  const cover = await sources.getCover(req.user.id, source, req.params.id);
  if (!cover) throw notFound('No cover');
  res.set('Cache-Control', 'private, max-age=86400');
  res.type(cover.type);
  // SVG covers from the device could carry scripts; neutralize them.
  if (cover.type === 'image/svg+xml') res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
  if (cover.file) return fs.createReadStream(cover.file).pipe(res);
  res.send(cover.data);
});

router.get('/export/:source/:id', async (req, res) => {
  const source = checkSource(req.params.source);
  const format = String(req.query.format || 'epub');
  if (!exporter.FORMATS[format]) throw notFound('Unknown export format.');
  const full = await sources.loadFullNovel(req.user.id, source, req.params.id);
  const result = await exporter.exportNovel(full, format, {
    book: req.query.book || undefined,
    chapter: req.query.chapter || undefined,
    synopsis: req.query.synopsis === '1',
    chapterTitles: req.query.titles !== '0'
  });
  res.attachment(result.filename);
  res.type(result.type);
  res.set('Cache-Control', 'no-store');
  res.send(result.buffer);
});

/* --------------------------------------- redirects for WebWriter 1.x URLs */

router.get('/novels', (req, res) => res.redirect(301, '/library'));
router.get('/novels/:id', (req, res) => {
  res.redirect(301, `/novels/${req.query.remote === '1' ? 'remote' : 'local'}/${encodeURIComponent(req.params.id)}`);
});
router.get('/editor/:id/:book/:chapter', (req, res) => {
  const { id, book, chapter } = req.params;
  const source = req.query.remote === '1' ? 'remote' : 'local';
  res.redirect(301, `/write/${source}/${[id, book, chapter].map(encodeURIComponent).join('/')}`);
});

module.exports = router;
