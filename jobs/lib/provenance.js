// Provenance of backtest inputs (leak review F6): file hashes and the git commit travel with simulations and
// fits, and the single opening of 2025-26 is allowed only from the pre-registered commit (design §14.4.1).
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
export const sha256File = async p => createHash('sha256').update(await readFile(p)).digest('hex');
export const filesHash = async paths => Object.fromEntries(await Promise.all(paths.map(async p => [p, await sha256File(p)])));
export const gitHead = () => git(['rev-parse', 'HEAD']);
export const gitDirty = () => git(['status', '--porcelain']).length > 0;
export function isAncestor(a, b) { try { execFileSync('git', ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } }
export const changedSince = (commit, paths) => git(['diff', '--name-only', commit, 'HEAD', '--', ...paths]).split('\n').filter(Boolean);

// code and fitted files that must not move after pre-registration
export const FROZEN = ['engine', 'jobs', 'package.json', 'data/model/params.json', 'data/model/latent.json', 'data/model/calibration.json'];

// state: { dirty, ancestor, changed, files }
export function preregistrationProblems(pre, state) {
  if (!pre) return ['no pre-registration (data/model/preregistration.json)'];
  const out = [];
  if (state.dirty) out.push('uncommitted changes in the working tree');
  if (!state.ancestor) out.push(`registered commit ${pre.commit} is not an ancestor of HEAD`);
  if (state.changed.length) out.push(`changed since the registered commit: ${state.changed.join(', ')}`);
  for (const [f, h] of Object.entries(pre.files)) if (state.files[f] !== h) out.push(`${f} differs from the registered hash`);
  return out;
}
