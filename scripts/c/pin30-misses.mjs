// :30 report misses of run C (2026-10-28 user decision 5): every run C log in data/runs/<season>/ with its report rule,
// the edition used and why the C predictions were provisional. Collected for two weeks before any fallback rule is
// considered (a fallback would be registered and validated separately, before computing).
//   node scripts/c/pin30-misses.mjs [--season 2026-27] [--from YYYY-MM-DD]
import { readdir, readFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const season = arg('--season', '2026-27'), from = arg('--from', '2026-10-28');
const dir = `data/runs/${season}`;
const runs = [];
for (const f of (await readdir(dir)).filter(x => /^\d{4}-\d{2}-\d{2}-C-/.test(x)).sort()) {
  const log = JSON.parse(await readFile(`${dir}/${f}`, 'utf8'));
  if (log.date < from) continue;
  runs.push({ runId: log.runId, date: log.date, rule: log.cReport?.rule ?? log.reportRule ?? 'latest', ok: log.cReport?.ok ?? null, pinMiss: log.cReport?.pinMiss ?? null, reportTime: log.cReport?.reportTime ?? null, why: log.cReport?.why ?? null });
}
const pinned = runs.filter(r => r.rule === 'pin30');
const misses = pinned.filter(r => r.ok === false);
const byReason = misses.reduce((a, r) => ({ ...a, [r.pinMiss ?? 'other']: (a[r.pinMiss ?? 'other'] ?? 0) + 1 }), {});
console.log(JSON.stringify({ season, from, runs: runs.length, pin30Runs: pinned.length, misses: misses.length, missRate: pinned.length ? +(misses.length / pinned.length).toFixed(3) : null, byReason, list: runs }, null, 1));
