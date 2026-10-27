// Dashboard (P8, design §11.1). Reads the day file the daily job publishes (data/live/today.json), re-runs
// scenarios in a Web Worker, keeps the pick log in the artifact database (engine/log-store.js) and shows it.
// On-screen rules (2026-10-23 user conditions): the pick log is only appended to (no edit or delete controls), the
// chain check is always in the header, every pick and EV carries "기록 전용 — 구매 비권장" (example data: "예시"),
// scenario results are "미검증" (back-to-back also "근사") and never reach the pick and EV columns, the exit
// progress never reads as a release, Korean team names are "미확인", integer lines "미지원(픽 제외)".
// P9 (2026-10-23 approval): odds go through a confirmation screen (the first entry of a market fixes it, later ones
// are odds only), overround outside 1.00-1.30 warns without blocking, no odds reads "배당 미입력" (never "오늘은
// 패스"), write failures stay on screen with their reason and are noted in the database outside the chain,
// 2-folds are a record table outside the exit conditions, provisional predictions and the ESPN+PDF parallel record
// are labelled and never priced.
import {
  TEXT, validateDay, gameView, scenarioView, sensitivityBadges, chainText, anchorCheck, exitView,
} from '../engine/dashboard-data.js';
import { pageStore, readChain, appendAsPage, HEAD_PATH } from '../engine/log-store.js';
import { roundRecords } from '../engine/log-records.js';
import { summarize, purchaseRecord } from '../engine/pick-log.js';
import { inFirstMonth, settle, SEASON_OPENING, FIRST_MONTH } from '../engine/picks.js';
import { SELECTIONS } from '../engine/odds.js';
import { MARGIN_T, marginSurvival } from '../engine/calibrate.js';
import { seasonOf } from '../engine/model.js';
import { classifyInput, gameStatuses, dayStatus, oddsMovement, comboTable } from '../engine/day-status.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const sgn = (x, d = 1) => (x == null ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${Math.abs(x).toFixed(d)}`);
const fx = (x, d = 2) => (x == null ? '—' : x.toFixed(d));
const hm = kst => (kst ? `${kst.slice(5, 10)} ${kst.slice(11, 16)}` : '—');
const store = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } return null; };

const TABS = ['today', 'detail', 'odds', 'record', 'model'];
const MARKET_KO = { ML: '승패', ML5: '승5패', HC: '핸디캡', OU: '언더오버' };
const SEL_KO = { home: '홈', away: '원정', close: '5점 이내', over: '오버', under: '언더' };
const REASON_KO = {
  busy: '다른 탭이 기록하고 있습니다. 30초 뒤 다시 시도하세요.',
  'lease expired': '저장 시간이 초과되어 중간에 멈췄습니다. 픽 로그 상태를 확인하세요.',
  'lease lost': '다른 탭이 기록 권한을 가져갔습니다. 다시 시도하세요.',
  conflict: '체인 저장 충돌 — 확인 필요. 기록하지 않았습니다.',
  'head mismatch': '머리 문서와 마지막 블록이 맞지 않습니다 — 확인 필요. 기록하지 않았습니다.',
};
const NOTE_KO = { 'already fixed': '이미 확정된 마켓이라 배당만 기록했습니다', 'awaiting the final prediction': '실행 B 예측 전이라 배당만 기록했습니다(실행 B가 평가)', 'after the deadline': '마감이 지나 배당만 기록했습니다' };

const S = {
  day: null, cal: null, status: null, anchor: null, db: null, store: null, owner: false, dbState: 'connecting',
  chain: { records: [], verify: { ok: true, problems: [] }, head: null, orphans: [] }, chainKnown: false,
  tab: 'today', gi: 0, scen: new Map(), running: false, runs: null, msg: null, pending: null, fail: null, retry: null, clearForm: false,
  tabId: `tab-${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`,
};
window.__dash = S; // read by the browser tests (tools/browser)

async function getJson(path, optional = false) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) { if (optional) return null; throw new Error(`${path}: HTTP ${r.status}`); }
  return r.json();
}

// ------------------------------------------------------------------ boot ------------------------------------------
async function boot() {
  try {
    const [day, cal, status, anchor] = await Promise.all([
      getJson('data/live/today.json'), getJson('data/model/calibration.json'), getJson('data/live/model-status.json', true), getJson('data/live/anchor.json', true),
    ]);
    const errs = validateDay(day);
    if (errs.length) throw new Error(`오늘 데이터 형식 오류: ${errs.join('; ')}`);
    Object.assign(S, { day, cal: cal.calibration, status, anchor });
  } catch (e) {
    $('#today').innerHTML = `<div class="msg bad">${esc(e.message)}</div>`;
    $('#sub').textContent = '데이터 없음';
    return;
  }
  const want = (location.hash || '').slice(1);
  S.tab = TABS.includes(want) ? want : TABS.includes(store('tab')) ? store('tab') : 'today';
  for (const b of $$('.tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));
  renderAll();
  connect();
}

async function connect() {
  const c = window.claude;
  if (!c?.use) { S.dbState = 'none'; renderHeader(); renderTab(); return; }
  const [db, user] = await Promise.all([c.use('db').catch(() => null), c.use('user').catch(() => null)]);
  S.db = db;
  S.owner = user ? await user.isOwner().catch(() => false) : false;
  if (!db) { S.dbState = 'none'; renderHeader(); renderTab(); return; }
  S.store = pageStore(db);
  S.dbState = 'ok';
  await refreshChain();
  let t = null;
  db.doc(HEAD_PATH).onSnapshot(() => { clearTimeout(t); t = setTimeout(refreshChain, 300); }, () => {});
}

const chainKey = c => `${c.records.length}|${c.records.at(-1)?.hash ?? ''}|${c.verify.ok}|${c.orphans.length}|${c.head?.leaseHolder ?? ''}`;
async function refreshChain() {
  const before = S.chainKnown ? chainKey(S.chain) : null;
  try {
    S.chain = await readChain(S.store);
    S.chainKnown = true;
  } catch (e) {
    S.dbState = 'error';
    S.msg = { bad: true, text: `픽 로그를 읽지 못했습니다: ${e.message ?? e.code ?? e}` };
  }
  renderHeader();
  // re-render only when the chain changed (the head snapshot also fires for nothing new)
  if (['odds', 'record', 'model'].includes(S.tab) && (S.dbState !== 'ok' || before !== chainKey(S.chain))) renderTab();
}

function setTab(t) {
  S.tab = t;
  store('tab', t);
  try { history.replaceState(null, '', `#${t}`); } catch { /* the viewer may refuse */ }
  renderTab();
}

// ------------------------------------------------------------------ header and bands ------------------------------
function renderAll() { renderHeader(); renderBands(); renderTab(); }

function renderHeader() {
  const d = S.day;
  $('#sub').textContent = `${d.date} (ET) · ${d.kind === 'example' ? '예시 데이터' : `실행 ${d.run ?? '—'}`} · 생성 ${hm(d.generatedAt?.kst)} KST`;
  const chip = $('#chain'), anchor = $('#anchor');
  chip.className = 'chip';
  if (S.dbState === 'none') { chip.textContent = '픽 로그: DB 연결 없음(이 화면에서 읽을 수 없음)'; chip.dataset.state = 'none'; anchor.textContent = ''; return; }
  if (S.dbState === 'error') { chip.classList.add('bad'); chip.textContent = '픽 로그: 읽기 실패'; chip.dataset.state = 'error'; return; }
  if (!S.chainKnown) { chip.textContent = '픽 로그: 확인 중'; chip.dataset.state = 'unknown'; return; }
  const t = chainText(S.chain);
  chip.classList.add(t.ok ? 'ok' : 'bad');
  chip.dataset.state = t.ok ? 'ok' : 'broken';
  chip.textContent = `체인 검증: ${t.text}`;
  const a = anchorCheck(S.chain.records, S.anchor);
  anchor.textContent = a.text;
  anchor.dataset.state = a.status;
}

function renderBands() {
  const d = S.day;
  $('#exBand').hidden = d.kind !== 'example';
  $('#exText').textContent = TEXT.example;
  $('#roText').textContent = TEXT.recordOnly;
  const why = ['기록 전용 기간(설계 §9.4): 해제 조건을 모두 채우고 사용자가 승인하기 전까지 구매 판단에 쓰지 않습니다.'];
  if (d.kind === 'live' && inFirstMonth(d.date)) {
    const s = seasonOf(d.date), open = SEASON_OPENING[s];
    const end = new Date(Date.parse(open) + FIRST_MONTH.days * 86400e3).toISOString().slice(0, 10);
    why.push(`${s} 시즌 첫 한 달(${open}~${end})은 시장과 관계없이 기록 전용입니다.`);
  }
  $('#roWhy').textContent = why.join(' ');
  renderAlerts();
}

function renderAlerts() {
  // a warning also seen in the comparable earlier run (jobs/daily.js escalate) leads the list and the header chip
  const al = S.day.alerts ?? [], again = al.filter(a => a.escalated);
  const items = [...again.map(a => `${a.streak}${TEXT.escalated} — ${a.text}`), ...al.filter(a => !a.escalated).map(a => a.text), ...(S.fail ? [S.fail.text] : [])];
  $('#escChip').hidden = !again.length;
  $('#escChip').textContent = again.length ? `${TEXT.escalatedChip} ${again.length}건` : '';
  $('#alertBand').hidden = !items.length;
  $('#alertList').innerHTML = items.map(x => `<li>${esc(x)}</li>`).join('');
}

function renderTab() {
  for (const t of TABS) { $(`#${t}`).hidden = t !== S.tab; $(`#t-${t}`).setAttribute('aria-selected', String(t === S.tab)); }
  ({ today: renderToday, detail: renderDetail, odds: renderOdds, record: renderRecord, model: renderModel })[S.tab]();
}

// ------------------------------------------------------------------ shared bits -----------------------------------
const isEx = () => S.day.kind === 'example';
const exTag = () => (isEx() ? ` <span class="badge ex">${TEXT.exampleCell}</span>` : '');
const roBadge = (lg = false) => `<span class="badge record${lg ? ' lg' : ''}">${TEXT.recordOnly}</span>`;
const teamName = t => `${esc(t.espn)} <span class="ko">${esc(t.ko)}</span>${t.koVerified ? '' : ` <span class="badge unc" title="베트맨 표기는 첫 실제 캡처에서 확인합니다">${TEXT.unconfirmed}</span>`}`;
const matchup = g => `${teamName(g.away)} @ ${teamName(g.home)}`;
const gameById = id => S.day.games.find(g => g.gameId === id);
const shortGame = id => { const g = gameById(id); return g ? `${g.away.espn}@${g.home.espn}` : esc(id); };
const canWrite = () => S.day.kind === 'live' && S.dbState === 'ok' && S.owner && S.chainKnown && S.chain.verify.ok;
const writeBlock = () => (isEx() ? TEXT.exampleLocked
  : S.dbState !== 'ok' ? '픽 로그 DB에 연결되지 않아 기록할 수 없습니다'
    : !S.owner ? '기록은 소유자만 할 수 있습니다(읽기 전용)'
      : !S.chainKnown ? '픽 로그 확인 중입니다' : !S.chain.verify.ok ? '체인 검증이 실패해서 기록을 멈췄습니다' : null);
const msgHtml = () => (S.msg ? `<div class="msg${S.msg.bad ? ' bad' : ''}" role="status">${esc(S.msg.text)}</div>` : '');

// ------------------------------------------------------------------ today ------------------------------------------
function renderToday() {
  const d = S.day;
  const gs = gameStatuses({ day: d, chain: S.chain.records, now: new Date() });
  const rows = d.games.map(g => {
    const v = gameView(g, S.cal), st = g.dataStatus ?? {};
    const inj = st.injurySnapshot ? ['home', 'away'].map(k => st.injurySnapshot[k]).filter(Boolean) : [];
    const unmatched = inj.flatMap(x => x.unmatched ?? []).length, absent = inj.reduce((a, x) => a + (x.top3Absent ?? 0), 0);
    const status = [`실행 ${esc(st.run ?? g.group)}`, st.injurySnapshot ? `부상 리포트 반영${absent ? `, 상위 3인 결장 ${absent}` : ''}${unmatched ? `, 이름 미매칭 ${unmatched}` : ''}` : '부상 리포트 없음'];
    if (!isEx() && g.prediction.final === false) status.unshift(`<span class="badge unv" data-prov>${TEXT.provisional}</span>`);
    if (g.parallel) status.push(`<span data-par>${TEXT.parallel}: ${g.parallel.same ? '차이 없음' : `차이 ${g.parallel.diffs.length}명(${g.parallel.diffs.slice(0, 3).map(x => esc(x.name)).join(', ')}), 홈 승률 ${pct(g.parallel.winProbHome)}`}</span>`);
    if (!isEx()) status.push(`<strong data-status>${esc(gs.get(g.gameId)?.text ?? '')}</strong>`);
    return `<tr data-game="${esc(g.gameId)}">
      <td class="n">${hm(g.start.kst)}<div class="note">${esc(g.start.et?.slice(11) ?? '')}</div></td>
      <td>${matchup(g)} <button class="btn ghost" data-open="${esc(g.gameId)}" style="padding:2px 8px;font-size:12px">상세</button></td>
      <td class="n">${pct(v.winProbHome)}${exTag()}</td>
      <td class="n">${sgn(v.margin)}<div class="note">[${sgn(v.interval90.margin[0], 0)}, ${sgn(v.interval90.margin[1], 0)}]</div></td>
      <td class="n">${fx(v.total, 1)}<div class="note">[${fx(v.interval90.total[0], 0)}, ${fx(v.interval90.total[1], 0)}]</div></td>
      <td class="note">${status.join(' · ')}</td></tr>`;
  }).join('');
  $('#today').innerHTML = `
    <div class="card"><header><h2>오늘 경기 ${d.games.length}개</h2>${exTag()}<span class="note">시각은 KST, 아래는 ET. 승률은 보정층을 거친 기본 예측, 점수 차는 홈 기준 앙상블 위치, 괄호는 90% 구간(시뮬레이션 분포).</span></header>
    <div class="tbl"><table><thead><tr><th class="n">시작(KST)</th><th>경기(원정 @ 홈)</th><th class="n">홈 승률</th><th class="n">예상 점수 차</th><th class="n">예상 총점</th><th>데이터 상태</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  for (const b of $$('#today [data-open]')) b.addEventListener('click', () => { S.gi = d.games.findIndex(g => g.gameId === b.dataset.open); setTab('detail'); });
}

// ------------------------------------------------------------------ detail -----------------------------------------
let worker = null, runSeq = 0;
function getWorker() {
  if (!worker) worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  return worker;
}
function simulate(payload) {
  return new Promise((resolve, reject) => {
    const id = ++runSeq, w = getWorker();
    const on = ({ data }) => { if (data.id !== id) return; w.removeEventListener('message', on); data.ok ? resolve(data) : reject(new Error(data.error)); };
    w.addEventListener('message', on);
    w.postMessage({ id, ...payload });
  });
}

function playersOf(g, side) {
  const plan = side ? g.simInput.awayPlan : g.simInput.homePlan;
  return [...plan.players].filter(p => p.expMin > 0 || p.playProb === 0).sort((a, b) => b.expMin - a.expMin);
}

function sensLabel(g, v) {
  const [kind, a, b] = String(v.key).split(':');
  const name = id => esc(g.names?.[id] ?? id);
  const abbrOf = tid => (tid === g.simInput.home ? g.home.espn : tid === g.simInput.away ? g.away.espn : tid);
  const sideOfPlayer = id => (g.simInput.homePlan.players.some(p => p.playerId === id) ? g.home.espn : g.away.espn);
  switch (kind) {
    case 'out': return `${sideOfPlayer(a)} ${name(a)} 결장`;
    case 'cap': return `${sideOfPlayer(a)} ${name(a)} 출전 시간 −20%`;
    case 'fg3': return `${abbrOf(a)} 3점 성공률 ${+b > 0 ? '+' : '−'}2%p`;
    case 'b2b': { const plan = a === g.simInput.home ? g.simInput.homePlan : g.simInput.awayPlan; return `${abbrOf(a)} 백투백 ${plan.b2b ? '끔' : '켬'}`; }
    case 'pace': return `경기 속도 ${+a > 0 ? '+' : '−'}3 공격권`;
    default: return esc(v.label);
  }
}
const badgesHtml = bs => bs.map(b => `<span class="badge ${b === TEXT.approx ? 'apx' : 'unv'}">${b}</span>`).join(' ');

function renderDetail() {
  const d = S.day, g = d.games[S.gi] ?? d.games[0], v = gameView(g, S.cal), be = g.breakeven;
  const sc = S.scen.get(g.gameId);
  const opts = d.games.map((x, i) => `<option value="${i}"${i === S.gi ? ' selected' : ''}>${esc(x.away.espn)} @ ${esc(x.home.espn)} · ${hm(x.start.kst)} KST</option>`).join('');
  const sens = g.sensitivity;
  const sensRows = (list, key) => (list ?? []).map(x => `<tr><td>${sensLabel(g, x)} ${badgesHtml(sensitivityBadges(x))}</td><td class="n">${sgn(x[key], 2)}</td></tr>`).join('');
  const beRow = (label, r, attr = '') => `<tr${attr}><td>${label}</td><td class="n">${pct(r.p)}</td><td class="n">${pct(r.pCons)}</td><td class="n">${fx(r.minOdds)}${exTag()}</td></tr>`;
  const playerRows = side => playersOf(g, side).map(p => {
    const id = esc(p.playerId);
    return `<tr><td>${esc(g.names?.[p.playerId] ?? p.playerId)}${p.starter ? ' <span class="note">선발</span>' : ''}</td><td class="n">${fx(p.expMin, 1)}</td>
      <td><input type="number" id="pp-${id}" data-pid="${id}" class="v-pp" min="0" max="1" step="0.05" value="${+p.playProb.toFixed(2)}" aria-label="출전 확률"></td>
      <td><input type="checkbox" id="po-${id}" data-pid="${id}" class="v-po" aria-label="결장"></td>
      <td><input type="number" id="cap-${id}" data-pid="${id}" class="v-cap" min="0" max="48" step="1" placeholder="—" aria-label="출전 시간 제한"></td></tr>`;
  }).join('');
  const teamVars = side => {
    const t = side ? g.away : g.home, plan = side ? g.simInput.awayPlan : g.simInput.homePlan, k = side ? 'away' : 'home';
    return `<div class="row"><strong>${esc(t.espn)}</strong>
      <label class="f">3점 %p<input type="number" id="fg3-${k}" class="sm" min="-10" max="10" step="0.5" value="0"></label>
      <label class="f">2점 %p<input type="number" id="fg2-${k}" class="sm" min="-10" max="10" step="0.5" value="0"></label>
      <label class="f">백투백 <span><input type="checkbox" id="b2b-${k}"${plan.b2b ? ' checked' : ''}> ${plan.b2b ? '기본 켬' : '기본 끔'} <span class="badge apx">${TEXT.approx}</span></span></label></div>`;
  };
  $('#detail').innerHTML = `
    <div class="card"><div class="picker"><label class="f">경기<select id="gsel">${opts}</select></label><span>${matchup(g)}</span>${exTag()}</div></div>
    <div class="grid2">
      <div class="card"><header><h2>기본 예측</h2>${exTag()}<span class="note">실행 ${esc(g.prediction.run)} · ${esc(g.prediction.runId)}</span></header>
        <div class="kpis">
          <div class="kpi"><b>${pct(v.winProbHome)}</b><span>${esc(g.home.espn)} 승률(보정)</span></div>
          <div class="kpi"><b>${sgn(v.margin)}</b><span>점수 차, 90% [${sgn(v.interval90.margin[0], 0)}, ${sgn(v.interval90.margin[1], 0)}]</span></div>
          <div class="kpi"><b>${fx(v.total, 1)}</b><span>총점, 90% [${fx(v.interval90.total[0], 0)}, ${fx(v.interval90.total[1], 0)}]</span></div>
        </div>
        <div id="chM" class="chart" style="margin-top:12px"></div>
        <div id="chT" class="chart" style="margin-top:8px"></div>
        <details><summary>분포 표로 보기</summary><div class="tbl" id="survTbl"></div></details>
      </div>
      <div class="card"><header><h2>변수 패널</h2><span class="badge unv">${TEXT.unverified}</span><span class="note">결과는 아래 시나리오 칸에만 표시되고 배당·픽 계산에는 쓰이지 않습니다.</span></header>
        <div class="form">
          ${teamVars(0)}${teamVars(1)}
          <div class="row"><label class="f">경기 속도(공격권 ±)<input type="number" id="pace" class="sm" min="-10" max="10" step="1" value="0"></label>
            <label class="f">가비지 타임 <span><input type="checkbox" id="rule-garbage" checked> 켬</span></label>
            <label class="f">클러치 파울 <span><input type="checkbox" id="rule-clutch" checked> 켬</span></label></div>
          <details><summary>선수별 출전 확률·결장·출전 시간 제한</summary>
            <div class="tbl players"><table><thead><tr><th>${esc(g.home.espn)}</th><th class="n">예상 분</th><th>출전 확률</th><th>결장</th><th>분 제한</th></tr></thead><tbody>${playerRows(0)}</tbody></table>
            <table><thead><tr><th>${esc(g.away.espn)}</th><th class="n">예상 분</th><th>출전 확률</th><th>결장</th><th>분 제한</th></tr></thead><tbody>${playerRows(1)}</tbody></table></div></details>
          <div class="row"><button class="btn" id="rerun"${S.running ? ' disabled' : ''}>다시 돌리기(1만 회)</button><span class="note" id="runInfo">${sc ? `${(sc.clickMs / 1000).toFixed(2)}초 (시뮬레이션 ${(sc.ms / 1000).toFixed(2)}초)` : ''}</span></div>
          <div class="scen" id="scenOut" data-runs="${sc?.count ?? 0}">${sc ? scenHtml(sc) : '<span class="note">변수를 바꾸고 다시 돌리면 시나리오 결과가 여기에 나옵니다.</span>'}</div>
        </div>
      </div>
    </div>
    <div class="grid2">
      <div class="card"><header><h2>손익분기표</h2>${exTag()}<span class="note">최소 필요 배당 = 1.03 / p_cons. 기본 예측만 씁니다.</span></header>
        <div class="tbl"><table><thead><tr><th>선택</th><th class="n">p</th><th class="n">p_cons</th><th class="n">최소 배당</th></tr></thead><tbody>
          ${beRow(`승패 ${esc(g.home.espn)}`, be.ml.home)}${beRow(`승패 ${esc(g.away.espn)}`, be.ml.away)}
          ${['home', 'close', 'away'].map(k => beRow(`승5패 ${SEL_KO[k]} <span class="badge unv">${TEXT.notOffered}</span>`, be.ml5[k], ' data-ml5')).join('')}
          ${be.hc.map(h => beRow(`핸디캡 홈 ${sgn(h.line)}`, h.home) + beRow(`핸디캡 원정 ${sgn(-h.line)}`, h.away)).join('')}
          ${be.ou.map(o => beRow(`오버 ${o.line}`, o.over) + beRow(`언더 ${o.line}`, o.under)).join('')}
        </tbody></table></div><p class="note" data-ml5-note>${TEXT.ml5NotOffered}</p></div>
      <div class="card"><header><h2>민감도 상위 3</h2><span class="badge unv">${TEXT.unverified}</span><span class="note">${sens ? `한 번에 변수 하나, ${sens.n}회, 같은 시드` : '일일 작업이 계산합니다'}</span></header>
        ${sens ? `<div class="tbl"><table><thead><tr><th>변수</th><th class="n">점수 차 변화</th></tr></thead><tbody>${sensRows(sens.topMargin, 'dMargin')}</tbody></table>
        <table><thead><tr><th>변수</th><th class="n">총점 변화</th></tr></thead><tbody>${sensRows(sens.topTotal, 'dTotal')}</tbody></table></div>` : ''}
        <p class="note">자동 시나리오 "시즌 초 손발 미숙": 기본 꺼짐 <span class="badge unv">${TEXT.unverified}</span></p></div>
    </div>`;
  $('#gsel').addEventListener('change', e => { S.gi = +e.target.value; renderDetail(); });
  $('#rerun').addEventListener('click', () => rerun(g));
  if (sc) applyInputs(g, sc.scenario);
  drawCharts(g, v, sc);
  const surv = marginSurvival(S.cal, g.prediction.sim);
  $('#survTbl').innerHTML = `<table><thead><tr><th>${esc(g.home.espn)} 점수 차 &gt; t</th>${MARGIN_T.filter((_, i) => i % 5 === 0).map(t => `<th class="n">${t}</th>`).join('')}</tr></thead><tbody><tr><td>보정 확률</td>${surv.filter((_, i) => i % 5 === 0).map(p => `<td class="n">${pct(p)}</td>`).join('')}</tr></tbody></table>`;
}

function drawCharts(g, v, sc) {
  drawHist($('#chM'), { hist: g.prediction.sim.marginHist, shift: g.prediction.sim.shift ?? 0, lo: -40, hi: 40, mean: v.margin, ci: v.interval90.margin, zero: true, title: `점수 차(${g.home.espn} 기준)`, scen: sc ? { hist: sc.view.prediction.sim.marginHist, shift: sc.view.prediction.sim.shift } : null });
  const tl = Math.round(v.total / 10) * 10;
  drawHist($('#chT'), { hist: g.prediction.sim.totalHist, shift: 0, lo: tl - 50, hi: tl + 50, mean: v.total, ci: v.interval90.total, title: '총점', scen: sc ? { hist: sc.view.prediction.sim.totalHist, shift: 0 } : null });
}

// put a game's last scenario back into the variable panel (the panel is rebuilt when the game or tab changes)
function applyInputs(g, sc) {
  for (const id of sc.playerOut ?? []) { const el = document.getElementById(`po-${id}`); if (el) el.checked = true; }
  for (const [id, p] of Object.entries(sc.playProb ?? {})) { const el = document.getElementById(`pp-${id}`); if (el) el.value = p; }
  for (const [id, m] of Object.entries(sc.minutesCap ?? {})) { const el = document.getElementById(`cap-${id}`); if (el) el.value = m; }
  const side = team => (team === g.simInput.home ? 'home' : 'away');
  for (const x of sc.shootingShift ?? []) { $(`#fg3-${side(x.team)}`).value = +(x.fg3 * 100).toFixed(2); $(`#fg2-${side(x.team)}`).value = +(x.fg2 * 100).toFixed(2); }
  for (const x of sc.fatigue ?? []) $(`#b2b-${side(x.team)}`).checked = !!x.b2b;
  if (sc.paceShift) $('#pace').value = sc.paceShift;
  if (sc.rules?.garbageTime === false) $('#rule-garbage').checked = false;
  if (sc.rules?.clutchFoul === false) $('#rule-clutch').checked = false;
}

function scenHtml(sc) {
  const v = sc.view;
  return `<div class="row">${badgesHtml(v.badges)}<strong>시나리오 결과</strong><span class="note">기본 예측과 같은 시드, 앙상블 이동량 그대로</span></div>
    <div class="kpis"><div class="kpi"><b>${pct(v.winProbHome)}</b><span>홈 승률(시나리오)</span></div>
    <div class="kpi"><b>${sgn(v.margin)}</b><span>점수 차, 기본 대비 ${sgn(v.delta.margin, 2)}</span></div>
    <div class="kpi"><b>${fx(v.total, 1)}</b><span>총점, 기본 대비 ${sgn(v.delta.total, 2)}</span></div></div>
    ${sc.notes?.length ? `<div class="note">${sc.notes.map(esc).join(' · ')}</div>` : ''}`;
}

function readScenario(g) {
  const sc = { playerOut: [], playProb: {}, minutesCap: {}, shootingShift: [], fatigue: [], rules: {} };
  const plans = [...g.simInput.homePlan.players, ...g.simInput.awayPlan.players];
  for (const el of $$('#detail .v-po')) if (el.checked) sc.playerOut.push(el.dataset.pid);
  for (const el of $$('#detail .v-pp')) {
    const p = plans.find(x => x.playerId === el.dataset.pid), val = +el.value;
    if (el.value !== '' && Math.abs(val - p.playProb) > 1e-9) sc.playProb[el.dataset.pid] = Math.min(1, Math.max(0, val));
  }
  for (const el of $$('#detail .v-cap')) if (el.value !== '') sc.minutesCap[el.dataset.pid] = Math.max(0, +el.value);
  [['home', g.simInput.home, g.simInput.homePlan], ['away', g.simInput.away, g.simInput.awayPlan]].forEach(([k, team, plan]) => {
    const fg3 = +$(`#fg3-${k}`).value || 0, fg2 = +$(`#fg2-${k}`).value || 0;
    if (fg3 || fg2) sc.shootingShift.push({ team, fg3: fg3 / 100, fg2: fg2 / 100 });
    const b2b = $(`#b2b-${k}`).checked;
    if (b2b !== !!plan.b2b) sc.fatigue.push({ team, b2b });
  });
  const pace = +$('#pace').value || 0;
  if (pace) sc.paceShift = pace;
  if (!$('#rule-garbage').checked) sc.rules.garbageTime = false;
  if (!$('#rule-clutch').checked) sc.rules.clutchFoul = false;
  return sc;
}

async function rerun(g) {
  if (S.running) return;
  const t0 = performance.now();
  const scenario = readScenario(g);
  S.running = true;
  $('#rerun').disabled = true;
  $('#runInfo').textContent = '계산 중…';
  try {
    const out = await simulate({ input: g.simInput, scenario, seed: g.seed, n: 10000, rules: { garbageTime: true, clutchFoul: true, overtime: true, latent: true } });
    const prev = S.scen.get(g.gameId);
    const sc = { view: scenarioView(g, out.res, S.cal, scenario), res: out.res, notes: out.notes, ms: out.ms, count: (prev?.count ?? 0) + 1, scenario };
    S.scen.set(g.gameId, sc);
    S.running = false;
    if (S.tab === 'detail' && S.day.games[S.gi] === g) {
      $('#scenOut').innerHTML = scenHtml(sc);
      drawCharts(g, gameView(g, S.cal), sc);
      $('#rerun').disabled = false;
      sc.clickMs = performance.now() - t0;
      $('#runInfo').textContent = `${(sc.clickMs / 1000).toFixed(2)}초 (시뮬레이션 ${(out.ms / 1000).toFixed(2)}초)`;
      $('#scenOut').dataset.done = String(sc.count);
    } else sc.clickMs = performance.now() - t0;
  } catch (e) {
    S.running = false;
    $('#rerun').disabled = false;
    $('#runInfo').textContent = `실패: ${e.message}`;
  }
}

// histogram of an integer distribution, moved by `shift`; 90% interval in full colour, tails lighter;
// an optional scenario drawn as a step line. Hover shows the bin.
function drawHist(el, { hist, shift, lo, hi, mean, ci, zero = false, title, scen = null }) {
  const W = 560, H = 170, L = 36, R = 8, T = 22, B = 26;
  const x = v => L + ((v - lo) / (hi - lo)) * (W - L - R);
  const bins = [];
  for (let i = 0; i < hist.p.length; i++) { const k = hist.lo + i + shift; if (k >= lo && k <= hi) bins.push({ k, p: hist.p[i] }); }
  const sbins = scen ? scen.hist.p.map((p, i) => ({ k: scen.hist.lo + i + scen.shift, p })).filter(b => b.k >= lo && b.k <= hi) : [];
  const max = Math.max(...bins.map(b => b.p), ...sbins.map(b => b.p), 1e-9);
  const step = max > 0.04 ? 0.02 : max > 0.02 ? 0.01 : 0.005;
  const y = p => T + (1 - p / (Math.ceil(max / step) * step)) * (H - T - B);
  const bw = Math.max(1, (W - L - R) / (hi - lo) - 1);
  const grid = [];
  for (let g = step; g <= Math.ceil(max / step) * step + 1e-12; g += step) grid.push(g);
  const ticks = [];
  const tstep = hi - lo > 60 ? 20 : 10;
  for (let t = Math.ceil(lo / tstep) * tstep; t <= hi; t += tstep) ticks.push(t);
  const stepPath = sbins.map((b, i) => `${i ? 'L' : 'M'}${(x(b.k) - bw / 2 - 0.5).toFixed(1)},${y(b.p).toFixed(1)}H${(x(b.k) + bw / 2 + 0.5).toFixed(1)}`).join('');
  el.innerHTML = `<div class="legend"><span><i style="background:var(--s1)"></i>${esc(title)} · 기본 예측(진한 막대 = 90% 구간)</span>${scen ? '<span><i style="background:var(--s2)"></i>시나리오(미검증)</span>' : ''}</div>
  <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)} 분포, 평균 ${mean.toFixed(1)}, 90% 구간 ${ci[0].toFixed(0)}~${ci[1].toFixed(0)}">
    ${grid.map(gv => `<line x1="${L}" x2="${W - R}" y1="${y(gv)}" y2="${y(gv)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 4}" y="${y(gv) + 3}" text-anchor="end" font-size="10" fill="var(--muted)">${(gv * 100).toFixed(gv < 0.01 ? 1 : 0)}%</text>`).join('')}
    ${bins.map(b => `<rect x="${(x(b.k) - bw / 2).toFixed(1)}" y="${y(b.p).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, H - B - y(b.p)).toFixed(1)}" rx="1" fill="var(--s1)" fill-opacity="${b.k >= ci[0] && b.k <= ci[1] ? 0.9 : 0.35}"/>`).join('')}
    ${scen ? `<path d="${stepPath}" fill="none" stroke="var(--s2)" stroke-width="2"/>` : ''}
    <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="var(--muted)" stroke-width="1"/>
    ${zero ? `<line x1="${x(0)}" x2="${x(0)}" y1="${T - 6}" y2="${H - B}" stroke="var(--ink)" stroke-width="1" stroke-dasharray="3 3"/><text x="${x(0) + 4}" y="${T + 9}" font-size="10" fill="var(--muted)">홈 승 ▸</text>` : ''}
    <line x1="${x(mean)}" x2="${x(mean)}" y1="${T}" y2="${H - B}" stroke="var(--ink)" stroke-width="2"/>
    <text x="${x(mean)}" y="${T - 8}" font-size="10.5" fill="var(--ink)" text-anchor="${zero ? 'end' : 'middle'}" dx="${zero ? -4 : 0}">평균 ${mean.toFixed(1)}</text>
    ${ticks.map(t => `<text x="${x(t)}" y="${H - B + 15}" font-size="10" fill="var(--muted)" text-anchor="middle">${t > 0 && zero ? '+' : ''}${t}</text>`).join('')}
    <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" class="hit"/>
  </svg><div class="tip" hidden></div>`;
  const svg = $('svg', el), tip = $('.tip', el), hit = $('.hit', el);
  hit.addEventListener('mousemove', e => {
    const r = svg.getBoundingClientRect(), vx = ((e.clientX - r.left) / r.width) * W;
    const k = lo + ((vx - L) / (W - L - R)) * (hi - lo);
    const b = bins.reduce((a, c) => (Math.abs(c.k - k) < Math.abs(a.k - k) ? c : a), bins[0]);
    const s = sbins.find(c => Math.abs(c.k - b.k) < 0.5);
    tip.hidden = false;
    tip.textContent = `${zero && b.k > 0 ? '+' : ''}${b.k.toFixed(1)}: 기본 ${pct(b.p, 2)}${s ? ` · 시나리오 ${pct(s.p, 2)}` : ''}`;
    tip.style.left = `${Math.min(r.width - 150, Math.max(0, (x(b.k) / W) * r.width + 8))}px`;
    tip.style.top = '18px';
  });
  hit.addEventListener('mouseleave', () => { tip.hidden = true; });
}

// ------------------------------------------------------------------ odds and picks ---------------------------------
const todayIds = () => new Set(S.day.games.map(g => g.gameId));
function purchases() { const m = new Map(); for (const r of S.chain.records) if (r.type === 'purchase') m.set(r.pickId, r.purchased); return m; }

function oddsFormHtml() {
  const games = S.day.games.map((g, i) => `<option value="${i}">${esc(g.away.espn)} @ ${esc(g.home.espn)} (${esc(g.away.ko)} @ ${esc(g.home.ko)})</option>`).join('');
  return `<div class="form" id="oddsForm">
    <div class="row"><label class="f">회차<input type="number" id="o-round" min="1" step="1" style="width:90px"></label><span class="note">입력 경로: 대시보드 직접 입력. 입력 시각은 기록 순간으로 저장합니다.</span></div>
    <div id="o-rows"></div>
    <div class="row"><button class="btn ghost" type="button" id="o-add">마켓 추가</button><button class="btn" type="button" id="o-save">검증 후 기록</button></div>
    <details><summary>설계 §10.1 형식 JSON으로 입력</summary><textarea id="o-json" spellcheck="false" placeholder='{"round": 125, "capturedAt": "...", "source": "manual", "markets": [...]}'></textarea>
      <div class="row"><button class="btn ghost" type="button" id="o-json-save">JSON 검증 후 기록</button></div></details>
    <template id="o-tpl"><div class="row o-row">
      <label class="f">경기<select class="o-game">${games}</select></label>
      <label class="f">번호<input type="number" class="o-no sm" min="1" step="1"></label>
      <label class="f">마켓<select class="o-type"><option value="ML">승패</option><option value="ML5">승5패(${TEXT.notOffered})</option><option value="HC">핸디캡</option><option value="OU">언더오버</option></select></label>
      <label class="f">기준선<input type="number" class="o-line sm" step="0.5" disabled></label>
      <span class="o-odds row"></span>
      <label class="f">마감(KST)<input type="datetime-local" class="o-deadline"></label>
    </div></template></div>`;
}

function addOddsRow() {
  const node = $('#o-tpl').content.firstElementChild.cloneNode(true);
  const n = $$('#o-rows .o-row').length;
  node.querySelectorAll('input,select').forEach(el => { el.id = `o-${n}-${el.className.split(' ')[0].slice(2)}`; });
  const setOdds = () => {
    const type = node.querySelector('.o-type').value;
    node.querySelector('.o-line').disabled = !(type === 'HC' || type === 'OU');
    node.querySelector('.o-odds').innerHTML = SELECTIONS[type].map(k => `<label class="f">${SEL_KO[k]}<input type="number" class="o-odd sm" data-sel="${k}" id="o-${n}-odd-${k}" min="1.01" max="50" step="0.01"></label>`).join('');
  };
  node.querySelector('.o-type').addEventListener('change', setOdds);
  setOdds();
  $('#o-rows').append(node);
}

function readOddsForm() {
  const markets = $$('#o-rows .o-row').map(row => {
    const g = S.day.games[+row.querySelector('.o-game').value], type = row.querySelector('.o-type').value;
    const dl = row.querySelector('.o-deadline').value;
    const m = { betmanNo: +row.querySelector('.o-no').value, home: g.home.ko, away: g.away.ko, deadline: dl ? `${dl}:00+09:00` : '', type, odds: {} };
    if (type === 'HC' || type === 'OU') m.line = row.querySelector('.o-line').value === '' ? NaN : +row.querySelector('.o-line').value;
    for (const el of row.querySelectorAll('.o-odd')) m.odds[el.dataset.sel] = +el.value;
    return m;
  });
  return { round: +$('#o-round').value, capturedAt: new Date().toISOString(), source: 'manual', markets };
}

function previewRound(input) {
  if (!canWrite()) { S.msg = { bad: true, text: writeBlock() }; return renderOdds(); }
  const c = classifyInput({ input, day: S.day, chain: S.chain.records, now: new Date() });
  if (!c.ok) { S.msg = { bad: true, text: `${c.error}${c.excluded?.length ? ` · ${c.excluded.map(excludedText).join(' · ')}` : ''}` }; S.pending = null; return renderOdds(); }
  // only the markets that passed the screen are written on [확정]; the rest are listed on the confirmation screen
  S.pending = { input: c.input, rows: c.rows, excluded: c.excluded };
  S.msg = null;
  renderOdds();
}

const excludedText = x => `#${x.betmanNo} ${x.game} ${MARKET_KO[x.type] ?? x.type}: ${x.text}`;

function excludedHtml() {
  const ex = S.pending.excluded ?? [];
  if (!ex.length) return '';
  return `<div class="msg bad" id="excluded"><strong>기록하지 않는 마켓 ${ex.length}개</strong><ul>${ex.map(x => `<li data-excluded="${esc(x.reason)}">${esc(excludedText(x))}</li>`).join('')}</ul></div>`;
}

function confirmHtml() {
  const rows = S.pending.rows.map(r => `<tr data-confirm-row><td class="mono">${esc(r.market)}</td><td>${esc(r.game)}</td><td>${MARKET_KO[r.type]}${r.line != null ? ` ${r.line}` : ''}</td>
    <td class="n">${Object.entries(r.odds).map(([k, o]) => `${SEL_KO[k]} ${fx(o)}`).join(' · ')}</td><td class="n">${fx(r.overround, 3)}${r.warning ? ` <span class="warnline" data-warn>${esc(r.warning.text)}</span>` : ''}</td>
    <td><strong>${esc(r.text)}</strong></td><td class="note">${hm(r.deadline.kst)} KST</td></tr>`).join('');
  return `<div class="card confirm" id="confirm"><header><h2>확인 — 아직 기록하지 않았습니다</h2><span class="note">[확정]을 누르면 픽 로그에 추가됩니다. ${TEXT.fixed}. 각 마켓의 처음 확정만 평가·픽이 되고, 나중 입력은 배당 레코드로만 남습니다.</span></header>
    <div class="tbl"><table><thead><tr><th>회차-번호</th><th>경기</th><th>마켓</th><th class="n">배당</th><th class="n">오버라운드</th><th>처리</th><th>마감</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${excludedHtml()}
    <div class="row"><button class="btn" type="button" id="o-confirm">확정</button><button class="btn ghost" type="button" id="o-back">돌아가기</button></div></div>`;
}

async function confirmRound() {
  const { input, rows } = S.pending;
  S.pending = null;
  if (!canWrite()) { S.msg = { bad: true, text: writeBlock() }; return renderOdds(); }
  let built;
  try {
    built = roundRecords({ input, day: S.day, cal: S.cal, chain: S.chain.records, now: new Date() });
  } catch (e) { S.msg = { bad: true, text: e.message }; return renderOdds(); }
  let r;
  try { r = await appendAsPage(S.store, built.records, { holder: S.tabId }); } catch (e) { r = { ok: false, reason: String(e.message ?? e.code ?? e) }; }
  await refreshChain();
  const notes = built.notes.map(n => `${n.market}: ${NOTE_KO[n.note] ?? n.note}`);
  if (r.ok) {
    S.fail = null; S.retry = null; S.clearForm = true;
    S.msg = { text: `기록했습니다: 레코드 ${built.records.length}개(배당 ${built.records.filter(x => x.type === 'odds').length}, 평가 ${built.records.filter(x => x.type === 'evaluation').length}, 픽 ${built.records.filter(x => x.type === 'pick').length}, 2폴더 ${built.records.filter(x => x.type === 'combo').length}). ${TEXT.fixed}.${notes.length ? ` · ${notes.join(' · ')}` : ''}` };
  } else await writeFailed(r.reason, rows, input);
  renderBands();
  renderOdds();
}

// a failed write stays on screen with its reason; a note goes to the database outside the chain (failures/) for the
// next daily run's report; the input is kept so it can be sent again before its deadline
async function writeFailed(reason, rows, input) {
  const at = new Date();
  const markets = rows.map(r => r.market).join(', ');
  let noted = false;
  try { await S.db.doc(`failures/${S.tabId}-${at.getTime()}`).set({ at: at.toISOString(), reason, markets, holder: S.tabId }); noted = true; } catch { noted = false; }
  S.fail = { text: `${TEXT.writeFailed} — ${REASON_KO[reason] ?? reason} (${hm(stampKst(at))} KST, 마켓 ${markets}). ${noted ? '사유를 DB failures에 남겼습니다' : 'DB에 사유를 남기지 못했습니다: 이 화면이 유일한 기록입니다'}. 마감 전이면 다시 확정할 수 있고, 마감 뒤에는 기록하지 않습니다.` };
  S.retry = input ? JSON.stringify(input) : null;
  S.msg = { bad: true, text: S.fail.text };
}
const stampKst = d => new Date(d.getTime() + 9 * 3600e3).toISOString().replace('Z', '+09:00');

async function savePurchase(pickId, bought) {
  if (!canWrite()) { S.msg = { bad: true, text: writeBlock() }; return renderTab(); }
  let r;
  try { r = await appendAsPage(S.store, [purchaseRecord(pickId, bought, { now: new Date() })], { holder: S.tabId }); } catch (e) { r = { ok: false, reason: String(e.message ?? e.code ?? e) }; }
  await refreshChain();
  if (r.ok) S.msg = { text: `구매 여부를 기록했습니다(${pickId}: ${bought ? '구매함' : '구매 안 함'}). 픽 레코드는 그대로입니다.` };
  else await writeFailed(r.reason, [{ market: pickId }], null);
  renderBands();
  renderTab();
}

function pickRow(p, bought, { showResult = false, results = null } = {}) {
  const res = showResult && results?.get(p.gameId) ? settle(p.market, p.selection, p.line, results.get(p.gameId).margin, results.get(p.gameId).total) : null;
  const buy = bought === undefined ? '미기록' : bought ? '구매함' : '구매 안 함';
  const ctl = canWrite() ? `<button class="btn ghost" data-buy="${esc(p.id)}" data-v="1">구매함 기록</button> <button class="btn ghost" data-buy="${esc(p.id)}" data-v="0">안 함 기록</button>` : '';
  return `<tr class="pick-row" data-pick="${esc(p.id)}"><td>${roBadge(true)}</td><td class="mono">${esc(p.id)}</td><td>${shortGame(p.gameId)}</td><td>${MARKET_KO[p.market]}${p.line != null ? ` ${p.line}` : ''} ${SEL_KO[p.selection]}</td>
    <td class="n">${fx(p.odds)}</td><td class="n">${pct(p.pCons)}</td><td class="n ev-cell">${sgn(p.ev * 100, 1)}% ${roBadge()}</td>
    ${showResult ? `<td>${res == null ? '대기' : res ? '적중' : '실패'}</td>` : ''}<td>${buy} ${ctl}</td></tr>`;
}

// what is typed in the odds form survives a re-render (a pick-log refresh re-renders this tab)
function formState() {
  if (!$('#oddsForm')) return null;
  const rows = $$('#o-rows .o-row').map(row => ({
    game: row.querySelector('.o-game').value, no: row.querySelector('.o-no').value, type: row.querySelector('.o-type').value,
    line: row.querySelector('.o-line').value, deadline: row.querySelector('.o-deadline').value,
    odds: Object.fromEntries($$('.o-odd', row).map(e => [e.dataset.sel, e.value])),
  }));
  return { round: $('#o-round').value, rows, json: $('#o-json').value };
}
function restoreForm(f) {
  $('#o-round').value = f.round;
  $('#o-json').value = f.json;
  f.rows.forEach((r, i) => {
    addOddsRow();
    const row = $$('#o-rows .o-row')[i];
    row.querySelector('.o-game').value = r.game;
    row.querySelector('.o-type').value = r.type;
    row.querySelector('.o-type').dispatchEvent(new Event('change'));
    row.querySelector('.o-no').value = r.no;
    row.querySelector('.o-line').value = r.line;
    row.querySelector('.o-deadline').value = r.deadline;
    for (const e of $$('.o-odd', row)) e.value = r.odds[e.dataset.sel] ?? '';
  });
}

function renderOdds() {
  const keep = S.clearForm ? null : formState();
  S.clearForm = false;
  const ex = isEx(), ids = todayIds();
  const recs = S.chain.records.filter(r => ids.has(r.gameId));
  const evals = recs.filter(r => r.type === 'evaluation'), picks = recs.filter(r => r.type === 'pick');
  const pickIds = new Set(picks.map(p => p.id));
  const combos = S.chain.records.filter(r => r.type === 'combo' && r.legs.some(id => pickIds.has(id)));
  const bought = purchases();
  const block = writeBlock();
  const ds = dayStatus({ day: S.day, chain: S.chain.records, now: new Date() });
  const none = ds.code === 'noOdds' ? TEXT.noOdds : ds.code === 'pending' ? ds.text : ds.code === 'unevaluated' ? TEXT.unevaluated : null;
  const evRows = ex
    ? `<tr class="pick-area"><td colspan="9"><span class="badge ex lg">${TEXT.exampleCell}</span> 예시 데이터에는 실제 베트맨 배당이 없어 EV를 계산하지 않습니다.</td></tr>`
    : evals.length ? evals.map(r => `<tr><td class="mono">${esc(r.round)}-${esc(r.betmanNo)}</td><td>${shortGame(r.gameId)}</td><td>${MARKET_KO[r.market]}</td><td class="n">${r.line ?? '—'}${r.unsupported && /integer/.test(r.unsupported) ? ` <span class="badge uns">${TEXT.unsupported}</span>` : ''}</td><td>${SEL_KO[r.selection]}</td><td class="n">${fx(r.odds)}</td>
        ${r.unsupported ? `<td class="n" colspan="2">${/integer/.test(r.unsupported) ? TEXT.unsupported : '보정 범위 밖(픽 제외)'}</td><td class="n ev-cell">— ${roBadge()}</td>` : `<td class="n">${pct(r.p)}</td><td class="n">${pct(r.pCons)}</td><td class="n ev-cell">${sgn(r.ev * 100, 1)}% ${roBadge()}</td>`}
        <td class="n">${pct(r.noVig)}</td></tr>`).join('')
      : `<tr><td colspan="10"><strong data-day-status>${esc(ds.text)}</strong> <span class="note">배당이 들어오고 그 경기의 최종 예측이 있으면 평가가 여기에 확정됩니다.</span></td></tr>`;
  $('#odds').innerHTML = `
    ${msgHtml()}
    ${!block && S.pending ? confirmHtml() : ''}
    <div class="card"><header><h2>배당 입력</h2><span class="note">저장 전에 확인 화면을 거칩니다. ${TEXT.fixed}. 오버라운드가 1.00 미만이거나 1.30을 넘으면 경고만 하고 저장은 막지 않습니다.</span></header>
      ${block ? `<div class="lock">${esc(block)}</div>` : oddsFormHtml()}</div>
    <div class="card"><header><h2>기대값 표</h2>${roBadge(true)}${exTag()}<span class="note">기본 예측만 씁니다. 시나리오·민감도 결과는 이 표에 들어오지 않습니다. EV = p_cons × 배당 − 1, p_cons = p − 0.1·|p − 0.5|</span></header>
      <div class="tbl"><table><thead><tr><th>회차-번호</th><th>경기</th><th>마켓</th><th class="n">기준선</th><th>선택</th><th class="n">배당</th><th class="n">모델 p</th><th class="n">p_cons</th><th class="n">EV</th><th class="n">시장(마진 제거)</th></tr></thead><tbody>${evRows}</tbody></table></div></div>
    <div class="card"><header><h2>단일 후보(EV ≥ +3%)</h2>${roBadge(true)}</header>
      ${ex ? `<div class="pick-area"><span class="badge ex lg">${TEXT.exampleCell}</span> 예시에는 후보가 없습니다.</div>`
    : picks.length ? `<div class="tbl"><table><thead><tr><th></th><th>id</th><th>경기</th><th>선택</th><th class="n">배당</th><th class="n">p_cons</th><th class="n">EV</th><th>구매 여부(별도 기록)</th></tr></thead><tbody>${picks.map(p => pickRow(p, bought.get(p.id))).join('')}</tbody></table></div>`
      : `<p data-single-status>${none ? `<strong>${esc(none)}</strong>` : '<span class="note">후보 없음</span>'}</p>`}</div>
    <div class="card"><header><h2>2폴더 후보</h2>${roBadge(true)}<span class="note">서로 다른 경기, 같은 회차, 원배당 곱 ≥ 2.0, 조합 EV 순 상위 3개</span></header>
      ${ex ? `<div class="pick-area"><span class="badge ex lg">${TEXT.exampleCell}</span> 예시에는 2폴더가 없습니다.</div>`
    : combos.length ? `<div class="tbl"><table><thead><tr><th></th><th>다리</th><th class="n">원배당 곱</th><th class="n">p_cons</th><th class="n">조합 EV</th><th>가장 이른 마감</th></tr></thead><tbody>${combos.map(c => `<tr class="pick-row"><td>${roBadge(true)}</td><td class="mono">${c.legs.map(esc).join(' + ')}</td><td class="n">${fx(c.oddsProduct)}</td><td class="n">${pct(c.pCons)}</td><td class="n ev-cell">${sgn(c.ev * 100, 1)}% ${roBadge()}</td><td>${hm(c.deadline?.kst)} KST</td></tr>`).join('')}</tbody></table></div>`
      : `<p data-combo-status>${none ? `<strong>${esc(none)}</strong>` : ds.code === 'pass' ? `<strong>${TEXT.pass}</strong> <span class="note">평가한 마켓 중 조건을 채우는 다리·2폴더가 없습니다.</span>` : '<span class="note">조건을 채우는 2폴더가 없습니다.</span>'}</p>`}</div>`;
  if (!block && !ex) {
    if (keep?.rows.length) restoreForm(keep); else addOddsRow();
    $('#o-add').addEventListener('click', addOddsRow);
    $('#o-save').addEventListener('click', () => previewRound(readOddsForm()));
    $('#o-json-save').addEventListener('click', () => { try { previewRound({ ...JSON.parse($('#o-json').value) }); } catch (e) { S.msg = { bad: true, text: `JSON 형식 오류: ${e.message}` }; renderOdds(); } });
    if (S.retry) { $('#o-json').value = S.retry; $('#o-json').closest('details').open = true; }
    if (S.pending) {
      $('#o-confirm').addEventListener('click', confirmRound);
      $('#o-back').addEventListener('click', () => { S.pending = null; S.msg = { text: '확정하지 않았습니다. 아무것도 기록하지 않았습니다.' }; renderOdds(); });
    }
  }
  for (const b of $$('#odds [data-buy]')) b.addEventListener('click', () => savePurchase(b.dataset.buy, b.dataset.v === '1'));
}

// ------------------------------------------------------------------ record -----------------------------------------
function exitTable(v, caption) {
  return `<div class="tbl"><table><caption class="note" style="text-align:left">${caption}</caption><thead><tr><th>조건</th><th class="n">현재</th><th>목표</th><th>상태</th></tr></thead><tbody>
    ${v.rows.map(r => `<tr data-exit="${r.key}"><td>${r.label}</td><td class="n">${esc(r.value)}</td><td>${esc(r.target)}</td><td><span class="badge ${r.met ? 'met' : 'unmet'}">${r.status}</span></td></tr>`).join('')}
  </tbody></table></div><p class="overall" data-overall>${esc(v.overall)}</p>`;
}

function renderRecord() {
  const recs = S.chain.records;
  const sum = summarize(recs, { now: new Date() });
  const vS = exitView(sum.exit), ct = comboTable(recs), mv = oddsMovement(recs), un = recs.filter(r => r.type === 'unevaluated');
  const results = new Map(recs.filter(r => r.type === 'result').map(r => [r.gameId, r]));
  const bought = purchases();
  const picks = recs.filter(r => r.type === 'pick').slice().reverse();
  const t = S.chainKnown ? chainText(S.chain) : null, a = S.chainKnown ? anchorCheck(recs, S.anchor) : null;
  const s = sum.singles, m = sum.market, tb = sum.monitor.totalBias;
  $('#record').innerHTML = `
    ${msgHtml()}
    <div class="card"><header><h2>픽 로그 체인</h2><span class="note">해시 체인(SHA-256), 추가 전용. 이 화면에는 수정·삭제 기능이 없습니다.</span></header>
      ${S.dbState !== 'ok' ? `<div class="msg">DB에 연결되지 않아 픽 로그를 읽을 수 없습니다.</div>` : t ? `<div class="msg${t.ok ? '' : ' bad'}" id="chainDetail">${esc(t.text)}</div>
      <p class="note">블록 ${S.chain.head?.blocks ?? 0}개 · ${esc(a.text)}${S.chain.orphans.length ? ` · <strong>머리 문서 밖 블록 ${S.chain.orphans.map(esc).join(', ')}: 확인 필요</strong>` : ''}${S.chain.verify.problems?.length ? ` · ${S.chain.verify.problems.map(esc).join(' · ')}` : ''}</p>` : '<p class="note">확인 중</p>'}</div>
    <div class="grid2">
      <div class="card"><header><h2>해제 조건 진행도 — 단일 픽</h2></header>${exitTable(vS, '설계 §9.4. 모두 충족해도 해제는 사용자 승인으로만 합니다.')}</div>
      <div class="card" id="comboTable"><header><h2>2폴더 기록 — 해제 조건에 넣지 않음</h2></header><div class="tbl"><table><caption class="note" style="text-align:left">${esc(ct.caption)}</caption><tbody>${ct.columns.map(c => `<tr><td>${c.label}</td><td class="n">${esc(c.value)}</td></tr>`).join('')}</tbody></table></div></div>
    </div>
    <div class="card"><header><h2>성적 요약</h2>${roBadge(true)}</header>
      <div class="kpis">
        <div class="kpi"><b>${s.settled} / ${s.n}</b><span>정산 / 단일 픽</span></div>
        <div class="kpi"><b>${pct(s.hitRate)}</b><span>적중률 (평균 p_cons ${pct(s.meanPCons)}, 이전 공식 ${pct(s.meanPConsOld)})</span></div>
        <div class="kpi"><b>${s.roi.value == null ? '—' : pct(s.roi.value)}</b><span>ROI 1단위 [${pct(s.roi.ci95?.[0])}, ${pct(s.roi.ci95?.[1])}], 경기 단위 군집</span></div>
        <div class="kpi"><b>${fx(m.brierModel, 4)} / ${fx(m.brierMarket, 4)}</b><span>Brier 모델 / 시장(마진 제거), 마켓 ${m.n}개</span></div>
        <div class="kpi"><b>${sum.combos.settled} / ${sum.combos.n}</b><span>2폴더 정산 / 전체, ROI ${pct(sum.combos.roi)}</span></div>
        <div class="kpi"><b>${sgn(tb.all, 2)}</b><span>${TEXT.biasLabel}, 최근 4주 ${sgn(tb.last4weeks, 2)}, ${tb.games}경기${tb.games ? ` (합 ${sgn(tb.all * tb.games, 1)})` : ''}. 표시만, 예측은 조정하지 않음</span></div>
      </div></div>
    <div class="card" id="unevaluated"><header><h2>평가 못 한 마켓</h2><span class="note">마감 전에 평가하지 못한 마켓도 사유와 함께 장부에 남깁니다.</span></header>
      ${un.length ? `<div class="tbl"><table><thead><tr><th>회차-번호</th><th>경기</th><th>마켓</th><th>사유</th></tr></thead><tbody>${un.map(r => `<tr><td class="mono">${esc(r.id)}</td><td>${shortGame(r.gameId)}</td><td>${MARKET_KO[r.market] ?? esc(r.market)}${r.line != null ? ` ${r.line}` : ''}</td><td>${esc(r.note)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="note">없음</p>'}</div>
    <div class="card" id="movement"><header><h2>배당 변동 — 첫 입력 대비</h2><span class="note">모니터링만 합니다. 픽·EV에는 쓰지 않습니다.</span></header>
      ${mv.markets.length ? `<div class="tbl"><table><thead><tr><th>회차-번호</th><th>경기</th><th>첫 입력</th><th>나중 입력</th><th class="n">마진 제거 확률 변화(%p)</th></tr></thead><tbody>${mv.markets.flatMap(m => m.later.map(l => `<tr><td class="mono">${esc(m.market)}</td><td>${shortGame(m.gameId)}</td><td>${Object.entries(m.first.odds).map(([k, o]) => `${SEL_KO[k]} ${fx(o)}`).join(' · ')}</td><td>${Object.entries(l.odds).map(([k, o]) => `${SEL_KO[k]} ${fx(o)}`).join(' · ')}${l.lineChanged ? ' (기준선 바뀜)' : ''}</td><td class="n">${Object.entries(l.dNoVigPp).map(([k, v]) => `${SEL_KO[k]} ${sgn(v)}`).join(' · ')}</td></tr>`)).join('')}</tbody></table></div><p class="note">마켓 ${mv.summary.markets}개, 나중 입력 ${mv.summary.laterEntries}개, 평균 ${fx(mv.summary.meanAbsNoVigPp, 1)}%p, 최대 ${fx(mv.summary.maxAbsNoVigPp, 1)}%p</p>` : '<p class="note">같은 마켓을 다시 입력한 기록이 없습니다.</p>'}</div>
    <div class="card"><header><h2>픽 기록</h2>${roBadge(true)}<span class="note">최근 것부터. 구매 여부는 별도 레코드로 추가합니다.</span></header>
      ${picks.length ? `<div class="tbl"><table><thead><tr><th></th><th>id</th><th>경기</th><th>선택</th><th class="n">배당</th><th class="n">p_cons</th><th class="n">EV</th><th>결과</th><th>구매 여부</th></tr></thead><tbody>${picks.map(p => pickRow(p, bought.get(p.id), { showResult: true, results })).join('')}</tbody></table></div>` : '<p class="note">아직 픽 기록이 없습니다.</p>'}</div>`;
  for (const b of $$('#record [data-buy]')) b.addEventListener('click', () => savePurchase(b.dataset.buy, b.dataset.v === '1'));
}

// ------------------------------------------------------------------ model status -----------------------------------
async function loadRuns() {
  if (S.dbState !== 'ok' || S.runs) return;
  try { S.runs = (await S.db.collection('runs').get()).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.id < b.id ? 1 : -1)).slice(0, 10); } catch { S.runs = []; }
  if (S.tab === 'model') renderModel();
}

function renderModel() {
  const st = S.status, d = S.day;
  const o = st?.opening;
  const grade = g => ({ pass: '통과', conditional: '조건부', fail: '미달' }[g] ?? g);
  loadRuns();
  $('#model').innerHTML = `
    <div class="card"><header><h2>데이터</h2></header>
      <p>오늘 파일: ${esc(d.kind === 'example' ? '예시' : '운영')} · ${esc(d.date)} (ET) · 생성 ${esc(d.generatedAt?.kst ?? '—')}</p>
      <p class="note">${esc(d.source?.path ?? '')}${d.source?.ensembleW != null ? ` · 앙상블 가중치 w = ${d.source.ensembleW}` : ''}</p></div>
    ${o ? `<div class="card"><header><h2>시험 시즌 개봉 결과(${esc(o.season)}, 1회, 판(B))</h2><span class="note">등록 커밋 ${esc(o.registeredCommit.slice(0, 7))} · 개봉 ${esc(o.at)}</span></header>
      <div class="kpis">
        <div class="kpi"><b>${fx(o.brier.ensembleCalibrated, 4)}</b><span>Brier 모델(보정) · 기준모델 ${fx(o.brier.baseline, 4)}</span></div>
        <div class="kpi"><b>${sgn(o.S1.diff, 4)}</b><span>S1 Brier 차이 [${fx(o.S1.ci95[0], 4)}, ${fx(o.S1.ci95[1], 4)}] — ${esc({ pass: '통과', 'pass, advantage unconfirmed': '통과, 우위 미확정', fail: '미달' }[o.S1.label] ?? o.S1.label)}</span></div>
        <div class="kpi"><b>${fx(o.S3.margin.ratio, 3)} / ${fx(o.S3.total.ratio, 3)}</b><span>S3 표준편차 비율 점수 차 / 총점</span></div>
      </div>
      <div class="tbl"><table><thead><tr><th>시장</th><th class="n">표본</th><th class="n">S2 기울기</th><th class="n">95% 구간</th><th>판정</th></tr></thead><tbody>
        ${Object.entries(o.markets).map(([k, v]) => `<tr><td>${{ ml: '승패', ml5: '승5패', hc: '핸디캡', ou: '언더오버' }[k]}</td><td class="n">${v.n}</td><td class="n">${fx(v.slope, 3)}</td><td class="n">[${fx(v.ci95[0], 3)}, ${fx(v.ci95[1], 3)}]</td><td>${grade(v.grade)}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="note">네 시장 모두 기록 전용으로만 운영합니다. 보정층: ${esc(st.calibration.fittedOn.season)} 판 ${esc(st.calibration.fittedOn.variant)} ${st.calibration.fittedOn.games}경기. 튜닝 누적 ${st.tuningRuns}회. 예측 불변 회귀 기준 ${esc(st.regression.commit)}.</p></div>` : ''}
    <div class="card"><header><h2>실행 기록</h2></header>
      ${S.dbState !== 'ok' ? '<p class="note">DB에 연결되지 않았습니다.</p>' : !S.runs ? '<p class="note">불러오는 중</p>' : S.runs.length ? `<div class="tbl"><table><thead><tr><th>실행</th><th>결과</th><th>메모</th></tr></thead><tbody>${S.runs.map(r => `<tr><td class="mono">${esc(r.id)}</td><td>${esc(r.status ?? '')}</td><td class="note">${esc(r.note ?? '')}</td></tr>`).join('')}</tbody></table></div>` : '<p class="note">실행 기록 없음(일일 작업 시작 전)</p>'}</div>`;
}

window.__dashRefresh = () => refreshChain(); // browser tests: re-read the chain after changing the fake database
boot();
