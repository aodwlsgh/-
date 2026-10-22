// Injury sources (design §5.2, §6.5): ESPN injuries (primary) and the NBA injury PDF (secondary).
// The PDF parser takes positioned text items, so PDF decoding stays outside the engine.

export const PLAY_PROB = { Out: 0, Doubtful: 0.15, Questionable: 0.55, Probable: 0.9, Available: 1, 'Day-To-Day': 0.55 };
const PDF_STATUSES = ['Out', 'Doubtful', 'Questionable', 'Probable', 'Available'];
const HEADER = ['Game Date', 'Game Time', 'Matchup', 'Team', 'Player Name', 'Current Status', 'Reason'];
const COLS = ['gameDate', 'gameTime', 'matchup', 'team', 'player', 'status', 'reason'];

export class PdfFormatError extends Error {
  constructor(msg) { super(`NBA injury PDF format: ${msg}`); this.name = 'PdfFormatError'; }
}

export function normalizeName(name) {
  let n = name.trim();
  const comma = n.indexOf(',');
  if (comma > 0) n = `${n.slice(comma + 1)} ${n.slice(0, comma)}`;
  return n.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[.'’]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
}
const displayFromPdf = name => {
  const comma = name.indexOf(',');
  return comma > 0 ? `${name.slice(comma + 1).trim()} ${name.slice(0, comma).trim()}` : name.trim();
};

// nickname is unique across the 30 teams ("Trail Blazers" -> "blazers")
export const teamKey = name => name.trim().split(/\s+/).at(-1).toLowerCase();

function lines(items) {
  const rows = new Map();
  for (const it of items) {
    const y = Math.round(it.y);
    if (!rows.has(y)) rows.set(y, []);
    rows.get(y).push(it);
  }
  return [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([y, its]) => ({ y, items: its.sort((a, b) => a.x - b.x) }));
}

// pages: [[{x, y, str}]]; returns {reportTime, rows, notSubmitted, issues}
export function parseInjuryPdf(pages) {
  if (!pages.length) throw new PdfFormatError('no pages');
  const first = lines(pages[0]);
  const titleLine = first.find(l => l.items.map(i => i.str).join(' ').startsWith('Injury Report:'));
  const headerLine = first.find(l => {
    const t = l.items.map(i => i.str).join(' ');
    let at = 0;
    return HEADER.every(h => { const k = t.indexOf(h, at); if (k < 0) return false; at = k + h.length; return true; });
  });
  if (!headerLine) throw new PdfFormatError(`header ${HEADER.join(' | ')} not found on page 1`);
  // column start x from the first word of each header label
  const words = headerLine.items.map(i => i.str);
  const starts = HEADER.map(h => {
    const w = h.split(' ')[0];
    const k = words.findIndex((s, i) => s === w && (h.split(' ').length === 1 || words[i + 1] === h.split(' ')[1]));
    return headerLine.items[k].x;
  });
  const colOf = x => { let c = 0; for (let i = 0; i < starts.length; i++) if (x >= starts[i] - 3) c = i; return COLS[c]; };

  const rows = [], notSubmitted = [], issues = [];
  const carry = { gameDate: '', gameTime: '', matchup: '', team: '' };
  const all = []; // player lines across pages, finalised at the end
  pages.forEach((page, pi) => {
    const pl = lines(page).filter(l => l.y < headerLine.y - 1 || pi > 0);
    const recs = []; // {y, cells}
    for (const l of pl) {
      const text = l.items.map(i => i.str).join(' ');
      if (/^Injury Report:/.test(text) || /^Page \d+ of \d+$/.test(text)) continue;
      const cells = {};
      for (const it of l.items) {
        const c = colOf(it.x);
        // "Two-" + "Way" -> "Two-Way"; a lone "-" keeps its spaces
        cells[c] = !cells[c] ? it.str : /\S-$/.test(cells[c]) ? `${cells[c]}${it.str}` : `${cells[c]} ${it.str}`;
      }
      recs.push({ y: l.y, cells });
    }
    const players = recs.filter(r => r.cells.player || r.cells.team || r.cells.matchup);
    for (const r of players) {
      for (const k of ['gameDate', 'gameTime', 'matchup', 'team']) if (r.cells[k]) carry[k] = r.cells[k];
      r.out = { ...carry, player: r.cells.player ?? null, status: r.cells.status ?? null, reasonParts: [] };
      if (r.cells.reason) r.out.reasonParts.push([pi, r.y, r.cells.reason]);
    }
    // reason-only lines belong to the nearest player line (a wrapped reason straddles it);
    // above every player line on a page, they continue the last player of the previous page
    for (const r of recs) {
      if (players.includes(r)) continue;
      if (!r.cells.reason || Object.keys(r.cells).length !== 1) { issues.push(`unrecognised line: ${JSON.stringify(r.cells)}`); continue; }
      if (pi > 0 && all.length && players.every(p => p.y < r.y - 20)) { all.at(-1).out.reasonParts.push([pi, r.y, r.cells.reason]); continue; }
      let best = null;
      for (const p of players) if (!best || Math.abs(p.y - r.y) < Math.abs(best.y - r.y)) best = p;
      if (!best || Math.abs(best.y - r.y) > 20) { issues.push(`orphan reason line: ${r.cells.reason}`); continue; }
      best.out.reasonParts.push([pi, r.y, r.cells.reason]);
    }
    all.push(...players);
  });
  for (const p of all) {
    const o = p.out;
    o.reason = o.reasonParts.sort((a, b) => a[0] - b[0] || b[1] - a[1]).map(x => x[2]).join(' ');
    delete o.reasonParts;
    if (!o.player) {
      if (/NOT YET SUBMITTED/.test(o.reason)) notSubmitted.push({ matchup: o.matchup, team: o.team });
      else issues.push(`row without player: ${JSON.stringify(o)}`);
      continue;
    }
    if (!PDF_STATUSES.includes(o.status)) issues.push(`unknown status ${JSON.stringify(o.status)} for ${o.player}`);
    rows.push(o);
  }
  return { reportTime: titleLine ? titleLine.items.map(i => i.str).join(' ').replace(/^Injury Report:\s*/, '') : null, rows, notSubmitted, issues };
}

export function parseEspnInjuries(doc) {
  const out = [];
  for (const t of doc.injuries) {
    for (const x of t.injuries) {
      const link = x.athlete.links.find(l => /\/id\/\d+/.test(l.href));
      out.push({
        espnId: link.href.match(/\/id\/(\d+)/)[1], name: x.athlete.displayName, team: teamKey(t.displayName),
        status: x.status, date: x.date, returnDate: x.details?.returnDate ?? null,
      });
    }
  }
  return out;
}

// Design §6.5 (2026-10-22): ESPN Out = 0; ESPN Day-To-Day takes the PDF status when the PDF
// passed its format check, else 0.55; players only in the PDF take the PDF status.
export function resolveStatuses({ espn, pdf }) {
  const key = (team, name) => `${team}|${normalizeName(name)}`;
  const pdfBy = new Map((pdf?.rows ?? []).map(r => [key(teamKey(r.team), r.player), r]));
  const players = [], conflicts = [];
  const seen = new Set();
  for (const e of espn) {
    const k = key(e.team, e.name);
    seen.add(k);
    const p = pdfBy.get(k);
    if (e.status === 'Out') {
      if (p && p.status !== 'Out') conflicts.push({ name: e.name, team: e.team, espn: 'Out', pdf: p.status });
      players.push({ ...e, status: 'Out', playProb: 0, source: 'espn' });
    } else if (p && PLAY_PROB[p.status] !== undefined) {
      players.push({ ...e, status: p.status, playProb: PLAY_PROB[p.status], source: 'pdf' });
    } else {
      players.push({ ...e, status: 'Day-To-Day', playProb: PLAY_PROB['Day-To-Day'], source: 'espn' });
    }
  }
  for (const [k, p] of pdfBy) {
    if (seen.has(k) || PLAY_PROB[p.status] === undefined) continue;
    players.push({ espnId: null, name: displayFromPdf(p.player), team: teamKey(p.team), status: p.status, playProb: PLAY_PROB[p.status], source: 'pdf-only' });
  }
  return { players, conflicts, pdfUsed: !!pdf };
}

// "10/22/25 05:30 PM" (PDF title, ET) -> { date: '2025-10-22', hour: 17, minute: 30 }
export function reportTimeEt(s) {
  const m = /^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/.exec((s ?? '').trim());
  if (!m) return null;
  const h12 = +m[4] % 12;
  return { date: `20${m[3]}-${m[1]}-${m[2]}`, hour: m[6] === 'PM' ? h12 + 12 : h12, minute: +m[5] };
}
