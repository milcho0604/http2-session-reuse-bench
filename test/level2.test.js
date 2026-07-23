'use strict';

// Level 2 exercises the real firebase-admin SDK, so it needs the devDependency
// installed. Skip gracefully (rather than fail) if it isn't there.
const { test } = require('node:test');
const assert = require('node:assert/strict');

let hasFirebase = true;
try {
  require.resolve('firebase-admin/app');
} catch {
  hasFirebase = false;
}

const { runLevel2 } = require('../scripts/level2-sdk');

test(
  'real firebase-admin sendEach() opens one session per call',
  { skip: hasFirebase ? false : 'firebase-admin not installed (run npm install)' },
  async () => {
    const r = await runLevel2({ calls: 6, perCall: 10, processingMs: 0 });
    assert.equal(r.successes, 6 * 10, 'all messages should succeed against the mock');
    assert.equal(r.sessions, 6, 'one new session per sendEach() call');
    assert.equal(r.redirectedConnects, 6, 'every connect was to the FCM endpoint');
    assert.equal(r.requests, 6 * 10, 'server saw every request as a stream');
  },
);

test(
  'requests within a single call are multiplexed on one session',
  { skip: hasFirebase ? false : 'firebase-admin not installed (run npm install)' },
  async () => {
    // With a server delay, streams overlap, so max-concurrent reveals in-call
    // multiplexing. One call, perCall messages -> up to perCall concurrent.
    const perCall = 20;
    const r = await runLevel2({ calls: 1, perCall, processingMs: 25 });
    assert.equal(r.sessions, 1);
    assert.equal(r.maxConcurrentStreams, perCall, 'all messages share one session concurrently');
  },
);
