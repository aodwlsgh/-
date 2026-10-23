// Betman Korean team names (P7, design §10.2), kept apart from engine/teams.js so that the validated prediction
// path (engine/snapshot.js imports teams.js) stays exactly as registered at 53c88f5. Unverified until the first
// real odds capture: koVerified = false.
import { TEAMS } from './teams.js';

const KO = {"ATL":"애틀랜타 호크스","BKN":"브루클린 네츠","BOS":"보스턴 셀틱스","CHA":"샬럿 호네츠","CHI":"시카고 불스","CLE":"클리블랜드 캐벌리어스","DAL":"댈러스 매버릭스","DEN":"덴버 너기츠","DET":"디트로이트 피스톤스","GS":"골든스테이트 워리어스","HOU":"휴스턴 로키츠","IND":"인디애나 페이서스","LAC":"LA 클리퍼스","LAL":"LA 레이커스","MEM":"멤피스 그리즐리스","MIA":"마이애미 히트","MIL":"밀워키 벅스","MIN":"미네소타 팀버울브스","NO":"뉴올리언스 펠리컨스","NY":"뉴욕 닉스","OKC":"오클라호마시티 썬더","ORL":"올랜도 매직","PHI":"필라델피아 76ers","PHX":"피닉스 선즈","POR":"포틀랜드 트레일블레이저스","SA":"샌안토니오 스퍼스","SAC":"새크라멘토 킹스","TOR":"토론토 랩터스","UTAH":"유타 재즈","WSH":"워싱턴 위저즈"};

export const BETMAN_TEAMS = TEAMS.map(t => ({ ...t, ko: KO[t.espn], koVerified: false }));

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
