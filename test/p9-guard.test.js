// P9 daily commit guard (2026-10-23 P9 approval 3): allowed paths only, frozen files equal to 53c88f5, fast-forward
// push to main without force, retry after fetching main.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ALLOWED_PATHS, allowed, statusPaths, frozenProblems, assertNoForce, PUSH_ARGS, commitAndPush, check } from '../jobs/lib/commit-guard.js';

test('the allowed list is the one written in docs/daily-run.md', async () => {
  const doc = await readFile(new URL('../docs/daily-run.md', import.meta.url), 'utf8');
  const sec = doc.split('## 일일 커밋 허용 경로')[1].split('\n## ')[0];
  const listed = [...sec.matchAll(/^- `([^`]+)`/gm)].map(m => m[1]);
  assert.deepEqual(listed, ALLOWED_PATHS);
});

test('only data and report paths of the season are allowed; code, parameters and the plan are not', () => {
  for (const p of ['data/games/2026-27/20261023.json.gz', 'data/picklog/log.jsonl', 'data/live/anchor.json', 'data/runs/2026-27/2026-10-23-A.json', 'docs/daily/2026-27/2026-10-23-A.md']) assert.equal(allowed(p), true, p);
  for (const p of ['engine/live.js', 'jobs/daily.js', 'package.json', 'data/model/params.json', 'data/model/calibration.json', 'docs/STATUS.md', 'data/games/2025-26/20251101.json.gz', 'data/live/today.json', 'data/picklog/log.jsonl.bak', '.claude/settings.json']) assert.equal(allowed(p), false, p);
});

test('status and diff parsing', () => {
  assert.deepEqual(statusPaths(' M data/live/anchor.json\n?? data/runs/2026-27/a.json\nR  a/x -> b/y\n'), ['data/live/anchor.json', 'data/runs/2026-27/a.json', 'a/x', 'b/y']);
  assert.deepEqual(frozenProblems('A\tengine/live.js\nA\tjobs/daily.js\n'), []);
  assert.deepEqual(frozenProblems('A\tengine/live.js\nM\tengine/sim.js\nD\tjobs/p4.js\n'), ['M engine/sim.js', 'D jobs/p4.js']);
});

test('no force push in any form', () => {
  assert.deepEqual(assertNoForce(PUSH_ARGS), PUSH_ARGS);
  for (const a of [['push', '-f'], ['push', '--force-with-lease'], ['push', 'origin', '+HEAD:main'], ['push', '--mirror'], ['push', '--delete', 'x']]) assert.throws(() => assertNoForce(a), /refused/);
});

// scripted git: records calls, answers from a table
function fakeGit({ status = '', frozenWt = '', frozenHead = '', pushFails = 0, rebaseFails = false, statusAfter = null } = {}) {
  const calls = [];
  let pushes = 0, fetched = false;
  const git = args => {
    assertNoForce(args);
    calls.push(args.join(' '));
    const [c] = args;
    if (c === 'status') return fetched && statusAfter != null ? statusAfter : status;
    if (c === 'diff') return args.includes('HEAD') ? frozenHead : frozenWt;
    if (c === 'rev-list') return '1\n';
    if (c === 'rev-parse') return 'abc1234\n';
    if (c === 'push') { pushes++; if (pushes <= pushFails) { const e = new Error('rejected'); e.stderr = '! [rejected] HEAD -> main (fetch first)'; throw e; } return ''; }
    if (c === 'fetch') { fetched = true; return ''; }
    if (c === 'rebase') { if (rebaseFails && args[1] !== '--abort') { const e = new Error('conflict'); e.stderr = 'CONFLICT'; throw e; } return ''; }
    return '';
  };
  return { git, calls };
}

test('commits the allowed changes and pushes main fast-forward', () => {
  const f = fakeGit({ status: ' M data/live/anchor.json\n?? data/runs/2026-27/x.json\n' });
  const r = commitAndPush('daily', { git: f.git });
  assert.deepEqual([r.ok, r.committed, r.pushed, r.attempts], [true, true, true, 1]);
  assert.ok(f.calls.includes('add -A -- data/live/anchor.json data/runs/2026-27/x.json'));
  assert.ok(f.calls.includes('push origin HEAD:refs/heads/main'));
});

test('refuses to commit a path outside the list or a changed frozen file', () => {
  let f = fakeGit({ status: ' M engine/sim.js\n M data/live/anchor.json\n' });
  let r = commitAndPush('daily', { git: f.git });
  assert.deepEqual([r.ok, r.reason, r.paths], [false, 'paths outside the allowed list', ['engine/sim.js']]);
  assert.ok(!f.calls.some(c => c.startsWith('commit') || c.startsWith('push')));
  f = fakeGit({ status: ' M data/live/anchor.json\n', frozenHead: 'M\tdata/model/params.json\n' });
  r = commitAndPush('daily', { git: f.git });
  assert.match(r.reason, /frozen files differ from 53c88f5/);
  assert.ok(!f.calls.some(c => c.startsWith('commit')));
});

test('a rejected push fetches main, replays the run commits and retries; a conflict or a third rejection is reported', () => {
  let f = fakeGit({ status: ' M data/live/anchor.json\n', pushFails: 1 });
  let r = commitAndPush('daily', { git: f.git });
  assert.deepEqual([r.ok, r.attempts], [true, 2]);
  assert.ok(f.calls.includes('fetch -q origin main') && f.calls.includes('rebase -q origin/main'));
  f = fakeGit({ status: ' M data/live/anchor.json\n', pushFails: 5 });
  r = commitAndPush('daily', { git: f.git });
  assert.deepEqual([r.ok, r.attempts], [false, 3]);
  assert.match(r.reason, /push failed 3 times/);
  f = fakeGit({ status: ' M data/live/anchor.json\n', pushFails: 1, rebaseFails: true });
  r = commitAndPush('daily', { git: f.git });
  assert.match(r.reason, /do not apply/);
  assert.ok(f.calls.includes('rebase --abort'));
});

test('this checkout: frozen files equal 53c88f5 (additions only)', () => {
  const c = check();
  assert.deepEqual(c.frozen, []);
});
