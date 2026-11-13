// Link shortener — Node built-ins only (http + fs + path + crypto).
// Usage: node server.js   ->  http://127.0.0.1:3000

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const CODE_LENGTH = 6;
const CODE_RE = /^[A-Za-z0-9]{6}$/;
const MAX_BODY_BYTES = 8 * 1024;
const DEFAULT_DATA_FILE = path.join(__dirname, 'data', 'links.json');

function generateCode() {
  // Rejection sampling keeps the distribution uniform (62 does not divide 256).
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const byte of crypto.randomBytes(CODE_LENGTH * 2)) {
      if (byte < 248 && code.length < CODE_LENGTH) code += ALPHABET[byte % ALPHABET.length];
    }
  }
  return code;
}

function loadLinks(dataFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? new Map(Object.entries(parsed))
      : new Map();
  } catch (err) {
    if (err.code === 'ENOENT') return new Map();
    throw err;
  }
}

function saveLinks(dataFile, links) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true });
  const tmp = `${dataFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(links), null, 2));
  fs.renameSync(tmp, dataFile);
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('request body too large');
        err.status = 413;
        reject(err);
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function validateUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { error: 'url is required and must be a string' };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { error: 'url is not a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'url protocol must be http: or https:' };
  }
  return { parsed };
}

function createServer({ dataFile = process.env.SHORTENER_DATA_FILE || DEFAULT_DATA_FILE } = {}) {
  const file = path.resolve(dataFile);
  const links = loadLinks(file);

  async function createLink(req, res) {
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BODY_BYTES) {
      req.resume();
      res.shouldKeepAlive = false;
      return sendJson(res, 413, { error: 'request body too large' }, { Connection: 'close' });
    }

    let raw;
    try {
      raw = await readBody(req);
    } catch (err) {
      if (err.status === 413) {
        res.shouldKeepAlive = false;
        return sendJson(res, 413, { error: err.message }, { Connection: 'close' });
      }
      throw err;
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: 'invalid JSON body' });
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return sendJson(res, 400, { error: 'body must be a JSON object' });
    }
    const { error, parsed } = validateUrl(body.url);
    if (error) return sendJson(res, 400, { error });

    let code;
    do {
      code = generateCode();
    } while (links.has(code));
    links.set(code, { url: parsed.href, created_at: new Date().toISOString(), hits: 0 });
    try {
      saveLinks(file, links);
    } catch (err) {
      links.delete(code);
      throw err;
    }
    return sendJson(res, 201, { code, short: `/${code}` });
  }

  function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');
    const method = req.method;

    if (pathname === '/api/links') {
      if (method === 'POST') return createLink(req, res);
      return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'POST' });
    }

    const stats = /^\/api\/links\/([^/]+)\/stats$/.exec(pathname);
    if (stats) {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
      const link = links.get(stats[1]);
      if (!link) return sendJson(res, 404, { error: 'not found' });
      return sendJson(res, 200, { url: link.url, created_at: link.created_at, hits: link.hits });
    }

    const redirect = /^\/([^/]+)$/.exec(pathname);
    if (redirect && CODE_RE.test(redirect[1])) {
      if (method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
      const link = links.get(redirect[1]);
      if (!link) return sendJson(res, 404, { error: 'not found' });
      link.hits += 1;
      try {
        saveLinks(file, links);
      } catch (err) {
        link.hits -= 1;
        throw err;
      }
      res.writeHead(302, { Location: link.url, 'Content-Length': 0 });
      return res.end();
    }

    return sendJson(res, 404, { error: 'not found' });
  }

  return http.createServer((req, res) => {
    Promise.resolve()
      .then(() => handle(req, res))
      .catch((err) => {
        console.error(err);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal server error' });
        else res.end();
      });
  });
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '127.0.0.1';
  createServer({}).listen(port, host, () => {
    console.log(`Shortener listening on http://${host}:${port}`);
  });
}
