// Print (and save) the checks the opening gate of jobs/backtest.js test performs (user approval 2026-10-23, item 1):
// clean tree, registered commit is an ancestor of HEAD, no frozen path changed since it, file hashes equal.
// Usage: node scripts/p5/gate-check.mjs <out.json>
import { readFile, writeFile } from 'node:fs/promises';
import { gitHead, gitDirty, isAncestor, changedSince, filesHash, FROZEN, preregistrationProblems } from '../../jobs/lib/provenance.js';

const pre = JSON.parse(await readFile('data/model/preregistration.json', 'utf8'));
const now = await filesHash(Object.keys(pre.files));
const state = { dirty: gitDirty(), ancestor: isAncestor(pre.commit, 'HEAD'), changed: changedSince(pre.commit, FROZEN), files: now };
const gate = {
  at: new Date().toISOString(), registered: { commit: pre.commit, at: pre.at }, head: gitHead(), clean: !state.dirty,
  registeredIsAncestor: state.ancestor, frozenPaths: FROZEN, changedSinceRegistered: state.changed,
  files: Object.fromEntries(Object.entries(pre.files).map(([f, h]) => [f, { registered: h, now: now[f] }])),
  problems: preregistrationProblems(pre, state),
};
await writeFile(process.argv[2], JSON.stringify(gate, null, 1));
console.log(`registered commit   ${gate.registered.commit}`);
console.log(`HEAD                ${gate.head}`);
console.log(`working tree clean  ${gate.clean}`);
console.log(`registered is ancestor of HEAD  ${gate.registeredIsAncestor}`);
console.log(`frozen paths changed since registered  ${gate.changedSinceRegistered.length ? gate.changedSinceRegistered.join(', ') : 'none'}`);
for (const [f, h] of Object.entries(gate.files)) console.log(`${f.padEnd(28)} now ${h.now}\n${''.padEnd(28)} reg ${h.registered}  ${h.now === h.registered ? 'SAME' : 'DIFFERENT'}`);
console.log(`gate  ${gate.problems.length ? 'REFUSE: ' + gate.problems.join('; ') : 'PASS'}`);
