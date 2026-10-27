// Betman Korean team names (P7, design §10.2), kept apart from engine/teams.js so that the validated prediction
// path (engine/snapshot.js imports teams.js) stays exactly as registered at 53c88f5. koVerified: the name was seen
// on a real Betman screen. First capture (user screenshots; time 17:00 KST as estimated by the user): 24 teams,
// Houston written "휴스턴 로케츠". BKN, CLE, DEN, OKC, PHI and PHX were not on it and stay unconfirmed ("미확인");
// an odds input naming them gets a warning, not a refusal (2026-10-23 approval). The 2026-10-27 KST screens (round 127,
// docs/betman/2026-10-27-capture.md) showed CLE, OKC and PHX as listed here and Denver written "덴버 너게츠"
// (changed 2026-10-27, user decision); BKN and PHI stay unconfirmed.
import { TEAMS } from './teams.js';

const KO = {"ATL":"애틀랜타 호크스","BKN":"브루클린 네츠","BOS":"보스턴 셀틱스","CHA":"샬럿 호네츠","CHI":"시카고 불스","CLE":"클리블랜드 캐벌리어스","DAL":"댈러스 매버릭스","DEN":"덴버 너게츠","DET":"디트로이트 피스톤스","GS":"골든스테이트 워리어스","HOU":"휴스턴 로케츠","IND":"인디애나 페이서스","LAC":"LA 클리퍼스","LAL":"LA 레이커스","MEM":"멤피스 그리즐리스","MIA":"마이애미 히트","MIL":"밀워키 벅스","MIN":"미네소타 팀버울브스","NO":"뉴올리언스 펠리컨스","NY":"뉴욕 닉스","OKC":"오클라호마시티 썬더","ORL":"올랜도 매직","PHI":"필라델피아 76ers","PHX":"피닉스 선즈","POR":"포틀랜드 트레일블레이저스","SA":"샌안토니오 스퍼스","SAC":"새크라멘토 킹스","TOR":"토론토 랩터스","UTAH":"유타 재즈","WSH":"워싱턴 위저즈"};

export const KO_CAPTURE = { at: '2026-10-23T17:00:00+09:00', atEstimated: true, source: 'user screenshots (4) of the Betman NBA list', doc: 'docs/betman/2026-10-23-capture.md' };
const SEEN = ['MIL', 'CHI', 'BOS', 'NY', 'CHA', 'ATL', 'IND', 'DAL', 'ORL', 'MIN', 'WSH', 'TOR', 'MIA', 'DET', 'SA', 'HOU', 'UTAH', 'NO', 'GS', 'MEM', 'LAL', 'LAC', 'SAC', 'POR', 'CLE', 'OKC', 'PHX', 'DEN'];
export const BETMAN_TEAMS = TEAMS.map(t => ({ ...t, ko: KO[t.espn], koVerified: SEEN.includes(t.espn) }));

// Korean name -> team: full name, or the city part, or the nickname part; spaces are ignored. "LA" alone is ambiguous.
const squash = s => s.replace(/\s+/g, '').toUpperCase();
export function byKorean(name) {
  const n = squash(name ?? '');
  if (!n) return undefined;
  const full = BETMAN_TEAMS.find(t => squash(t.ko) === n);
  if (full) return full;
  const parts = BETMAN_TEAMS.filter(t => { const [city, ...nick] = t.ko.split(' '); return squash(city) === n || squash(nick.join('')) === n; });
  return parts.length === 1 ? parts[0] : undefined;
}

// a team name whose Betman spelling is not confirmed yet: warn, do not refuse (unmapped names are refused by
// engine/odds.js validateRound)
export function teamNameWarning(name) {
  const t = byKorean(name);
  return t && !t.koVerified ? { espn: t.espn, name, text: `미확인 팀명: ${name}(${t.espn}) — 베트맨 화면 표기와 아직 대조하지 않았습니다. 화면과 같은지 확인하세요` } : null;
}
export const inputTeamWarnings = input => (input?.markets ?? []).flatMap(m => [m.home, m.away].map(teamNameWarning).filter(Boolean).map(w => ({ betmanNo: m.betmanNo, ...w })));
