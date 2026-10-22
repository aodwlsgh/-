// The 2025-26 test season is sealed (design §14.2, §14.4): any job that evaluates it must call this first.
// Without --open-test it refuses; a second opening needs --reopen; every opening is logged.
import { readFile, writeFile } from 'node:fs/promises';

export const OPENINGS = 'data/model/test-openings.json';

export async function openTestSeason({ by, argv = process.argv, details = {} }) {
  if (!argv.includes('--open-test')) {
    console.error('2025-26 is the sealed test season; pass --open-test to open it (logged).');
    process.exit(2);
  }
  let log = [];
  try { log = JSON.parse(await readFile(OPENINGS, 'utf8')); } catch {}
  if (log.length && !argv.includes('--reopen')) {
    console.error(`test season already opened ${log.length}x (${log.map(x => x.at).join(', ')}); pass --reopen to open again (logged).`);
    process.exit(2);
  }
  log.push({ at: new Date().toISOString(), by, ...details });
  await writeFile(OPENINGS, JSON.stringify(log, null, 1));
  return log.length;
}
