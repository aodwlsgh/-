// In-memory stand-in for the artifact `db` capability (P8 tests; also injected into the page by the browser tests).
// Page API: db.doc(path).get/set/update/delete/acquire, db.collection(path).get/doc. Writes are last-writer-wins,
// every write raises the document version, `acquire` is a lease that does not change the document.
// `batch(writes)` behaves like the ArtifactData batch the daily job uses: a write without `ifVersion` creates and is
// refused when the document exists, a write with `ifVersion` applies only at that version, all or nothing.
// `hooks` run before every operation (tests use them to interleave a second writer); `now` is the server clock.
const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
function merge(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a[k]) ? merge(a[k], v) : v;
  return out;
}

export function fakeDb({ now = () => Date.now() } = {}) {
  const docs = new Map(), leases = new Map(), hooks = [], listeners = new Map();
  const run = async (op, path) => { for (const h of [...hooks]) await h(op, path); };
  const notify = path => { for (const fn of listeners.get(path) ?? []) queueMicrotask(() => fn(snap(path))); };
  const write = (path, data) => { docs.set(path, { data: clone(data), version: (docs.get(path)?.version ?? 0) + 1 }); notify(path); };
  const snap = path => {
    const d = docs.get(path);
    return { id: path.split('/').at(-1), exists: !!d, data: () => clone(d?.data), metadata: { fromCache: false, hasPendingWrites: false } };
  };
  const doc = path => ({
    id: path.split('/').at(-1), path,
    async get() { await run('get', path); return snap(path); },
    async set(data) { await run('set', path); write(path, data); },
    async update(data) {
      await run('update', path);
      const d = docs.get(path);
      if (!d) throw { code: 'invalid_argument', message: `update of a missing document ${path}` };
      write(path, merge(d.data, data));
    },
    async delete() { await run('delete', path); docs.delete(path); notify(path); },
    onSnapshot(next) {
      const set = listeners.get(path) ?? listeners.set(path, new Set()).get(path);
      set.add(next);
      queueMicrotask(() => next(snap(path)));
      return () => set.delete(next);
    },
    async acquire({ holder, ttlMs = 30000 }) {
      await run('acquire', path);
      const t = now(), l = leases.get(path);
      if (l && l.holder !== holder && Date.parse(l.expiresAt) > t) return { acquired: false, expiresAt: l.expiresAt };
      const expiresAt = new Date(t + Math.min(600000, Math.max(1000, ttlMs || 30000))).toISOString();
      leases.set(path, { holder, expiresAt });
      return { acquired: true, expiresAt, holder, version: docs.get(path)?.version };
    },
    collection: sub => collection(`${path}/${sub}`),
  });
  const collection = path => ({
    path,
    doc: id => doc(`${path}/${id}`),
    async get() {
      await run('list', path);
      const depth = path.split('/').length + 1;
      const list = [...docs.keys()].filter(k => k.startsWith(`${path}/`) && k.split('/').length === depth).sort().map(snap);
      return { docs: list, size: list.length, empty: !list.length, metadata: { fromCache: false, hasPendingWrites: false } };
    },
  });
  async function batch(writes) {
    await run('batch', null);
    for (const w of writes) {
      const d = docs.get(w.path);
      if (w.ifVersion == null ? !!d : !d || d.version !== w.ifVersion) return { ok: false, conflict: w.path, current: d?.version ?? null };
    }
    for (const w of writes) write(w.path, w.op === 'update' ? merge(docs.get(w.path).data, w.data) : w.data);
    return { ok: true };
  }
  // ArtifactData-style reads for the job side: the version comes with the document
  const read = path => { const d = docs.get(path); return { exists: !!d, data: clone(d?.data), version: d?.version ?? null }; };
  return { doc, collection, batch, read, hooks, docs, leases };
}
