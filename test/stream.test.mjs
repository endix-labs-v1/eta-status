// The production stream is not deployed yet, so its "up" path is tested against a tiny local
// websocket server written with node:http only. It listens on port 0 (a free port the OS picks).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { checkWs } from '../scripts/check.mjs';
import { emptyHistory } from '../scripts/history.mjs';

const KEY = 'eta_000000000000_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const svc = (path) => ({
  id: 'stream', kind: 'ws', url: `ws://127.0.0.1:${port}${path}`,
  send: { type: 'auth', key: KEY }, expect: { text: 'bad key', close: 4001 },
  notLiveStatus: [404], slowMs: 3000,
});

let server, port;
const received = [];

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
  server = createServer((req, res) => { res.writeHead(404).end('Not Found'); });
  server.on('upgrade', (req, socket) => {
    if (req.url === '/missing') { // what Railway does today for an app with no websocket route
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.once('data', (buf) => {
      received.push(readClientText(buf));
      if (req.url === '/ok') {
        socket.write(frame(0x1, Buffer.from('{"type":"error","error":"bad key"}')));
        socket.write(closeFrame(4001, 'bad key'));
      } else if (req.url === '/wrong') {
        socket.write(frame(0x1, Buffer.from('{"type":"hello"}')));
        socket.write(closeFrame(1000, 'bye'));
      }
      setTimeout(() => socket.destroy(), 200);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => server.close());

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
