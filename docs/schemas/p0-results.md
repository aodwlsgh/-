# P0 환경 점검 결과

## 3차 점검 (2026-10-22, ESPN 주 출처 승인 후)

### 1. 샘플 20경기 검증 (`scripts/p0/feasibility.mjs`, 원자료 `docs/schemas/p0-feasibility.json`)
- 표본
  - 2024-25: 4경기 (2025-01-16 ×3, 2025-03-10)
  - 2025-26: 11경기 (11-05 ×3, 12-25 ×3, 01-21 ×3, 03-25 ×2)
  - 2026-27: 5경기 (10-20 ×2, 10-21 ×3)
  - 연장 2경기 포함
- 프로토타입 스크립트다. P1에서 `engine/parse.js`로 TDD 재구현한다.

**공격권 수** (플레이바이플레이에서 공격 팀이 바뀌는 구간을 세는 방식. 경기당 두 팀 평균)

| 비교 기준 | ±2% 이내 | 평균 \|오차\| | 평균 부호 오차 | 최대 \|오차\| |
|---|---|---|---|---|
| ① 설계 기준: 박스 `FGA − OREB + TOV + 0.44·FTA` | **7/20 (미달)** | 2.98% | −1.65% | 13.15% |
| ② 보정 추정식: ①에 ESPN 박스가 빠뜨린 팀 공격 리바운드(플레이바이플레이, 자유투 사이 데드볼 제외)를 OREB에 더함. 박스 TOV=0이면 플레이바이플레이 TOV 사용 | 13/20 | 1.64% | +1.48% | 3.10% |

- ①이 체계적으로 높게 나오는 원인: ESPN 박스 `offensiveRebounds`에 팀 리바운드가 빠져 있다(팀·경기당 3~5개의 실제 공격권 연장이 OREB에서 누락).
- 13.15% 이탈 1경기(2026-01-21 LAC@CHI): ESPN 박스 `totalTurnovers`가 양 팀 0, `teamTurnovers`가 −16/−12로 깨져 있다(플레이바이플레이 TOV는 16/12).
- "Traveling"(샘플 22건)은 이름에 "Turnover"가 없는 단독 턴오버다. 이를 턴오버로 분류해야 한다(분류표 반영 완료).

**출전 구간(스틴트)** (박스 선발 + 교체 이벤트. 2쿼터 이후 쿼터 시작 라인업은 첫 등장 이벤트로 추론)

| 지표 | 값 |
|---|---|
| 쿼터 시작 라인업이 정확히 5명으로 결정된 쿼터 | 162/164 (98.8%) |
| 5명이 아닌 구간 | 10/682 (1.5%) |
| 선수 출전 시간이 박스 MIN과 ±1분 이내 | 526/533 (98.7%) |
| 팀 출전 시간 합 240분(연장 +25분) 일치 | 17/20경기 (불일치: TOR-MIL 248.5, CHI-LAC 246.7, MIA-MIN 239.1) |
| 최대 선수 출전 시간 오차 | 8.97분 (2025-11-05 TOR-MIL, 한 쿼터의 시작 라인업 추론 실패) |
| 데이터 결함 | 들어온 선수가 빠진 교체 3건(2경기), 박스 명단에 없는 선수 1명, 박스 MIN `--` 1건 |

**슛 구역** (좌표 단위 피트, 림 위치는 텍스트 거리 "N-foot"에 맞춰 (25, 1)로 추정)

| 지표 | 값 |
|---|---|
| 야투 플레이 / 박스 FGA | 3,634 / 3,624 (+0.28%) |
| 3점 시도 플레이 / 박스 3PA | 1,488 / 1,477 (+0.74%) |
| 좌표 없는 야투 | 0 |
| 좌표 거리와 텍스트 거리 차이 | 평균 0.38ft, ±2ft 이내 2,644/2,644 |
| 21ft 미만 좌표의 3점 시도 | 0 |
| 구역 비율 | 제한구역 29.6%, 페인트(비RA) 19.5%, 중거리 9.9%, 코너3 10.5%, 정면3 30.5% |

- 야투 +10, 3점 +11 차이(경기당 약 0.5개)는 P1에서 원인을 확인한다.

### 2. 스키마 검증 (`engine/schema/espn.js`, `test/schema.espn.test.js`)
- `node --test`: **31/31 통과**
  - 실제 픽스처 통과 1건
  - 형식 변경 모사 26건이 모두 실패로 잡힘(박스 레이블 순서·이름, 팀 스탯 누락, `m-a` 형식, ID 타입, 시계 형식, 좌표 누락·범위, 처음 보는 플레이 유형 ID, 유형 텍스트 변경, 교체 문구, 부상 상태값 등)
  - `SchemaError` 2건, 품질 경고 2건
- 실제 응답 30개 파일(요약 20, 스코어보드 9, 부상 1): 형식 오류 0
- 품질 경고 2경기
  - 401810469: 6건(박스 TOV 0·음수, ID 없는 선수 행, 교체 결함)
  - 401909091: 2건(교체 결함)
- 실시간 점검 `scripts/check-schema-live.mjs`: 2026-10-21 스코어보드(11경기)·경기 요약·부상(71명) 통과, exit 0
- 처음 보는 플레이 유형은 형식 오류로 처리한다. 분류표 `engine/schema/espn-play-types.js`(샘플에서 본 111개 유형)에 분류를 추가해야 통과한다.

### 3. 부상 정보
- **ESPN injuries (주)**
  - `injuries[]`(팀: `id`, `displayName`) → `injuries[]`(선수: `status`, `date`, `athlete.displayName`, `athlete.links[].href`의 `/id/N`, `details.fantasyStatus`, `details.returnDate`, `shortComment`)
  - 선수 객체에 `athlete.id` 필드가 **없다**. ID는 링크 URL에서 추출한다(71/71 추출 가능).
  - 상태값은 `Out`(40), `Day-To-Day`(31) 두 가지뿐이다(fantasyStatus: OUT/OFS/GTD).
- **NBA PDF (보조): 이번 시즌 파일명 규칙 확인됨**
  - 2025-26 이후: `Injury-Report_{YYYY-MM-DD}_{hh}_{mm}{AM|PM}.pdf`
    - 확인: `2026-10-21_05_00PM`, `_05_15PM`, `_05_45PM`, `_12_00AM`, `_06_00AM`, `_11_30PM`, `2026-10-22_03_00AM` 등
    - **15분 간격, 하루 종일** 올라온다.
  - 2024-25까지: `{hh}{AM|PM}` (`2025-04-01_01PM`, `_05PM`)
  - 시간대: **미국 동부시간**. 07:12 UTC(=03:12 EDT)에 `2026-10-22_03_00AM`은 있고 `_03_15AM`은 아직 없었다.
  - 형식: 6쪽 PDF, 머리글 `Game Date | Game Time | Matchup | Team | Player Name | Current Status | Reason`
    - 선수명은 "성, 이름" 순서
    - 상태: Out / Questionable / Probable 등
    - 사유가 여러 줄에 걸칠 수 있다.
    - 매치업 약어는 NBA 표기(`MIL@WAS`)
  - pdfjs-dist의 x좌표로 열을 나눌 수 있음을 확인했다(1쪽).

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
