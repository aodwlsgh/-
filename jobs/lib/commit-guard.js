// Daily git commit guard (P9; 2026-10-23 P9 approval 3 and 6). The unattended run commits only the paths listed
// here (the same list is in docs/daily-run.md), only while every file that existed at the registered commit
// 53c88f5 under the frozen paths is unchanged (additions after it are P6-P9 files), and pushes to main as a
// fast-forward: never forced; a rejected push fetches main, replays the run's own unpushed commits on it and tries
// again (three times), otherwise it stops and reports. A shallow clone without the registered commit fetches the
// history of main once before the frozen check (first run C, 2026-10-28: `bad revision`).
import { execFileSync } from 'node:child_process';
import { FROZEN } from './provenance.js';

export const REGISTERED = '53c88f5';
export const ALLOWED_PATHS = [
  'data/games/2026-27/',
  'data/schedule/2026-27.json',
  'data/checks/2026-27.json',
  'data/checks/unknown-play-types-2026-27.json',
  'data/excluded_games.json',
  'data/injury-pdf/2026-27/',
  'data/predictions/2026-27/',
  'data/runs/2026-27/',
  'data/picklog/log.jsonl',
  'data/live/anchor.json',
  'docs/daily/2026-27/',
];
export const allowed = path => ALLOWED_PATHS.some(a => (a.endsWith('/') ? path.startsWith(a) : path === a));

// `git status --porcelain=v1 -uall` lines -> paths (both sides of a rename)
export function statusPaths(text) {
  return text.split('\n').filter(Boolean).flatMap(l => l.slice(3).split(' -> ')).map(p => p.replace(/^"|"$/g, ''));
}

// `git diff --name-status <registered> [HEAD] -- <frozen>` lines: anything but an added file is a change
export function frozenProblems(text) {
  return text.split('\n').filter(Boolean).map(l => l.split('\t')).filter(([s]) => s !== 'A').map(([s, ...p]) => `${s} ${p.join(' -> ')}`);
}

export const PUSH_ARGS = ['push', 'origin', 'HEAD:refs/heads/main'];
export const assertNoForce = args => {
  if (args.some(a => /^(-f|--force.*|--mirror|--delete|-d)$/.test(a) || /^\+/.test(a))) throw new Error(`refused git arguments: ${args.join(' ')}`);
  return args;
};

const sh = (args, opts = {}) => execFileSync('git', assertNoForce(args), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });

// true when the registered commit is in this clone, after one unshallow fetch if it was not
export function ensureRegistered(git = sh) {
  const has = () => { try { git(['cat-file', '-e', `${REGISTERED}^{commit}`]); return true; } catch { return false; } };
  if (has()) return true;
  try { git(['fetch', '-q', '--unshallow', 'origin', 'main']); } catch {}
  return has();
}

export function check(git = sh) {
  if (!ensureRegistered(git)) return { paths: [], outside: [], frozen: [], ok: false, missing: `registered commit ${REGISTERED} not found after fetching the history` };
  const paths = statusPaths(git(['status', '--porcelain=v1', '-uall']));
  const outside = paths.filter(p => !allowed(p));
  const frozen = [...frozenProblems(git(['diff', '--name-status', REGISTERED, '--', ...FROZEN])), ...frozenProblems(git(['diff', '--name-status', REGISTERED, 'HEAD', '--', ...FROZEN]))];
  return { paths, outside, frozen: [...new Set(frozen)], ok: !outside.length && !frozen.length };
}

// commit the allowed changes and push to main; returns { ok, committed, pushed, attempts, reason?, commit? }
export function commitAndPush(message, { git = sh, attempts = 3 } = {}) {
  const c = check(git);
  if (c.missing) return { ok: false, reason: c.missing };
  if (c.outside.length) return { ok: false, reason: 'paths outside the allowed list', paths: c.outside };
  if (c.frozen.length) return { ok: false, reason: `frozen files differ from ${REGISTERED}`, paths: c.frozen };
  if (c.paths.length) {
    git(['add', '-A', '--', ...new Set(c.paths)]);
    git(['commit', '-q', '-m', message]);
  }
  const ahead = +git(['rev-list', '--count', 'origin/main..HEAD']).trim();
  if (!ahead) return { ok: true, committed: !!c.paths.length, pushed: false, attempts: 0, commit: git(['rev-parse', 'HEAD']).trim() };
  for (let i = 1; i <= attempts; i++) {
    try { git(PUSH_ARGS); return { ok: true, committed: !!c.paths.length, pushed: true, attempts: i, commit: git(['rev-parse', 'HEAD']).trim() }; } catch (e) {
      if (i === attempts) return { ok: false, reason: `push failed ${attempts} times: ${String(e.stderr ?? e.message).trim().split('\n').at(-1)}`, attempts: i };
      git(['fetch', '-q', 'origin', 'main']);
      try { git(['rebase', '-q', 'origin/main']); } catch (r) {
        try { git(['rebase', '--abort']); } catch {}
        return { ok: false, reason: `main moved and the run's commits do not apply on it: ${String(r.stderr ?? r.message).trim().split('\n').at(-1)}`, attempts: i };
      }
      const again = check(git);
      if (!again.ok) return { ok: false, reason: `after fetching main: ${again.missing ?? (again.outside.length ? 'paths outside the allowed list' : `frozen files differ from ${REGISTERED}`)}`, paths: [...again.outside, ...again.frozen], attempts: i };
    }
  }
  return { ok: false, reason: 'unreachable' };
}
