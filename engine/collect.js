// Data collection (design §5). fetch, cache and clock are injected so the same code runs
// in Node jobs, tests and (without a cache) the browser. Every ESPN response is schema-checked.
import { assertValid } from './schema/espn.js';
import { etParts } from './time.js';

export const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
export const INJURY_PDF_BASE = 'https://ak-static.cms.nba.com/referee/injury';
// from 2025-12-22: "_hh_mmAM" every 15 minutes; before that: "_hhAM" hourly (probed 2026-10-22)
export const PDF_15MIN_FROM = '2025-12-22';

export class FetchError extends Error {
  constructor(url, detail) { super(`fetch failed ${url}: ${detail}`); this.name = 'FetchError'; this.url = url; }
}
export class DomainBlockedError extends Error {
  constructor(host, detail) {
    super(`domain blocked: ${host} (${detail}). Allow it in the environment network settings, or the host refuses this IP.`);
    this.name = 'DomainBlockedError';
    this.host = host;
  }
}

export function injuryPdfName({ date, hour, minute }) {
  const ampm = hour < 12 ? 'AM' : 'PM';
  const h12 = String(hour % 12 === 0 ? 12 : hour % 12).padStart(2, '0');
  const tail = date >= PDF_15MIN_FROM ? `${h12}_${String(minute).padStart(2, '0')}${ampm}` : `${h12}${ampm}`;
  return `Injury-Report_${date}_${tail}.pdf`;
}

export function createCollector({
  fetch = globalThis.fetch, cache = null, sleep = ms => new Promise(r => setTimeout(r, ms)),
  now = () => Date.now(), perSecond = 2, retries = 3,
} = {}) {
  const gap = 1000 / perSecond;
  let nextAt = 0;

  async function throttle() {
    const t = now();
    if (t < nextAt) await sleep(nextAt - t);
    nextAt = Math.max(t, nextAt) + gap;
  }

  // returns the Response for 2xx, or for 4xx when allow4xx; throws otherwise
  async function request(url, { allow4xx = false } = {}) {
    const host = new URL(url).host;
    for (let attempt = 0; ; attempt++) {
      await throttle();
      let r;
      try {
        r = await fetch(url);
      } catch (e) {
        const msg = String(e.cause?.message ?? e.message);
        if (/403|tunnel|Forbidden/i.test(msg)) throw new DomainBlockedError(host, msg);
        if (attempt >= retries) throw new FetchError(url, msg);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (r.ok) return r;
      const type = r.headers.get('content-type') ?? '';
      if (r.status === 403 && type.includes('text/html')) {
        const body = await r.text();
        if (/Access Denied/i.test(body)) throw new DomainBlockedError(host, 'HTTP 403 Access Denied');
      }
      if (r.status >= 500 || r.status === 429) {
        if (attempt >= retries) throw new FetchError(url, `HTTP ${r.status} after ${retries} retries`);
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      if (allow4xx) return r;
      throw new FetchError(url, `HTTP ${r.status}`);
    }
  }

  async function espn(kind, path) {
    return assertValid(kind, await (await request(`${ESPN_BASE}/${path}`)).json());
  }

  return {
    // date: YYYYMMDD (US date). Cached once every game that day is final.
    async schedule(date) {
      const key = `espn/scoreboard_${date}`;
      const hit = await cache?.get(key);
      if (hit) return hit;
      const sb = await espn('scoreboard', `scoreboard?dates=${date}`);
      if (sb.events.length && sb.events.every(e => e.competitions[0].status.type.name === 'STATUS_FINAL')) await cache?.set(key, sb);
      return sb;
    },
    // ESPN event id; cached once final
    // ESPN event id; the raw response is cached once final, before validation, so a schema
    // mismatch never forces a refetch. Cached copies are validated on every read.
    async game(espnId) {
      const key = `espn/summary_${espnId}`;
      const hit = await cache?.get(key);
      if (hit) return assertValid('summary', hit);
      const s = await (await request(`${ESPN_BASE}/summary?event=${espnId}`)).json();
      if (s?.header?.competitions?.[0]?.status?.type?.completed) await cache?.set(key, s);
      return assertValid('summary', s);
    },
    injuries: () => espn('injuries', 'injuries'),
    // newest NBA injury PDF at or before `at`, searching back in 15-minute ET steps
    async latestInjuryPdf(at, { maxSteps = 96 } = {}) {
      let t = new Date(Math.floor(at.getTime() / 900e3) * 900e3);
      for (let i = 0; i < maxSteps; i++, t = new Date(t.getTime() - 900e3)) {
        const et = etParts(t);
        if (et.date < PDF_15MIN_FROM && et.minute !== 0) continue;
        const name = injuryPdfName(et);
        const r = await request(`${INJURY_PDF_BASE}/${name}`, { allow4xx: true });
        if (r.ok && (r.headers.get('content-type') ?? '').includes('pdf')) {
          return { name, et, bytes: new Uint8Array(await r.arrayBuffer()) };
        }
      }
      return null;
    },
  };
}
