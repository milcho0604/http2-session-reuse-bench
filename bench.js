'use strict';

// Runs both strategies against the same in-process server with identical
// workloads and prints a side-by-side comparison. Configure via env vars:
//
//   BATCHES           number of batches (default 200)
//   PER_BATCH         requests per batch, sent concurrently (default 50)
//   PROCESSING_MS     server-side per-request delay (default 0)
//   CONNECT_DELAY_MS  simulated per-connection network setup cost (default 0)
//
// Example modeling a WAN handshake cost:
//   CONNECT_DELAY_MS=15 BATCHES=200 PER_BATCH=50 node bench.js

const { createServer } = require('./src/server');
const { perCallSession, sharedSession } = require('./src/senders');
const { ensureCert } = require('./src/cert');
const { round, summarize } = require('./src/stats');

const BATCHES = intEnv('BATCHES', 200);
const PER_BATCH = intEnv('PER_BATCH', 50);
const PROCESSING_MS = intEnv('PROCESSING_MS', 0);
const CONNECT_DELAY_MS = intEnv('CONNECT_DELAY_MS', 0);
const BODY = JSON.stringify({ message: { token: 'demo', notification: { title: 'x' } } });

function intEnv(name, def) {
  const v = process.env[name];
  return v === undefined ? def : parseInt(v, 10);
}

function pad(s, n) {
  s = String(s);
  return s + ' '.repeat(Math.max(0, n - s.length));
}

function printTable(rows) {
  const cols = [
    ['strategy', 22],
    ['sessions', 10],
    ['requests', 10],
    ['wall(ms)', 12],
    ['req/s', 12],
    ['p50(ms)', 10],
    ['p95(ms)', 10],
    ['p99(ms)', 10],
  ];
  const header = cols.map(([c, w]) => pad(c, w)).join('');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    console.log(
      pad(r.name, 22) + pad(r.sessions, 10) + pad(r.requests, 10) +
      pad(r.wallMs, 12) + pad(r.throughput, 12) +
      pad(r.p50, 10) + pad(r.p95, 10) + pad(r.p99, 10),
    );
  }
}

async function main() {
  ensureCert(); // warm the cert before timing anything
  const { cert: ca } = ensureCert();
  const { stats, listen, close } = createServer({ processingMs: PROCESSING_MS });
  const { url } = await listen();

  const opts = { batches: BATCHES, perBatch: PER_BATCH, body: BODY, connectDelayMs: CONNECT_DELAY_MS };

  console.log(
    `\nWorkload: ${BATCHES} batches x ${PER_BATCH} req = ${BATCHES * PER_BATCH} requests ` +
    `| server delay ${PROCESSING_MS}ms | connect delay ${CONNECT_DELAY_MS}ms\n`,
  );

  const before1 = stats.sessions;
  const r1 = await perCallSession(url, ca, opts);
  const perCall = summarize('per-call session', r1, stats.sessions - before1);

  const before2 = stats.sessions;
  const r2 = await sharedSession(url, ca, opts);
  const shared = summarize('shared session', r2, stats.sessions - before2);

  printTable([perCall, shared]);

  // Integrity: both strategies must have completed exactly the intended work.
  const expected = BATCHES * PER_BATCH;
  const totalSeen = stats.requests;
  if (perCall.requests !== expected || shared.requests !== expected) {
    throw new Error(
      `request-count mismatch: expected ${expected} each, got ` +
      `per-call=${perCall.requests}, shared=${shared.requests}`,
    );
  }

  const fewer = round(perCall.sessions / shared.sessions);
  const speedup = round(perCall.wallMs / shared.wallMs);
  console.log(
    `\nSame workload both ways (${expected} requests each, ${totalSeen} served). ` +
    `Shared session opened ${fewer}x fewer connections ` +
    `(${perCall.sessions} -> ${shared.sessions}) and finished ${speedup}x faster ` +
    `on this run.\n`,
  );

  await close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
