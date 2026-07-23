'use strict';

// A minimal TLS + HTTP/2 server that stands in for a batched send endpoint
// (e.g. the FCM v1 send API). Its only job for the benchmark is to:
//   1. accept HTTP/2 requests and reply quickly, and
//   2. count how many distinct HTTP/2 sessions (connections) were opened.
//
// The session counter is the core evidence: a client that opens a fresh
// session per batch drives this number up linearly, while a client that
// reuses one session keeps it at 1 — regardless of how many requests are sent.

const http2 = require('http2');
const { ensureCert } = require('./cert');

function createServer({ processingMs = 0 } = {}) {
  const { key, cert } = ensureCert();
  const stats = { sessions: 0, requests: 0, maxConcurrentStreams: 0 };
  let liveStreams = 0;

  const server = http2.createSecureServer({ key, cert });

  server.on('session', session => {
    stats.sessions += 1;
    session.on('error', () => {});
  });

  server.on('stream', (stream, headers) => {
    stats.requests += 1;
    liveStreams += 1;
    if (liveStreams > stats.maxConcurrentStreams) {
      stats.maxConcurrentStreams = liveStreams;
    }
    stream.on('error', () => {});
    // Decrement on 'close' (fires for success AND abort paths), so an aborted
    // stream can never leak a live-stream slot and skew maxConcurrentStreams.
    stream.once('close', () => {
      liveStreams -= 1;
    });

    const respond = () => {
      if (stream.destroyed) return;
      stream.respond({
        ':status': 200,
        'content-type': 'application/json',
      });
      stream.end('{"name":"projects/demo/messages/0"}');
    };

    // Consume the full request body before responding, so upload/flow-control
    // is part of the request the way a real endpoint would see it. Optional
    // server-side processing delay models backend work; off by default so the
    // measured difference is connection setup, not fabricated server latency.
    stream.resume();
    stream.on('end', () => {
      if (processingMs > 0) setTimeout(respond, processingMs);
      else respond();
    });
  });

  function listen(portToBind = 0) {
    return new Promise((resolve, reject) => {
      // Fail loudly if the port cannot be bound (e.g. a sandbox that forbids
      // listening). Swallowing this used to make the whole benchmark exit 0
      // with no output, which hid the environment problem.
      const onError = err => reject(err);
      server.once('error', onError);
      server.listen(portToBind, '127.0.0.1', () => {
        server.removeListener('error', onError);
        server.on('error', () => {}); // post-listen runtime errors: non-fatal
        const { port } = server.address();
        resolve({ port, url: `https://127.0.0.1:${port}` });
      });
    });
  }

  function close() {
    return new Promise(resolve => server.close(resolve));
  }

  return { server, stats, listen, close };
}

module.exports = { createServer };

// Allow running standalone: `npm run server`
if (require.main === module) {
  createServer().listen().then(({ url }) => {
    // eslint-disable-next-line no-console
    console.log(`h2 server listening at ${url}`);
  });
}
