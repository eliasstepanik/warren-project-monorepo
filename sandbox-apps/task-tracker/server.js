// Task Tracker — minimal static file server.
// Node built-ins only (http + fs + path + url). No npm packages.
// Usage: node server.js   ->  http://127.0.0.1:4321

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const HOST = '127.0.0.1';
const PORT = 4321;
const ROOT = __dirname; // only ever serve files from this folder

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function contentTypeFor(filePath) {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

const server = http.createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
    res.end('Method Not Allowed\n');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}:${PORT}`).pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bad Request\n');
    return;
  }

  if (pathname === '/' || pathname === '') pathname = '/index.html';

  // Resolve inside ROOT and reject traversal attempts.
  const target = path.resolve(ROOT, '.' + path.posix.normalize(pathname));
  if (target !== ROOT && !target.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden\n');
    return;
  }

  try {
    const stat = await fsp.stat(target);
    if (stat.isDirectory()) {
      const index = path.join(target, 'index.html');
      const indexStat = await fsp.stat(index).catch(() => null);
      if (!indexStat || !indexStat.isFile()) throw Object.assign(new Error('is directory'), { code: 'ENODIR' });
      await sendFile(index, req, res);
      return;
    }
    await sendFile(target, req, res);
  } catch (err) {
    const code = err && err.code;
    const status = code === 'ENOENT' || code === 'ENODIR' || code === 'ENOTDIR' ? 404 : 500;
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(status === 404 ? 'Not Found\n' : 'Internal Server Error\n');
    if (status === 500) console.error(err);
  }
});

async function sendFile(filePath, req, res) {
  const stat = await fsp.stat(filePath);
  res.writeHead(200, {
    'Content-Type': contentTypeFor(filePath),
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on('error', (err) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Internal Server Error\n');
  });
  stream.pipe(res);
}

server.listen(PORT, HOST, () => {
  console.log(`Task Tracker serving ${ROOT} on http://${HOST}:${PORT}`);
});
