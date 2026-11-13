'use strict';

const http = require('node:http');

function createServer() {
  return http.createServer((req, res) => {
    const path = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, marker: 'none' }));
    } else if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Warren self-test</title></head><body><h1>Warren self-test</h1></body></html>');
    } else {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
    }
  });
}

module.exports = { createServer };

if (require.main === module) {
  const port = process.env.PORT || 4320;
  createServer().listen(port, () => {
    console.log(`listening on ${port}`);
  });
}
