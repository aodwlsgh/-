// User decision 1b (2026-10-22) and P6 condition 6 (2026-10-23): prove that the validated predictions do not move.
// Hashes (sha256) of the input files and of the walk-forward predictions (A and B: model and baseline margins
// and totals, minutes plans, snapshot info). Game results are never part of a hash and no metric is computed.
// simSample: also simulate a fixed sample of B games (every 100th game, first 12, seed = game id, 1,000 runs,
// default rules and latent) and hash the simulator output, so changes inside the simulator are caught as well.
// CLI: node scripts/p5/prediction-hashes.mjs <out.json> [--sim-sample]
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { loadGames } from '../../jobs/lib/games.js';
import { walkForward } from '../../engine/evaluate.js';
import { snapshotInjuries, snapshotCutoff, jobGroup } from '../../engine/snapshot.js';
import { simulateGame } from '../../engine/sim.js';
import { etParts } from '../../engine/time.js';

const sha = buf => createHash('sha256').update(buf).digest('hex');
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

// returns { inputs, predictions, sims?, simInputs? } ; simInputs (kept only on request) feed scenario tests
export async function predictionHashes({ simSample = false, keepSimInputs = false } = {}) {
  const P = JSON.parse(await readFile('data/model/params.json', 'utf8'));
  const out = { inputs: {}, predictions: {} };
  if (simSample) { out.sims = {}; if (keepSimInputs) out.simInputs = {}; }
  for (const f of ['params', 'latent', 'calibration', 'play-prob']) out.inputs[`data/model/${f}.json`] = sha(await readFile(`data/model/${f}.json`));
  for (const season of Object.keys(PRIOR)) {
    for (const d of [`data/games/${season}`, `data/injury-pdf/${season}`, ...PRIOR[season].map(s => `data/games/${s}`)]) out.inputs[d] = await dirHash(d);
    out.inputs[`data/schedule/${season}.json`] = sha(await readFile(`data/schedule/${season}.json`));
    const games = await loadGames([...PRIOR[season], season]);
    for (const variant of ['A', 'B']) {
      const plans = [], kept = [];
      const injuriesFor = variant === 'B' ? await snapshotsFor(season, games) : null;
      const rows = walkForward({
        games, target: { season }, params: P.params, variant, injuriesFor,
        onGame: x => { plans.push([x.homePlan.players, x.awayPlan.players]); if (simSample && variant === 'B') kept.push(x); return {}; },
      });
      // results removed: actual, overtime; everything else is a prediction input or output
      const pred = rows.map((r, i) => ({ id: r.id, model: r.model, base: r.base, group: r.group, snapshot: r.snapshot ?? null, plans: plans[i] }));
      out.predictions[`${season} ${variant}`] = { games: pred.length, sha256: sha(JSON.stringify(pred)) };
      if (simSample && variant === 'B') {
        const sample = kept.filter((_, i) => i % 100 === 0).slice(0, 12);
        const results = sample.map(({ ratings, homePlan, awayPlan, game }) => simulateGame({ ratings, home: game.home.id, away: game.away.id, homePlan, awayPlan }, { n: 1000, seed: +game.id % 2147483647 }));
        out.sims[`${season} B`] = { games: sample.map(x => x.game.id), sha256: sha(JSON.stringify(results)) };
        if (keepSimInputs) out.simInputs[`${season} B`] = sample;
      }
    }
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = { generatedAt: new Date().toISOString(), ...(await predictionHashes({ simSample: process.argv.includes('--sim-sample') })) };
  await writeFile(process.argv[2], JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ predictions: out.predictions, sims: out.sims }));
}
