'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { freshDataDir, agentFor, refreshCsrf, startFakeLiteWriter } = require('./helpers');

freshDataDir();
process.env.LITEWRITER_TIMEOUT_MS = '1500';
const request = require('supertest');
const { createApp } = require('../lib/app');

const app = createApp();
let agent;
let device;

const api = (method, url) => agent[method](url).set('X-CSRF-Token', agent.csrf).set('Accept', 'application/json');

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

before(async () => {
  // The layout LiteWriter uses on its WebDAV share.
  device = await startFakeLiteWriter({
    '/My_Great_Novel/Synopsis.md': 'A story about rivers.',
    '/My_Great_Novel/cover.png': PNG,
    '/My_Great_Novel/Chapter 1.md': 'It was a dark and stormy night.',
    '/My_Great_Novel/Chapter 10.md': 'Ten.',
    '/My_Great_Novel/Chapter 2.txt': 'Two words.',
    '/My_Great_Novel/Book Two/Chapter 3.md': 'Three is a magic number.',
    '/Second/Intro.md': 'Intro acts as the synopsis.',
    '/Second/Part: One/Chapter 5: Storm?.md': 'Rain and more rain.',
    '/Second/Notes.md': 'Some notes here.',
    '/.hidden/ignored.md': 'ignored'
  });
  agent = await agentFor(request, app, '/setup');
  await agent.post('/setup').type('form').send({ _csrf: agent.csrf, username: 'phoneuser', password: 'phone password', confirm: 'phone password' });
  await refreshCsrf(agent);
});

after(async () => {
  await device.stop();
});

test('connection test and settings', async () => {
  const bad = await api('post', '/settings/litewriter/test').send({ enabled: true, url: 'http://127.0.0.1:9' });
  assert.equal(bad.status, 502);
  assert.match(bad.body.error, /refused|reach/);

  const ok = await api('post', '/settings/litewriter/test').send({ enabled: true, url: device.url });
  assert.equal(ok.status, 200);
  assert.match(ok.body.message, /Found 2 novels/);

  const notConfigured = await api('get', '/api/remote/novels');
  assert.deepEqual(notConfigured.body, { configured: false, novels: [] });

  assert.equal((await api('post', '/settings/litewriter').send({ enabled: true, url: device.url })).status, 200);
});

test('library page renders without waiting for the device', async () => {
  const res = await agent.get('/library');
  assert.equal(res.status, 200);
  assert.match(res.text, /data-remote-configured="1"/);
});

test('remote novels are recognized like LiteWriter stores them', async () => {
  const res = await api('get', '/api/remote/novels');
  assert.equal(res.status, 200);
  const novels = Object.fromEntries(res.body.novels.map(n => [n.id, n]));
  assert.deepEqual(Object.keys(novels).sort(), ['My_Great_Novel', 'Second']);

  const n = novels.My_Great_Novel;
  assert.equal(n.title, 'My Great Novel');
  assert.equal(n.synopsis, 'A story about rivers.');
  assert.equal(n.chapterCount, 4);
  assert.equal(n.words, 7 + 1 + 2 + 5);
  assert.equal(n.bookCount, 2);
  assert.ok(n.coverUrl.startsWith('/covers/remote/My_Great_Novel'));

  assert.equal(novels.Second.synopsis, 'Intro acts as the synopsis.');
  assert.equal(novels.Second.chapterCount, 2);

  const detail = await api('get', '/api/novels/remote/My_Great_Novel');
  const [main, two] = detail.body.books;
  assert.equal(main.name, 'Main');
  assert.deepEqual(main.chapters.map(c => c.name), ['Synopsis', 'Chapter 1', 'Chapter 2', 'Chapter 10'], 'natural order, synopsis first');
  assert.equal(main.chapters[2].file, 'Chapter 2.txt');
  assert.equal(two.name, 'Book Two');

  const cover = await agent.get(n.coverUrl);
  assert.equal(cover.status, 200);
  assert.equal(cover.headers['content-type'], 'image/png');

  const page = await agent.get('/novels/remote/My_Great_Novel');
  assert.equal(page.status, 200);
  assert.match(page.text, /On your device/);
});

test('editing a remote chapter writes back to the device (.txt kept as .txt)', async () => {
  const url = '/api/chapters/remote/My_Great_Novel/Main/Chapter%202';
  const read = await api('get', url);
  assert.equal(read.body.content, 'Two words.');

  const saved = await api('put', url).send({ content: 'Now there are five words.', baseVersion: read.body.version });
  assert.equal(saved.status, 200);
  assert.equal(await device.client.getFileContents('/My_Great_Novel/Chapter 2.txt', { format: 'text' }), 'Now there are five words.');
  assert.equal(await device.client.exists('/My_Great_Novel/Chapter 2.md'), false);

  const editor = await agent.get('/write/remote/My_Great_Novel/Book%20Two/Chapter%203');
  assert.equal(editor.status, 200);
  assert.match(editor.text, /Three is a magic number\./);
});

test('changes made on the phone are not overwritten silently', async () => {
  const url = '/api/chapters/remote/My_Great_Novel/Main/Chapter%201';
  const read = await api('get', url);
  await new Promise(r => setTimeout(r, 1100)); // let the mtime tick
  await device.client.putFileContents('/My_Great_Novel/Chapter 1.md', 'Edited on the phone meanwhile.');

  const stale = await api('put', url).send({ content: 'Edited in the browser.', baseVersion: read.body.version });
  assert.equal(stale.status, 409);
  assert.equal(await device.client.getFileContents('/My_Great_Novel/Chapter 1.md', { format: 'text' }), 'Edited on the phone meanwhile.');

  const forced = await api('put', url).send({ content: 'Edited in the browser.', baseVersion: read.body.version, force: true });
  assert.equal(forced.status, 200);
});

test('device files with : and ? in their names can be opened, saved and added to', async () => {
  const detail = await api('get', '/api/novels/remote/Second');
  const book = detail.body.books.find(b => b.name === 'Part: One');
  assert.deepEqual(book.chapters.map(c => c.name), ['Chapter 5: Storm?']);

  const url = `/api/chapters/remote/Second/${encodeURIComponent('Part: One')}/${encodeURIComponent('Chapter 5: Storm?')}`;
  const read = await api('get', url);
  assert.equal(read.status, 200);
  assert.equal(read.body.content, 'Rain and more rain.');
  assert.equal((await api('put', url).send({ content: 'Sunshine.', baseVersion: read.body.version })).status, 200);
  assert.equal(await device.client.getFileContents('/Second/Part: One/Chapter 5: Storm?.md', { format: 'text' }), 'Sunshine.');

  const editor = await agent.get(`/write/remote/Second/${encodeURIComponent('Part: One')}/${encodeURIComponent('Chapter 5: Storm?')}`);
  assert.equal(editor.status, 200);

  const created = await api('post', `/api/novels/remote/Second/books/${encodeURIComponent('Part: One')}/chapters`).send({ name: 'Chapter 6: Why?' });
  assert.equal(created.status, 201);
  assert.equal(await device.client.exists('/Second/Part: One/Chapter 6: Why?.md'), true, 'plain name used when the device accepts it');
});

test('new chapters can be created on the device', async () => {
  const res = await api('post', '/api/novels/remote/My_Great_Novel/books/Book%20Two/chapters').send({ name: 'Chapter 4' });
  assert.equal(res.status, 201);
  assert.equal(await device.client.exists('/My_Great_Novel/Book Two/Chapter 4.md'), true);
  const dup = await api('post', '/api/novels/remote/My_Great_Novel/books/Main/chapters').send({ name: 'Chapter 2' });
  assert.equal(dup.status, 409, 'Chapter 2.txt already exists');
});

test('local-only operations are refused for remote novels', async () => {
  assert.equal((await api('delete', '/api/novels/remote/My_Great_Novel')).status, 400);
  assert.equal((await api('delete', '/api/novels/remote/My_Great_Novel/books/Main/chapters/Chapter%201')).status, 400);
});

test('export and copy a remote novel', async () => {
  const md = await agent.get('/export/remote/My_Great_Novel?format=md');
  assert.equal(md.status, 200);
  assert.match(md.text, /# My Great Novel/);
  assert.match(md.text, /Now there are five words\./);
  assert.match(md.text, /# Book Two/);

  const epub = await agent.get('/export/remote/My_Great_Novel?format=epub').buffer(true);
  assert.equal(epub.status, 200);

  const copy = await api('post', '/api/novels/remote/My_Great_Novel/copy').send({});
  assert.equal(copy.status, 201);
  const local = await api('get', `/api/novels/local/${copy.body.id}`);
  assert.equal(local.body.novel.title, 'My Great Novel');
  assert.equal(local.body.novel.synopsis, 'A story about rivers.');
  assert.ok(local.body.novel.hasCover);
  assert.deepEqual(local.body.books.map(b => b.name), ['Main', 'Book Two']);
  assert.equal(local.body.novel.chapterCount, 5);
  const second = await api('post', '/api/novels/remote/Second/copy').send({});
  const copied = await api('get', `/api/novels/local/${second.body.id}`);
  assert.ok(copied.body.books.some(b => b.name === 'Part: One' && b.chapters.some(c => c.name === 'Chapter 6: Why?')));
});

test('backups can include a snapshot of the device', async () => {
  const res = await api('post', '/backups').send({ includeRemote: true });
  assert.equal(res.status, 201);
  assert.doesNotMatch(res.body.message, /skipped/);
});

test('an unreachable device produces a clear error instead of hanging', async () => {
  await api('post', '/settings/litewriter').send({ enabled: true, url: 'http://127.0.0.1:9' });
  const res = await api('get', '/api/remote/novels?fresh=1');
  assert.equal(res.status, 502);
  assert.match(res.body.error, /refused/);
  const page = await agent.get('/novels/remote/My_Great_Novel');
  assert.equal(page.status, 502);
  assert.match(page.text, /Try again/);
});

test('a device that accepts connections but never answers times out quickly', async () => {
  const net = require('net');
  const sockets = [];
  const blackhole = net.createServer(s => sockets.push(s));
  await new Promise(r => blackhole.listen(0, '127.0.0.1', r));
  const { port } = blackhole.address();
  await api('post', '/settings/litewriter').send({ enabled: true, url: `http://127.0.0.1:${port}` });
  const started = Date.now();
  const res = await api('get', '/api/remote/novels?fresh=1');
  assert.equal(res.status, 502);
  assert.match(res.body.error, /too long/);
  assert.ok(Date.now() - started < 5000, 'gave up after the configured timeout');
  sockets.forEach(s => s.destroy());
  blackhole.close();
});
