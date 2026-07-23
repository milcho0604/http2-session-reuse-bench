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

**Modeling a real network** (`CONNECT_DELAY_MS=15`, i.e. a ~15 ms per-connection
TLS + HTTP/2 setup cost — conservative for a WAN):

| strategy         | sessions | requests | wall (ms) | req/s   |
|------------------|----------|----------|-----------|---------|
| per-call session | 200      | 10,000   | 3,818     | 2,619   |
| shared session   | 1        | 10,000   | 182       | 55,001  |

→ **~21x faster.**

**Bursty workload** (many small batches: `BATCHES=500 PER_BATCH=20 CONNECT_DELAY_MS=25`):

| strategy         | sessions | requests | wall (ms) | req/s   |
|------------------|----------|----------|-----------|---------|
| per-call session | 500      | 10,000   | 14,223    | 703     |
| shared session   | 1        | 10,000   | 193       | 51,772  |

→ **~74x faster.** The more batches (calls), the wider the gap — because the
per-call strategy pays a handshake for each one.

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
- Per-request latency is measured from request send to response end (server
  time only); connection setup shows up in wall-clock time and throughput,
  where it belongs.

## License

MIT © Changhyun Kim
