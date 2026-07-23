'use strict';

// Two sending strategies against the same endpoint. Both send exactly the same
// number of requests (batches * perBatch) with the same in-batch concurrency.
// The ONLY difference is session lifetime:
//
//   perCallSession  – open a fresh HTTP/2 session for every batch, then close
//                     it. This mirrors the behavior described in
//                     firebase/firebase-admin-node#2488, where each
//                     sendEach()/sendEachForMulticast() call establishes its
//                     own session, so there is no reuse across calls.
//
//   sharedSession   – open one HTTP/2 session and reuse it for every batch.
//
// Keeping everything else identical is what makes the comparison fair.

const http2 = require('http2');
const { performance } = require('perf_hooks');

function delay(ms) {
  return ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve();
}

// connectDelayMs models the extra wall-clock cost of establishing a *new*
// connection over a real network (TLS + HTTP/2 handshake takes several
// round-trips). On loopback this is ~0, which understates the effect, so the
// benchmark exposes it as an explicit, transparent knob (default 0 = pure
// measurement). It is applied only when a new session is opened, so it is paid
// once by the shared strategy and once-per-batch by the per-call strategy.
async function connect(url, ca, connectDelayMs = 0) {
  const session = await new Promise((resolve, reject) => {
    const s = http2.connect(url, { ca });
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
  await delay(connectDelayMs);
  return session;
}

function sendOne(session, body) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const req = session.request({
      ':method': 'POST',
      ':path': '/v1/send',
      'content-type': 'application/json',
    });
    let status = 0;
    let data = '';
    req.on('response', headers => {
      status = Number(headers[':status']);
    });
    req.setEncoding('utf8');
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      if (status !== 200) {
        reject(new Error(`unexpected status ${status}`));
        return;
      }
      resolve(performance.now() - start);
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function runBatch(session, perBatch, body) {
  const jobs = [];
  for (let i = 0; i < perBatch; i += 1) jobs.push(sendOne(session, body));
  return Promise.all(jobs);
}

async function perCallSession(url, ca, { batches, perBatch, body, connectDelayMs = 0 }) {
  const latencies = [];
  const startWall = performance.now();
  for (let b = 0; b < batches; b += 1) {
    const session = await connect(url, ca, connectDelayMs);
    const batchLatencies = await runBatch(session, perBatch, body);
    latencies.push(...batchLatencies);
    session.close();
  }
  return { latencies, wallMs: performance.now() - startWall };
}

async function sharedSession(url, ca, { batches, perBatch, body, connectDelayMs = 0 }) {
  const latencies = [];
  const startWall = performance.now();
  const session = await connect(url, ca, connectDelayMs);
  for (let b = 0; b < batches; b += 1) {
    const batchLatencies = await runBatch(session, perBatch, body);
    latencies.push(...batchLatencies);
  }
  session.close();
  return { latencies, wallMs: performance.now() - startWall };
}

module.exports = { perCallSession, sharedSession };
