'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http2 = require('node:http2');
const { createServer } = require('../src/server');
const { perCallSession, sharedSession } = require('../src/senders');
const { ensureCert } = require('../src/cert');

const WORKLOAD = { batches: 5, perBatch: 10, body: '{}' };

test('perCallSession opens one session per batch', async () => {
  const { cert: ca } = ensureCert();
  const { stats, listen, close } = createServer();
  const { port } = await listen();

  const before = stats.sessions;
  const r = await perCallSession(`https://127.0.0.1:${port}`, ca, WORKLOAD);

  assert.equal(stats.sessions - before, WORKLOAD.batches); // 5 sessions
  assert.equal(r.latencies.length, WORKLOAD.batches * WORKLOAD.perBatch); // 50 requests
  assert.equal(stats.requests, WORKLOAD.batches * WORKLOAD.perBatch);

  await close();
});

test('sharedSession opens exactly one session for the whole run', async () => {
  const { cert: ca } = ensureCert();
  const { stats, listen, close } = createServer();
  const { port } = await listen();

  const before = stats.sessions;
  const r = await sharedSession(`https://127.0.0.1:${port}`, ca, WORKLOAD);

  assert.equal(stats.sessions - before, 1); // 1 session, no matter how many batches
  assert.equal(r.latencies.length, WORKLOAD.batches * WORKLOAD.perBatch); // same work
  // the server must have SEEN every request too, not just the client claiming so
  assert.equal(stats.requests, WORKLOAD.batches * WORKLOAD.perBatch);

  await close();
});

test('a non-200 response is treated as a failure, not counted as success', async () => {
  // stand up a server that always returns 500
  const { key, cert } = ensureCert();
  const server = http2.createSecureServer({ key, cert });
  server.on('stream', stream => {
    stream.respond({ ':status': 500 });
    stream.end('{"error":"boom"}');
  });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();

  await assert.rejects(
    () => sharedSession(`https://127.0.0.1:${port}`, cert, { batches: 1, perBatch: 1, body: '{}' }),
    /unexpected status 500/,
  );

  await new Promise(res => server.close(res));
});
