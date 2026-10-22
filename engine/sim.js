// Possession-level Monte Carlo (design §7). Browser and Node; no I/O.
// Per lineup and minute, event probabilities are solved from the P3 per-possession rates so that, with the
// game-state rules off, the simulated means equal engine/predict.js:
//   per action: turnover τ, free-throw trip φ, field goal by zone α_z (Σ = 1); a missed field goal is
//   rebounded by the offence with probability ρ (same possession continues), where
//   N = ΣA_z + T + F actions per possession and ρ = (1 − 1/N) / Σ α_z(1 − p_z).
import { ZONE_POINTS } from './model.js';
import { offense, expectedGame } from './predict.js';

const NZ = 5;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

// xoshiro128** seeded through splitmix32
export function rng(seed) {
  let s = seed >>> 0;
  const sm = () => { s = (s + 0x9e3779b9) >>> 0; let z = s; z = Math.imul(z ^ (z >>> 16), 0x85ebca6b); z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35); return (z ^ (z >>> 16)) >>> 0; };
  let a = sm(), b = sm(), c = sm(), d = sm();
  return () => {
    const r = Math.imul(((Math.imul(b, 5) << 7) | (Math.imul(b, 5) >>> 25)), 9) >>> 0;
    const t = b << 9;
    c ^= a; d ^= b; b ^= c; a ^= d; c ^= t; d = (d << 11) | (d >>> 21);
    return r / 4294967296;
  };
}
function normal(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// ---- minutes: integer minutes into 48 one-minute slots of five ------------------------------------
// players: [{playerId, expMin, pos}] all available. Starters (top five) open both halves; otherwise the
// player furthest behind his remaining-minutes pace plays, with a small bonus for staying on.
export function allocateMinutes(players, { minutes = 48 } = {}) {
  const ps = players.filter(p => p.expMin > 0).map(p => ({ id: p.playerId, m: Math.min(p.expMin, minutes) }));
  const total = ps.reduce((a, p) => a + p.m, 0) || 1;
  // scale to 5 × minutes, then largest-remainder rounding (cap at `minutes`)
  const want = ps.map(p => Math.min(minutes, p.m * 5 * minutes / total));
  const ints = want.map(Math.floor);
  let left = 5 * minutes - ints.reduce((a, b) => a + b, 0);
  const order = want.map((w, i) => [w - ints[i], i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) { if (left <= 0) break; if (ints[i] < minutes) { ints[i]++; left--; } }
  for (let i = 0; left > 0 && i < ints.length; i++) while (left > 0 && ints[i] < minutes) { ints[i]++; left--; }
  const starters = new Set([...ps.map((p, i) => [ints[i], i])].sort((a, b) => b[0] - a[0]).slice(0, 5).map(([, i]) => i));
  const rem = [...ints];
  const slots = [];
  let on = new Set();
  for (let m = 0; m < minutes; m++) {
    const R = minutes - m;
    const half = m === 0 || m === minutes / 2;
    const score = i => (rem[i] >= R ? 1e9 : 0) + rem[i] / R + (half && starters.has(i) ? 1 : 0) + (!half && on.has(i) ? 0.15 : 0);
    const pick = rem.map((r, i) => i).filter(i => rem[i] > 0).sort((a, b) => score(b) - score(a) || a - b).slice(0, 5);
    pick.forEach(i => rem[i]--);
    on = new Set(pick);
    slots.push(pick.map(i => ps[i].id));
  }
  return { slots, minutes: Object.fromEntries(ps.map((p, i) => [p.id, ints[i]])), starters: [...starters].map(i => ps[i].id) };
}

// absent players' minutes go to available players of the same position first (as engine/minutes.js)
function redistribute(players, avail) {
  const act = players.filter(p => avail.has(p.playerId));
  const min = new Map(act.map(p => [p.playerId, p.expMin]));
  for (const g of ['G', 'F', 'C']) {
    const gone = players.filter(p => p.pos === g && !avail.has(p.playerId)).reduce((a, p) => a + p.expMin, 0);
    const grp = act.filter(p => p.pos === g);
    const w = grp.reduce((a, p) => a + p.expMin, 0);
    if (gone > 0 && w > 0) for (const p of grp) min.set(p.playerId, min.get(p.playerId) + gone * p.expMin / w);
  }
  return act.map(p => ({ ...p, expMin: min.get(p.playerId) }));
}

// ---- lineup event tables ----------------------------------------------------------------------------
function leaguePlayer(league) {
  return { att: league.attRate.map(a => a / 5), fg: [...league.fg], fta: league.ftaRate / 5, ft: league.ft, tov: league.tovRate / 5 };
}

// offence of five players vs defence; factor scales make probabilities (home advantage, environment)
function lineupTable(ids, ratings, def, factor) {
  const { league } = ratings;
  const fb = leaguePlayer(league);
  const rs = ids.map(id => ratings.players[id] ?? fb);
  const att = new Array(NZ).fill(0), made = new Array(NZ).fill(0);
  let fta = 0, ftm = 0, tov = 0;
  for (const r of rs) {
    for (let z = 0; z < NZ; z++) { att[z] += r.att[z]; made[z] += r.att[z] * r.fg[z]; }
    fta += r.fta; ftm += r.fta * r.ft; tov += r.tov;
  }
  const used = att.reduce((a, b) => a + b, 0) + 0.44 * fta + tov;
  const lgUsed = league.attRate.reduce((a, b) => a + b, 0) + 0.44 * league.ftaRate + league.tovRate;
  const u = used > 0 ? lgUsed / used : 1;
  for (let z = 0; z < NZ; z++) { att[z] *= u; made[z] *= u; }
  fta *= u; ftm *= u; tov *= u;
  const T = Math.min(0.5, tov * def.tovMult);
  const shotScale = (1 - T) / (1 - tov);
  const A = att.map((a, z) => a * def.attMult[z] * shotScale);
  const p = att.map((a, z) => (a > 0 ? clamp((made[z] / a) * def.fgMult[z] * factor, 0.01, 0.99) : 0));
  const FTA = fta * def.ftaMult * shotScale;
  const ftPct = fta > 0 ? clamp((ftm / fta) * factor, 0.01, 0.995) : league.ft;
  const F = FTA / 2;
  const N = A.reduce((a, b) => a + b, 0) + T + F;
  const alpha = A.map(a => a / N), tau = T / N, phi = F / N;
  const miss = alpha.reduce((s, a, z) => s + a * (1 - p[z]), 0);
  const rho = clamp(miss > 0 ? (1 - 1 / N) / miss : 0, 0, 0.95);
  // cumulative action thresholds: [tau, tau+phi, then zones]
  const cum = new Float64Array(2 + NZ);
  cum[0] = tau; cum[1] = tau + phi;
  for (let z = 0; z < NZ; z++) cum[2 + z] = cum[1 + z] + alpha[z];
  // shooters per zone (cumulative weights) with individual make probabilities (mean = p[z])
  const shooters = [];
  for (let z = 0; z < NZ; z++) {
    const w = rs.map(r => r.att[z]);
    const tw = w.reduce((a, b) => a + b, 0);
    const lineP = tw > 0 ? rs.reduce((s, r, i) => s + w[i] * r.fg[z], 0) / tw : 0;
    const scaleP = lineP > 0 ? p[z] / lineP : 1;
    let c = 0;
    shooters.push(rs.map((r, i) => { c += tw > 0 ? w[i] / tw : 1 / 5; return [c, clamp(r.fg[z] * scaleP, 0.005, 0.995), i]; }));
  }
  const fw = rs.map(r => r.fta), tf = fw.reduce((a, b) => a + b, 0);
  const lineFt = tf > 0 ? rs.reduce((s, r, i) => s + fw[i] * r.ft, 0) / tf : league.ft;
  let c = 0;
  const ftShooters = rs.map((r, i) => { c += tf > 0 ? fw[i] / tf : 1 / 5; return [c, clamp(r.ft * ftPct / lineFt, 0.01, 0.995), i]; });
  const bestFt = rs.map((r, i) => [r.ft * ftPct / lineFt, i]).sort((a, b) => b[0] - a[0])[0];
  return { ids, cum, rho, shooters, ftShooters, bestFt: [clamp(bestFt[0], 0.01, 0.995), bestFt[1]] };
}

const pickCum = (arr, x) => { for (const e of arr) if (x < e[0]) return e; return arr[arr.length - 1]; };

// one possession; returns points and credits players (pts[] indexed by global player index)
function possession(tbl, rand, shootMult, idx, pts) {
  let points = 0;
  for (let guard = 0; guard < 20; guard++) {
    const x = rand();
    if (x < tbl.cum[0]) return points; // turnover
    if (x < tbl.cum[1]) { // two free throws
      const [, ft, i] = pickCum(tbl.ftShooters, rand());
      for (let k = 0; k < 2; k++) if (rand() < ft) { points++; pts[idx[tbl.ids[i]]]++; }
      return points;
    }
    let z = 0;
    while (z < NZ - 1 && x >= tbl.cum[2 + z]) z++;
    const [, pz, i] = pickCum(tbl.shooters[z], rand());
    if (rand() < Math.min(0.995, pz * shootMult)) { points += ZONE_POINTS[z]; pts[idx[tbl.ids[i]]] += ZONE_POINTS[z]; return points; }
    if (rand() >= tbl.rho) return points; // defensive rebound
  }
  return points;
}

function clutchTrip(tbl, rand, idx, pts) {
  const [ft, i] = tbl.bestFt;
  let points = 0;
  for (let k = 0; k < 2; k++) if (rand() < ft) { points++; pts[idx[tbl.ids[i]]]++; }
  return points;
}

// ---- game -------------------------------------------------------------------------------------------
export const DEFAULT_RULES = { garbageTime: true, clutchFoul: true, overtime: true, latent: true };
// shootSD: team shooting form; gameSD: shooting environment shared by both teams; paceSD: shared pace;
// kappa: score effect, % change in make probability per point of lead above the expected lead so far
// (mean-preserving); regPace: regulation pace factor, because the P3 ratings already contain late-game
// fouling and overtime that the rules add explicitly. Calibrated on 2024-25 in P4.
export const DEFAULT_LATENT = { shootSD: 0.04, gameSD: 0, paceSD: 0.03, kappa: 0, regPace: 1 };

export function simulateGame({ ratings, home, away, homePlan, awayPlan }, { n = 10000, seed = 1, rules = DEFAULT_RULES, latent = DEFAULT_LATENT, check = false } = {}) {
  const rand = rng(seed);
  const R = { ...DEFAULT_RULES, ...rules };
  const lg = ratings.league;
  const env = lg.env ?? { ortgRatio: 1, paceRatio: 1 };
  const hca = lg.hca ?? 0;
  const teamIds = [home, away];
  const plans = [homePlan, awayPlan].map(p => p.players.filter(x => x.expMin > 0 || x.playProb > 0));
  // make-probability factors: analytic team rating with environment and home advantage / without
  const factor = plans.map((pl, s) => {
    const def = ratings.teams[teamIds[1 - s]];
    const base = offense(ratings, { players: pl }, def);
    return (base * env.ortgRatio + (s === 0 ? hca / 2 : -hca / 2)) / base;
  });
  const L8 = { ...DEFAULT_LATENT, ...latent };
  const possTarget = ratings.teams[home].pace * ratings.teams[away].pace / lg.pace * env.paceRatio * (R.latent ? L8.regPace : 1);
  const expMargin = R.latent && L8.kappa ? expectedGame(ratings, home, away, { players: plans[0] }, { players: plans[1] }).margin : 0;

  const allIds = [...new Set(plans.flat().map(p => p.playerId))];
  const idx = Object.fromEntries(allIds.map((id, i) => [id, i]));
  const sumPts = new Float64Array(allIds.length), sumSec = new Float64Array(allIds.length);

  // schedules and lineup tables per availability pattern
  const cache = new Map();
  const tablesFor = (s, avail) => {
    const key = `${s}|${[...avail].sort().join(',')}`;
    if (cache.has(key)) return cache.get(key);
    const pl = redistribute(plans[s], avail);
    const sched = allocateMinutes(pl);
    const def = ratings.teams[teamIds[1 - s]];
    const memo = new Map();
    const tableOf = ids => { const k = ids.slice().sort().join(','); if (!memo.has(k)) memo.set(k, lineupTable(ids, ratings, def, factor[s])); return memo.get(k); };
    const byMin = sched.slots.map(tableOf);
    const ranked = [...pl].sort((a, b) => b.expMin - a.expMin).map(p => p.playerId);
    const out = { byMin, ot: tableOf(ranked.slice(0, 5)), bench: tableOf(ranked.slice(-5)) };
    cache.set(key, out);
    return out;
  };

  const margins = new Float64Array(n), totals = new Float64Array(n);
  let homeSum = 0, awaySum = 0, possSum = 0, otGames = 0, garbageGames = 0, clutchGames = 0, invariantFailures = 0, homeWins = 0;
  const pts = new Float64Array(allIds.length), sec = new Float64Array(allIds.length);

  for (let it = 0; it < n; it++) {
    pts.fill(0); sec.fill(0);
    const T = [0, 1].map(s => {
      const avail = new Set(plans[s].filter(p => p.playProb >= 1 || (p.playProb > 0 && rand() < p.playProb)).map(p => p.playerId));
      return tablesFor(s, avail);
    });
    const gameMult = R.latent && L8.gameSD ? Math.max(0.7, 1 + L8.gameSD * normal(rand)) : 1;
    const shoot = R.latent ? [0, 1].map(() => gameMult * Math.max(0.7, 1 + L8.shootSD * normal(rand))) : [1, 1];
    const paceMult = R.latent ? Math.max(0.8, 1 + L8.paceSD * normal(rand)) : 1;
    const score = [0, 0];
    let garbage = false, clutch = false, poss = 0;
    const jump = rand() < 0.5 ? 0 : 1; // team with the opening possession
    let period = 0;
    for (;;) {
      period++;
      const L = period <= 4 ? 720 : 300;
      if (period > 4 && (!R.overtime || score[0] !== score[1])) break;
      if (period > 4) otGames += period === 5 ? 1 : 0;
      const expected = 2 * possTarget * paceMult * L / 2880;
      const mu = L / Math.max(1, expected - 0.54);
      // Q1 and Q4: jump winner; Q2, Q3: the other team; overtime: coin flip
      let off = period > 4 ? (rand() < 0.5 ? 0 : 1) : (period === 1 || period === 4 ? jump : 1 - jump);
      let clock = L;
      while (clock > 0) {
        const elapsed = (period - 1) * 720 + (L - clock); // regulation seconds (overtime handled separately)
        if (R.garbageTime && period >= 4 && !garbage) {
          const diff = Math.abs(score[0] - score[1]);
          if ((period === 4 && clock <= 480 && diff >= 20) || diff >= 25) garbage = true;
        }
        const lineup = s => (garbage ? T[s].bench : period > 4 ? T[s].ot : T[s].byMin[Math.min(47, Math.floor(elapsed / 60))]);
        const def = 1 - off;
        let d;
        if (R.clutchFoul && period >= 4 && clock <= 60 && score[def] - score[off] <= -3 && score[def] - score[off] >= -8) {
          // trailing defence fouls at once
          clutch = true;
          d = Math.min(clock, 2 + 4 * rand());
          score[off] += clutchTrip(lineup(off), rand, idx, pts);
        } else {
          d = Math.min(clock, mu * (0.5 + rand()) / (garbage ? 1.03 : 1));
          let mult = shoot[off];
          if (R.latent && L8.kappa) {
            const frac = Math.min(1, ((period - 1) * 720 + (L - clock)) / 2880);
            const dev = score[off] - score[def] - (off === 0 ? 1 : -1) * expMargin * frac;
            mult *= clamp(1 - L8.kappa * dev / 100, 0.7, 1.3);
          }
          score[off] += possession(lineup(off), rand, mult, idx, pts);
        }
        for (const s of [0, 1]) for (const id of lineup(s).ids) sec[idx[id]] += d;
        clock -= d;
        poss++;
        off = 1 - off;
      }
      if (period >= 4 && (score[0] !== score[1] || !R.overtime)) break;
      if (period >= 10) break;
    }
    if (garbage) garbageGames++;
    if (clutch) clutchGames++;
    margins[it] = score[0] - score[1];
    totals[it] = score[0] + score[1];
    homeSum += score[0]; awaySum += score[1]; possSum += poss / 2;
    homeWins += score[0] > score[1] ? 1 : score[0] === score[1] ? 0.5 : 0;
    for (let i = 0; i < allIds.length; i++) { sumPts[i] += pts[i]; sumSec[i] += sec[i]; }
    if (check) {
      const ot = Math.max(0, period - 4);
      for (const s of [0, 1]) {
        const ids = plans[s].map(p => p.playerId);
        const p = ids.reduce((a, id) => a + pts[idx[id]], 0);
        const m = ids.reduce((a, id) => a + sec[idx[id]], 0) / 60;
        if (Math.abs(p - score[s]) > 1e-9 || Math.abs(m - (240 + 25 * ot)) > 1e-6) invariantFailures++;
      }
    }
  }
  const stats = arr => {
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
    const sorted = Float64Array.from(arr).sort();
    const q = f => sorted[Math.min(n - 1, Math.floor(f * n))];
    return { mean, sd, q: { p05: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) } };
  };
  const hist = (arr, lo, hi) => { const h = new Array(hi - lo + 1).fill(0); for (const v of arr) { const k = Math.round(v) - lo; if (k >= 0 && k < h.length) h[k]++; } return h; };
  const margin = stats(margins), total = stats(totals);
  return {
    n, seed, winProbHome: homeWins / n,
    margin: { ...margin, hist: hist(margins, -60, 60) }, total: { ...total, hist: hist(totals, 150, 300) },
    home: { id: home, mean: homeSum / n }, away: { id: away, mean: awaySum / n },
    possessions: { mean: possSum / n },
    overtimeRate: otGames / n, garbageTimeRate: garbageGames / n, clutchFoulRate: clutchGames / n,
    invariantFailures: check ? invariantFailures : undefined,
    playerMeans: Object.fromEntries(allIds.map((id, i) => [id, { pts: sumPts[i] / n, min: sumSec[i] / 60 / n }])),
  };
}
