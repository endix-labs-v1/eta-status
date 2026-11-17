// Synthetic history for tests and for looking at the page locally.
//
//   node test/synth.mjs --out demo.json [--days 100]
//
// writes a compacted history whose newest point is 5 minutes ago. The events below plant
// a red day, a slow afternoon, short outages and a gap, so every cell colour shows up.

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { compact, emptyHistory, serialize } from '../scripts/history.mjs';

export const IDS = ['api', 'app', 'mcp', 'stream', 'docs'];
const OK = { api: 200, app: 200, mcp: 401, docs: 200 };

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function defaultEvents(end) {
  const ago = (h) => end - h * 3600;
  return [
    { ids: ['api', 'mcp'], from: ago(40 * 24 + 9), to: ago(40 * 24 + 3), state: 'down', status: 502, note: 'HTTP 502, expected 200' },
    { ids: ['api', 'mcp'], from: ago(12 * 24 + 5), to: ago(12 * 24 + 3), state: 'down', status: 503, note: 'HTTP 503, expected 200' },
    { ids: ['app'], from: ago(3 * 24 + 6), to: ago(3 * 24 + 3), state: 'degraded', status: 200, ms: 4200 },
    { ids: ['docs'], from: ago(26 * 24 + 2), to: ago(26 * 24 + 1), state: 'down', status: 0, note: 'curl exit 28: Operation timed out' },
    { ids: ['docs'], from: ago(6.5), to: ago(6), state: 'down', status: 0, note: 'curl exit 28: Operation timed out' },
    { ids: ['api'], from: ago(2), to: ago(1.75), state: 'degraded', status: 200, ms: 3400 },
  ];
}

// All points every 5 minutes for `days` days ending at `end`, left raw in `recent`.
// `gaps` are windows with no point at all (GitHub skipped the scheduled run).
export function synthRaw({ days = 100, end, events = defaultEvents(end), gaps = [[end - 20 * 86400, end - 20 * 86400 + 3 * 3600]] } = {}) {
  const rand = rng(42);
  const h = emptyHistory();
  const start = end - days * 86400 + 300;
  for (let t = start; t <= end; t += 300) {
    if (gaps.some(([a, b]) => t >= a && t < b)) continue;
    const r = {};
    for (const id of IDS) {
      if (id === 'stream') { r[id] = ['notlive', 404, 700 + Math.round(rand() * 200)]; continue; }
      const ev = events.find((e) => e.ids.includes(id) && t >= e.from && t < e.to);
      const ms = 80 + Math.round(rand() * (id === 'docs' ? 600 : 400));
      if (!ev) r[id] = ['up', OK[id], ms];
      else if (ev.state === 'degraded') r[id] = ['degraded', ev.status, ev.ms];
      else r[id] = [ev.state, ev.status, ev.status ? ms : 15000, ev.note];
    }
    h.recent.push({ t, r });
  }
  const first = new Date(start * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  h.liveSince = { api: first, app: first, mcp: first, docs: first };
  h.updated = new Date(end * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return h;
}

async function main() {
  const a = { out: null, days: 100 };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--days') a.days = Number(argv[++i]);
  }
  if (!a.out) throw new Error('usage: node test/synth.mjs --out demo.json [--days 100]');
  const now = Math.floor(Date.now() / 1000);
  const end = now - (now % 300) - 300;
  const h = compact(synthRaw({ days: a.days, end }), end);
  await writeFile(a.out, serialize(h));
  console.log(`wrote ${a.out}: ${h.recent.length} raw points, ${Object.keys(h.days).length} days`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
