# http2-session-reuse-bench

A small, self-contained benchmark that measures the cost of **opening a new
HTTP/2 session per batch** versus **reusing one shared session across batches**.

It is a reproducible illustration of the behavior discussed in
[firebase/firebase-admin-node#2488](https://github.com/firebase/firebase-admin-node/issues/2488):
`sendEach()` / `sendEachForMulticast()` multiplex requests *within* a single
call, but each call establishes its **own** HTTP/2 session, so there is no
session reuse *across* calls. Under bursty, high-volume load this puts a
TLS + HTTP/2 handshake on the hot path of every batch.

> This repository does **not** contain or depend on any proprietary code. It is
> a generic, from-scratch demonstration using only Node.js built-ins
> (`http2`, `perf_hooks`, `crypto`). It is not affiliated with or endorsed by
> Firebase/Google.

## What it does

- Starts a local **TLS + HTTP/2** server that counts how many distinct
  sessions (connections) get opened.
- Sends an identical workload (`batches x perBatch` requests, same in-batch
  concurrency) two ways, changing **only** the session lifetime:
  - `per-call session` — a fresh session per batch (the #2488 behavior).
  - `shared session` — one session reused for every batch.
- Reports sessions opened, wall-clock time, throughput, and latency
  percentiles.

The session count is the key, unarguable fact: the per-call strategy opens one
connection **per batch**, while the shared strategy stays at **1** no matter how
many requests are sent.

## Results

Measured on Node.js v25 (loopback). Numbers vary by machine; run it yourself.

**Pure loopback** (handshake cost only, no modeled network latency):

| strategy         | sessions | requests | wall (ms) | req/s   | p99 (ms) |
|------------------|----------|----------|-----------|---------|----------|
| per-call session | 200      | 10,000   | 524       | 19,094  | 2.37     |
| shared session   | 1        | 10,000   | 178       | 56,322  | 2.70     |

→ **~3x faster**, 200x fewer connections.

**With a modeled per-connection cost** (`CONNECT_DELAY_MS=15`): this adds a fixed
15 ms delay to every new connection to stand in for the round-trips a real
TLS + HTTP/2 handshake takes over a network. It is a **model, not a measured
handshake** — loopback handshakes are sub-millisecond.

| strategy         | sessions | requests | wall (ms) | req/s   |
|------------------|----------|----------|-----------|---------|
| per-call session | 200      | 10,000   | ~3,800    | ~2,600  |
| shared session   | 1        | 10,000   | ~180      | ~55,000 |

Be explicit about what this shows: because the per-call strategy pays the delay
once per batch and the shared strategy pays it once total, the gap is
approximately `(BATCHES - 1) x CONNECT_DELAY_MS` **by construction**. The point
is not the exact multiplier (you can dial it up or down with the constant) — it
is that *the per-call strategy pays a connection setup on the hot path of every
batch, and the shared strategy pays it once*. On a real network that per-batch
cost is real; here it is modeled so the effect is visible and reproducible
without depending on network conditions.

## Level 2: against the real `firebase-admin` SDK

The benchmark above uses a hand-written client to model the two strategies. To
show this is not a strawman, `scripts/level2-sdk.js` runs the **actual**
`firebase-admin` `sendEach()` code path and counts the sessions it opens.

It stays fully offline and credential-free:

- `http2.connect()` is monkeypatched so the SDK's connections to
  `fcm.googleapis.com` are redirected to the local counting server.
- The app is initialized with a fake credential whose `getAccessToken()` returns
  a static token, so no OAuth or network call ever happens.

```bash
npm install            # pulls firebase-admin (devDependency, level 2 only)
CALLS=20 PER_CALL=50 node scripts/level2-sdk.js
```

Output:

```
SDK reported successes : 1000 / 1000
http2 sessions opened  : 20 (to the FCM endpoint)
streams (requests) seen: 1000

ACROSS calls: 20 sessions for 20 sendEach() calls = 1.00 session(s) per call
              — a new session every call, no reuse across calls.
```

Run it with a server delay to also see the in-call behavior:

```bash
CALLS=10 PER_CALL=50 PROCESSING_MS=20 node scripts/level2-sdk.js
# WITHIN a call: up to 50 concurrent streams on one session
#               — requests ARE multiplexed inside a single call.
```

So the SDK does two things at once, and both are true: it **multiplexes
within** a call, but it opens a **new session per** call. Multiplexing across
calls (session reuse) is the gap tracked in #2488.

> The local mock is stricter than Google's server about HTTP/2 header casing, so
> the script canonicalizes header names to lowercase at the transport boundary.
> This only lets the mock accept the request; it does not affect session
> lifetime, which is what the script measures.

## Run it

```bash
node bench.js
# or model a network handshake cost:
CONNECT_DELAY_MS=15 BATCHES=200 PER_BATCH=50 node bench.js
```

No install step; Node.js >= 18 only. A throwaway self-signed cert is generated
at runtime under `.certs/` (gitignored).

### Knobs

| env var            | default | meaning                                             |
|--------------------|---------|-----------------------------------------------------|
| `BATCHES`          | 200     | number of batches (≈ number of `sendEach` calls)    |
| `PER_BATCH`        | 50      | requests per batch, sent concurrently               |
| `PROCESSING_MS`    | 0       | server-side per-request delay (models backend work) |
| `CONNECT_DELAY_MS` | 0       | modeled per-connection network setup cost           |

## Why the comparison is fair

- Both strategies send the **same** number of requests with the **same**
  in-batch concurrency against the **same** server.
- The only variable is session lifetime.
- `CONNECT_DELAY_MS` is applied to **every** new connection, so the shared
  strategy pays it once and the per-call strategy pays it per batch — which is
  precisely the difference under test. With `CONNECT_DELAY_MS=0` the result is a
  pure, unembellished measurement.
- Per-request latency is measured from `request()` to the response `end`, so it
  deliberately **excludes** connection setup; that cost shows up in wall-clock
  time and throughput instead. Latency percentiles are therefore *not* an
  end-to-end caller number — for the per-call strategy the caller also waits for
  a handshake per batch, which lives in the wall-clock column.

## Tests

```bash
npm install   # for the level-2 test (firebase-admin); other tests need nothing
npm test      # node --test
```

The suite (`node:test`, no framework) asserts the load-bearing claims directly:

- `perCallSession` opens exactly one session per batch; `sharedSession` opens
  exactly one for the whole run.
- The real `firebase-admin` `sendEach()` opens one session per call, and
  multiplexes every message within a call onto that one session.
- A non-2xx response is counted as a failure, never a success.
- Percentiles use nearest-rank and never over-index.

The level-2 test is skipped (not failed) if `firebase-admin` isn't installed.

## Limitations

This is a focused illustration, not a network benchmark. Read the numbers with
these caveats:

- **Single caller, serialized.** The per-call strategy opens connections one
  after another. A real service with many concurrent callers would overlap
  handshakes, so wall-clock totals here reflect a single serial caller, not
  aggregate burst behavior.
- **Modeled, not measured, network cost.** `CONNECT_DELAY_MS` is a fixed sleep.
  It does not reproduce RTT, DNS/TCP/TLS/ALPN/SETTINGS, bandwidth, packet loss,
  or TLS session resumption. Treat the modeled multipliers as illustrative.
- **Idealized shared session.** The shared strategy assumes one permanently
  healthy session. A production implementation must handle GOAWAY, idle/lifetime
  limits, `SETTINGS_MAX_CONCURRENT_STREAMS`, and reconnection — which is exactly
  why session reuse is non-trivial to add to an SDK.
- **Same process.** Client and server share one Node event loop, so client and
  server work contend; absolute throughput is not representative of a remote
  service.
- **Single run.** Numbers are one run on one machine with no warmup, repetition,
  or confidence interval. Run it yourself; treat the session count — not the
  timings — as the load-bearing evidence.

The one claim this repo makes without caveat is structural and reproducible:
**a per-call session is opened once per batch (N sessions for N batches), while a
shared session stays at 1** — including against the real `firebase-admin` SDK.

## License

MIT © Changhyun Kim
