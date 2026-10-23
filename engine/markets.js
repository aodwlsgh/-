// Market probabilities at Betman's own lines (P7, design §9.1). Only the base prediction is accepted: the validated
// simulation moved to the ensemble location and passed through the calibration layer (engine/calibrate.js markets).
// Scenario or sensitivity results are refused (2026-10-23 user conditions 5 and 10). All markets include overtime.
//   HC line H: P(home + H > away);  OU line L: P(total > L)
// Integer lines are recorded as unsupported until Betman's rule for them is confirmed on the first real capture;
// lines outside the calibrated range (|H| > 15.5, L more than 14.5 from the expected total) give no probability.
import { markets } from './calibrate.js';

export function assertBase(prediction) {
  if (!prediction || prediction.source !== 'base' || prediction.label === 'unverified') {
    throw new Error('picks and EV use the base prediction only (scenario and sensitivity results are unverified)');
  }
}

export function marketProbs(prediction, cal, rec) {
  assertBase(prediction);
  const m = markets(cal, prediction.sim);
  switch (rec.type ?? rec.market) {
    case 'ML': return { home: m.ml.home, away: m.ml.away };
    case 'ML5': return { ...m.ml5 };
    case 'HC': {
      if (Number.isInteger(rec.line)) return { unsupported: 'integer line (rule unconfirmed)' };
      const p = m.hc(rec.line);
      return p === null ? { unsupported: `line ${rec.line} outside the calibrated range` } : { home: p, away: 1 - p };
    }
    case 'OU': {
      if (Number.isInteger(rec.line)) return { unsupported: 'integer line (rule unconfirmed)' };
      const p = m.ou(rec.line);
      return p === null ? { unsupported: `line ${rec.line} outside the calibrated range` } : { over: p, under: 1 - p };
    }
    default: throw new Error(`unknown market ${rec.type ?? rec.market}`);
  }
}
