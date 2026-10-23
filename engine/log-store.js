// Pick log in the artifact database (P8, design §12; 2026-10-23 user conditions 4 and 5). The chain itself is
// engine/pick-log.js unchanged (chainAppend, verifyChain); this file only stores it. The database caps documents
// (25,000 per artifact, 256 KiB each), so records are stored in blocks, one document per append:
//   blocks/b000000  { firstSeq, lastSeq, count, writer, writtenAt, records[] }   (split at BLOCK_BYTES)
//   meta/head       { blocks, lastSeq, lastHash, leaseHolder, leaseUntil }
// Empty chain: no head or blocks = 0; it is valid ("정상(레코드 0개)"). First record: seq 0, prevHash null.
// Two writers and no transactions:
//   dashboard  acquire a lease on the head (expires), write leaseHolder/leaseUntil into the head (this raises its
//              version, so a job write pinned to an older version fails), re-read, write each block only if it
//              does not exist yet and only while the lease still covers it, then advance the head and clear the lease
//   daily job  (ArtifactData) one atomic batch: create the new blocks (refused if a block exists) and update the
//              head pinned to the version it read; on a version conflict re-read and retry, never overwrite.
//              An active lease makes it wait; an expired lease is ignored.
// A block that exists past the head (a writer stopped before advancing the head) is adopted only when it
// continues the chain exactly; anything else stops both writers ("conflict").
import { chainAppend, verifyChain } from './pick-log.js';
import { stamp } from './clock.js';

export const HEAD_PATH = 'meta/head', BLOCKS = 'blocks';
export const LEASE_MS = 30000, LEASE_SAFETY_MS = 5000, BLOCK_BYTES = 200 * 1024, JOB_BLOCKS_PER_BATCH = 4;
export const EMPTY_HEAD = { blocks: 0, lastSeq: null, lastHash: null, leaseHolder: null, leaseUntil: null };
export const blockId = n => `b${String(n).padStart(6, '0')}`;
export const byteSize = v => new TextEncoder().encode(JSON.stringify(v)).length;

const headOf = data => ({ ...EMPTY_HEAD, ...(data ?? {}) });
const tailOf = head => (head.lastSeq == null ? null : { seq: head.lastSeq, hash: head.lastHash });

// record bodies -> chained records after `tail` ({seq, hash} of the last stored record, or null)
export function chainRecords(tail, bodies) {
  const out = [];
  for (const b of bodies) out.push(chainAppend(out.at(-1) ?? tail, b));
  return out;
}

export const blockDoc = (records, writer, now) => ({
  firstSeq: records[0].seq, lastSeq: records.at(-1).seq, count: records.length, writer, writtenAt: stamp(now), records,
});

export function splitBlocks(records, limit = BLOCK_BYTES) {
  const parts = [];
  let cur = [];
  for (const r of records) {
    if (cur.length && byteSize(blockDoc([...cur, r], 'job', 0)) > limit) { parts.push(cur); cur = []; }
    cur.push(r);
    if (byteSize(blockDoc(cur, 'job', 0)) > limit) throw new Error(`record seq ${r.seq} alone exceeds the block limit`);
  }
  if (cur.length) parts.push(cur);
  return parts;
}

// does `block` continue the chain at `head`? Each record is re-chained with chainAppend from the head's tail and
// must come out identical (seq, prevHash and hash).
function continues(head, block) {
  const recs = block?.records;
  if (!Array.isArray(recs) || !recs.length) return false;
  let prev = tailOf(head);
  for (const r of recs) {
    const { hash, seq, prevHash, ...body } = r;
    const again = chainAppend(prev, body);
    if (again.hash !== hash || again.seq !== seq || again.prevHash !== prevHash) return false;
    prev = again;
  }
  return true;
}

const advance = (head, block) => ({ blocks: head.blocks + 1, lastSeq: block.records.at(-1).seq, lastHash: block.records.at(-1).hash });

// the stored tail must match the head
async function tailMatches(store, head) {
  if (head.blocks === 0) return head.lastSeq == null && head.lastHash == null;
  const last = await store.getBlock(blockId(head.blocks - 1));
  const r = last.data?.records?.at(-1);
  return !!r && r.seq === head.lastSeq && r.hash === head.lastHash;
}

// whole chain as stored: records of blocks 0..head.blocks-1, structural problems, blocks past the head
export async function readChain(store) {
  const head = headOf((await store.getHead()).data);
  const listed = await store.listBlocks();
  const limit = blockId(head.blocks);
  const inHead = listed.filter(b => b.id < limit), orphans = listed.filter(b => b.id >= limit).map(b => b.id);
  const problems = [];
  const byId = new Map(inHead.map(b => [b.id, b.data]));
  const records = [];
  for (let i = 0; i < head.blocks; i++) {
    const b = byId.get(blockId(i));
    if (!b || !Array.isArray(b.records)) { problems.push(`missing block ${blockId(i)}`); continue; }
    if (b.records[0]?.seq !== b.firstSeq || b.records.at(-1)?.seq !== b.lastSeq) problems.push(`block ${blockId(i)} sequence range does not match its records`);
    records.push(...b.records);
  }
  const v = verifyChain(records);
  if (records.length !== (head.lastSeq ?? -1) + 1) problems.push(`head lastSeq ${head.lastSeq} but ${records.length} records`);
  else if (records.length && records.at(-1).hash !== head.lastHash) problems.push('head lastHash does not match the last record');
  return { head, records, orphans, verify: { ok: v.ok && !problems.length, brokenAt: v.brokenAt, problems } };
}

// ---- dashboard writer (page `db` capability) ----
export function pageStore(db) {
  const head = () => db.doc(HEAD_PATH);
  return {
    getHead: async () => { const s = await head().get(); return { exists: s.exists, data: s.data() }; },
    getBlock: async id => { const s = await db.doc(`${BLOCKS}/${id}`).get(); return { exists: s.exists, data: s.data() }; },
    listBlocks: async () => (await db.collection(BLOCKS).get()).docs.map(d => ({ id: d.id, data: d.data() })),
    acquireHead: o => head().acquire(o),
    writeHead: async data => { const s = await head().get(); return s.exists ? head().update(data) : head().set({ ...EMPTY_HEAD, ...data }); },
    setBlock: (id, data) => db.doc(`${BLOCKS}/${id}`).set(data),
  };
}

export async function appendAsPage(store, bodies, { holder, now = () => Date.now(), ttlMs = LEASE_MS, blockBytes = BLOCK_BYTES } = {}) {
  if (!bodies.length) return { ok: true, records: [] };
  const lease = await store.acquireHead({ holder, ttlMs });
  if (!lease.acquired) return { ok: false, reason: 'busy', until: lease.expiresAt ?? null };
  // measured on this machine's clock from the grant, so a skewed clock cannot stretch the lease
  const deadline = now() + ttlMs - LEASE_SAFETY_MS;
  const covered = () => now() < deadline;
  await store.writeHead({ leaseHolder: holder, leaseUntil: lease.expiresAt });
  const stop = async reason => { if (covered()) await store.writeHead({ leaseHolder: null, leaseUntil: null }); return { ok: false, reason }; };
  let head = headOf((await store.getHead()).data);
  if (head.leaseHolder !== holder) return { ok: false, reason: 'lease lost' };
  if (!(await tailMatches(store, head))) return stop('head mismatch');
  let adopted = 0;
  for (let next = await store.getBlock(blockId(head.blocks)); next.exists; next = await store.getBlock(blockId(head.blocks))) {
    if (!continues(head, next.data)) return stop('conflict');
    head = { ...head, ...advance(head, next.data) };
    adopted++;
  }
  const records = chainRecords(tailOf(head), bodies);
  const parts = splitBlocks(records, blockBytes);
  for (let i = 0; i < parts.length; i++) {
    const id = blockId(head.blocks + i);
    if (!covered()) return { ok: false, reason: 'lease expired', written: i };
    if ((await store.getBlock(id)).exists) return stop('conflict');
    if (!covered()) return { ok: false, reason: 'lease expired', written: i };
    await store.setBlock(id, blockDoc(parts[i], 'page', now()));
  }
  if (!covered()) return { ok: false, reason: 'lease expired', written: parts.length };
  await store.writeHead({ blocks: head.blocks + parts.length, lastSeq: records.at(-1).seq, lastHash: records.at(-1).hash, leaseHolder: null, leaseUntil: null });
  return { ok: true, records, adopted, first: records[0].seq, last: records.at(-1).seq };
}

// ---- daily job writer (ArtifactData: versioned reads, atomic batch with if_version) ----
// api: { read(path) -> {exists, data, version}, list(collection) -> [{id, data}], batch(writes) -> {ok} }
export function jobStore(api) {
  const list = api.list ?? (async c => (await api.collection(c).get()).docs.map(d => ({ id: d.id, data: d.data() })));
  return {
    getHead: async () => api.read(HEAD_PATH),
    getBlock: async id => api.read(`${BLOCKS}/${id}`),
    listBlocks: () => list(BLOCKS),
    commit: writes => api.batch(writes),
  };
}

// one decision from what the job has read (pure; P9 runs it between ArtifactData reads and the batch)
export function jobStep({ head: rawHead, headExists, headVersion, tailOk, next, bodies, now, blockBytes = BLOCK_BYTES }) {
  const head = headOf(rawHead);
  if (head.leaseUntil && Date.parse(head.leaseUntil) > now) return { action: 'wait', until: Date.parse(head.leaseUntil) };
  if (!tailOk) return { action: 'stop', reason: 'head mismatch' };
  const headWrite = data => (headExists ? { op: 'update', path: HEAD_PATH, data, ifVersion: headVersion } : { op: 'set', path: HEAD_PATH, data: { ...EMPTY_HEAD, ...data } });
  if (next?.exists) {
    if (!continues(head, next.data)) return { action: 'stop', reason: 'conflict' };
    return { action: 'adopt', writes: [headWrite({ ...advance(head, next.data), leaseHolder: null, leaseUntil: null })] };
  }
  const records = chainRecords(tailOf(head), bodies);
  const parts = splitBlocks(records, blockBytes);
  if (parts.length > JOB_BLOCKS_PER_BATCH) return { action: 'split', blocks: parts.length };
  const writes = parts.map((p, i) => ({ op: 'set', path: `${BLOCKS}/${blockId(head.blocks + i)}`, data: blockDoc(p, 'job', now) }));
  writes.push(headWrite({ blocks: head.blocks + parts.length, lastSeq: records.at(-1).seq, lastHash: records.at(-1).hash, leaseHolder: null, leaseUntil: null }));
  return { action: 'commit', writes, records };
}

export async function appendAsJob(store, bodies, { now = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), maxAttempts = 6, maxWaitMs = 3 * LEASE_MS, blockBytes = BLOCK_BYTES } = {}) {
  if (!bodies.length) return { ok: true, records: [], attempts: 0 };
  // keep each batch within the batch limits: at most JOB_BLOCKS_PER_BATCH blocks
  const sizeOf = b => byteSize(b) + 200;
  const chunks = [];
  let cur = [], size = 0;
  for (const b of bodies) {
    if (cur.length && size + sizeOf(b) > blockBytes * (JOB_BLOCKS_PER_BATCH - 1)) { chunks.push(cur); cur = []; size = 0; }
    cur.push(b); size += sizeOf(b);
  }
  chunks.push(cur);
  const all = [];
  let attempts = 0, waitedMs = 0, adopted = 0;
  for (const chunk of chunks) {
    let done = false;
    while (!done) {
      if (attempts >= maxAttempts) return { ok: false, reason: 'retries exhausted', attempts, records: all };
      const h = await store.getHead();
      const head = headOf(h.data);
      const tailOk = await tailMatches(store, head);
      const next = await store.getBlock(blockId(head.blocks));
      const step = jobStep({ head: h.data, headExists: h.exists, headVersion: h.version, tailOk, next, bodies: chunk, now: now(), blockBytes });
      if (step.action === 'wait') {
        const ms = step.until - now() + 1;
        if (waitedMs + ms > maxWaitMs) return { ok: false, reason: 'busy', attempts, records: all };
        await sleep(ms); waitedMs += ms;
        continue;
      }
      if (step.action === 'stop') return { ok: false, reason: step.reason, attempts, records: all };
      if (step.action === 'split') throw new Error(`append of ${step.blocks} blocks exceeds one batch`);
      attempts++;
      const res = await store.commit(step.writes);
      if (!res.ok) continue; // version changed or a block appeared: re-read and retry
      if (step.action === 'adopt') { adopted++; continue; }
      all.push(...step.records);
      done = true;
    }
  }
  return { ok: true, records: all, attempts, waitedMs, adopted };
}
