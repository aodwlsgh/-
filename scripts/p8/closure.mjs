// Files the dashboard loads in the browser (P8): the static import closure of dashboard/app.js and
// dashboard/worker.js. Used for the publish file list and checked for Node-only imports.
// CLI: node scripts/p8/closure.mjs
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function closure(entries = ['dashboard/app.js', 'dashboard/worker.js']) {
  const seen = new Set(), problems = [];
  const visit = async f => {
    if (seen.has(f)) return;
    seen.add(f);
    const src = await readFile(f, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (!spec.startsWith('.')) { problems.push(`${f}: non-relative import ${spec}`); continue; }
      await visit(normalize(join(dirname(f), spec)));
    }
  };
  for (const e of entries) await visit(e);
  return { files: [...seen].sort(), problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const c = await closure();
  console.log(JSON.stringify(c, null, 1));
  if (c.problems.length) process.exit(1);
}
