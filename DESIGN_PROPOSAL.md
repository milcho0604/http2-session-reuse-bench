# Design Proposal: Opt-in HTTP/2 session reuse across `sendEach()` calls

**Status:** Draft — written at the team's invitation on
[#2488](https://github.com/firebase/firebase-admin-node/issues/2488#issuecomment-5059292865)
**Author:** @milcho0604 · **Scope:** `firebase-admin/messaging` (Node.js)
**Default behavior change:** none — opt-in, default-off

---

## 1. Problem

As of v14, one `sendEach()` / `sendEachForMulticast()` call multiplexes all of
its messages onto a single HTTP/2 session — the within-call part of #2488 is
done. The remaining gap, discussed later in that thread: each call constructs
its own `Http2SessionHandler` and closes it in `finally`, so **N calls open N
sessions** and repeated senders pay a TLS + HTTP/2 handshake per call.
Reproducible, offline benchmark (counted at the `http2.connect` boundary,
verified against 14.2.0): https://github.com/milcho0604/http2-session-reuse-bench

Proposed: an opt-in mode where the `Messaging` instance keeps a long-lived
session and reuses it across calls. (`sendEachForMulticast()` delegates to
`sendEach()`, so it is covered automatically.)

## 2. Proposed API

Preferred shape is an open question (§6.1) — the closest existing reference,
`enableLegacyHttpTransport()`, is itself `@deprecated`, so I don't propose
copying it blindly. Strawman, as a messaging-level method:

```ts
const messaging = getMessaging(app);
messaging.enablePersistentHttp2Session(options?: PersistentHttp2Options);

interface PersistentHttp2Options {
  maxIdleMillis?: number;            // close the session after this long with no active calls
  maxSessionLifetimeMillis?: number; // optional proactive recycle (LB drains, NAT timeouts)
}
```

Interaction rules:

- If legacy HTTP/1.1 transport is already enabled → throw (contradictory).
- If `enableLegacyHttpTransport()` is called while persistent mode is on: the
  flag flips immediately (it stays synchronous `void`; new calls use HTTP/1.1)
  and the persistent session is closed in the background once its active calls
  finish.
- Calling `enablePersistentHttp2Session()` twice is idempotent; option updates
  take effect from the next acquire/idle cycle.

Public-surface note: the new method and options interface go through the normal
`.d.ts` + API-report (api-extractor) update; the shutdown hook (§4.4) follows
the existing *internal* precedent and adds no public API.

## 3. Design sketch

A `PersistentHttp2SessionManager` owned by `Messaging`, created lazily on first
send when the mode is on. Sessions are managed as **generations**: a generation
bundles one session with its own error list and its own event listeners (the
current handler keeps a single mutable session/error array — exactly right for
its per-call use today, but not designed for sharing: late events from a
replaced session must not leak into its successor). A generation has exactly one state, moved synchronously:
**accepting** (hands out leases) → **draining** (on GOAWAY, session error,
close, or lifetime expiry: no new leases, existing leases finish) → **closed**
(last lease released, session closed). `acquire()` only ever returns the
current *accepting* generation, starting a fresh one if none exists.

Per call: `acquire(batchSize)` returns a lease pinned to the current
generation; the call issues its requests on that generation's session and
releases the lease in `finally`. Mode off → exactly today's per-call path; the
manager is never constructed.

- **No readiness gate.** The session is handed out immediately, exactly as
  today — Node buffers `request()` while connecting, and a connect failure
  surfaces as per-message rejections through the existing
  `Promise.allSettled()` path. `sendEach()` keeps today's contract: it resolves
  with a `BatchResponse`; connection problems appear as per-message failures,
  never as a thrown `sendEach()` error.
- **Error attribution.** A generation's session errors decorate the rejected
  results of calls that used that generation — same decoration semantics as
  today (only already-rejected results are decorated). One consequence of
  sharing: concurrent calls on one generation share its session errors, since
  a connection-level event cannot be causally pinned to one call. Calls
  acquired after a failure get a fresh generation and see none of it.
- **Retries.** Unchanged. The SDK's low-level retry keeps whatever session its
  request started with; if that session died, the retry fails as it does
  today. Reviving sessions mid-retry would make previously-failing retries
  actually resend — a behavior change (and an idempotency question) this
  proposal deliberately avoids. Fresh sessions happen at call boundaries only.
- **GOAWAY.** Streams the server already accepted (≤ `lastStreamID`) may still
  complete; unprocessed ones reject through the normal per-message path, and
  the generation is marked dead so the next acquire reconnects. Same semantics
  a mid-call GOAWAY has today — reuse widens who shares the session, not how
  errors are reported. No automatic re-send in v1 (idempotency of FCM sends is
  the team's call); `lastStreamID` is recorded for diagnostics.
- **Backpressure.** Baseline for comparison: today a single 500-message call
  already submits 500 streams against the session's concurrent-stream limit
  and Node queues the excess — that is current, accepted behavior, and reuse
  must keep it (a 500-message batch must reuse the shared session, not be
  penalized for its size). What reuse adds is the risk of *unbounded* pileup
  when many concurrent calls collapse onto one session, each stream carrying
  the SDK's fixed timeout. Mitigation: `acquire(batchSize)` atomically reserves
  against an **outstanding-request budget** on the generation (a constant on
  the order of a few times `FCM_MAX_BATCH_SIZE` — deliberately *not* tied to
  `SETTINGS_MAX_CONCURRENT_STREAMS`, which caps open streams, not admissions).
  A call that doesn't fit falls back to a per-call session, preserving current
  behavior for that call. Reuse when it helps; degrade to the status quo under
  heavy concurrency.

## 4. Lifecycle

1. **Idle:** defined as zero active leases. An `unref()`ed timer closes the
   session after `maxIdleMillis`; the session is also `unref()`ed while idle
   and `ref()`ed while leased, so a cached idle session never keeps a process
   alive but an active send does.
2. **Lifetime recycle:** at acquire time, a past-due generation moves to
   *draining* and a fresh generation is started; the old one closes when its
   remaining leases release. Active calls are never cut.
3. **Failure:** GOAWAY / session error moves the generation to *draining*
   synchronously; it is never handed out again, and recovery is lazy, on the
   next acquire. No background reconnect loops, no keepalive pings.
4. **Shutdown:** `Messaging` gains a runtime `delete(): Promise<void>` — the
   same *internal* duck-typed hook `FirebaseApp` teardown already calls on
   stateful services (`DatabaseService.delete()` is the in-repo precedent;
   nothing is added to the public type surface). It stops new leases, waits
   (bounded) for active leases, then closes the session, destroying it after a
   grace period so `deleteApp(app)` does not leave manager-owned handles. No-op
   if the mode was never enabled; idempotent at the messaging level.

Observability: reuse hits, fallbacks, recycles, and GOAWAYs should be countable
so an opted-in report is diagnosable from a support ticket; the SDK has no
existing transport-level logging facility, so the mechanism (debug log vs.
counters) is left to maintainer preference.

## 5. Testing (sketch)

- Mode off: M calls → M sessions (today, asserted at the connect boundary).
  Mode on, sequential calls within one idle window: 1 session; >1 is expected
  and asserted across idle expiry / recycle / failure.
- Error scoping: concurrent calls sharing a generation both see its session
  error on their rejected results (shared-fate, as specified); a call acquired
  after the failure sees a fresh generation and no stale errors.
- Connect failure with mode on: `sendEach()` still resolves with per-message
  failures (contract parity).
- Budget: a 500-message batch reuses the shared session (never falls back for
  size alone); an over-budget concurrent pileup falls back to per-call
  sessions.
- Refs/exit: an idle cached session does not keep the process alive.
- Shutdown: `deleteApp(app)` leaves no manager-owned handles; internal delete
  is idempotent.
- The benchmark repo's offline approach (connect-boundary counting, fake
  credential) adapts directly into fixtures.

## 6. Open questions

1. API shape: messaging method (shown) vs. `initializeApp()` option?
2. Idle/lifetime defaults — configurable in v1, or hard-coded first?
3. Is the outstanding-request budget + per-call fallback acceptable, or would
   the team rather cap-and-queue?
4. Any appetite for `lastStreamID`-aware re-send later, or keep it out?

## 7. Rollout

Proposal → team alignment → PR (manager + internal delete hook + tests,
written fresh against the SDK's own abstractions, default-off) → docs note
under `sendEach()` describing the trade-off and when to enable.

This proposal is intended as a starting point — happy to revise, split, or
narrow the scope based on the team's feedback and preferred process.

---

*Benchmark and raw numbers: https://github.com/milcho0604/http2-session-reuse-bench*
