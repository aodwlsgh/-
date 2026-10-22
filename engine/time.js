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
