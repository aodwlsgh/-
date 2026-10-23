// Network side of the daily run (P9): the day's games from the ESPN scoreboard, the injury-report snapshot a run
// may use and the ESPN injuries feed (parallel record only). The snapshot rule is jobs/build-data.js `snapshot`:
// the newest NBA report readable by the cutoff (later of its title time and Last-Modified), later ones listed.
import { parseInjuryPdf, PdfFormatError, parseEspnInjuries } from '../../engine/injury.js';
import { availableAt } from '../../engine/snapshot.js';
import { NBA_TEAMS } from '../../engine/schedule.js';
import { etParts } from '../../engine/time.js';
import { pdfTextItems } from './pdf-text.js';

export const usDate = etDate => etDate.replaceAll('-', '');

// scoreboard -> fixtures of the ET date (regular season, both NBA teams, not the NBA Cup final: as the backtest)
export function fixturesFromScoreboard(sb, { date, season }) {
  const out = [], skipped = [];
  for (const e of sb.events) {
    const c = e.competitions[0];
    const side = k => c.competitors.find(x => x.homeAway === k).team;
    const home = side('home'), away = side('away');
    const row = { id: e.id, start: e.date, season, home: { id: String(home.id), abbr: home.abbreviation }, away: { id: String(away.id), abbr: away.abbreviation }, status: c.status.type.name };
    const why = e.season?.slug !== 'regular-season' ? `slug ${e.season?.slug}` : !NBA_TEAMS.includes(row.home.abbr) || !NBA_TEAMS.includes(row.away.abbr) ? 'non-NBA team' : c.type?.abbreviation === 'CC' ? 'NBA Cup championship' : etParts(new Date(e.date)).date !== date ? 'other ET date' : null;
    (why ? skipped : out).push(why ? { id: e.id, game: `${row.away.abbr}@${row.home.abbr}`, reason: why } : row);
  }
  return { fixtures: out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id)), skipped };
}

// pdfs: async iterable of { name, bytes, lastModified } newest first; parse(bytes) -> parseInjuryPdf result
export async function pickSnapshot(pdfs, { at, gameDate, parse }) {
  const mdY = `${gameDate.slice(5, 7)}/${gameDate.slice(8, 10)}/${gameDate.slice(0, 4)}`;
  const skipped = [];
  for await (const pdf of pdfs) {
    let parsed = null, formatError = null;
    try { parsed = await parse(pdf.bytes); } catch (e) { if (!(e instanceof PdfFormatError)) throw e; formatError = e.message; }
    const avail = availableAt({ reportTime: parsed?.reportTime, lastModified: pdf.lastModified });
    if (!avail || avail > at) { skipped.push({ pdf: pdf.name, reportTime: parsed?.reportTime ?? null, lastModified: pdf.lastModified }); continue; }
    const base = { pdf: pdf.name, reportTime: parsed?.reportTime ?? null, lastModified: pdf.lastModified, availableAt: avail.toISOString(), lagMin: Math.round((at - avail) / 60000), skippedLater: skipped };
    if (formatError) return { ...base, formatError };
    return { ...base, rows: parsed.rows.filter(r => r.gameDate === mdY), notSubmitted: parsed.notSubmitted, issues: parsed.issues };
  }
  return { pdf: null, skippedLater: skipped };
}

export const parsePdf = async bytes => parseInjuryPdf(await pdfTextItems(bytes));

export async function liveInputs(col, { date, season, searchAt }) {
  const sb = await col.schedule(usDate(date));
  const fx = fixturesFromScoreboard(sb, { date, season });
  const snapshot = await pickSnapshot(col.injuryPdfsBefore(searchAt, { maxSteps: 16 }), { at: searchAt, gameDate: date, parse: parsePdf });
  let espn = null, espnError = null;
  try { espn = parseEspnInjuries(await col.injuries()); } catch (e) { espnError = String(e.message ?? e); }
  return { ...fx, snapshot, espn, espnError };
}
