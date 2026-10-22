// Node-only gzip JSON cache for collector responses (raw responses stay in the session; design D2).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export function fsCache(dir = '.cache/raw') {
  const path = key => join(dir, `${key}.json.gz`);
  return {
    async get(key) {
      try { return JSON.parse(gunzipSync(await readFile(path(key)))); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
    },
    async set(key, value) {
      await mkdir(dirname(path(key)), { recursive: true });
      await writeFile(path(key), gzipSync(JSON.stringify(value)));
    },
  };
}
