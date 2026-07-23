'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http2 = require('http2');
const { createServer } = require('../src/server');
const { ensureCert } = require('../src/cert');

function request(session, body) {
  return new Promise((resolve, reject) => {
    const req = session.request({ ':method': 'POST', ':path': '/v1/send' });
    let status = 0;
    let data = '';
    req.on('response', h => (status = Number(h[':status'])));
    req.setEncoding('utf8');
    req.on('data', c => (data += c));
    req.on('end', () => resolve({ status, data }));
    req.on('error', reject);
    req.end(body);
  });
}

test('listen() rejects loudly when the port cannot be bound', async () => {
  // Bind a port, then try to bind the same port again — the second listen must
  // reject (EADDRINUSE), not silently do nothing and let the process exit 0.
  const first = createServer();
  const { port } = await first.listen();

  const second = createServer();
  await assert.rejects(() => second.listen(port), /EADDRINUSE/);

  await first.close();
});

test('server counts one session per connection and one request per stream', async () => {
  const { cert: ca } = ensureCert();
  const { stats, listen, close } = createServer();
  const { port } = await listen();

  // two separate connections, three requests total
  const s1 = http2.connect(`https://127.0.0.1:${port}`, { ca });
  await new Promise((res, rej) => s1.once('connect', res).once('error', rej));
  const r1 = await request(s1, 'a');
  const r2 = await request(s1, 'b');
  s1.close();

  const s2 = http2.connect(`https://127.0.0.1:${port}`, { ca });
  await new Promise((res, rej) => s2.once('connect', res).once('error', rej));
  const r3 = await request(s2, 'c');
  s2.close();

  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 200);
  assert.match(r1.data, /"name"/);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.requests, 3);

  await close();
});
