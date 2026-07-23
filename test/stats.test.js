'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pct, round, summarize } = require('../src/stats');

test('pct: nearest-rank on 1..10', () => {
  const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(pct(s, 50), 5); // ceil(0.5*10)=5 -> idx4 -> 5
  assert.equal(pct(s, 95), 10); // ceil(9.5)=10 -> idx9 -> 10
  assert.equal(pct(s, 99), 10);
  assert.equal(pct(s, 100), 10);
  assert.equal(pct(s, 10), 1); // ceil(1)=1 -> idx0 -> 1
});

test('pct: does not over-index (no off-by-one past the end)', () => {
  const s = [1, 2, 3, 4, 5];
  assert.equal(pct(s, 100), 5);
  assert.equal(pct(s, 95), 5);
  assert.ok(pct(s, 99) <= 5);
});

test('pct: empty input is 0', () => {
  assert.equal(pct([], 50), 0);
});

test('round: two decimals', () => {
  assert.equal(round(1.23456), 1.23);
  assert.equal(round(2), 2);
});

test('summarize: computes counts, throughput, percentiles', () => {
  const latencies = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100 ms
  const result = { latencies, wallMs: 1000 };
  const s = summarize('x', result, 7);
  assert.equal(s.name, 'x');
  assert.equal(s.sessions, 7);
  assert.equal(s.requests, 100);
  assert.equal(s.throughput, 100); // 100 req / 1s
  assert.equal(s.p50, 50);
  assert.equal(s.p95, 95);
  assert.equal(s.p99, 99);
});
