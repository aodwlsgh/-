// Live ESPN schema check: fetch yesterday's scoreboard (US date), one final game summary,
// and the injuries feed, then validate. Exits 1 on any schema mismatch or fetch failure.
// Usage: node scripts/check-schema-live.mjs [YYYYMMDD]
import { assertValid, checkSummaryQuality } from '../engine/schema/espn.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const usDate = d => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).replaceAll('-', '');
const date = process.argv[2] ?? usDate(new Date(Date.now() - 86400e3));

async function get(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

let failed = false;
async function step(name, fn) {
  try { console.log(`ok   ${name}${(await fn()) ?? ''}`); }
  catch (e) { failed = true; console.error(`FAIL ${name}\n${e.message}`); }
}

let gameId;
await step(`scoreboard ${date}`, async () => {
  const sb = assertValid('scoreboard', await get(`${BASE}/scoreboard?dates=${date}`));
  gameId = sb.events.find(e => e.competitions[0].status.type.name === 'STATUS_FINAL')?.id;
  return ` (${sb.events.length} events)`;
});
if (gameId) {
  await step(`summary ${gameId}`, async () => {
    const s = assertValid('summary', await get(`${BASE}/summary?event=${gameId}`));
    const q = checkSummaryQuality(s);
    return q.length ? ` (quality issues: ${q.join('; ')})` : '';
  });
} else {
  console.log(`skip summary: no final game on ${date}`);
}
await step('injuries', async () => {
  const d = assertValid('injuries', await get(`${BASE}/injuries`));
  return ` (${d.injuries.reduce((a, t) => a + t.injuries.length, 0)} players)`;
});
process.exit(failed ? 1 : 0);
