import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pdfTextItems } from '../jobs/lib/pdf-text.js';
import {
  parseInjuryPdf, parseEspnInjuries, resolveStatuses, normalizeName, teamKey, PdfFormatError, PLAY_PROB,
} from '../engine/injury.js';

const pdfBytes = () => new Uint8Array(readFileSync(new URL('./fixtures/nba/Injury-Report_2026-10-21_05_00PM.pdf', import.meta.url)));
const espnDoc = () => JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/espn/injuries_20261022.json.gz', import.meta.url))));

test('names normalise across "Last, First", suffixes and accents', () => {
  assert.equal(normalizeName('Dennis, RayJ'), 'rayj dennis');
  assert.equal(normalizeName('Trent Jr., Gary'), 'gary trent');
  assert.equal(normalizeName('Luka Dončić'), 'luka doncic');
  assert.equal(normalizeName("De'Aaron Fox"), 'deaaron fox');
  assert.equal(normalizeName('Jaren Jackson Jr.'), 'jaren jackson');
});

test('team key is the nickname', () => {
  assert.equal(teamKey('Portland Trail Blazers'), 'blazers');
  assert.equal(teamKey('LA Clippers'), 'clippers');
  assert.equal(teamKey('Philadelphia 76ers'), '76ers');
});

test('real PDF: header found, rows parsed with carried-forward game and team', async () => {
  const r = parseInjuryPdf(await pdfTextItems(pdfBytes()));
  assert.equal(r.reportTime, '10/21/26 05:00 PM');
  const first = r.rows[0];
  assert.deepEqual(
    { game: first.matchup, team: first.team, player: first.player, status: first.status },
    { game: 'ATL@ORL', team: 'Atlanta Hawks', player: 'Dennis, RayJ', status: 'Questionable' },
  );
  // two-line reason stitched in reading order
  const isaac = r.rows.find(x => x.player === 'Isaac, Jonathan');
  assert.equal(isaac.team, 'Orlando Magic');
  assert.equal(isaac.reason, 'Injury/Illness - Left Knee Injury Management');
  assert.equal(first.reason, 'G League - Two-Way');
  // team rows that have not been submitted are kept separately
  assert.deepEqual(r.notSubmitted.map(x => x.team), ['Denver Nuggets', 'Oklahoma City Thunder']);
  assert.ok(r.rows.length > 60);
  assert.ok(r.rows.every(x => ['Out', 'Questionable', 'Doubtful', 'Probable', 'Available'].includes(x.status)), r.issues.join('\n'));
  assert.deepEqual(r.issues, []);
});

test('PDF without the expected header fails the format check', () => {
  const items = [[{ x: 20, y: 480, str: 'Something' }, { x: 120, y: 480, str: 'Else' }]];
  assert.throws(() => parseInjuryPdf(items), PdfFormatError);
});

test('ESPN injuries: player id from the link, team nickname, status', () => {
  const rows = parseEspnInjuries(espnDoc());
  assert.equal(rows.length, 71);
  const g = rows.find(x => x.name === 'Mouhamed Gueye');
  assert.deepEqual({ id: g.espnId, team: g.team, status: g.status }, { id: '4712863', team: 'hawks', status: 'Out' });
});

test('resolve: ESPN Out wins; Day-To-Day takes the PDF status; PDF-only players are added', () => {
  const espn = [
    { espnId: '1', name: 'A One', team: 'hawks', status: 'Out' },
    { espnId: '2', name: 'B Two', team: 'hawks', status: 'Day-To-Day' },
    { espnId: '3', name: 'C Three', team: 'magic', status: 'Day-To-Day' },
  ];
  const pdf = { rows: [
    { team: 'Atlanta Hawks', player: 'One, A', status: 'Available' },
    { team: 'Atlanta Hawks', player: 'Two, B', status: 'Doubtful' },
    { team: 'Orlando Magic', player: 'Four, D', status: 'Questionable' },
  ] };
  const r = resolveStatuses({ espn, pdf });
  const by = Object.fromEntries(r.players.map(x => [x.name, x]));
  assert.deepEqual([by['A One'].playProb, by['A One'].source], [0, 'espn']);
  assert.deepEqual([by['B Two'].status, by['B Two'].playProb, by['B Two'].source], ['Doubtful', PLAY_PROB.Doubtful, 'pdf']);
  assert.deepEqual([by['C Three'].status, by['C Three'].playProb], ['Day-To-Day', 0.55]);
  assert.deepEqual([by['D Four'].status, by['D Four'].source], ['Questionable', 'pdf-only']);
  assert.equal(r.conflicts.length, 1); // ESPN Out vs PDF Available
});

test('resolve without a usable PDF: Day-To-Day defaults to 0.55', () => {
  const r = resolveStatuses({ espn: [{ espnId: '2', name: 'B Two', team: 'hawks', status: 'Day-To-Day' }], pdf: null });
  assert.equal(r.players[0].playProb, 0.55);
  assert.equal(r.pdfUsed, false);
});

import { reportTimeEt } from '../engine/injury.js';

test('report time from the PDF title (ET)', () => {
  assert.deepEqual(reportTimeEt('10/22/25 05:30 PM'), { date: '2025-10-22', hour: 17, minute: 30 });
  assert.deepEqual(reportTimeEt('01/10/24 12:15 AM'), { date: '2024-01-10', hour: 0, minute: 15 });
  assert.deepEqual(reportTimeEt('03/05/26 12:45 PM'), { date: '2026-03-05', hour: 12, minute: 45 });
  assert.equal(reportTimeEt('garbage'), null);
  assert.equal(reportTimeEt(null), null);
});
