// node jobs/normalize-raw.js <season>
// Runs before `jobs/build-data.js games <season>` (jobs/daily.js). For the finished games of every date whose game
// file is missing or short, it caches the ESPN summary with the play-type aliases of engine/schema/play-type-aliases.js
// applied, so build-data (frozen) reads known types. Each mapping is added to data/games/<season>/play-type-aliases.json
// and printed. Ids with no alias still fail build-data's validation, as before.
import { readFile, writeFile, access } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createCollector } from '../engine/collect.js';
import { SchemaError } from '../engine/schema/espn.js';
import { aliasingCache } from '../engine/schema/play-type-aliases.js';
import { fsCache } from './lib/fs-cache.js';

const exists = p => access(p).then(() => true, () => false);

// sched: data/schedule/<season>.json; count(usDate) -> games in that date file (0 if none); col: a collector whose
// cache is aliasingCache. A fresh fetch is validated before the cache has aliased it, so a schema error is retried
// once from the cache. -> { checked, unknown: [espnId] }
export async function normalizeSeason({ sched, count, col }) {
  const byDate = new Map();
  for (const g of sched.list) { if (!byDate.has(g.usDate)) byDate.set(g.usDate, []); byDate.get(g.usDate).push(g); }
  let checked = 0;
  const unknown = [];
  const valid = async id => { try { await col.game(id); return true; } catch (e) { if (!(e instanceof SchemaError)) throw e; return false; } };
  for (const [date, list] of byDate) {
    if ((await count(date)) === list.length) continue;
    for (const g of list.filter(x => x.status === 'STATUS_FINAL')) {
      checked++;
      if (!(await valid(g.id)) && !(await valid(g.id))) unknown.push(g.id);
    }
  }
  return { checked, unknown };
}

async function main(season) {
  if (!season) { console.error('usage: node jobs/normalize-raw.js <season>'); process.exit(2); }
  const sched = JSON.parse(await readFile(`data/schedule/${season}.json`, 'utf8'));
  const dateOf = new Map(sched.list.map(g => [g.id, g.usDate]));
  const logPath = `data/games/${season}/play-type-aliases.json`;
  const log = (await exists(logPath)) ? JSON.parse(await readFile(logPath, 'utf8')) : {};
  const now = [], added = [];
  const cache = aliasingCache(fsCache(), (id, plays) => {
    now.push(id);
    if (!log[id]) { added.push(id); log[id] = { usDate: dateOf.get(id) ?? null, plays }; }
  });
  const count = async date => {
    const p = `data/games/${season}/${date}.json.gz`;
    return (await exists(p)) ? JSON.parse(gunzipSync(await readFile(p))).length : 0;
  };
  const r = await normalizeSeason({ sched, count, col: createCollector({ cache }) });
  if (added.length) await writeFile(logPath, `${JSON.stringify(Object.fromEntries(Object.entries(log).sort()), null, 1)}\n`);
  const plays = now.flatMap(id => log[id].plays.map(p => `${id}:${p.playId} ${p.from}->${p.to} "${p.text}"`));
  console.log(`${season} normalize: checked ${r.checked} games, aliased ${plays.length} play(s) (${added.length} game(s) new in the log)${plays.length ? ` [${plays.join('; ')}]` : ''}, still unknown ${r.unknown.length}${r.unknown.length ? ` [${r.unknown.join(',')}]` : ''}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv[2]);
