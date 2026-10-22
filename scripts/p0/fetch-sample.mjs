// P0: fetch a 20-game ESPN sample (scoreboards + summaries) into a raw cache dir.
// Usage: node scripts/p0/fetch-sample.mjs <outDir>
import { writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const out = process.argv[2];
// (date, how many games) spread across three seasons
const PLAN = [
  ['20241105', 3], ['20250115', 3], ['20250310', 1],
  ['20251104', 3], ['20260120', 3], ['20260325', 2],
  ['20251225', 3], ['20261020', 2], ['20261021', 3],
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url) {
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url);
    await sleep(600); // <= 2 req/s
    if (r.ok) return r.json();
    if (r.status < 500) throw new Error(`${r.status} ${url}`);
    await sleep(1000 * 2 ** i);
  }
  throw new Error(`retries exhausted ${url}`);
}
await mkdir(out, { recursive: true });
const picked = [];
for (const [date, k] of PLAN) {
  const sb = await get(`${BASE}/scoreboard?dates=${date}`);
  await writeFile(join(out, `scoreboard_${date}.json`), JSON.stringify(sb));
  const fin = sb.events.filter(e => e.season.slug === 'regular-season' && e.competitions[0].status.type.name === 'STATUS_FINAL');
  for (const e of fin.slice(0, k)) picked.push({ id: e.id, date, name: e.shortName });
}
for (const g of picked) {
  const f = join(out, `summary_${g.id}.json`);
  try { await access(f); continue; } catch {}
  await writeFile(f, JSON.stringify(await get(`${BASE}/summary?event=${g.id}`)));
}
await writeFile(join(out, 'sample.json'), JSON.stringify(picked, null, 1));
await writeFile(join(out, 'injuries.json'), JSON.stringify(await get(`${BASE}/injuries`)));
console.log(picked.length, 'games', picked.map(g => g.name).join(', '));
