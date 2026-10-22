// User decision 1b (2026-10-22): prove that adding 2022-23 changes no 2024-25 / 2025-26 input or prediction.
// Hashes (sha256) of the input files and of the walk-forward predictions (A and B: model and baseline margins
// and totals, minutes plans, snapshot info). Game results are never part of a hash and no metric is computed,
// so 2025-26 stays unevaluated. Usage: node scripts/p5/prediction-hashes.mjs <out.json>
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadGames } from '../../jobs/lib/games.js';
import { walkForward } from '../../engine/evaluate.js';
import { snapshotInjuries, snapshotCutoff, jobGroup } from '../../engine/snapshot.js';
import { etParts } from '../../engine/time.js';

const sha = buf => createHash('sha256').update(buf).digest('hex');
const P = JSON.parse(await readFile('data/model/params.json', 'utf8'));
const PRIOR = { '2024-25': ['2023-24'], '2025-26': ['2024-25'] };

async function dirHash(dir) {
  const files = (await readdir(dir)).sort();
  const h = createHash('sha256');
  for (const f of files) h.update(f).update(await readFile(`${dir}/${f}`));
  return { files: files.length, sha256: h.digest('hex') };
}

async function snapshotsFor(season, games) {
  const cache = new Map(), snaps = new Map();
  for (const g of games.filter(x => x.season === season)) {
    const date = etParts(new Date(g.start)).date, group = jobGroup(g.start);
    if (!cache.has(date)) { try { cache.set(date, JSON.parse(gunzipSync(await readFile(`data/injury-pdf/${season}/${date}.json.gz`)))); } catch { cache.set(date, null); } }
    const rec = cache.get(date);
    const s = !rec ? null : group === 'pre_job_start' ? rec.early.find(x => x.id === g.id) : group === 'B' ? rec.runB : rec.main;
    snaps.set(g.id, s && s.rows && !s.formatError && new Date(s.availableAt) <= snapshotCutoff(g.start) ? s : null);
  }
  return (g, side, players) => snapshotInjuries(snaps.get(g.id), { team: side ? g.away.abbr : g.home.abbr, home: g.home.abbr, away: g.away.abbr, players });
}

const out = { generatedAt: new Date().toISOString(), inputs: {}, predictions: {} };
for (const f of ['params', 'latent', 'calibration', 'play-prob']) out.inputs[`data/model/${f}.json`] = sha(await readFile(`data/model/${f}.json`));
for (const season of Object.keys(PRIOR)) {
  for (const d of [`data/games/${season}`, `data/injury-pdf/${season}`, ...PRIOR[season].map(s => `data/games/${s}`)]) out.inputs[d] = await dirHash(d);
  out.inputs[`data/schedule/${season}.json`] = sha(await readFile(`data/schedule/${season}.json`));
  const games = await loadGames([...PRIOR[season], season]);
  for (const variant of ['A', 'B']) {
    const plans = [];
    const injuriesFor = variant === 'B' ? await snapshotsFor(season, games) : null;
    const rows = walkForward({ games, target: { season }, params: P.params, variant, injuriesFor, onGame: ({ homePlan, awayPlan }) => { plans.push([homePlan.players, awayPlan.players]); return {}; } });
    // results removed: actual, overtime; everything else is a prediction input or output
    const pred = rows.map((r, i) => ({ id: r.id, model: r.model, base: r.base, group: r.group, snapshot: r.snapshot ?? null, plans: plans[i] }));
    out.predictions[`${season} ${variant}`] = { games: pred.length, sha256: sha(JSON.stringify(pred)) };
  }
}
await writeFile(process.argv[2], JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.predictions));
