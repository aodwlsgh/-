// Which daily run covers a game, and the injury-snapshot cutoff it implies (design §11.2, §14.2).
// Run A 17:50 ET covers games after it; run B 20:50 ET re-runs for games starting 21:00 ET or later;
// games starting at or before 17:50 ET start before any run ("pre_job_start", excluded from S1-S3).
import { etParts, fromEt } from './time.js';

export const RUN_A_ET = { hour: 17, minute: 50 };
export const RUN_B_ET = { hour: 20, minute: 50 };
export const LATE_GAME_ET = { hour: 21, minute: 0 };

export function jobGroup(startIso) {
  const start = new Date(startIso);
  const d = etParts(start).date;
  if (start <= fromEt(d, RUN_A_ET.hour, RUN_A_ET.minute)) return 'pre_job_start';
  if (start >= fromEt(d, LATE_GAME_ET.hour, LATE_GAME_ET.minute)) return 'B';
  return 'A';
}

// latest moment whose injury PDF the game may use
export function snapshotCutoff(startIso) {
  const start = new Date(startIso);
  const d = etParts(start).date;
  switch (jobGroup(startIso)) {
    case 'pre_job_start': return new Date(start.getTime() - 60e3);
    case 'B': return fromEt(d, RUN_B_ET.hour, RUN_B_ET.minute);
    default: return fromEt(d, RUN_A_ET.hour, RUN_A_ET.minute);
  }
}
