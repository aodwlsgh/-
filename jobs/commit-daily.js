// Commit and push the daily run's files (P9; guard in jobs/lib/commit-guard.js, list in docs/daily-run.md).
// Usage: node jobs/commit-daily.js "<message>"   -> JSON result; exit 1 when nothing could be committed or pushed
import { commitAndPush, check } from './lib/commit-guard.js';

const message = process.argv[2];
if (!message) { console.error('usage: node jobs/commit-daily.js "<message>"'); process.exit(2); }
if (process.argv.includes('--check')) { console.log(JSON.stringify(check(), null, 1)); process.exit(0); }
const r = commitAndPush(message);
console.log(JSON.stringify(r, null, 1));
process.exit(r.ok ? 0 : 1);
