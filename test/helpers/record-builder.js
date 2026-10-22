// Small game records in the data/games format (engine/extract.js) for model tests.
import { ZONE_NAMES } from '../../engine/extract.js';

// p(id, t, opts): player line. opts: pos, min, st, z: {ra:[m,a],...}, fta, ftm, tov, orb, drb, ast, blk, pts
export function pl(id, t, o = {}) {
  const z = Object.fromEntries(ZONE_NAMES.map(n => [n, o.z?.[n] ?? [0, 0]]));
  const pts = o.pts ?? ZONE_NAMES.reduce((a, n, i) => a + z[n][0] * (i >= 3 ? 3 : 2), 0) + (o.ftm ?? 0);
  return {
    id, t, n: id, pos: o.pos ?? 'F', st: o.st ?? 0, dnp: o.dnp ?? 0, min: o.min ?? 24, sec: (o.min ?? 24) * 60,
    pts, ast: o.ast ?? 0, stl: 0, blk: o.blk ?? 0, pf: 0, orb: o.orb ?? 0, drb: o.drb ?? 0, tov: o.tov ?? 0,
    ftm: o.ftm ?? 0, fta: o.fta ?? 0, z, hv: 0, zx: 0,
  };
}

// ten players at 48 min each half... default lineup: 5 per side at 48 minutes
export function rec({ id, start, home = 'H', away = 'A', players, poss = [100, 100], season }) {
  const ps = players ?? [
    ...['h1', 'h2', 'h3', 'h4', 'h5'].map(x => pl(x, 0, { min: 48, z: { ra: [4, 8], ab3: [3, 8] }, fta: 4, ftm: 3, tov: 3, orb: 2, drb: 6 })),
    ...['a1', 'a2', 'a3', 'a4', 'a5'].map(x => pl(x, 1, { min: 48, z: { ra: [3, 8], ab3: [3, 9] }, fta: 3, ftm: 2, tov: 3, orb: 2, drb: 6 })),
  ];
  const final = [0, 1].map(t => ps.filter(p => p.t === t).reduce((a, p) => a + p.pts, 0));
  return {
    id, season: season ?? (start.slice(5, 7) >= '08' ? `${start.slice(0, 4)}-${String(+start.slice(0, 4) + 1).slice(2)}` : `${+start.slice(0, 4) - 1}-${start.slice(2, 4)}`),
    start, home: { id: home, abbr: home }, away: { id: away, abbr: away }, final, periods: 4,
    checks: { poss }, failed: [], excluded: false,
    quality: { issues: [], usable: { pbp: true, stints: false, box: true }, notes: [] },
    players: ps, poss: [], shots: [], stints: [],
  };
}
