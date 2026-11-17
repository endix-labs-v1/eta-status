// Dry run of .github/workflows/check.yml: its own `run:` steps, in order, the way the runner runs
// them (bash -eo pipefail, RUNNER_TEMP, GITHUB_ENV), from a depth-1 clone of a local bare
// "origin". The checks point at a local HTTP server, so nothing here touches the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

// git with no user or system config, so a local setting cannot change the result
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GITHUB_') && !k.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com',
  ETA_STATUS_RETRY_MS: '0',
};

function git(args, cwd, input) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8', input });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

// The steps of check.yml that have `run:`, with their `env:`. A small reader for our own file.
function readSteps(text) {
  const lines = text.split('\n');
  const steps = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*- (name|uses):/.test(l)) steps.push((cur = { name: '', env: {}, run: null }));
    if (!cur) continue;
    const name = l.match(/^\s*-?\s*name:\s*(.+)$/);
    if (name && !cur.name) cur.name = name[1].trim();
    const block = l.match(/^(\s*)(run|env):\s*(\|)?\s*(.*)$/);
    if (!block) continue;
    const [, ind, key, pipe, inline] = block;
    if (key === 'run' && !pipe) { cur.run = inline; continue; }
    const body = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || lines[i + 1].search(/\S/) > ind.length)) body.push(lines[++i]);
    if (key === 'run') {
      const cut = Math.min(...body.filter((b) => b.trim()).map((b) => b.search(/\S/)));
      cur.run = body.map((b) => b.slice(cut)).join('\n');
    } else {
      for (const b of body) {
        const kv = b.match(/^\s*([A-Z_]+):\s*(.*)$/);
        if (kv) cur.env[kv[1]] = kv[2].replace(/^(['"])(.*)\1$/, '$2');
      }
    }
  }
  return steps.filter((s) => s.run);
}

let tmp, src, server, port, steps;

before(async () => {
  steps = readSteps(readFileSync(join(ROOT, '.github/workflows/check.yml'), 'utf8'));
  server = createServer((req, res) => res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}'));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;

  tmp = mkdtempSync(join(tmpdir(), 'eta-status-wf-'));
  src = join(tmp, 'src');
  mkdirSync(src);
  cpSync(join(ROOT, 'scripts'), join(src, 'scripts'), { recursive: true });
  cpSync(join(ROOT, '.github'), join(src, '.github'), { recursive: true });
  writeFileSync(join(src, 'services.json'), JSON.stringify({ services: [
    { id: 'api', name: 'API', kind: 'http', method: 'GET', url: `http://127.0.0.1:${port}/health`, expect: { status: 200, json: { ok: true } }, slowMs: 3000 },
  ] }));
  git(['init', '-q', '-b', 'main'], src);
  git(['add', '-A'], src);
  git(['commit', '-q', '-m', 'main'], src);
});

after(() => {
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

let n = 0;
function origin() {
  const bare = join(tmp, `origin-${++n}.git`);
  git(['clone', '-q', '--bare', src, bare], tmp);
  return bare;
}

// Point `data` at a new parentless commit holding these files.
function setData(bare, files) {
  const entries = Object.entries(files).map(([name, body]) => `100644 blob ${git(['hash-object', '-w', '--stdin'], bare, body)}\t${name}`);
  const tree = git(['mktree'], bare, entries.join('\n') + '\n');
  const commit = git(['commit-tree', tree, '-m', 'setup'], bare);
  git(['update-ref', 'refs/heads/data', commit], bare);
  return commit;
}

function readData(bare) {
  const sha = git(['rev-parse', 'refs/heads/data'], bare);
  return {
    sha,
    parents: git(['log', '-1', '--format=%P', sha], bare),
    files: git(['ls-tree', '--name-only', sha], bare).split('\n'),
    history: JSON.parse(git(['show', `${sha}:history.json`], bare)),
  };
}

// One workflow run: a depth-1 checkout of main, then each `run:` step in order.
async function job(bare, { remote } = {}) {
  const dir = join(tmp, `job-${++n}`);
  const repo = join(dir, 'repo');
  const temp = join(dir, 'temp');
  mkdirSync(temp, { recursive: true });
  git(['clone', '-q', '--depth', '1', '--branch', 'main', `file://${bare}`, repo], tmp);
  assert.equal(git(['rev-parse', '--is-shallow-repository'], repo), 'true');
  if (remote) git(['remote', 'set-url', 'origin', remote], repo);
  const envFile = join(dir, 'github_env');
  writeFileSync(envFile, '');
  for (const step of steps) {
    const fromEnvFile = Object.fromEntries(readFileSync(envFile, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const script = join(dir, 'step.sh');
    writeFileSync(script, step.run);
    try {
      await run('bash', ['--noprofile', '--norc', '-eo', 'pipefail', script],
        { cwd: repo, env: { ...ENV, RUNNER_TEMP: temp, GITHUB_ENV: envFile, ...fromEnvFile, ...step.env } });
    } catch (e) {
      return { failed: step.name, output: `${e.stdout}${e.stderr}` };
    }
  }
  return { failed: null };
}

test('the workflow has the three run steps this test drives', () => {
  assert.deepEqual(steps.map((s) => s.name), ['Load history from the data branch', 'Run checks', 'Publish history to the data branch']);
});

test('no data branch: the first run creates it with one check', async () => {
  const bare = origin();
  const r = await job(bare);
  assert.equal(r.failed, null, r.output);
  const d = readData(bare);
  assert.deepEqual(d.files, ['history.json']);
  assert.equal(d.parents, '', 'one parentless commit');
  assert.equal(d.history.recent.length, 1);
  assert.equal(d.history.recent[0].r.api[0], 'up');
});

test('data branch without history.json: the run starts a new history and publishes it', async () => {
  const bare = origin();
  setData(bare, { 'README.md': 'made by hand\n' });
  const r = await job(bare);
  assert.equal(r.failed, null, r.output);
  const d = readData(bare);
  assert.deepEqual(d.files, ['history.json']);
  assert.equal(d.history.recent.length, 1);
});

test('two runs in a row: the second reads the first back, data stays one parentless commit', async () => {
  const bare = origin();
  assert.equal((await job(bare)).failed, null);
  const r = await job(bare);
  assert.equal(r.failed, null, r.output);
  const d = readData(bare);
  assert.equal(d.history.recent.length, 2);
  assert.equal(d.parents, '');
});

test('history.json that does not parse: the run fails and data is not touched', async () => {
  const bare = origin();
  const before = setData(bare, { 'history.json': 'not json {' });
  const r = await job(bare);
  assert.equal(r.failed, 'Run checks');
  assert.equal(git(['rev-parse', 'refs/heads/data'], bare), before);
});

test('origin cannot be reached: the load step fails and nothing is published', async () => {
  const bare = origin();
  const r = await job(bare, { remote: `file://${join(tmp, 'no-such-origin.git')}` });
  assert.equal(r.failed, 'Load history from the data branch');
  assert.throws(() => git(['rev-parse', '--verify', '-q', 'refs/heads/data'], bare));
});
