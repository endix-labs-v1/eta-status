#!/usr/bin/env node
// Runs every check in services.json once, appends the results to history.json and compacts it.
//
//   node scripts/check.mjs --history path/to/history.json [--new] [--services services.json]
//
// --new   allow starting a new history when the file does not exist (first run only).
//         A file that exists but does not parse always stops the run: history is never reset.
//
// No npm packages: HTTP checks use curl, the stream check uses the WebSocket built into Node 22+.

import { readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendPoint, compact, emptyHistory, serialize, validate } from './history.mjs';

const UA = 'eta-status-check (+https://github.com/endix-labs-v1/eta-status)';
const MARK = '__eta_status__';
const HTTP_TIMEOUT_S = 15;
const WS_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = Number(process.env.ETA_STATUS_RETRY_MS ?? 5000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n = 160) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

function curl(args) {
  return new Promise((resolve) => {
    execFile('curl', args, { maxBuffer: 16 * 1024 * 1024, timeout: (HTTP_TIMEOUT_S + 5) * 1000 },
      (err, stdout, stderr) => {
        const exit = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
        const i = stdout.lastIndexOf(MARK);
        let status = 0, ms = null, body = stdout;
        if (i >= 0) {
          const [code, secs] = stdout.slice(i + MARK.length).trim().split(' ');
          status = Number(code) || 0;
          ms = Math.round(Number(secs) * 1000);
          body = stdout.slice(0, i);
        }
        resolve({ exit, status, ms, body, stderr: clip(stderr) });
      });
  });
}

export async function checkHttp(svc) {
  const args = ['-sS', '--max-time', String(HTTP_TIMEOUT_S), '-A', UA, '-X', svc.method || 'GET'];
  for (const [k, v] of Object.entries(svc.headers || {})) args.push('-H', `${k}: ${v}`);
  if (svc.body != null) args.push('--data-raw', svc.body);
  args.push('-w', `${MARK}%{http_code} %{time_total}`, svc.url);

  const r = await curl(args);
  const base = { status: r.status, ms: r.ms ?? HTTP_TIMEOUT_S * 1000 };
  // Any curl error is down, even after a status line: a 200 that stalls until the timeout is not up.
  if (r.exit !== 0) return { ...base, state: 'down', note: `curl exit ${r.exit}: ${r.stderr}` };
  if (r.status !== svc.expect.status) return { ...base, state: 'down', note: `HTTP ${r.status}, expected ${svc.expect.status}` };
  if (svc.expect.json) {
    let body;
    try { body = JSON.parse(r.body); } catch { return { ...base, state: 'down', note: 'body is not JSON' }; }
    for (const [k, v] of Object.entries(svc.expect.json)) {
      if (body?.[k] !== v) return { ...base, state: 'down', note: `body.${k} is ${JSON.stringify(body?.[k])}, expected ${JSON.stringify(v)}` };
    }
  }
  return { ...base, state: base.ms > svc.slowMs ? 'degraded' : 'up' };
}

// The browser-style WebSocket hides the HTTP status of a failed handshake, so when the socket
// never opens we record the status of a plain GET of the same URL. A plain GET, not an
// upgrade request: on 2026-11-17 api.eta.cash answered every upgrade (even /health) with a
// Railway 502 "Application failed to respond", while a plain GET of /stream said 404.
async function routeStatus(url) {
  const httpUrl = url.replace(/^ws(s?):/, 'http$1:');
  const r = await curl(['-sS', '--max-time', '10', '-A', UA, '-o', '/dev/null',
    '-w', `${MARK}%{http_code} %{time_total}`, httpUrl]);
  return r.status;
}

export async function checkWs(svc, history) {
  if (typeof WebSocket !== 'function') throw new Error('This check needs Node 22 or newer (global WebSocket).');
  const t0 = performance.now();
  const want = svc.expect.text.toLowerCase();
  const seen = await new Promise((resolve) => {
    const s = { opened: false, matched: false, frame: '', code: null, reason: '', timedOut: false };
    let ws;
    const done = () => { clearTimeout(timer); resolve(s); };
    const timer = setTimeout(() => { s.timedOut = true; try { ws.close(); } catch {} done(); }, WS_TIMEOUT_MS);
    try { ws = new WebSocket(svc.url); } catch (e) { s.reason = clip(e.message); return done(); }
    ws.addEventListener('open', () => { s.opened = true; ws.send(JSON.stringify(svc.send)); });
    ws.addEventListener('message', (e) => {
      const text = typeof e.data === 'string' ? e.data : '';
      if (!s.frame) s.frame = clip(text, 120);
      if (text.toLowerCase().includes(want)) s.matched = true;
    });
    ws.addEventListener('error', () => {});
    ws.addEventListener('close', (e) => {
      s.code = e.code; s.reason = clip(e.reason, 120);
      if (s.reason.toLowerCase().includes(want)) s.matched = true;
      done();
    });
  });
  const ms = Math.round(performance.now() - t0);

  if (seen.opened) {
    if (seen.matched && seen.code === svc.expect.close) {
      return { state: ms > svc.slowMs ? 'degraded' : 'up', status: 101, ms };
    }
    const why = seen.timedOut ? `no close within ${WS_TIMEOUT_MS / 1000}s` : `close ${seen.code} "${seen.reason}"`;
    return { state: 'down', status: 101, ms, note: `${why}; first frame: ${seen.frame || '(none)'}` };
  }

  // The socket did not open. Until the stream has been seen working once (liveSince), that means
  // "not yet live" whatever the GET says: an API outage before launch must not paint a service
  // that does not exist yet red. Once it has worked, the same failure is down.
  const status = await routeStatus(svc.url);
  const why = `${seen.timedOut ? 'websocket did not open in time' : 'websocket did not open'}; plain GET is HTTP ${status}`;
  if (!history.liveSince[svc.id]) return status === 404 ? { state: 'notlive', status, ms } : { state: 'notlive', status, ms, note: why };
  return { state: 'down', status, ms, note: why };
}

export async function checkService(svc, history) {
  const run = () => (svc.kind === 'ws' ? checkWs(svc, history) : checkHttp(svc));
  let r = await run();
  if (r.state === 'down' || r.state === 'degraded') {
    await sleep(RETRY_DELAY_MS);
    r = await run();
  }
  return r;
}

const toRaw = (r) => (r.note ? [r.state, r.status, r.ms, r.note] : [r.state, r.status, r.ms]);

async function loadHistory(path, allowNew) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' && allowNew) return emptyHistory();
    throw new Error(`cannot read ${path} (${e.code}). Pass --new only for the very first run.`);
  }
  return validate(JSON.parse(text)); // throws on bad JSON: never start over on top of real history
}

function parseArgs(argv) {
  const a = { services: fileURLToPath(new URL('../services.json', import.meta.url)), history: null, new: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--history') a.history = argv[++i];
    else if (argv[i] === '--services') a.services = argv[++i];
    else if (argv[i] === '--new') a.new = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!a.history) throw new Error('usage: node scripts/check.mjs --history path/to/history.json [--new]');
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { services } = JSON.parse(await readFile(args.services, 'utf8'));
  const history = await loadHistory(args.history, args.new);

  const t = Math.floor(Date.now() / 1000);
  const results = await Promise.all(services.map((s) => checkService(s, history)));
  const raw = Object.fromEntries(services.map((s, i) => [s.id, toRaw(results[i])]));

  appendPoint(history, t, raw);
  compact(history, t);

  const tmp = `${args.history}.tmp`;
  await writeFile(tmp, serialize(history));
  await rename(tmp, args.history);

  const rows = services.map((s, i) => {
    const r = results[i];
    return `| ${s.name} | ${r.state} | ${r.status} | ${r.ms} | ${r.note ?? ''} |`;
  });
  const table = ['| service | state | http | ms | note |', '|---|---|---|---|---|', ...rows].join('\n');
  console.log(`checks at ${history.updated}\n${table}`);
  console.log(`history: ${history.recent.length} raw points, ${Object.keys(history.days).length} days`);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `### Checks at ${history.updated}\n\n${table}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
