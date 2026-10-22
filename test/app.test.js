'use strict';

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { freshDataDir, agentFor, refreshCsrf } = require('./helpers');

freshDataDir();
const request = require('supertest');
const { createApp } = require('../lib/app');

const app = createApp();
let admin;
let novelId;

const api = (agent, method, url) => agent[method](url).set('X-CSRF-Token', agent.csrf).set('Accept', 'application/json');

before(async () => {
  admin = await agentFor(request, app, '/setup');
  const res = await admin.post('/setup').type('form').send({ _csrf: admin.csrf, username: 'writer', password: 'correct horse', confirm: 'correct horse' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/library');
  await refreshCsrf(admin);
});

test('first run redirects everything to setup until an admin exists', async () => {
  const res = await request(app).get('/setup');
  assert.equal(res.status, 302, 'setup is closed once a user exists');
  const login = await request(app).get('/library');
  assert.equal(login.status, 302);
  assert.match(login.headers.location, /^\/login/);
});

test('state-changing requests require a CSRF token', async () => {
  const res = await admin.post('/api/novels').set('Accept', 'application/json').send({ title: 'Nope' });
  assert.equal(res.status, 403);
});

test('login rejects wrong passwords and accepts the right one', async () => {
  const a = await agentFor(request, app);
  const bad = await a.post('/login').type('form').send({ _csrf: a.csrf, username: 'writer', password: 'wrong' });
  assert.equal(bad.status, 401);
  const good = await a.post('/login').type('form').send({ _csrf: a.csrf, username: 'WRITER', password: 'correct horse' });
  assert.equal(good.status, 302);
});

test('create a novel with chapters and books', async () => {
  const res = await api(admin, 'post', '/api/novels').send({ title: 'The Long Road', synopsis: 'A journey.', author: 'Me' });
  assert.equal(res.status, 201);
  novelId = res.body.id;

  const ch = await api(admin, 'post', `/api/novels/local/${novelId}/books/Main/chapters`).send({ name: 'Kapitel 1 – Über den Fluss' });
  assert.equal(ch.status, 201);
  assert.match(ch.body.url, /^\/write\/local\//);

  assert.equal((await api(admin, 'post', `/api/novels/local/${novelId}/books`).send({ name: 'Part Two' })).status, 201);
  assert.equal((await api(admin, 'post', `/api/novels/local/${novelId}/books/Part%20Two/chapters`).send({ name: 'Chapter 10' })).status, 201);
  assert.equal((await api(admin, 'post', `/api/novels/local/${novelId}/books/Part%20Two/chapters`).send({ name: 'Chapter 2' })).status, 201);

  const bad = await api(admin, 'post', `/api/novels/local/${novelId}/books/Main/chapters`).send({ name: '../escape' });
  assert.equal(bad.status, 400);

  const { body } = await api(admin, 'get', `/api/novels/local/${novelId}`);
  assert.equal(body.novel.title, 'The Long Road');
  assert.deepEqual(body.books.map(b => b.name), ['Main', 'Part Two']);
  assert.deepEqual(body.books[0].chapters.map(c => c.name), ['Synopsis', 'Kapitel 1 – Über den Fluss']);
  assert.deepEqual(body.books[1].chapters.map(c => c.name), ['Chapter 10', 'Chapter 2'], 'creation order is kept');

  const page = await admin.get(`/novels/local/${novelId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /The Long Road/);
});

test('saving tracks versions, detects conflicts and logs words', async () => {
  const url = `/api/chapters/local/${novelId}/Main/${encodeURIComponent('Kapitel 1 – Über den Fluss')}`;
  const first = await api(admin, 'get', url);
  assert.equal(first.status, 200);
  const v1 = first.body.version;

  const save = await api(admin, 'put', url).send({ content: 'One two three *four* five.', baseVersion: v1 });
  assert.equal(save.status, 200);
  assert.equal(save.body.words, 5);
  assert.equal(save.body.wordsToday, 5);

  const stale = await api(admin, 'put', url).send({ content: 'Overwrite!', baseVersion: v1 });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, 'CONFLICT');

  const forced = await api(admin, 'put', url).send({ content: 'Forced text here.', baseVersion: v1, force: true });
  assert.equal(forced.status, 200);

  const editor = await admin.get(`/write/local/${novelId}/Main/${encodeURIComponent('Kapitel 1 – Über den Fluss')}`);
  assert.equal(editor.status, 200);
  assert.match(editor.text, /Forced text here\./);

  // sendBeacon posts text/plain JSON with the token in the body
  const beacon = await admin
    .post(url)
    .set('Content-Type', 'text/plain')
    .send(JSON.stringify({ content: 'Beacon save works fine now.', _csrf: admin.csrf }));
  assert.equal(beacon.status, 200);
});

test('rename, move, reorder and delete chapters', async () => {
  const base = `/api/novels/local/${novelId}`;
  assert.equal((await api(admin, 'put', `${base}/order`).send({ chapters: { 'Part Two': ['Chapter 2', 'Chapter 10'] } })).status, 200);
  let { body } = await api(admin, 'get', base);
  assert.deepEqual(body.books[1].chapters.map(c => c.name), ['Chapter 2', 'Chapter 10']);

  assert.equal((await api(admin, 'patch', `${base}/books/Part%20Two/chapters/Chapter%202`).send({ name: 'Interlude' })).status, 200);
  assert.equal((await api(admin, 'patch', `${base}/books/Part%20Two/chapters/Interlude`).send({ book: 'Main' })).status, 200);
  ({ body } = await api(admin, 'get', base));
  assert.ok(body.books[0].chapters.some(c => c.name === 'Interlude'));

  assert.equal((await api(admin, 'delete', `${base}/books/Main/chapters/Synopsis`)).status, 400, 'synopsis is protected');
  assert.equal((await api(admin, 'delete', `${base}/books/Main/chapters/Interlude`)).status, 200);
  assert.equal((await api(admin, 'patch', `${base}/books/Part%20Two`).send({ name: 'Volume II' })).status, 200);
  ({ body } = await api(admin, 'get', base));
  assert.deepEqual(body.books.map(b => b.name), ['Main', 'Volume II']);
});

test('exports work in every format', async () => {
  const expected = {
    epub: 'application/epub+zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    html: 'text/html',
    md: 'text/markdown',
    txt: 'text/plain',
    zip: 'application/zip'
  };
  for (const [format, type] of Object.entries(expected)) {
    const res = await admin.get(`/export/local/${novelId}?format=${format}&synopsis=1`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    assert.equal(res.status, 200, format);
    assert.ok(res.headers['content-type'].startsWith(type), `${format}: ${res.headers['content-type']}`);
    assert.match(res.headers['content-disposition'], /attachment; filename="?the-long-road\./);
    if (['epub', 'docx', 'zip'].includes(format)) assert.equal(res.body.subarray(0, 2).toString(), 'PK');
    if (format === 'epub') assert.equal(res.body.subarray(30, 38).toString(), 'mimetype', 'mimetype must be the first, stored entry');
    if (format === 'md') {
      const text = res.body.toString();
      assert.match(text, /^# The Long Road/);
      assert.match(text, /Beacon save works fine now\./);
      assert.match(text, /A journey\./);
    }
    if (format === 'html') assert.match(res.body.toString(), /<p>Beacon save works fine now\.<\/p>/);
  }
});

test('invites, roles and per-user isolation', async () => {
  const inv = await api(admin, 'post', '/admin/invites').send({ note: 'Anna', expiresInDays: 7, maxUses: 1 });
  assert.equal(inv.status, 201);
  const token = inv.body.link.split('/join/')[1];

  const guest = await agentFor(request, app, `/join/${token}`);
  const joined = await guest.post(`/join/${token}`).type('form').send({ _csrf: guest.csrf, username: 'anna', password: 'annas password', confirm: 'annas password' });
  assert.equal(joined.status, 302);
  await refreshCsrf(guest);

  const reuse = await request(app).get(`/join/${token}`);
  assert.equal(reuse.status, 410, 'single-use invites cannot be reused');

  assert.equal((await guest.get(`/novels/local/${novelId}`)).status, 404, "other users' novels are invisible");
  assert.equal((await api(guest, 'get', `/api/novels/local/${novelId}`)).status, 404);
  assert.equal((await guest.get('/admin/users')).status, 403);
  assert.equal((await api(guest, 'post', '/admin/invites').send({})).status, 403);

  const users = await admin.get('/admin/users');
  assert.match(users.text, /anna/);

  // Admin resets Anna's password -> she must change it.
  const annaId = users.text.match(/data-user-id="(\d+)" data-username="anna"/)[1];
  const reset = await api(admin, 'post', `/admin/users/${annaId}/reset-password`).send({});
  assert.equal(reset.status, 200);
  assert.equal((await guest.get('/library')).status, 302, 'old session revoked');

  const relog = await agentFor(request, app);
  await relog.post('/login').type('form').send({ _csrf: relog.csrf, username: 'anna', password: reset.body.password });
  const forced = await relog.get('/library');
  assert.equal(forced.status, 302);
  assert.equal(forced.headers.location, '/account/password');

  // Cannot remove the last admin.
  const me = users.text.match(/data-user-id="(\d+)" data-username="writer"/)[1];
  assert.equal((await api(admin, 'post', `/admin/users/${me}/disabled`).send({ disabled: true })).status, 400);

  // Delete Anna.
  assert.equal((await api(admin, 'delete', `/admin/users/${annaId}`).send({ confirm: 'wrong' })).status, 400);
  assert.equal((await api(admin, 'delete', `/admin/users/${annaId}`).send({ confirm: 'anna' })).status, 200);
});

test('backups: create, download, restore and reject path tricks', async () => {
  const created = await api(admin, 'post', '/backups').send({});
  assert.equal(created.status, 201);
  const name = created.body.name;

  const dl = await admin.get(`/backups/file/${name}`);
  assert.equal(dl.status, 200);

  assert.equal((await admin.get('/backups/file/..%2F..%2Fwebwriter.db')).status, 404);
  assert.equal((await admin.get('/backups/file/%2E%2E%2Fsecret.zip')).status, 404);

  await api(admin, 'delete', `/api/novels/local/${novelId}`);
  assert.equal((await api(admin, 'get', `/api/novels/local/${novelId}`)).status, 404);

  const restored = await api(admin, 'post', `/backups/file/${name}/restore`).send({ mode: 'merge' });
  assert.equal(restored.status, 200);
  assert.equal((await api(admin, 'get', `/api/novels/local/${novelId}`)).status, 200);

  const page = await admin.get('/backups');
  assert.match(page.text, /Before restore/);
});

test('pages render', async () => {
  for (const p of ['/library', '/stats', '/backups', '/settings/account', '/settings/appearance', '/settings/writing', '/settings/litewriter', '/admin/users']) {
    const res = await admin.get(p);
    assert.equal(res.status, 200, p);
  }
  assert.equal((await admin.get('/nope')).status, 404);
  assert.equal((await admin.get('/novels/local/does-not-exist')).status, 404);
});

test('old 1.x URLs redirect', async () => {
  assert.equal((await admin.get(`/novels/${novelId}`)).headers.location, `/novels/local/${novelId}`);
  assert.equal((await admin.get('/novels/Foo?remote=1')).headers.location, '/novels/remote/Foo');
});
