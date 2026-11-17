// The websocket checks run against a tiny local websocket server written with node:http only
// (the production stream is not deployed yet, so its "up" path can only be tested here).
// It listens on port 0 (a free port the OS picks).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkHttp, checkWs } from '../scripts/check.mjs';
import { emptyHistory, serialize } from '../scripts/history.mjs';

const CHECK = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url));

const KEY = 'eta_000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const svc = (path) => ({
  id: 'stream', kind: 'ws', url: `ws://127.0.0.1:${port}${path}`,
  send: { type: 'auth', key: KEY }, expect: { text: 'bad key', close: 4001 }, notLiveUntilUp: true, slowMs: 3000,
});
const liveSvc = (path) => ({
  id: 'live', kind: 'ws', url: `ws://127.0.0.1:${port}${path}`, expect: { firstFrame: { t: 'marks' } }, slowMs: 3000,
});

let server, port;
const received = [];
const sockets = new Set();
const hits = new Map(); // upgrade attempts per path
// these paths serve the first connection only and refuse every later upgrade, the way a
// service that falls over between the first try and the retry looks from the check
const ONCE = new Set(['/slow-then-gone', '/wrong-then-gone']);

const frame = (opcode, payload) => Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
const closeFrame = (code, reason = '') => {
  const r = Buffer.from(reason);
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code);
  r.copy(p, 2);
  return frame(0x8, p);
};
// client frames are masked; payloads here are under 126 bytes
function readClientText(buf) {
  const len = buf[1] & 0x7f;
  const mask = buf.subarray(2, 6);
  return Buffer.from(buf.subarray(6, 6 + len).map((b, i) => b ^ mask[i % 4])).toString();
}

before(async () => {
  server = createServer((req, res) => {
    if (req.url === '/broken') return res.writeHead(502).end('Bad Gateway');
    if (req.url === '/short') { // says 200 and 100 bytes, sends 10 and hangs up: curl exits 18
      res.writeHead(200, { 'content-length': '100' });
      res.write('0123456789');
      return setTimeout(() => res.destroy(), 50);
    }
    res.writeHead(404).end('Not Found');
  });
  server.on('upgrade', (req, socket) => {
    sockets.add(socket);
    const n = (hits.get(req.url) ?? 0) + 1;
    hits.set(req.url, n);
    if (req.url === '/missing' || req.url === '/broken' || req.url === '/nows' || (ONCE.has(req.url) && n > 1)) { // what Railway does today for an app with no websocket route
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // live updates: the server speaks first, no auth
    if (req.url === '/marks' || req.url === '/other' || req.url === '/silent') {
      if (req.url === '/marks') socket.write(frame(0x1, Buffer.from('{"t":"marks","d":{"BTC":"97000.5"}}')));
      if (req.url === '/other') socket.write(frame(0x1, Buffer.from('{"t":"hello"}')));
      socket.on('data', () => socket.end()); // the client's close frame
      return;
    }
    socket.once('data', (buf) => {
      received.push(readClientText(buf));
      if (req.url === '/ok') {
        socket.write(frame(0x1, Buffer.from('{"type":"error","error":"bad key"}')));
        socket.write(closeFrame(4001, 'bad key'));
      } else if (req.url === '/wrong' || req.url === '/wrong-then-gone') {
        socket.write(frame(0x1, Buffer.from('{"type":"hello"}')));
        socket.write(closeFrame(1000, 'bye'));
      } else if (req.url === '/slow-then-gone') { // the right answer, but after 400 ms
        return setTimeout(() => {
          socket.write(frame(0x1, Buffer.from('{"type":"error","error":"bad key"}')));
          socket.write(closeFrame(4001, 'bad key'));
          setTimeout(() => socket.destroy(), 200);
        }, 400);
      }
      setTimeout(() => socket.destroy(), 200);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => {
  for (const s of sockets) s.destroy();
  server.close();
});

test('auth with the placeholder key, "bad key" frame and close 4001: up', async () => {
  const r = await checkWs(svc('/ok'), emptyHistory());
  assert.equal(r.state, 'up');
  assert.equal(r.status, 101);
  assert.deepEqual(JSON.parse(received.at(-1)), { type: 'auth', key: KEY }, 'sent the auth frame');
});

test('socket opens but answers wrong: down, with the close code and first frame recorded', async () => {
  const r = await checkWs(svc('/wrong'), emptyHistory());
  assert.equal(r.state, 'down');
  assert.match(r.note, /close 1000 "bye"/);
  assert.match(r.note, /"type":"hello"/);
});

test('no websocket and the route is 404, never seen working: not yet live', async () => {
  const r = await checkWs(svc('/missing'), emptyHistory());
  assert.equal(r.state, 'notlive');
  assert.equal(r.status, 404);
});

test('same answer after the stream has worked once: down', async () => {
  const h = emptyHistory();
  h.liveSince.stream = '2026-11-20T00:00:00Z';
  const r = await checkWs(svc('/missing'), h);
  assert.equal(r.state, 'down');
  assert.match(r.note, /plain GET is HTTP 404/);
});

test('before launch, the whole host failing (upgrade refused, GET 502) is still not yet live', async () => {
  const r = await checkWs(svc('/broken'), emptyHistory());
  assert.equal(r.state, 'notlive');
  assert.equal(r.status, 502);
  assert.match(r.note, /plain GET is HTTP 502/);
});

test('after launch, the same failure is down', async () => {
  const h = emptyHistory();
  h.liveSince.stream = '2026-11-20T00:00:00Z';
  const r = await checkWs(svc('/broken'), h);
  assert.equal(r.state, 'down');
});

test('HTTP: a 200 status line followed by a curl error is down, not up', async () => {
  const r = await checkHttp({ id: 'app', kind: 'http', method: 'GET', url: `http://127.0.0.1:${port}/short`, expect: { status: 200 }, slowMs: 3000 });
  assert.equal(r.status, 200);
  assert.equal(r.state, 'down');
  assert.match(r.note, /^curl exit 18/);
});

test('live updates: opens and the first frame has "t":"marks": up', async () => {
  const r = await checkWs(liveSvc('/marks'), emptyHistory());
  assert.equal(r.state, 'up');
  assert.equal(r.status, 101);
});

test('live updates: opens but the first frame is something else: down', async () => {
  const r = await checkWs(liveSvc('/other'), emptyHistory());
  assert.equal(r.state, 'down');
  assert.match(r.note, /first frame did not match; first frame: \{"t":"hello"\}/);
});

test('live updates: opens and sends nothing for 10 s: down', async () => {
  const t0 = Date.now();
  const r = await checkWs(liveSvc('/silent'), emptyHistory());
  assert.equal(r.state, 'down');
  assert.match(r.note, /no frame within 10s/);
  assert.ok(Date.now() - t0 >= 10_000, 'waited the full 10 seconds');
});

test('live updates: does not open: down (never "not yet live", even with no history)', async () => {
  const r = await checkWs(liveSvc('/nows'), emptyHistory());
  assert.equal(r.state, 'down');
  assert.match(r.note, /websocket did not open; plain GET is HTTP 404/);
});

// One full run of the CLI (check, retry, store) against a stream service on the mock server.
async function runOnce(path) {
  const dir = mkdtempSync(join(tmpdir(), 'eta-status-cli-'));
  try {
    const services = join(dir, 'services.json');
    const history = join(dir, 'history.json');
    writeFileSync(services, JSON.stringify({ services: [{ ...svc(path), name: 'Live stream', slowMs: 200 }] }));
    writeFileSync(history, serialize(emptyHistory()));
    hits.delete(path);
    await promisify(execFile)(process.execPath, [CHECK, '--history', history, '--services', services],
      { env: { ...process.env, ETA_STATUS_RETRY_MS: '0' } });
    const h = JSON.parse(readFileSync(history, 'utf8'));
    return { stored: h.recent.at(-1).r.stream, liveSince: h.liveSince.stream, attempts: hits.get(path) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('retry: the stream answered right but slowly, then the retry could not connect: stored down, liveSince latched', async () => {
  const r = await runOnce('/slow-then-gone');
  assert.equal(r.attempts, 2, 'the slow answer was retried');
  assert.notEqual(r.stored[0], 'notlive', 'a socket that opened in this run is never "not yet live"');
  assert.equal(r.stored[0], 'down');
  assert.ok(r.liveSince, 'it worked once (slowly), so liveSince is set');
});

test('retry: the stream opened but answered wrong, then the retry could not connect: stored down, no liveSince', async () => {
  const r = await runOnce('/wrong-then-gone');
  assert.equal(r.attempts, 2);
  assert.equal(r.stored[0], 'down', 'a socket that opened in this run is never "not yet live"');
  assert.equal(r.liveSince, undefined, 'it never gave the right answer');
});
