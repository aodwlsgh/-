// Time-zone helpers. Always via IANA zones, never fixed offsets (US DST shifts ET vs KST).
function parts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(date).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
}

export const etParts = date => parts(date, 'America/New_York');
export const kstParts = date => parts(date, 'Asia/Seoul');

// wall-clock time in New York -> Date (tries the two possible offsets, EDT then EST)
export function fromEt(date, hour, minute) {
  for (const off of [4, 5]) {
    const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), hour + off, minute));
    const p = etParts(d);
    if (p.date === date && p.hour === hour && p.minute === minute) return d;
  }
  throw new Error(`no such ET time ${date} ${hour}:${minute}`);
}
