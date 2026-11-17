// History format (history.json on the `data` branch).
//
// {
//   "v": 1,
//   "updated": "2026-11-17T11:10:00Z",
//   "liveSince": { "api": "2026-11-17T11:10:00Z" },   first time each service was seen working
//   "recent": [ { "t": 1763377800, "r": { "api": ["up", 200, 498], ... } } ],
//   "days":   { "2026-11-16": { "api": [up, slow, down, notlive], ... } }
// }
//
// Every check result is in exactly one place: a raw point in `recent` (the last 24 hours)
// or a count in `days` (UTC days). compact() moves points older than 24 hours into `days`,
// so a day that is partly raw and partly counted is never counted twice.
// A raw result is [state, httpStatus, ms] or [state, httpStatus, ms, note] when it failed.

export const STATES = ['up', 'degraded', 'down', 'notlive'];
export const RECENT_SECONDS = 24 * 60 * 60;
export const DAYS_KEPT = 90;

export function emptyHistory() {
  return { v: 1, updated: null, liveSince: {}, recent: [], days: {} };
}

export function dayKey(sec) {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

export function validate(h) {
  const ok =
    h && typeof h === 'object' && h.v === 1 &&
    Array.isArray(h.recent) &&
    h.days && typeof h.days === 'object' && !Array.isArray(h.days) &&
    h.liveSince && typeof h.liveSince === 'object' &&
    h.recent.every((p) => Number.isInteger(p.t) && p.r && typeof p.r === 'object');
  if (!ok) throw new Error('history.json does not have the expected shape (v1)');
  return h;
}

export function appendPoint(h, t, results) {
  h.recent.push({ t, r: results });
  for (const [id, res] of Object.entries(results)) {
    if ((res[0] === 'up' || res[0] === 'degraded') && !h.liveSince[id]) {
      h.liveSince[id] = new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    }
  }
  h.updated = new Date(t * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return h;
}

// Move raw points older than 24 hours into daily counts and drop days older than 90.
// Running it twice with the same `now` changes nothing the second time.
export function compact(h, now) {
  const cutoff = now - RECENT_SECONDS;
  const keep = [];
  for (const p of h.recent) {
    if (p.t > cutoff) { keep.push(p); continue; }
    const day = (h.days[dayKey(p.t)] ??= {});
    for (const [id, res] of Object.entries(p.r)) {
      const i = STATES.indexOf(res[0]);
      if (i < 0) continue;
      const c = (day[id] ??= [0, 0, 0, 0]);
      c[i] += 1;
    }
  }
  keep.sort((a, b) => a.t - b.t);
  h.recent = keep;

  const oldest = dayKey(now - (DAYS_KEPT - 1) * 86400);
  const days = {};
  for (const k of Object.keys(h.days).sort()) {
    if (k >= oldest) days[k] = h.days[k];
  }
  h.days = days;
  return h;
}

// Small, stable JSON: one raw point per line so the file stays readable.
export function serialize(h) {
  const head = {
    v: h.v,
    updated: h.updated,
    liveSince: h.liveSince,
  };
  const lines = [];
  lines.push('{');
  for (const [k, v] of Object.entries(head)) lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)},`);
  lines.push('  "recent": [');
  h.recent.forEach((p, i) => lines.push(`    ${JSON.stringify(p)}${i < h.recent.length - 1 ? ',' : ''}`));
  lines.push('  ],');
  lines.push('  "days": {');
  const dk = Object.keys(h.days);
  dk.forEach((k, i) => lines.push(`    ${JSON.stringify(k)}: ${JSON.stringify(h.days[k])}${i < dk.length - 1 ? ',' : ''}`));
  lines.push('  }');
  lines.push('}');
  return lines.join('\n') + '\n';
}
