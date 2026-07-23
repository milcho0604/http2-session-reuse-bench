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

    const respond = () => {
      liveStreams -= 1;
      stream.respond({
        ':status': 200,
        'content-type': 'application/json',
      });
      stream.end('{"name":"projects/demo/messages/0"}');
    };

    // Optional server-side processing delay to model backend work. Off by
    // default so the measured difference is purely connection setup, not
    // fabricated server latency.
    if (processingMs > 0) {
      setTimeout(respond, processingMs);
    } else {
      respond();
    }
  });

  server.on('error', () => {});

  function listen() {
    return new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
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
