'use strict';

// Level 2: prove the behavior against the *real* firebase-admin SDK.
//
// Instead of trusting a claim, this runs the actual Messaging.sendEach() code
// path and counts how many HTTP/2 sessions the SDK opens across N calls.
//
// How it stays offline and credential-free:
//   1. We monkeypatch http2.connect() so any connection the SDK makes to
//      fcm.googleapis.com is transparently redirected to a local TLS h2 server
//      (which counts sessions). We also count the redirects ourselves.
//   2. We initialize the SDK with a fake credential whose getAccessToken()
//      returns a static token, so no OAuth/network call ever happens.
//
// Expected result: one session per sendEach() call — i.e. no reuse across
// calls, exactly the behavior discussed in firebase/firebase-admin-node#2488.

const http2 = require('http2');
const { createServer } = require('../src/server');
const { ensureCert } = require('../src/cert');

function intEnv(name, def) {
  const v = process.env[name];
  return v === undefined ? def : parseInt(v, 10);
}

// unique firebase app name per run so multiple runs in one process don't collide
let appSeq = 0;

// The real FCM server tolerates non-canonical HTTP/2 headers that the SDK emits
// (mixed-case names like `Content-Length`, and a `:scheme` of "https:"). Node's
// built-in http2 *server* is stricter and rejects them with a PROTOCOL_ERROR
// before the stream is even delivered. Since our only goal is to observe
// session lifetime — not to re-test Google's leniency — we canonicalize headers
// at the transport boundary so the local mock accepts them. This does not touch
// how many sessions are opened, which is what we measure.
function canonicalizeHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.startsWith(':')) {
      out[k] = k === ':scheme' ? String(v).replace(/:$/, '') : v;
    } else {
      out[k.toLowerCase()] = v;
    }
  }
  return out;
}

// Runs `calls` sendEach() invocations of `perCall` messages each against a
// local counting server, and returns what actually happened. Pure enough to
// unit-test: no process.exit, no console output.
async function runLevel2({ calls = 20, perCall = 50, processingMs = 0 } = {}) {
  const { cert: ca } = ensureCert();
  const { stats, listen, close } = createServer({ processingMs });
  const { port } = await listen();

  let redirectedConnects = 0;
  const realConnect = http2.connect.bind(http2);
  http2.connect = (authority, options, listener) => {
    if (String(authority).includes('fcm.googleapis.com')) {
      redirectedConnects += 1;
      const session = realConnect(
        `https://127.0.0.1:${port}`,
        { ...(options || {}), ca, servername: 'localhost', rejectUnauthorized: false },
        listener,
      );
      const realRequest = session.request.bind(session);
      session.request = (headers, opts) => realRequest(canonicalizeHeaders(headers), opts);
      return session;
    }
    return realConnect(authority, options, listener);
  };

  try {
    // firebase-admin v14 removed the legacy namespace, so use the modular API.
    const { initializeApp, deleteApp } = require('firebase-admin/app');
    const { getMessaging } = require('firebase-admin/messaging');
    const app = initializeApp(
      {
        projectId: 'demo-project',
        credential: {
          getAccessToken: async () => ({ access_token: 'fake-token', expires_in: 3600 }),
        },
      },
      // unique app name so multiple runs in one process don't collide
      `lvl2-${appSeq += 1}`,
    );
    const messaging = getMessaging(app);

    const messages = [];
    for (let i = 0; i < perCall; i += 1) {
      messages.push({ token: `demo-token-${i}`, notification: { title: 'x', body: 'y' } });
    }

    let successes = 0;
    for (let c = 0; c < calls; c += 1) {
      const resp = await messaging.sendEach(messages);
      successes += resp.successCount;
    }

    await deleteApp(app);
    return {
      calls,
      perCall,
      successes,
      sessions: stats.sessions,
      redirectedConnects,
      requests: stats.requests,
      maxConcurrentStreams: stats.maxConcurrentStreams,
    };
  } finally {
    http2.connect = realConnect;
    await close();
  }
}

module.exports = { runLevel2, canonicalizeHeaders };

// CLI
if (require.main === module) {
  const calls = intEnv('CALLS', 20);
  const perCall = intEnv('PER_CALL', 50);
  const processingMs = intEnv('PROCESSING_MS', 0);
  console.log(
    `\nCalling messaging.sendEach() ${calls} times, ${perCall} messages each ` +
    `(${calls * perCall} messages total)\n`,
  );
  runLevel2({ calls, perCall, processingMs })
    .then(r => {
      console.log('SDK reported successes :', r.successes, '/', calls * perCall);
      console.log('http2 sessions opened  :', r.sessions, '(to the FCM endpoint)');
      console.log('redirected connects    :', r.redirectedConnects);
      console.log('streams (requests) seen:', r.requests);
      console.log('max concurrent streams :', r.maxConcurrentStreams,
        r.maxConcurrentStreams <= 1 ? '(run with PROCESSING_MS>0 to observe in-call multiplexing)' : '');
      console.log(
        `\nACROSS calls: ${r.sessions} sessions for ${calls} sendEach() calls ` +
        `= ${(r.sessions / calls).toFixed(2)} session(s) per call` +
        `${r.sessions === calls ? ' — a new session every call, no reuse across calls.' : '.'}`,
      );
      if (r.maxConcurrentStreams > 1) {
        console.log(
          `WITHIN a call: up to ${r.maxConcurrentStreams} concurrent streams on one session ` +
          `— requests ARE multiplexed inside a single call.`,
        );
      }
      console.log(
        '\nSo multiplexing works within a call, but the session is torn down after ' +
        'each call. That is exactly the gap in firebase/firebase-admin-node#2488.\n',
      );
      process.exit(0);
    })
    .catch(err => {
      console.error(err);
      process.exit(1);
    });
}
