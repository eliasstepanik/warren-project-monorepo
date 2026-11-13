'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const events = require('node:events');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { createServer } = require('../server');

async function start(dataFile) {
  const server = createServer({ dataFile });
  server.listen(0, '127.0.0.1');
  await events.once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function stop(server) {
  server.close();
  server.closeAllConnections();
  await events.once(server, 'close');
}

function post(base, body, raw = false) {
  return fetch(`${base}/api/links`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw ? body : JSON.stringify(body),
  });
}

describe('link shortener', () => {
  let tmpDir;
  let dataFile;
  let server;
  let base;

  before(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'shortener-'));
    dataFile = path.join(tmpDir, 'links.json');
    ({ server, base } = await start(dataFile));
  });

  after(async () => {
    await stop(server);
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a short link', async () => {
    const res = await post(base, { url: 'https://example.com/a?b=1' });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.match(body.code, /^[A-Za-z0-9]{6}$/);
    assert.equal(body.short, `/${body.code}`);
  });

  for (const url of ['ftp://example.com/file', 'javascript:alert(1)']) {
    it(`rejects non-http(s) url ${url}`, async () => {
      const res = await post(base, { url });
      assert.equal(res.status, 400);
      assert.match((await res.json()).error, /protocol/);
    });
  }

  it('rejects an unparseable url', async () => {
    const res = await post(base, { url: 'not a url' });
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  });

  it('rejects a missing url', async () => {
    const res = await post(base, {});
    assert.equal(res.status, 400);
    assert.ok((await res.json()).error);
  });

  it('rejects a non-string url', async () => {
    const res = await post(base, { url: 42 });
    assert.equal(res.status, 400);
  });

  it('rejects invalid JSON', async () => {
    const res = await post(base, '{not json', true);
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /JSON/);
  });

  it('rejects an oversized body', async () => {
    const res = await post(base, { url: `https://example.com/${'a'.repeat(9000)}` });
    assert.equal(res.status, 413);
    assert.ok((await res.json()).error);
  });

  it('rejects an oversized body sent without Content-Length', async () => {
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        `${base}/api/links`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.on('error', reject);
      req.write(JSON.stringify({ url: `https://example.com/${'a'.repeat(9000)}` }));
      req.end();
    });
    assert.equal(status, 413);
  });

  for (const [name, input, expected] of [
    ['non-ASCII path', 'https://example.com/日本', 'https://example.com/%E6%97%A5%E6%9C%AC'],
    ['non-ASCII host', 'https://例え.jp/', 'https://xn--r8jz45g.jp/'],
    ['Latin-1 char', 'https://example.com/ü', 'https://example.com/%C3%BC'],
    ['surrounding spaces', '  https://example.com/spaced  ', 'https://example.com/spaced'],
    ['embedded tab and newline', 'https://example.com/a\tb\r\nc', 'https://example.com/abc'],
  ]) {
    it(`normalizes the stored url (${name}) and redirects`, async () => {
      const res = await post(base, { url: input });
      assert.equal(res.status, 201);
      const { code } = await res.json();

      const redirect = await fetch(`${base}/${code}`, { redirect: 'manual' });
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get('location'), expected);

      const stats = await (await fetch(`${base}/api/links/${code}/stats`)).json();
      assert.equal(stats.url, expected);
    });
  }

  it('redirects with 302 and counts hits in stats', async () => {
    const url = 'https://example.com/target';
    const { code } = await (await post(base, { url })).json();

    for (let i = 0; i < 2; i += 1) {
      const res = await fetch(`${base}/${code}`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), url);
    }

    const res = await fetch(`${base}/api/links/${code}/stats`);
    assert.equal(res.status, 200);
    const stats = await res.json();
    assert.equal(stats.url, url);
    assert.equal(stats.hits, 2);
    assert.equal(new Date(stats.created_at).toISOString(), stats.created_at);
  });

  it('starts with zero hits', async () => {
    const { code } = await (await post(base, { url: 'http://example.com/' })).json();
    const stats = await (await fetch(`${base}/api/links/${code}/stats`)).json();
    assert.equal(stats.hits, 0);
  });

  it('returns 404 for an unknown code on redirect', async () => {
    const res = await fetch(`${base}/zzzzzz`, { redirect: 'manual' });
    assert.equal(res.status, 404);
    assert.ok((await res.json()).error);
  });

  it('returns 404 for unknown code stats', async () => {
    const res = await fetch(`${base}/api/links/zzzzzz/stats`);
    assert.equal(res.status, 404);
  });

  it('returns 404 for unknown routes and 405 for wrong methods', async () => {
    assert.equal((await fetch(`${base}/no/such/route`)).status, 404);
    const get = await fetch(`${base}/api/links`);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get('allow'), 'POST');
    const del = await fetch(`${base}/api/links/abcdef/stats`, { method: 'DELETE' });
    assert.equal(del.status, 405);
  });

  it('returns 404 for extra path segments, trailing slashes and /api', async () => {
    const { code } = await (await post(base, { url: 'https://example.com/x' })).json();
    for (const p of ['/api/links/x/stats/extra', `/${code}/`, '/api']) {
      const res = await fetch(`${base}${p}`, { redirect: 'manual' });
      assert.equal(res.status, 404, p);
    }
  });

  it('ignores the query string when redirecting', async () => {
    const url = 'https://example.com/query';
    const { code } = await (await post(base, { url })).json();
    const res = await fetch(`${base}/${code}?x=1`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), url);
  });

  it('persists links and hits to the data file', async () => {
    const url = 'https://example.com/persist';
    const { code } = await (await post(base, { url })).json();
    await fetch(`${base}/${code}`, { redirect: 'manual' });

    const onDisk = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    assert.equal(onDisk[code].url, url);
    assert.equal(onDisk[code].hits, 1);
    assert.deepEqual(
      fs.readdirSync(tmpDir).filter((f) => f.endsWith('.tmp')),
      [],
    );

    const second = await start(dataFile);
    try {
      const res = await fetch(`${second.base}/${code}`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), url);
      const stats = await (await fetch(`${second.base}/api/links/${code}/stats`)).json();
      assert.equal(stats.hits, 2);
    } finally {
      await stop(second.server);
    }
  });
});
