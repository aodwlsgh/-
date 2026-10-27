// What the daily run knows about the season (P9): final scores of the committed games and the final predictions
// that were published (prediction archives, data/predictions/<season>/<runId>.json.gz with publishedAt).
import { readFile, readdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { loadGames } from './games.js';

export async function seasonState({ season, root = '.' }) {
  const games = await loadGames([season]).catch(() => []);
  const results = new Map(games.map(g => [g.id, { margin: g.final[0] - g.final[1], total: g.final[0] + g.final[1] }]));
  // finals: path AB (runs A and B), finalsC: early run C; the total-bias monitor keeps using path AB only
  const finals = new Map(), finalsC = new Map(), starts = new Map(), totals = [];
  const dir = join(root, `data/predictions/${season}`);
  for (const f of (await readdir(dir).catch(() => [])).filter(x => x.endsWith('.json.gz')).sort()) {
    const a = JSON.parse(gunzipSync(await readFile(join(dir, f))));
    for (const g of a.games) if (g.start?.utc) starts.set(g.gameId, g.start.utc); // tip-off of every predicted game (evaluation path)
    if (!a.publishedAt) continue; // never shown to anyone: not a final prediction anyone could act on
    for (const g of a.games) {
      if (!g.prediction.final) continue;
      if (g.prediction.run === 'C') { if (!finalsC.has(g.gameId)) finalsC.set(g.gameId, { at: a.publishedAt.utc, runId: a.runId, start: g.start.utc }); continue; }
      if (finals.has(g.gameId)) continue;
      finals.set(g.gameId, { at: a.publishedAt.utc, runId: a.runId, start: g.start.utc });
      const r = results.get(g.gameId);
      if (r) totals.push({ pred: g.prediction.sim.total, actual: r.total, at: g.start.utc });
    }
  }
  return { results, finals, finalsC, starts, totals };
}
