// ESPN play types first seen after the registered commit 53c88f5, mapped onto an existing type of
// engine/schema/espn-play-types.js before validation (2026-10-26 user decision: engine/schema stays frozen).
// An alias applies only when id and text both match; anything else stays unknown and fails validation as before.
// The mapped play takes the target id and its text from PLAY_TYPES (validation checks both); the play's own `text`
// ("Kings 20 Sec. timeout") is kept. Every mapping is returned to the caller, which writes it to
// data/games/<season>/play-type-aliases.json.
import { PLAY_TYPES } from './espn-play-types.js';

export const PLAY_TYPE_ALIASES = {
  // "Kings 20 Sec. timeout" (401909852, 2026-10-23): the same play fields as "16" "Full Timeout"
  '17': { text: 'Short Timeout', to: '16', since: '2026-10-26' },
};

// summary -> { summary, mapped: [{ playId, from, to, text }] }; the input is not modified, and with nothing
// to map the same object comes back
export function aliasPlayTypes(summary) {
  const mapped = [];
  if (!Array.isArray(summary?.plays)) return { summary, mapped };
  const plays = summary.plays.map(p => {
    const a = PLAY_TYPE_ALIASES[p?.type?.id];
    if (!a || p.type.text !== a.text) return p;
    mapped.push({ playId: p.id, from: p.type.id, to: a.to, text: p.type.text });
    return { ...p, type: { ...p.type, id: a.to, text: PLAY_TYPES[a.to][0] } };
  });
  return mapped.length ? { summary: { ...summary, plays }, mapped } : { summary, mapped };
}

// a collector cache that stores ESPN summaries with their aliases applied (raw responses are cached before
// validation, engine/collect.js), so jobs/build-data.js reads them as known types. onMap(espnId, mapped).
export function aliasingCache(inner, onMap = () => {}) {
  const SUMMARY = 'espn/summary_';
  // writes back only what changed on a read; always writes on a set
  const fix = async (key, v, write) => {
    const r = aliasPlayTypes(v);
    if (r.mapped.length) { await inner.set(key, r.summary); onMap(key.slice(SUMMARY.length), r.mapped); } else if (write) await inner.set(key, v);
    return r.summary;
  };
  return {
    async get(key) { const v = await inner.get(key); return key.startsWith(SUMMARY) && v ? fix(key, v, false) : v; },
    async set(key, v) { if (key.startsWith(SUMMARY) && v) await fix(key, v, true); else await inner.set(key, v); },
  };
}
