// ESPN injury status values the frozen schema (engine/schema/espn.js: Out, Day-To-Day) does not list
// (2026-11-13 user decision 8). For the ESPN+PDF parallel record only — predictions, picks and EV read the NBA PDF.
// "Suspension" maps to "Out" only when ESPN itself marks the player out (details.fantasyStatus OUT); the mapping is
// logged. Any other value is not mapped: it is reported and the parallel record is skipped as before.
import { SchemaError, checkInjuries, INJURY_STATUSES } from '../../engine/schema/espn.js';
import { parseEspnInjuries } from '../../engine/injury.js';
import { ESPN_BASE } from '../../engine/collect.js';

const certainOut = x => x.status === 'Suspension' && x.details?.fantasyStatus?.abbreviation === 'OUT';

// doc as received -> { doc: mapped copy, map: [{ team, player, from, to, why }], unmapped: [{ team, player, status }] }
export function mapEspnStatuses(received) {
  const doc = structuredClone(received);
  const map = [], unmapped = [];
  for (const t of doc.injuries ?? []) {
    for (const x of t.injuries ?? []) {
      if (INJURY_STATUSES.includes(x.status)) continue;
      const who = { team: t.displayName, player: x.athlete?.displayName ?? null };
      if (certainOut(x)) { map.push({ ...who, from: x.status, to: 'Out', why: 'ESPN fantasyStatus OUT' }); x.status = 'Out'; } else unmapped.push({ ...who, status: x.status ?? null });
    }
  }
  return { doc, map, unmapped };
}

const fetchRaw = async () => (await fetch(`${ESPN_BASE}/injuries`)).json();

// col.injuries() validates; on a schema mismatch the feed is read again as received and mapped
export async function espnInjuriesMapped(col, raw = fetchRaw) {
  try {
    const doc = await col.injuries();
    return { espn: parseEspnInjuries(doc), espnRaw: doc, espnError: null };
  } catch (e) {
    if (!(e instanceof SchemaError)) return { espn: null, espnRaw: null, espnError: String(e.message ?? e) };
    let received;
    try { received = await raw(); } catch (e2) { return { espn: null, espnRaw: null, espnError: `${e.message} (raw read failed: ${e2.message ?? e2})` }; }
    const m = mapEspnStatuses(received);
    const errs = checkInjuries(m.doc);
    if (errs.length) return { espn: null, espnRaw: received, espnError: new SchemaError('injuries', errs).message, espnUnmapped: m.unmapped, ...(m.map.length ? { espnStatusMap: m.map } : {}) };
    return { espn: parseEspnInjuries(m.doc), espnRaw: received, espnError: null, espnStatusMap: m.map };
  }
}
