// P2 data build (design §5, plan P2). Phases run independently and are resumable:
//   schedule  scan US dates, list regular-season games          -> data/schedule/{season}.json
//   games     fetch summaries, run checks, write parsed data     -> data/games/{season}/{usDate}.json.gz
//   pdf       pre-game injury PDF snapshots for backtest (B)     -> data/injury-pdf/{season}/{etDate}.json.gz
// Raw responses live in .cache/raw (session only); everything under data/ is committed.
// Usage: NODE_USE_ENV_PROXY=1 node jobs/build-data.js <phase> <season...>   e.g. schedule 2024-25 2025-26
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createCollector, PDF_15MIN_FROM, injuryPdfEt } from '../engine/collect.js';
import { fsCache } from './lib/fs-cache.js';
import { extractGame } from '../engine/extract.js';
import { scheduleExclusion } from '../engine/schedule.js';
import { SchemaError } from '../engine/schema/espn.js';
import { fromEt, etParts } from '../engine/time.js';
import { jobGroup, snapshotCutoff, RUN_A_ET, RUN_B_ET } from '../engine/snapshot.js';
import { parseInjuryPdf, PdfFormatError } from '../engine/injury.js';
import { pdfTextItems } from './lib/pdf-text.js';

// backtest (B) snapshots follow the daily runs (engine/snapshot.js): last PDF at or before 17:50 ET
// (run A), 20:50 ET for games from 21:00 ET (run B), or before tip-off for pre_job_start games
const etLabel = d => { const p = etParts(d); return `${p.date} ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };

const MAX_EXCLUDED_RATIO = 0.05; // P2 condition 1: stop and report above 5%
const REBUILD = process.argv.includes('--rebuild');
const exists = async p => { try { await readFile(p); return true; } catch { return false; } };

export const SEASONS = {
  '2024-25': { year: 2025, from: '2024-10-15', to: '2025-04-30' },
  '2025-26': { year: 2026, from: '2025-10-15', to: '2026-04-30' },
  '2026-27': { year: 2027, from: '2026-10-15', to: '2027-04-30' },
};

const col = createCollector({ cache: fsCache() });
const writeJson = async (path, v) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(v, null, 1)); };
const writeGz = async (path, v) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, gzipSync(JSON.stringify(v))); };
export const readGz = async path => JSON.parse(gunzipSync(await readFile(path)));

function usDates(from, to) {
  const out = [];
  for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); d = new Date(d.getTime() + 86400e3)) {
    out.push(d.toISOString().slice(0, 10).replaceAll('-', ''));
  }
  return out;
}
// last US date whose games are all over (yesterday in ET)
function lastCompleteUsDate() {
  return new Date(Date.now() - 86400e3).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

async function schedule(season) {
  const cfg = SEASONS[season];
  const to = cfg.to < lastCompleteUsDate() ? cfg.to : lastCompleteUsDate();
  const games = [], other = {}, skipped = [];
  for (const date of usDates(cfg.from, to)) {
    const sb = await col.schedule(date);
    for (const e of sb.events) {
      const c = e.competitions[0];
      const row = {
        id: e.id, usDate: date, start: e.date, status: c.status.type.name,
        home: c.competitors.find(x => x.homeAway === 'home').team.abbreviation,
        away: c.competitors.find(x => x.homeAway === 'away').team.abbreviation,
        slug: e.season.slug, year: e.season.year, ctype: c.type?.abbreviation ?? null,
      };
      if (e.season.year !== cfg.year) continue;
      const why = scheduleExclusion(row);
      if (!why) games.push(row);
      else if (row.slug === 'regular-season') skipped.push({ ...row, reason: why });
      else other[e.season.slug] = (other[e.season.slug] || 0) + 1;
    }
  }
  const out = {
    season, scannedThrough: to, generatedAt: new Date().toISOString(),
    games: games.length, gameDates: new Set(games.map(g => g.usDate)).size,
    gamesPerTeam: Object.entries(games.reduce((a, g) => { a[g.home] = (a[g.home] || 0) + 1; a[g.away] = (a[g.away] || 0) + 1; return a; }, {})).reduce((a, [t, n]) => ({ ...a, [n]: [...(a[n] || []), t] }), {}),
    skippedRegularSeasonLabel: skipped.map(g => ({ id: g.id, usDate: g.usDate, game: `${g.away}@${g.home}`, reason: g.reason })),
    otherSlugs: other, list: games,
  };
  await writeJson(`data/schedule/${season}.json`, out);
  console.log(season, JSON.stringify({ games: out.games, gameDates: out.gameDates, gamesPerTeam: Object.fromEntries(Object.entries(out.gamesPerTeam).map(([n, ts]) => [n, ts.length])), skipped: skipped.reduce((a, g) => ({ ...a, [g.reason]: (a[g.reason] || 0) + 1 }), {}), otherSlugs: other }));
  return out;
}

async function games(season) {
  const sched = JSON.parse(await readFile(`data/schedule/${season}.json`, 'utf8'));
  const byDate = new Map();
  for (const g of sched.list) { if (!byDate.has(g.usDate)) byDate.set(g.usDate, []); byDate.get(g.usDate).push(g); }
  const checks = [], excluded = [];
  const unknownTypes = new Map(); // "id text" -> [gameId...]; collected across the run, then stop
  let done = 0;
  const t0 = Date.now();
  for (const [date, list] of byDate) {
    const path = `data/games/${season}/${date}.json.gz`;
    let recs = !REBUILD && await exists(path) ? await readGz(path) : null;
    if (!recs || recs.length !== list.length) {
      recs = [];
      for (const g of list) {
        let s;
        try { s = await col.game(g.id); } catch (e) {
          if (!(e instanceof SchemaError)) throw e;
          const types = e.errors.map(x => x.match(/unknown play type id (".*?" ".*?")/)?.[1]);
          if (types.some(t => !t)) { console.error(`schema mismatch in game ${g.id} (${date}); stopping\n${e.message}`); process.exit(3); }
          for (const t of new Set(types)) unknownTypes.set(t, [...(unknownTypes.get(t) ?? []), g.id]);
          continue;
        }
        recs.push(extractGame(s));
      }
      if (recs.length === list.length) await writeGz(path, recs);
      else { done += list.length; continue; } // date incomplete: rerun after classifying new play types
    }
    for (const r of recs) {
      const matchup = `${r.away.abbr}@${r.home.abbr}`;
      checks.push({
        id: r.id, usDate: date, matchup, errPct2: r.checks.errPct2, errPct1: r.checks.errPct1, haDiff: r.checks.haDiff,
        heaves: r.checks.heaves, heaveRule: r.checks.heaveRule, fgaMatch: r.checks.fgaMatch, teamMinutes: r.checks.teamMinutes,
        teamMinutesOk: r.checks.teamMinutesOk, pbpComplete: r.checks.pbpComplete, failed: r.failed,
        issues: r.quality.issues.map(i => i.code + (i.team ? `(${i.team})` : '')),
      });
      if (r.excluded) excluded.push({ season, id: r.id, usDate: date, game: matchup, stage: 'data', reason: r.quality.issues.map(i => `${i.code}: ${i.detail ?? ''}`).join('; ') });
    }
    done += list.length;
    if (excluded.length > MAX_EXCLUDED_RATIO * sched.list.length) {
      console.error(`${season}: excluded ${excluded.length} > ${MAX_EXCLUDED_RATIO * 100}% of ${sched.list.length}; stopping`);
      await writeJson(`data/checks/${season}.json`, { season, partial: true, checks });
      process.exit(4);
    }
    if (done % 100 < list.length) console.log(`${season} ${done}/${sched.list.length} games, excluded ${excluded.length}, ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  if (unknownTypes.size) {
    console.error(`${season}: ${unknownTypes.size} unknown play type(s); classify in engine/schema/espn-play-types.js and rerun`);
    for (const [t, ids] of unknownTypes) console.error(`  ${t}  games ${ids.length} e.g. ${ids.slice(0, 3).join(',')}`);
    await writeJson(`data/checks/unknown-play-types-${season}.json`, Object.fromEntries([...unknownTypes].map(([t, ids]) => [t, ids])));
    process.exit(3);
  }
  await writeJson(`data/checks/${season}.json`, { season, generatedAt: new Date().toISOString(), games: checks.length, checks });
  // excluded list across seasons: schedule-stage skips + data-stage exclusions
  const exPath = 'data/excluded_games.json';
  const all = (await exists(exPath)) ? JSON.parse(await readFile(exPath, 'utf8')) : [];
  const keep = all.filter(x => x.season !== season);
  const schedSkips = sched.skippedRegularSeasonLabel.map(x => ({ season, id: x.id, usDate: x.usDate, game: x.game, stage: 'schedule', reason: x.reason }));
  await writeJson(exPath, [...keep, ...schedSkips, ...excluded].sort((a, b) => (a.season + a.usDate).localeCompare(b.season + b.usDate)));
  console.log(`${season} done: ${checks.length} games, data-excluded ${excluded.length} (${(100 * excluded.length / sched.list.length).toFixed(2)}%)`);
}

async function snapshot(at, gameDate) {
  const pdf = await col.latestInjuryPdf(at, { maxSteps: 16 });
  if (!pdf) return { pdf: null };
  const mdY = `${gameDate.slice(5, 7)}/${gameDate.slice(8, 10)}/${gameDate.slice(0, 4)}`;
  const lagMin = Math.round((at - fromEt(pdf.et.date, pdf.et.hour, pdf.et.minute)) / 60000);
  try {
    const parsed = parseInjuryPdf(await pdfTextItems(pdf.bytes));
    return {
      pdf: pdf.name, lagMin, reportTime: parsed.reportTime,
      rows: parsed.rows.filter(r => r.gameDate === mdY), notSubmitted: parsed.notSubmitted, issues: parsed.issues,
    };
  } catch (e) {
    if (e instanceof PdfFormatError) return { pdf: pdf.name, lagMin, formatError: e.message };
    throw e;
  }
}

async function pdf(season) {
  const sched = JSON.parse(await readFile(`data/schedule/${season}.json`, 'utf8'));
  const byDate = new Map();
  for (const g of sched.list) { const d = `${g.usDate.slice(0, 4)}-${g.usDate.slice(4, 6)}-${g.usDate.slice(6)}`; if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(g); }
  const index = []; // one row per game: group, cutoff, PDF actually used
  for (const [date, list] of byDate) {
    const path = `data/injury-pdf/${season}/${date}.json.gz`;
    let rec = !REBUILD && await exists(path) ? await readGz(path) : null;
    let dirty = false;
    if (!rec) {
      const cutoff = fromEt(date, RUN_A_ET.hour, RUN_A_ET.minute);
      rec = { date, cutoff: cutoff.toISOString(), format: date >= PDF_15MIN_FROM ? '15min' : 'hourly', main: await snapshot(cutoff, date), early: [] };
      for (const g of list.filter(x => jobGroup(x.start) === 'pre_job_start')) {
        rec.early.push({ id: g.id, game: `${g.away}@${g.home}`, start: g.start, ...(await snapshot(snapshotCutoff(g.start), date)) });
      }
      dirty = true;
    }
    if (!rec.runB && list.some(g => jobGroup(g.start) === 'B')) {
      const cutoffB = fromEt(date, RUN_B_ET.hour, RUN_B_ET.minute);
      rec.runB = { cutoff: cutoffB.toISOString(), ...(await snapshot(cutoffB, date)) };
      dirty = true;
    }
    if (dirty) await writeGz(path, rec);
    for (const g of list) {
      const group = jobGroup(g.start);
      const snap = group === 'pre_job_start' ? rec.early.find(x => x.id === g.id) : group === 'B' ? rec.runB : rec.main;
      const cutoff = snapshotCutoff(g.start);
      const pdfEt = snap?.pdf ? injuryPdfEt(snap.pdf) : null;
      const pdfAt = pdfEt ? fromEt(pdfEt.date, pdfEt.hour, pdfEt.minute) : null;
      index.push({
        id: g.id, date, game: `${g.away}@${g.home}`, start: g.start, group, format: rec.format,
        cutoffEt: etLabel(cutoff), pdf: snap?.pdf ?? null, pdfEt: pdfAt ? etLabel(pdfAt) : null,
        lagMin: pdfAt ? Math.round((cutoff - pdfAt) / 60000) : null,
        ok: !!pdfAt && pdfAt <= cutoff && !snap.formatError, formatError: snap?.formatError ?? null,
      });
    }
  }
  const agg = (fmt, group) => {
    const rows = index.filter(x => x.format === fmt && (!group || x.group === group));
    const lags = rows.filter(x => x.lagMin != null).map(x => x.lagMin).sort((p, q) => p - q);
    return {
      games: rows.length, withSnapshot: rows.filter(x => x.ok).length,
      coveragePct: rows.length ? +(100 * rows.filter(x => x.ok).length / rows.length).toFixed(2) : null,
      pdfAfterCutoff: rows.filter(x => x.pdf && !x.ok && !x.formatError).length, formatErrors: rows.filter(x => x.formatError).length,
      lagMinMedian: lags.length ? lags[Math.floor(lags.length / 2)] : null, lagMinMax: lags.length ? lags.at(-1) : null,
    };
  };
  const byFmt = fmt => Object.fromEntries(['all', 'A', 'B', 'pre_job_start'].map(g => [g, agg(fmt, g === 'all' ? null : g)]));
  const out = { season, runs: { A: '17:50 ET', B: '20:50 ET (games from 21:00 ET)' }, generatedAt: new Date().toISOString(), hourly: byFmt('hourly'), '15min': byFmt('15min') };
  await writeJson(`data/injury-pdf/${season}/index.json`, index);
  await writeJson(`data/checks/injury-pdf-${season}.json`, out);
  console.log(season, JSON.stringify(out, null, 0));
}

const [phase, ...seasons] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const PHASES = { schedule, games, pdf };
if (!PHASES[phase]) { console.error(`phases: ${Object.keys(PHASES).join(', ')}`); process.exit(2); }
for (const s of seasons) {
  if (!SEASONS[s]) { console.error(`unknown season ${s}`); process.exit(2); }
  await PHASES[phase](s);
}
