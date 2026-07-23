'use strict';

// Pure statistics helpers, extracted so they can be unit-tested without
// starting a server or running the CLI.

function round(n) {
  return Math.round(n * 100) / 100;
}

// nearest-rank percentile: rank = ceil(p/100 * n), 1-indexed.
function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length, Math.max(1, rank)) - 1;
  return sorted[idx];
}

function summarize(name, result, sessions) {
  const sorted = result.latencies.slice().sort((a, b) => a - b);
  const total = sorted.length;
  const throughput = total / (result.wallMs / 1000);
  return {
    name,
    sessions,
    requests: total,
    wallMs: round(result.wallMs),
    throughput: round(throughput),
    p50: round(pct(sorted, 50)),
    p95: round(pct(sorted, 95)),
    p99: round(pct(sorted, 99)),
  };
}

module.exports = { round, pct, summarize };
