// NBA injury-report PDF names whose accented letter the text extraction split into its own token ("L ó pez, Karim",
// 2026-10-25 reports). Rejoined here, on the parsed rows, before matching (2026-10-26 user decision: engine/injury.js
// and jobs/lib/pdf-text.js stay frozen). A name with no lone non-ASCII letter comes back unchanged.
const lone = t => t.length === 1 && t.charCodeAt(0) > 0x7f && /\p{L}/u.test(t);
const lower = t => t !== t.toUpperCase();
const startsLower = t => !!t && /^\p{Ll}/u.test(t);
const endsLetter = t => !!t && /\p{L}$/u.test(t);

// a lone lowercase letter joins the word before it and a lowercase word after it ("L ó pez" -> "López",
// "Jos é" -> "José"); a lone capital joins a lowercase word after it ("Á lvarez" -> "Álvarez")
function rejoinPart(part) {
  const out = [];
  const t = part.split(' ');
  for (let i = 0; i < t.length; i++) {
    let w = t[i];
    if (lone(w)) {
      if (lower(w) && endsLetter(out.at(-1))) w = out.pop() + w;
      if (startsLower(t[i + 1])) w += t[++i];
    }
    out.push(w);
  }
  return out.join(' ');
}

export function rejoinSplitAccents(name) {
  if (typeof name !== 'string' || !name.split(/[ ,]/).some(lone)) return name;
  return name.split(', ').map(rejoinPart).join(', ');
}

// rows of engine/injury.js parseInjuryPdf -> { rows, fixes: [{ team, from, to }] }; unchanged rows keep their object
export function normalizePdfRows(rows = []) {
  const fixes = [];
  const out = rows.map(r => {
    const to = rejoinSplitAccents(r.player);
    if (to === r.player) return r;
    fixes.push({ team: r.team, from: r.player, to });
    return { ...r, player: to };
  });
  return { rows: out, fixes };
}
