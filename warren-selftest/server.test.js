'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { createServer } = require('./server');

let server;
let base;

before(async () => {
  server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

test('GET /health returns JSON', async () => {
  const res = await fetch(`${base}/health`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.deepStrictEqual(await res.json(), { ok: true, marker: 'none' });
});

test('GET / returns HTML page', async () => {
  const res = await fetch(`${base}/`);
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/html/);
  assert.ok((await res.text()).includes('<h1>Warren self-test</h1>'));
});

test('unknown path returns 404', async () => {
  const res = await fetch(`${base}/nope`);
  assert.strictEqual(res.status, 404);
  await res.text();
});
