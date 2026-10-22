// Node-only: load committed game records (data/games/{season}/*.json.gz), sorted by start.
import { readdir, readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

export async function loadGames(seasons) {
  const out = [];
  for (const s of seasons) {
    const dir = `data/games/${s}`;
    for (const f of (await readdir(dir)).filter(x => x.endsWith('.json.gz')).sort()) {
      out.push(...JSON.parse(gunzipSync(await readFile(`${dir}/${f}`))));
    }
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}
