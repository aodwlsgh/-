// Network side of the daily run (P9): the day's games from the ESPN scoreboard, the injury-report snapshot a run
// may use and the ESPN injuries feed (parallel record only). The snapshot rule is jobs/build-data.js `snapshot`:
// the newest NBA report readable by the cutoff (later of its title time and Last-Modified), later ones listed.
import { parseInjuryPdf, PdfFormatError, parseEspnInjuries, reportTimeEt } from '../../engine/injury.js';
import { injuryPdfEt, PDF_15MIN_FROM } from '../../engine/collect.js';
import { availableAt } from '../../engine/snapshot.js';
import { NBA_TEAMS } from '../../engine/schedule.js';
import { etParts } from '../../engine/time.js';
import { pdfTextItems } from './pdf-text.js';
import { normalizePdfRows } from '../../engine/pdf-names.js';

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

// Report choice of run C (2026-10-28 user decision 2): "pin30" takes only the game-day report titled HH:30 of the
// cutoff hour (07:30 for 07:50 ET, 08:30 for 08:50 ET), the edition the validations used; missing, late or broken means
// no snapshot (no other edition). Runs A and B keep "latest" (the latest report out by the cutoff).
export const PIN30 = 'pin30', LATEST = 'latest';
const isPinFile = (name, pin) => {
  try { const e = injuryPdfEt(name); return e.date === pin.date && e.hour === pin.hour && e.minute === (pin.date < PDF_15MIN_FROM ? 0 : 30); } catch { return false; }
};

// pdfs: async iterable of { name, bytes, lastModified } newest first; parse(bytes) -> parseInjuryPdf result
// pin: { date, hour, minute: 30 } (ET) -> only that report, see PIN30
export async function pickSnapshot(pdfs, { at, gameDate, parse, pin = null }) {
  const mdY = `${gameDate.slice(5, 7)}/${gameDate.slice(8, 10)}/${gameDate.slice(0, 4)}`;
  const skipped = [];
  for await (const pdf of pdfs) {
    let parsed = null, formatError = null;
    try { parsed = await parse(pdf.bytes); } catch (e) { if (!(e instanceof PdfFormatError)) throw e; formatError = e.message; }
    const avail = availableAt({ reportTime: parsed?.reportTime, lastModified: pdf.lastModified });
    if (pin) {
      const rt = parsed ? reportTimeEt(parsed.reportTime) : null;
      const isPin = rt ? rt.date === pin.date && rt.hour === pin.hour && rt.minute === pin.minute : isPinFile(pdf.name, pin);
      if (!isPin) {
        // an edition after the pinned one is passed over; one before it means the pinned report is not there
        if (rt && (rt.date < pin.date || (rt.date === pin.date && rt.hour * 60 + rt.minute < pin.hour * 60 + pin.minute))) return { pdf: null, pinMiss: 'missing', skippedLater: skipped };
        skipped.push({ pdf: pdf.name, reportTime: parsed?.reportTime ?? null, lastModified: pdf.lastModified, notPinned: true });
        continue;
      }
      if (formatError) return { pdf: pdf.name, reportTime: null, lastModified: pdf.lastModified, availableAt: avail?.toISOString() ?? null, formatError, pinMiss: 'format error', skippedLater: skipped };
      if (!avail || avail > at) return { pdf: null, pinMiss: 'late', late: { pdf: pdf.name, reportTime: parsed.reportTime, availableAt: avail?.toISOString() ?? null }, skippedLater: skipped };
    } else if (!avail || avail > at) { skipped.push({ pdf: pdf.name, reportTime: parsed?.reportTime ?? null, lastModified: pdf.lastModified }); continue; }
    const base = { pdf: pdf.name, reportTime: parsed?.reportTime ?? null, lastModified: pdf.lastModified, availableAt: avail.toISOString(), lagMin: Math.round((at - avail) / 60000), skippedLater: skipped };
    if (formatError) return { ...base, formatError };
    // split accented names rejoined before any matching (engine/pdf-names.js); each fix is kept with the snapshot
    const { rows, fixes } = normalizePdfRows(parsed.rows.filter(r => r.gameDate === mdY));
    return { ...base, rows, ...(fixes.length ? { nameFixes: fixes } : {}), notSubmitted: parsed.notSubmitted, issues: parsed.issues };
  }
  return { pdf: null, ...(pin ? { pinMiss: 'missing' } : {}), skippedLater: skipped };
}

export const parsePdf = async bytes => parseInjuryPdf(await pdfTextItems(bytes));

export async function liveInputs(col, { date, season, searchAt, pin = null }) {
  const sb = await col.schedule(usDate(date));
  const fx = fixturesFromScoreboard(sb, { date, season });
  // pinned: from the cutoff back to the pinned hour (4 steps of 15 minutes reach HH:00 from HH:50)
  const snapshot = await pickSnapshot(col.injuryPdfsBefore(searchAt, { maxSteps: pin ? 4 : 16 }), { at: searchAt, gameDate: date, parse: parsePdf, pin });
  let espn = null, espnRaw = null, espnError = null;
  try { espnRaw = await col.injuries(); espn = parseEspnInjuries(espnRaw); } catch (e) { espnError = String(e.message ?? e); }
  return { ...fx, snapshot, espn, espnRaw, espnError };
}
