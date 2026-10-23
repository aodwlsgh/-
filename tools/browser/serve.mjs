// Local server for the dashboard browser tests (P8). Serves the repository files at the paths the artifact publishes
// them under, wraps dashboard/index.html in the skeleton the Artifact publish adds, and answers
// data/live/today.json (and anchor.json) with the day the test chooses. Nothing here is published.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8' };
const ALLOWED = /^\/(?:(?:engine|engine\/schema|dashboard|test\/helpers)\/[\w.-]+\.js|data\/model\/calibration\.json|data\/live\/model-status\.json)$/;

export const skeleton = body => '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">'
  + '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>'
  + `</head><body>${body}</body></html>`;

export async function serve({ day, anchor = null }) {
  const server = createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://local').pathname);
    const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    try {
      if (p === '/' || p === '/index.html') return send(TYPES['.html'], skeleton(await readFile(join(ROOT, 'dashboard/index.html'), 'utf8')));
      if (p === '/data/live/today.json') return send(TYPES['.json'], JSON.stringify(day));
      if (p === '/data/live/anchor.json') return send(TYPES['.json'], JSON.stringify(anchor)); // null until the first daily git commit (P9)
      if (!ALLOWED.test(p)) { res.writeHead(404); return res.end(); }
      send(TYPES[extname(p)], await readFile(join(ROOT, p)));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/`, close: () => new Promise(r => server.close(r)) };
}
