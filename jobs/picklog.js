// Pick-log steps of the daily run (P9, docs/daily-run.md). ArtifactData saves the documents into a directory
// (`get meta/head` and `list blocks` with out_dir); these commands read it. Exit codes: 0 done, 3 a dashboard lease
// was active (waited until it ended: read again), 4 stop (reported, nothing to send), 5 git copy refused.
//   plan --dir D [--head-version N] [--day F]   next ArtifactData batch -> D/plan.json, documents in D/write/
//   check --dir D                     chain check and contents (the first real write is reported from this)
//   export --dir D                    data/picklog/log.jsonl, only after the chain check and the prefix check
//   anchor                            data/live/anchor.json from the committed copy
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { readDir } from './lib/db-files.js';
import { seasonState } from './lib/season-state.js';
import { syncStep, jobBodies, artifactBatch, copyCheck, anchorOf } from '../engine/log-sync.js';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const LOG = 'data/picklog/log.jsonl', ANCHOR = 'data/live/anchor.json';
const MARGIN_MS = 120000; // odds within two minutes of their deadline are left alone (no late write)
const out = v => console.log(JSON.stringify(v, null, 1));
const write = async (p, v) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, typeof v === 'string' ? v : JSON.stringify(v)); };
const counts = recs => recs.reduce((a, r) => ({ ...a, [r.type]: (a[r.type] ?? 0) + 1 }), {});

async function plan() {
  const dir = resolve(arg('--dir'));
  const hv = arg('--head-version');
  const db = await readDir(dir, { headVersion: hv == null ? null : +hv });
  // no day file (prepare failed): results and unevaluated markets are still written, pending odds wait
  const day = await readFile(arg('--day', 'data/live/today.json'), 'utf8').then(JSON.parse, () => null);
  const cal = JSON.parse(await readFile('data/model/calibration.json', 'utf8')).calibration;
  const { results, finals, finalsC, starts } = await seasonState({ season: day?.season ?? '2026-27' });
  const now = Date.now();
  const step = await syncStep({ head: db.head, headVersion: db.headVersion, blocks: db.blocks, build: (chain, t) => jobBodies({ chain, day, cal, finals, finalsC, starts, results, now: new Date(t), marginMs: MARGIN_MS }), now });
  const res = { action: step.action, reason: step.reason ?? null, records: step.records?.length ?? 0, types: counts(step.bodies ?? []), notes: step.notes ?? [], chain: { count: db.records.length, ok: db.verify.ok } };
  if (step.action === 'commit' || step.action === 'adopt') {
    for (const w of step.writes) await write(join(dir, 'write', `${w.path}.json`), w.data);
    res.batch = artifactBatch(step.writes, p => join(dir, 'write', `${p}.json`));
  }
  await write(join(dir, 'plan.json'), res);
  out(res);
  if (step.action === 'wait') {
    const ms = Math.min(35000, Math.max(0, step.until - Date.now() + 1000));
    await new Promise(r => setTimeout(r, ms));
    process.exit(3);
  }
  if (step.action === 'stop' || step.action === 'split') process.exit(4);
}

async function check() {
  const db = await readDir(resolve(arg('--dir')));
  const last = db.records.at(-1);
  out({ ok: db.verify.ok, verify: db.verify, count: db.records.length, byType: counts(db.records), lastSeq: last?.seq ?? null, lastHash: last?.hash ?? null, head: db.head, orphans: db.orphans });
  if (!db.verify.ok) process.exit(4);
}

async function exportCopy() {
  const db = await readDir(resolve(arg('--dir')));
  if (!db.verify.ok) { out({ ok: false, reason: 'chain check failed', verify: db.verify }); process.exit(5); }
  const prev = await readFile(LOG, 'utf8').catch(() => '');
  const c = copyCheck(prev, db.records);
  if (!c.ok) { out({ ok: false, reason: c.reason }); process.exit(5); }
  await write(LOG, c.text);
  out({ ok: true, count: db.records.length, added: c.added });
}

async function anchor() {
  const text = await readFile(LOG, 'utf8');
  const records = text.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const commit = execFileSync('git', ['log', '-1', '--format=%H', '--', LOG], { encoding: 'utf8' }).trim();
  if (!commit) throw new Error(`${LOG} has no commit yet`);
  if (execFileSync('git', ['status', '--porcelain', '--', LOG], { encoding: 'utf8' }).trim()) throw new Error(`${LOG} has uncommitted changes`);
  const a = anchorOf(records, commit);
  await write(ANCHOR, JSON.stringify(a, null, 1));
  out(a);
}

const CMDS = { plan, check, export: exportCopy, anchor };
const cmd = CMDS[argv[0]];
if (!cmd) { console.error(`usage: node jobs/picklog.js ${Object.keys(CMDS).join('|')}`); process.exit(2); }
await cmd();
