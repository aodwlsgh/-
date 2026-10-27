// Shared browser setup for the dashboard tests and the timing run (P8): Chromium from /opt/pw-browsers, the fake
// artifact database injected as window.claude (owner by default), Google Fonts requests refused (offline tests).
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { serve } from './serve.mjs';
import { stamp } from '../../engine/clock.js';
import { etParts, fromEt } from '../../engine/time.js';

export const EXE = process.env.CHROMIUM ?? '/opt/pw-browsers/chromium';
export const example = JSON.parse(await readFile(new URL('../../data/live/example-day.json', import.meta.url), 'utf8'));

// test-only live day: the example predictions moved to the next ET evening at least 2 h away, tip-offs from 19:00 ET
// 8 minutes apart (all group A, so odds due 10 minutes before tip-off are evaluated by run A; never published)
export function liveDay(now = Date.now()) {
  const d = structuredClone(example);
  d.kind = 'live';
  delete d.exampleNote;
  delete d.season;
  d.run = 'A';
  let date = etParts(new Date(now)).date;
  if (fromEt(date, 19, 0).getTime() < now + 2 * 3600e3) date = etParts(new Date(fromEt(date, 19, 0).getTime() + 86400e3)).date;
  d.date = date;
  d.generatedAt = stamp(now);
  d.games.forEach((g, i) => {
    const t = fromEt(date, 19, 0).getTime() + i * 8 * 60e3, et = etParts(new Date(t));
    g.start = { ...stamp(t), et: `${et.date} ${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')} ET` };
    g.group = 'A';
    g.prediction = { ...g.prediction, run: 'A', final: true, runId: `test-live-${d.date}` };
  });
  return d;
}

export async function launch() { return chromium.launch({ executablePath: EXE, headless: true }); }

// every opened page and server, closed by the tests' after() even when a test fails halfway
const opened = new Set();
export async function closeAll() { for (const c of [...opened]) await c(); }

export async function open(browser, { day = example, anchor = null, owner = true, viewport = { width: 1280, height: 900 } } = {}) {
  const srv = await serve({ day, anchor });
  const page = await browser.newPage({ viewport });
  const close = async () => { if (!opened.delete(close)) return; await page.close().catch(() => {}); await srv.close(); };
  opened.add(close);
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)/.test(m.text()) && !/ERR_FAILED|net::/.test(m.text())) errors.push(m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await page.addInitScript(isOwner => {
    let dbP = null;
    window.claude = {
      use: async name => {
        if (name === 'db') { dbP ??= import('/test/helpers/fake-db.js').then(m => (window.__db = m.fakeDb())); return dbP; }
        if (name === 'user') return { isOwner: async () => isOwner, canEdit: async () => isOwner, can: async () => isOwner, id: async () => 'u_test' };
        return null;
      },
    };
  }, owner);
  await page.goto(srv.url);
  await page.waitForFunction(() => window.__dash?.day && window.__dash.chainKnown);
  return { page, errors, close };
}

export const tab = (page, name) => page.click(`#t-${name}`);
