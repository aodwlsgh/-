// Append-only pick log (P7, design §9.4, §12; 2026-10-23 user conditions 7-9). One log of typed records:
//   evaluation  every market the model priced (for the market Brier comparison of exit condition 3)
//   pick        every candidate leg the model produced (EV >= 3%), fixed before the deadline, whatever the user buys
//   combo       every 2-fold candidate
//   purchase    whether the user bought a pick (separate record; the pick itself never changes)
//   result      final score of a game (margin and total, overtime included)
// Each record carries the previous record's hash (hash chain); there are no update or delete functions.
// P8/P9 add a daily git commit of the log as a second copy.
import { stamp } from './clock.js';
import { settle } from './picks.js';
import { rng } from './sim.js';

// ---- SHA-256 (synchronous, same result in Node and in the browser worker) ----
const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
export function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  const len = bytes.length, words = new Uint32Array(((len + 9 + 63) >> 6) << 4);
  for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  words[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
  words[words.length - 1] = len * 8;
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rot = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < words.length; o += 16) {
    for (let t = 0; t < 64; t++) {
      if (t < 16) w[t] = words[o + t];
      else w[t] = (rot(w[t - 2], 17) ^ rot(w[t - 2], 19) ^ (w[t - 2] >>> 10)) + w[t - 7] + (rot(w[t - 15], 7) ^ rot(w[t - 15], 18) ^ (w[t - 15] >>> 3)) + w[t - 16];
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = (h + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[t] + w[t]) >>> 0;
      const t2 = ((rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((v, i) => { H[i] = (H[i] + v) >>> 0; });
  }
  return H.map(v => v.toString(16).padStart(8, '0')).join('');
}

// canonical JSON (sorted keys) so the hash does not depend on key order
const canon = v => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
const body = r => { const { hash, ...rest } = r; return rest; };

export function chainAppend(prev, record) {
  const r = { ...record, seq: prev ? prev.seq + 1 : 0, prevHash: prev ? prev.hash : null };
  return { ...r, hash: sha256(canon(r)) };
}

export function verifyChain(log) {
  for (let i = 0; i < log.length; i++) {
    const r = log[i];
    const prevOk = i === 0 ? r.prevHash === null && r.seq === 0 : r.prevHash === log[i - 1].hash && r.seq === log[i - 1].seq + 1;
    if (!prevOk || sha256(canon(body(r))) !== r.hash) return { ok: false, brokenAt: i };
  }
  return { ok: true, brokenAt: null };
}

// a leg from engine/picks.js becomes a pick record; refused at or after the deadline (= before tip-off)
export function pickRecord(leg, { now = new Date() } = {}) {
  if (!leg.deadline?.utc || new Date(now) >= new Date(leg.deadline.utc)) throw new Error(`pick ${leg.gameId} ${leg.market} ${leg.selection}: at or after the deadline ${leg.deadline?.utc}`);
  return {
    type: 'pick', id: `${leg.round}-${leg.betmanNo}-${leg.selection}`, createdAt: stamp(now), deadline: leg.deadline,
    gameId: leg.gameId, round: leg.round, betmanNo: leg.betmanNo, market: leg.market, line: leg.line, selection: leg.selection,
    odds: leg.odds, p: leg.p, pCons: leg.pCons, ev: leg.ev, pConsOld: leg.pConsOld, evOld: leg.evOld, noVig: leg.noVig, predictionRef: leg.predictionRef,
  };
}
export const purchaseRecord = (pickId, purchased, { now = new Date(), stake = null } = {}) => ({ type: 'purchase', pickId, purchased: !!purchased, stake, at: stamp(now) });
export const resultRecord = (gameId, margin, total, { now = new Date() } = {}) => ({ type: 'result', gameId, margin, total, at: stamp(now) });

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r4 = x => (x == null ? null : +x.toFixed(4));

// ROI per unit stake with a game-clustered bootstrap interval (legs of the same game are resampled together)
function roiByGame(settled, { resamples = 2000, seed = 1 } = {}) {
  const groups = new Map();
  for (const s of settled) (groups.get(s.gameId) ?? groups.set(s.gameId, []).get(s.gameId)).push(s.win ? s.odds - 1 : -1);
  const g = [...groups.values()];
  if (!g.length) return { value: null, ci95: null, clusteredBy: 'game' };
  const est = list => { let sum = 0, n = 0; for (const x of list) { for (const v of x) sum += v; n += x.length; } return sum / n; };
  const rand = rng(seed), boot = [];
  for (let b = 0; b < resamples; b++) boot.push(est(Array.from({ length: g.length }, () => g[Math.floor(rand() * g.length)])));
  boot.sort((a, b) => a - b);
  return { value: r4(est(g)), ci95: [r4(boot[Math.floor(0.025 * resamples)]), r4(boot[Math.floor(0.975 * resamples)])], clusteredBy: 'game' };
}

// weekly summary of the record-only period (§9.4): single picks counted alone (200-pick condition), 2-folds apart
export function summarize(log, { now = new Date() } = {}) {
  const results = new Map(log.filter(r => r.type === 'result').map(r => [r.gameId, r]));
  const outcome = r => { const g = results.get(r.gameId); return g ? settle(r.market, r.selection, r.line, g.margin, g.total) : null; };
  const singles = log.filter(r => r.type === 'pick');
  const settled = singles.map(r => ({ ...r, win: outcome(r) })).filter(r => r.win !== null);
  const created = singles.map(r => Date.parse(r.createdAt.utc)).sort((a, b) => a - b);
  const weeks = created.length > 1 ? (created.at(-1) - created[0]) / (7 * 86400e3) : 0;
  const hitRate = mean(settled.map(r => (r.win ? 1 : 0))), meanPCons = mean(settled.map(r => r.pCons));
  const roi = roiByGame(settled);
  const picksById = new Map(singles.map(r => [r.id, r]));
  const combos = log.filter(r => r.type === 'combo').map(c => {
    const legs = c.legs.map(id => picksById.get(id)).map(l => (l ? outcome(l) : null));
    return { ...c, win: legs.some(x => x === null) ? null : legs.every(Boolean) };
  });
  const combosSettled = combos.filter(c => c.win !== null);
  const evals = log.filter(r => r.type === 'evaluation' && r.p != null && r.noVig != null).map(r => ({ ...r, y: outcome(r) })).filter(r => r.y !== null);
  const brierModel = mean(evals.map(r => (r.p - (r.y ? 1 : 0)) ** 2)), brierMarket = mean(evals.map(r => (r.noVig - (r.y ? 1 : 0)) ** 2));
  // total bias monitor (2026-10-23 user condition 10): actual - predicted total, shown only
  const predTotal = new Map();
  for (const r of log.filter(x => x.type === 'evaluation' && x.predTotal != null)) if (!predTotal.has(r.gameId)) predTotal.set(r.gameId, { pred: r.predTotal, at: r.evaluatedAt ?? null });
  const biases = [...predTotal].filter(([g]) => results.has(g)).map(([g, v]) => ({ d: results.get(g).total - v.pred, at: v.at }));
  const cut = Date.parse(new Date(now).toISOString()) - 28 * 86400e3;
  const recent = biases.filter(b => b.at && Date.parse(b.at) >= cut);
  const purchases = new Map();
  for (const p of log.filter(r => r.type === 'purchase')) purchases.set(p.pickId, p.purchased);
  const gap = hitRate == null ? null : hitRate - meanPCons;
  const exit = {
    minPicks: { target: 200, value: settled.length, met: settled.length >= 200 },
    minWeeks: { target: 8, value: r4(weeks), met: weeks >= 8 },
    calibration: { target: 0.05, value: r4(gap), met: gap != null && Math.abs(gap) <= 0.05 },
    marketBrier: { model: r4(brierModel), market: r4(brierMarket), met: brierModel != null && brierModel <= brierMarket },
    roi: { value: roi.value, ci95: roi.ci95, met: roi.value != null && roi.value >= 0 && roi.ci95[0] >= -0.10 },
    releaseNeedsUserApproval: true,
  };
  exit.allMet = ['minPicks', 'minWeeks', 'calibration', 'marketBrier', 'roi'].every(k => exit[k].met);
  return {
    chain: verifyChain(log),
    singles: { n: singles.length, settled: settled.length, hits: settled.filter(r => r.win).length, hitRate: r4(hitRate), meanPCons: r4(meanPCons), meanPConsOld: r4(mean(settled.map(r => r.pConsOld).filter(x => x != null))), meanEV: r4(mean(settled.map(r => r.ev))), roi },
    combos: { n: combos.length, settled: combosSettled.length, hits: combosSettled.filter(c => c.win).length, roi: r4(mean(combosSettled.map(c => (c.win ? c.oddsProduct - 1 : -1)))) },
    purchases: { recorded: purchases.size, purchased: [...purchases.values()].filter(Boolean).length },
    market: { n: evals.length, brierModel: r4(brierModel), brierMarket: r4(brierMarket) },
    monitor: { totalBias: { games: biases.length, all: r4(mean(biases.map(b => b.d))), last4weeks: recent.length ? r4(mean(recent.map(b => b.d))) : null, note: 'shown only; predictions are not adjusted' } },
    exit,
  };
}
