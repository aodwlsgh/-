// Pick-log documents saved by ArtifactData reads with `out_dir` (P9): <dir>/meta/head.json and <dir>/blocks/*.json.
// The saved file may hold the document itself or a wrapper with `data` and `version`; both are read. The head's
// version, when the file does not carry it, is passed on the command line from the read's result.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readChain } from '../../engine/log-store.js';

const isDoc = o => o && typeof o === 'object' && ('records' in o || 'lastSeq' in o || 'blocks' in o);
export function unwrap(o) {
  if (!isDoc(o) && o && typeof o.data === 'object' && o.data !== null) return { data: o.data, version: o.version ?? o._version ?? null };
  return { data: o, version: null };
}

const readMaybe = async p => { try { return JSON.parse(await readFile(p, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } };

export async function readDir(dir, { headVersion = null } = {}) {
  const h = await readMaybe(join(dir, 'meta', 'head.json'));
  const head = h === undefined ? null : unwrap(h);
  const names = (await readdir(join(dir, 'blocks')).catch(() => [])).filter(f => /^b\d{6}\.json$/.test(f)).sort();
  const blocks = [];
  for (const f of names) blocks.push({ id: f.slice(0, -5), data: unwrap(await readMaybe(join(dir, 'blocks', f))).data });
  const store = { getHead: async () => ({ exists: !!head, data: head?.data }), getBlock: async id => { const b = blocks.find(x => x.id === id); return { exists: !!b, data: b?.data }; }, listBlocks: async () => blocks };
  const chain = await readChain(store);
  return { head: head?.data ?? null, headVersion: head?.version ?? headVersion, blocks, ...chain };
}
