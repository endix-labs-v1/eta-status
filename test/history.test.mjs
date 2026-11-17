// node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendPoint, compact, dayKey, emptyHistory, serialize, validate, STATES } from '../scripts/history.mjs';
import { IDS, synthRaw } from './synth.mjs';

const END = Date.UTC(2026, 10, 17, 11, 15) / 1000; // 2026-11-17 11:15 UTC
const clone = (x) => structuredClone(x);

// counts[day][id] = [up, degraded, down, notlive] straight from raw points
function rawCounts(points) {
  const out = {};
  for (const p of points) {
    const d = (out[dayKey(p.t)] ??= {});
    for (const [id, res] of Object.entries(p.r)) (d[id] ??= [0, 0, 0, 0])[STATES.indexOf(res[0])] += 1;
  }
  return out;
}

test('compacts 100 days of 5-minute points into 24 hours raw plus 90 daily counts', () => {
  const raw = synthRaw({ days: 100, end: END });
  const before = rawCounts(raw.recent);
  const h = compact(clone(raw), END);

  assert.ok(h.recent.every((p) => p.t > END - 86400), 'only the last 24 hours stay raw');
  assert.equal(h.recent.length, raw.recent.filter((p) => p.t > END - 86400).length);
  assert.equal(h.recent.length, 288);

  // At 11:15 UTC all of today's points are still raw, so `days` ends yesterday and
  // today comes from `recent`. Together they cover exactly 90 UTC days.
  const keys = Object.keys(h.days);
  assert.equal(keys[0], dayKey(END - 89 * 86400), 'oldest kept day is 89 days back');
  assert.equal(keys.at(-1), dayKey(END - 86400), 'newest counted day is yesterday');
  const covered = new Set([...keys, ...h.recent.map((p) => dayKey(p.t))]);
  assert.equal(covered.size, 90, '90 days covered');

  // every retained day: counted + still raw == what the raw points said. Nothing lost, nothing twice.
  const fromRecent = rawCounts(h.recent);
  for (const day of Object.keys(before)) {
    if (day < keys[0]) { assert.equal(h.days[day], undefined, `${day} dropped`); continue; }
    for (const id of IDS) {
      const got = [0, 1, 2, 3].map((i) => (h.days[day]?.[id]?.[i] ?? 0) + (fromRecent[day]?.[id]?.[i] ?? 0));
      assert.deepEqual(got, before[day][id], `${day} ${id}`);
    }
  }

  const bytes = Buffer.byteLength(serialize(h));
  console.log(`  compacted: ${h.recent.length} raw points, ${keys.length} counted days + today raw, ${(bytes / 1024).toFixed(1)} KB (raw input ${(Buffer.byteLength(serialize(raw)) / 1024 / 1024).toFixed(1)} MB)`);
  assert.ok(bytes < 120 * 1024, `history stays small (${bytes} bytes)`);
});

test('compaction is idempotent', () => {
  const once = compact(synthRaw({ days: 100, end: END }), END);
  const twice = compact(clone(once), END);
  assert.deepEqual(twice, once);
});

test('one point per run with compaction each time gives the same result as one big compaction', () => {
  const raw = synthRaw({ days: 3, end: END });
  const step = emptyHistory();
  for (const p of raw.recent) {
    appendPoint(step, p.t, p.r);
    compact(step, p.t);
  }
  const batch = compact(clone(raw), END);
  assert.deepEqual(step.recent, batch.recent);
  assert.deepEqual(step.days, batch.days);
});

test('the not-live stream never gets a liveSince; working services do', () => {
  const h = emptyHistory();
  appendPoint(h, END, { api: ['up', 200, 300], stream: ['notlive', 404, 700] });
  assert.ok(h.liveSince.api);
  assert.equal(h.liveSince.stream, undefined);
  appendPoint(h, END + 300, { stream: ['degraded', 101, 3500] });
  assert.ok(h.liveSince.stream, 'latched once it works, even slowly');
});

test('serialize round-trips and validate rejects a wrong shape', () => {
  const h = compact(synthRaw({ days: 5, end: END }), END);
  assert.deepEqual(validate(JSON.parse(serialize(h))), h);
  assert.throws(() => validate({ v: 1, recent: {}, days: {} }));
  assert.throws(() => validate({ v: 2, recent: [], days: {}, liveSince: {} }));
});
