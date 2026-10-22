'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Point the app at a fresh temporary data directory. Must run before requiring lib/*. */
function freshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webwriter-test-'));
  process.env.DATA_DIR = dir;
  process.env.SESSION_SECRET = 'test-secret';
  return dir;
}

function csrfFrom(html) {
  const m = html.match(/name="csrf-token" content="([^"]+)"/) || html.match(/name="_csrf" value="([^"]+)"/);
  if (!m) throw new Error('No CSRF token in page');
  return m[1];
}

/** A supertest agent that remembers its CSRF token. */
async function agentFor(request, app, pagePath = '/login') {
  const agent = request.agent(app);
  const res = await agent.get(pagePath);
  agent.csrf = csrfFrom(res.text);
  return agent;
}

async function refreshCsrf(agent, pagePath = '/library') {
  const res = await agent.get(pagePath);
  agent.csrf = csrfFrom(res.text);
  return agent;
}

/** Start an in-memory WebDAV server that mimics LiteWriter's storage. */
async function startFakeLiteWriter(files) {
  const { v2: webdav } = require('webdav-server');
  const server = new webdav.WebDAVServer({ port: 0, hostname: '127.0.0.1' });
  await new Promise(resolve => server.start(resolve));
  const port = server.server.address().port;
  const url = `http://127.0.0.1:${port}`;
  const { createClient } = require('webdav');
  const client = createClient(url);
  for (const [p, content] of Object.entries(files)) {
    const dir = path.posix.dirname(p);
    if (dir !== '/') await client.createDirectory(dir, { recursive: true });
    await client.putFileContents(p, content);
  }
  return { url, client, stop: () => new Promise(resolve => server.stop(resolve)) };
}

module.exports = { freshDataDir, csrfFrom, agentFor, refreshCsrf, startFakeLiteWriter };
