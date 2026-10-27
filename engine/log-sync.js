// Daily job side of the pick log (P9; 2026-10-23 P9 approvals 1, 2, 6, 8, 10). ArtifactData is a Claude tool, so
// a run alternates: read the head and blocks (files) -> syncStep (here) -> one ArtifactData batch -> read again.
// The records to append are rebuilt from the stored chain at every attempt, with the attempt's own time: an
// evaluation whose deadline passed between attempts is not written late; its market gets an `unevaluated`
// record (engine/day-status.js) instead, so nothing leaves the ledger silently.
// The git copy (data/picklog/log.jsonl) is one record per line in the hash's canonical JSON (sorted keys), so a
// database that reorders keys does not change it; a new copy must keep the committed copy as its exact prefix.
import { readChain, jobStep, blockId, HEAD_PATH, BLOCKS } from './log-store.js';
import { pendingOdds, evaluationRecords } from './log-records.js';
import { unevaluatedRecords } from './day-status.js';
import { resultRecord, verifyChain, sha256 } from './pick-log.js';
import { canEvaluate } from './trigger-time.js';

// = engine/pick-log.js canon (not exported there; the chain functions stay as they are). Tests hold the two equal.
export const canon = v => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
export const sameHash = r => { const { hash, ...rest } = r; return sha256(canon(rest)) === hash; };

// records the daily job appends at `now`: results of games in the log, evaluations of pending odds whose game has
// its final prediction in `day`, and unevaluated markets past their deadline.
// results: Map gameId -> { margin, total }; finals / finalsC: Map gameId -> { at, runId, start } of path AB / C
// marginMs: odds whose deadline is that close are left for the next run (the batch is sent a little after this step)
export function jobBodies({ chain, day = null, cal = null, finals = new Map(), finalsC = new Map(), starts = new Map(), results = new Map(), now = new Date(), marginMs = 0 }) {
  const bodies = [], notes = [];
  const settled = new Set(chain.filter(r => r.type === 'result').map(r => r.gameId));
  const logged = new Set(chain.filter(r => r.type === 'odds' || r.type === 'evaluation' || r.type === 'pick').map(r => r.gameId));
  for (const id of [...logged].sort()) {
    const res = results.get(id);
    if (!settled.has(id) && res) bodies.push(resultRecord(id, res.margin, res.total, { now }));
  }
  if (day?.kind === 'live' && cal) {
    // only markets whose path (C or AB) matches the day's final prediction (engine/trigger-time.js canEvaluate)
    const games = new Map(day.games.map(g => [g.gameId, g]));
    const pend = pendingOdds(chain, { now: new Date(new Date(now).getTime() + marginMs) }).filter(o => canEvaluate(o, games.get(o.gameId)));
    if (pend.length) {
      const ev = evaluationRecords({ oddsRecs: pend, day, cal, chain, now });
      bodies.push(...ev.records);
      notes.push(...ev.notes);
    }
  }
  bodies.push(...unevaluatedRecords({ chain: [...chain, ...bodies], finals, finalsC, starts, now }));
  return { bodies, notes };
}

const memStore = (head, blocks) => ({
  getHead: async () => ({ exists: !!head, data: head ?? undefined }),
  getBlock: async id => { const b = blocks.find(x => x.id === id); return { exists: !!b, data: b?.data }; },
  listBlocks: async () => blocks,
});

// one attempt from what was read: head (data or null), its version, every stored block [{id, data}]
// build(chain records, now) -> { bodies, notes }
export async function syncStep({ head, headVersion = null, blocks, build, now, blockBytes }) {
  const chain = await readChain(memStore(head, blocks));
  if (!chain.verify.ok) return { action: 'stop', reason: 'chain check failed', verify: chain.verify };
  if (head && headVersion == null) return { action: 'stop', reason: 'head version unknown' };
  const stored = { ...(head ?? {}) };
  const nextBlock = blocks.find(b => b.id === blockId(stored.blocks ?? 0));
  const next = nextBlock ? { exists: true, data: nextBlock.data } : { exists: false };
  const { bodies, notes } = build(chain.records, now);
  if (!bodies.length && !next.exists) return { action: 'none', notes, chain };
  const step = jobStep({ head, headExists: !!head, headVersion, tailOk: true, next, bodies, now: new Date(now).getTime(), blockBytes });
  return { ...step, notes, bodies, chain };
}

// jobStep writes -> ArtifactData batch entries; the documents themselves go to files (never retyped)
export function artifactBatch(writes, fileOf) {
  return writes.map(w => {
    const [collection, doc_id] = [w.path.split('/').slice(0, -1).join('/'), w.path.split('/').at(-1)];
    const e = { op: w.op, collection, doc_id, file_path: fileOf(w.path) };
    if (w.ifVersion != null) e.if_version = w.ifVersion;
    return e;
  });
}

// in-process loop over a job store (tests; the run does the same steps through ArtifactData)
export async function syncAsJob(api, build, { now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), maxAttempts = 6, maxWaitMs = 90000, blockBytes } = {}) {
  let attempts = 0, waitedMs = 0;
  const written = [];
  for (;;) {
    const h = api.read(HEAD_PATH);
    const blocks = [...api.docs.keys()].filter(k => k.startsWith(`${BLOCKS}/`)).sort().map(k => ({ id: k.split('/')[1], data: api.read(k).data }));
    const step = await syncStep({ head: h.exists ? h.data : null, headVersion: h.version, blocks, build, now: now(), blockBytes });
    if (step.action === 'none') return { ok: true, attempts, waitedMs, records: written, notes: step.notes };
    if (step.action === 'stop') return { ok: false, reason: step.reason, attempts, records: written };
    if (step.action === 'split') return { ok: false, reason: `append of ${step.blocks} blocks exceeds one batch`, attempts, records: written };
    if (step.action === 'wait') {
      const ms = step.until - now() + 1;
      if (waitedMs + ms > maxWaitMs) return { ok: false, reason: 'busy', attempts, waitedMs, records: written };
      await sleep(ms); waitedMs += ms;
      continue;
    }
    if (attempts >= maxAttempts) return { ok: false, reason: 'retries exhausted', attempts, records: written };
    attempts++;
    const res = await api.batch(step.writes);
    if (res.ok && step.action === 'commit') written.push(...step.records);
  }
}

// ---- git copy ----
export const copyText = records => records.map(r => `${canon(r)}\n`).join('');

// prevText: the committed copy ('' when none). The new copy must verify and keep prevText as its exact prefix.
export function copyCheck(prevText, records) {
  const v = verifyChain(records);
  if (!v.ok) return { ok: false, reason: `chain check failed at seq ${v.brokenAt}` };
  const text = copyText(records);
  if (!text.startsWith(prevText)) {
    const prev = prevText.split('\n').filter(Boolean), now = text.split('\n').filter(Boolean);
    const at = prev.findIndex((l, i) => i < now.length && l !== now[i]);
    return { ok: false, reason: at < 0 ? 'committed copy is longer than the database chain' : `committed record ${at} differs from the database chain` };
  }
  return { ok: true, text, added: records.length - prevText.split('\n').filter(Boolean).length };
}

export const anchorOf = (records, commit) => (records.length
  ? { count: records.length, seq: records.at(-1).seq, hash: records.at(-1).hash, commit }
  : { count: 0, seq: null, hash: null, commit });
