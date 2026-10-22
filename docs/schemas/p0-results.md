# P0 환경 점검 결과

## 2차 점검 (2026-10-22 06:56 UTC, 도메인 허용 후)

| 도메인 | 결과 | 비고 |
|---|---|---|
| cdn.nba.com | **403 Access Denied (Akamai)** | 터널은 열린다. NBA CDN이 이 클라우드 출구 IP를 거부한다. 브라우저 User-Agent·Referer·Origin 헤더를 붙이거나 curl/Node fetch로 바꿔도 같다. 허용 목록 문제가 아니라 NBA 쪽 차단이다. |
| ak-static.cms.nba.com | **사용 가능** | `/referee/injury/Injury-Report_2025-04-01_05PM.pdf` → 200, 86KB PDF. `Injury-Report_2026-10-21_05PM.pdf`는 403(XML)이라 이번 시즌 파일명의 시각 표기는 따로 확인해야 한다. 루트(`/`)는 503. |
| site.api.espn.com | **사용 가능** | 아래 스키마 참조 |
| stats.nba.com | 타임아웃(30초, 0B) | 설계 §13대로 쓰지 않는다. |

## ESPN 스키마 (실제 응답으로 확인)

### 일정·스코어보드
- `GET https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD`
- `events[]`
  - `id`: ESPN 경기 ID, 예: `401809234`
  - `date`: UTC ISO 시각
  - `season`: `{year, type, slug}` (`slug: "regular-season"`, `type: 2`. `year`는 시즌이 끝나는 해: 2025-26 → 2026)
  - `competitions[0].status.type.name`: `STATUS_FINAL` 등
  - `competitions[0].competitors[]`: `{homeAway, score, team.abbreviation}`
- 기간 조회(`dates=A-B&limit=1000`)는 **0건**을 돌려준다. 그래서 날짜별로 하루씩 조회해야 한다(시즌당 약 170회).
- 확인한 날짜
  - 2024-10-22: 2경기
  - 2025-10-22: 12경기
  - 2026-10-21: 11경기
  - 세 날짜 모두 `regular-season`, `STATUS_FINAL`

### 경기 요약 (박스스코어와 플레이바이플레이)
- `GET https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={id}`
  - 응답 크기 약 400KB
  - 최상위 키: `boxscore`, `plays`, `header`, `gameInfo`, `injuries`, `pickcenter`, `odds` 등
- `boxscore.players[t].statistics[0]`
  - 레이블: `MIN,PTS,FG,3PT,FT,REB,AST,TO,STL,BLK,OREB,DREB,PF,+/-`
  - `FG`·`3PT`·`FT`는 `"성공-시도"` 문자열, **MIN은 정수 분**
  - `athletes[].athlete.id`·`displayName`
- `plays[]` 필드: `sequenceNumber`, `type{id,text}`, `text`, `period.number`, `clock.displayValue`(`"11:45"`), `homeScore`/`awayScore`, `scoringPlay`, `scoreValue`, `shootingPlay`, `pointsAttempted`, `team.id`, `participants[].athlete.id`, `coordinate{x,y}`
  - 좌표 없음은 `x=-214748340` 같은 센티넬 값으로 표시된다.
  - 교체: `type.text="Substitution"`, `text: "A enters the game for B"`, participants는 [들어온 선수, 나간 선수] 순서
  - 자유투: `type.text="Free Throw - 1 of 2"` 형식
  - 턴오버: `type.text`에 "Turnover"가 들어간다.
  - 리바운드: "Offensive Rebound" / "Defensive Rebound"
  - 쿼터 끝: "End Period", 경기 끝: "End Game"
  - 슛 거리: `text`의 "11-foot" 표기
- 박스스코어와 플레이바이플레이 정합성(샘플 2경기)

| 경기 | 야투 플레이 / 박스 FGA | 좌표 있는 야투 | 자유투 플레이 / 박스 FTA |
|---|---|---|---|
| 2025-26 CLE@NY | 174 / 172 | 174/174 | 54 / 54 |
| 2024-25 샘플 | 173 / 173 | 173/173 | 24 / 24 |

  - CLE@NY의 차이 +2는 P1에서 원인을 확인한다(블록·헤이브 중복 집계 의심).

### 부상
- `GET https://site.api.espn.com/apis/site/v2/sports/basketball/nba/injuries`
  - 200, 40KB
  - `season.displayName: "2026-27"`
  - 구조: `injuries[]`(팀별) → `injuries[]`(선수별, `longComment` 등)
  - 선수별 필드 상세는 P1에서 기록한다.

## 1차 점검 (2026-10-22, 도메인 허용 전)
- 7개 URL 모두 프록시 `403 CONNECT tunnel failed`(환경 네트워크 정책 차단)
