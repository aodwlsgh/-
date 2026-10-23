// Browser timing (P8 completion criterion, 2026-10-23 user condition 7): on the published example day, for every
// game, change a variable and press "다시 돌리기" five times; time from the click to the scenario result on
// screen (10,000 simulations in the Web Worker). Reports median and max per game; fails if any run takes 5 s or more.
// Run: cd tools/browser && npm run perf    -> docs/reports/p8-browser-timing.json
import { writeFile } from 'node:fs/promises';
import { launch, open, tab, example, EXE } from './harness.mjs';

const RUNS = 5, LIMIT_MS = 5000;
const browser = await launch();
const { page, errors, close } = await open(browser);
const version = browser.version();
await tab(page, 'detail');
const games = [];
for (let gi = 0; gi < example.games.length; gi++) {
  await page.selectOption('#gsel', String(gi));
  const runs = [];
  for (let r = 1; r <= RUNS; r++) {
    await page.fill('#fg3-home', String(r * 0.5)); // a different variable value every run
    await page.click('#rerun');
    await page.waitForSelector(`#scenOut[data-done="${r}"]`, { timeout: 60000 });
    runs.push(await page.evaluate(i => { const s = window.__dash.scen.get(window.__dash.day.games[i].gameId); return { clickMs: s.clickMs, simMs: s.ms }; }, gi));
  }
  const click = runs.map(x => x.clickMs).sort((a, b) => a - b);
  const g = example.games[gi];
  games.push({ gameId: g.gameId, game: `${g.away.espn}@${g.home.espn}`, medianMs: Math.round(click[2]), maxMs: Math.round(click.at(-1)), simMedianMs: Math.round(runs.map(x => x.simMs).sort((a, b) => a - b)[2]), runsMs: runs.map(x => Math.round(x.clickMs)) });
  console.log(`${games.at(-1).game.padEnd(8)} median ${games.at(-1).medianMs} ms, max ${games.at(-1).maxMs} ms`);
}
await close();
await browser.close();
const all = games.flatMap(g => g.runsMs).sort((a, b) => a - b);
const out = {
  generatedAt: new Date().toISOString(), browser: `Chromium ${version} (${EXE}, headless)`, day: example.date, kind: example.kind,
  measure: 'click on 다시 돌리기 -> scenario result rendered; 10,000 simulations in a module Web Worker; one variable changed before every run',
  runsPerGame: RUNS, limitMs: LIMIT_MS, overall: { runs: all.length, medianMs: all[Math.floor(all.length / 2)], maxMs: all.at(-1) },
  pass: all.at(-1) < LIMIT_MS, pageErrors: errors, games,
};
await writeFile(new URL('../../docs/reports/p8-browser-timing.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out.overall), out.pass ? 'PASS' : 'FAIL');
process.exit(out.pass && !errors.length ? 0 : 1);
