// Timestamps for records (P7, 2026-10-23 user condition 9): every time is kept in UTC and in KST (Asia/Seoul, no
// daylight saving). Game times are set in ET elsewhere (engine/time.js), so the KST hour of a game moves when US
// daylight saving ends (2026-11-01) — the stored pair shows it.
import { kstParts } from './time.js';

export function stamp(t) {
  const d = new Date(t);
  const k = kstParts(d);
  const sec = String(d.getUTCSeconds()).padStart(2, '0');
  return { utc: d.toISOString(), kst: `${k.date}T${String(k.hour).padStart(2, '0')}:${String(k.minute).padStart(2, '0')}:${sec}+09:00` };
}
