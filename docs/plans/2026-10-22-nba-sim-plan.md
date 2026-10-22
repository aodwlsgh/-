# NBA 시뮬레이터 v1 — 구현 계획

- 작성일: 2026-10-22
- 기준 문서: `docs/design/2026-10-22-nba-sim-design.md` (이하 "설계")
- 상태: **승인 대기** (승인 전에는 코드를 쓰지 않음)

---

## 0. P0 환경 점검 결과 (2026-10-22, Node v22.22.0)

설계 §3, §5.1의 도메인을 모두 시도했고, 전부 환경 네트워크 정책에서 차단됐다(프록시 `403 CONNECT tunnel failed`, 0B 수신).

| 도메인 | 시도한 URL | 결과 |
|---|---|---|
| cdn.nba.com | `/static/json/staticData/scheduleLeagueV2.json` | 차단 |
| cdn.nba.com | `/static/json/liveData/scoreboard/todaysScoreboard_00.json` | 차단 |
| cdn.nba.com | `/static/json/liveData/boxscore/boxscore_0022500001.json` | 차단 |
| cdn.nba.com | `/static/json/liveData/playbyplay/playbyplay_0022500001.json` | 차단 |
| ak-static.cms.nba.com | `/` | 차단 |
| site.api.espn.com | `/apis/site/v2/sports/basketball/nba/injuries` | 차단 |
| stats.nba.com | `/stats/scoreboardv2` | 차단 |

- 실제 응답 스키마는 **하나도 확인하지 못했다.** 스키마 기록은 도메인 허용 후 P0을 다시 실행해서 채운다.
- 이 작업은 Cowork가 아니라 **Claude Code 클라우드 환경**에서 돌고 있다. 허용 위치는 설계 §3의 "관리자 설정 → Capabilities"가 아니라 **세션 상단 클라우드 환경 메뉴 → Edit → Network access → Allowed domains**다(https://code.claude.com/docs/en/cloud-environments#network-access).
- 허용할 도메인: `cdn.nba.com`, `ak-static.cms.nba.com`, `site.api.espn.com` (선택: `stats.nba.com`)
- `registry.npmjs.org`은 이미 열려 있다. 필요한 npm 패키지(아래 §2)는 설치할 수 있다.

### P0 재실행 시 확인할 항목 (`scripts/p0-probe.js`로 자동화, 결과는 `docs/schemas/*.md`에 기록)
1. 일정 JSON의 경기 목록 경로, gameId·날짜·팀·경기 유형 필드. **지난 시즌(2024-25, 2025-26) 일정도 이 파일에 들어 있는지** 확인한다. 없으면 gameId를 순번으로 나열(`002SS00001`~`01230`)해 박스스코어 존재 여부로 확정한다.
2. 박스스코어: 선수별 출전 시간 형식(`PT34M12.00S` 등), 슛·리바운드·턴오버 필드, 연장 여부.
3. 플레이바이플레이: `actionType`·`subType`·`x/y`·`area`·`shotDistance`·`possession` 필드가 있는지 확인한다(설계 §6.2 슛 구역 분류 근거). 교체 이벤트 형식도 본다.
4. **지난 시즌 경기도 liveData 경로에서 받을 수 있는지** 확인한다(2024-25 경기 1건 샘플).
5. 부상 리포트 PDF의 파일명 시각 표기와 갱신 주기, ESPN injuries의 JSON 구조.
6. Akamai 등의 봇 차단 여부. 필요한 요청 헤더(User-Agent, Referer)가 있으면 기록한다.

---

## 1. 설계와 다르게 하자고 제안하는 것 (승인 필요)

| # | 설계 | 제안 | 이유 |
|---|---|---|---|
| D1 | §12: 코드·데이터를 전부 아티팩트에 보관 | **코드와 가공 데이터는 이 Git 저장소(`aodwlsgh/-`)에 커밋**한다. 아티팩트에는 대시보드, 엔진 사본, 최신 데이터 파일, 픽 기록 DB(`picks`/`results`/`runs`)를 둔다. | 이 환경에는 Git 저장소가 붙어 있고, 예약 작업 세션도 같은 저장소를 새로 받아 시작한다. 코드를 아티팩트에서 꺼내 쓰는 것보다 확실하고, 이력도 남는다. |
| D2 | §5.2: 응답 원본을 압축 저장 | 원본(.json.gz)은 **세션 안의 캐시에만** 두고, 영구 보관은 가공본(경기별 공격권 요약, 선수-경기 행)만 한다. | 원본 2,500경기는 수백 MB로 추정된다(실측 전). 가공본은 시즌당 수 MB로 예상된다. 원본은 언제든 다시 받을 수 있다. |
| D3 | §1.1: 순서상 P0→P1→P2 | 네트워크가 열리기 전에는 **네트워크와 무관한 모듈을 먼저 진행**한다: `rng`, `sim`(합성 리그 평균 입력으로 불변식 테스트), `markets`, `picks`, `odds`(입력 검증), 팀명 매핑 | 합성 입력은 테스트 픽스처로만 쓰고 "합성"이라고 표시한다. 실데이터처럼 보고하지 않는다. |

---

## 2. 공통 사항

- 디렉터리: `engine/`(브라우저·Node 공용, Node 전용 API 금지), `jobs/`(Node 전용), `scripts/`(점검·일회성), `test/`, `data/`(가공 데이터), `docs/`
- 런타임: Node 20+ (현재 v22), `package.json`에 `"type": "module"`. 테스트는 `node --test`.
- 외부 의존성은 최소한으로 둔다.
  - `pdfjs-dist`: 부상 리포트 PDF에서 텍스트 추출(Node 전용 경로에서만 사용)
  - 그 외는 직접 구현한다(시드 난수 xoshiro128**, Beta·정규 분포 샘플러, 로지스틱 회귀).
- 공용 규칙
  - 엔진 함수는 순수 함수로, 입출력은 설계 §4.2 타입을 따른다.
  - 시드 고정 시 결과가 같아야 한다.
- 네트워크 계층(`collect.js`)
  - 초당 2회 이하 토큰 버킷, 지수 백오프 최대 3회
  - 도메인 거부(403 CONNECT)는 재시도하지 않고 `DomainBlockedError(host)`로 즉시 중단한다(설계 §13).

---

## 3. 단계별 계획

각 단계의 완료 기준은 빌드 프롬프트의 표와 설계 §14를 그대로 쓴다. 테스트를 먼저 쓰고(TDD), 단계를 마칠 때 숫자로 보고하고 커밋·푸시한다.

### P0 환경 점검 — 네트워크 허용 대기 중
- 파일: `scripts/p0-probe.js`, `docs/schemas/{schedule,boxscore,pbp,injury-pdf,espn-injuries}.md`, `test/fixtures/` (샘플 응답 원본 각 1건, 작게 잘라서)
- 완료 기준: cdn.nba.com 일정·박스스코어·플레이바이플레이 응답을 확인하고, 실패 도메인 목록을 보고한다.

### P1 수집기·파서
- `engine/collect.js`
  - 함수: `fetchSchedule`, `fetchBoxscore`, `fetchPlayByPlay`, `fetchInjuryReport`
  - 구성: 레이트리미터, 재시도, 디스크 캐시(`.cache/raw/{gameId}.{box|pbp}.json.gz`), 증분 판정(`isFinal && !cached`)
- `engine/parse.js`
  - `toPossessions(pbp)`: 설계 §6.1 종료 규칙. 앤드원, 테크니컬 자유투, 점프볼, 쿼터 끝 처리
  - `toStints(pbp, box)`: 쿼터 시작 라인업은 교체 이벤트와 이후 등장 선수로 역추론
  - `shotZone(action)`: 좌표·구역 필드를 우선 쓰고, 없으면 거리로 분류. 5구역: RA / 페인트 비RA / 중거리 / 코너3 / 정면3
- `engine/injury.js`: PDF 텍스트를 행 `{playerName, team, status, reason}`으로 파싱, 선수 이름 정규화·매칭
- 테스트
  - fixture 기반 단위 테스트
  - `test/p1-possessions.test.js`: 샘플 20경기에서 분해 공격권 수와 `FGA − OREB + TOV + 0.44·FTA`의 차이가 ±2% 이내
- 완료 기준: 20경기 전부 ±2% 이내. 오차 분포(평균·최대)를 보고한다.

### P2 데이터 구축
- `jobs/build-data.js`
  - 대상: 2024-25, 2025-26 정규시즌 전체와 2026-27 현재까지
  - 정규시즌 정의: gameId `002` 접두. NBA컵 결승은 정규시즌 기록에 들어가지 않으므로 제외 여부를 P0에서 확인한다.
- 출력: `data/player_games_{season}.json.gz`, `data/possessions_{season}.json.gz`(공격권 요약), `data/games_{season}.json`
- `docs/data-report.md`: 시즌별 경기 수, 선수 수, 누락 경기와 사유
- 예상 요청 수: 약 2,500경기 × 2 = 5,000건. 초당 2회면 약 45분(실측으로 갱신)
- 완료 기준: 누락 0건, 또는 누락마다 사유를 명시한다.

### P3 선수·팀 모델
- `engine/model.js` — `buildRatings(playerGames, priors, asOfDate)`
  - 설계 §6.2 능력치 전부
  - §6.3 축소 추정: 사전값 = 지난 시즌 값을 역할군 평균 쪽으로 30% 당긴 값. 신인은 역할군 평균.
  - §6.4 팀 수비: 구역 분포·허용 성공률, 유도 턴오버, 수비 리바운드, 경기 속도, 림 프로텍터 보정
  - 홈 어드밴티지 추정
- `engine/minutes.js` — `projectMinutes(...)`
  - 출전 시간: 최근 15경기 EWMA(반감기 5경기)
  - 부상 상태 → 출전 확률
  - 결장 시 같은 포지션 그룹 뎁스 순으로 재분배, 팀 합계 240분
  - 백투백 −8%와 휴식 확률
- `jobs/tune-k.js`: k값 교차검증(2024-25 → 2025-26 전반부 예측 로그우도)
- 테스트
  - 표본 0이면 축소 결과 = 사전값, n이 매우 크면 관측값에 수렴
  - 출전 시간 합 240분
  - 결장 재분배가 같은 포지션 그룹으로 감
  - 백투백이면 주전 출전 시간 감소
- 완료 기준: §6 항목 전부 구현. 튜닝된 k값과 그 근거 수치를 보고한다.

### P4 시뮬레이터
- `engine/rng.js`: 시드 난수, Beta·정규 샘플러
- `engine/sim.js` — `simulateGame(input, {n, seed})`
  - 설계 §7.1 루프, §7.2 잠재 변수(Beta 슛 감각, 경기 속도 잡음), §7.3 클러치 파울·가비지 타임·연장
  - 성능을 위해 선수 능력치를 Float64Array로 미리 펼친다. 라인업은 `rotationByQuarter`의 체크포인트에서만 바꾼다. 구역 선택은 누적분포로 한다.
- 테스트 (설계 §14.1)
  - 팀 점수 = 선수 득점 합
  - 출전 시간 합 = 240분(+25분/연장)
  - 리그 평균 대결 시 평균 득점이 리그 평균 ±1.5점 이내
  - 같은 시드면 같은 결과
  - `test/perf.test.js`: Node에서 1만 회 2초 이내
- 완료 기준: 위 테스트 통과. 실측 시간을 보고한다.

### P5 백테스트·보정
- `jobs/backtest.js`: 2025-26 경기일마다 그 전날까지의 데이터만 쓰는 워크포워드(사전값은 2024-25). 결과는 `data/backtest_2025-26.json.gz`.
- 기준모델: 그날까지의 팀 순레이팅(축소) + 홈 어드밴티지 → 로지스틱
- `engine/calibrate.js`
  - `fitCalibration`: 로지스틱 보정(절편·기울기)과 점수 차·총점 분산 스케일
  - 전반부로 적합하고 후반부로 평가한다.
- 지표: Brier, 로그 손실, 보정 기울기(결과 ~ logit(p) 로지스틱 회귀 기울기), 점수 차·총점 MAE, 표준편차 비율
- 완료 기준
  - S1: Brier가 기준모델보다 낮음
  - S2: 보정 기울기 0.9~1.1
  - S3: 표준편차 비율 ±10%
  - 미달이면 원인 분석과 개선안을 보고하고 **멈춘다.**
- 계산량: 경기당 1만 회 × 약 1,230경기. Node 2초/경기면 약 40분이다. 백테스트에는 n=2,000도 검토하고, 바꾸면 보고한다.

### P6 변수 엔진
- `engine/scenario.js` — `applyScenario`: 설계 §8.1 형식 전부(playerOut, playProb, minutesCap, shootingShift, fatigue, chemistry, paceShift, rules)
- `engine/auto-scenario.js`: 부상 리포트 반영, 백투백 감지, 시즌 초 손발 미숙(상위 8명 중 새 합류 2명 이상, 1경기 −1.5점에서 15경기째 0까지)
- `engine/sensitivity.js`: 변수 하나씩 2,000회 재시뮬레이션해서 점수 차 Top 3, 총점 Top 3 산출
- 테스트(방향성)
  - 주전 결장 → 해당 팀 승률 하락
  - 3점 −2%p → 해당 팀 득점 하락
  - paceShift +2 → 총점 상승
  - 백투백 → 해당 팀 점수 차 악화
  - 가비지 타임 규칙 on → 큰 점수 차 구간의 총점 상승

### P7 마켓·픽 엔진
- `engine/markets.js` — `priceMarkets`
  - ML: 승패
  - ML5: 승5패. '5' = 점수 차 |d| ≤ 5. 승패가 연장으로 갈리므로 '정규시간 동점'의 처리는 규정 확인 필요(§4 결정 항목)
  - HC: 핸디캡 x.5
  - OU: 언더오버 x.5
  - SUM: 제외
- `engine/picks.js` — `evaluate(marketProbs, odds, rules)`
  - `p_cons = 0.5 + 0.9(p − 0.5)`, EV ≥ +3%
  - 2폴더: 서로 다른 경기, 같은 회차, 원배당 곱 ≥ 2.0, 조합 EV 정렬(동률이면 적중 확률 순), 상위 3개와 가장 이른 마감
  - 조합이 없으면 "오늘은 패스"
  - 손익분기표: `1.03/p_cons`, 기준점 ±3점 구간을 0.5 단위로
- 픽 활성화 게이트: `data/calibration.json`의 `passed: {S1,S2,S3}`가 모두 true일 때만 단일·2폴더를 내고, 아니면 손익분기표만 낸다.
- `engine/odds.js`: 설계 §10 형식 검증(배당 1.01~50, 기준점 0.5 단위, 마감 시각이 미래, 회차 일치)
- `engine/teams.js`: 베트맨 한글 팀명 ↔ 3자 약어. 도시명·애칭 토큰으로 매칭하고, 매칭 실패는 오류로 표시한다. **실제 베트맨 표기는 첫 캡처·화면 판독으로 검증한다.**
- 테스트(설계 §14.1)
  - 알려진 분포에서 해석해와 일치
  - 같은 경기 조합 금지
  - 원배당 곱 2.0 미만 제외
  - EV 3% 미만 제외
  - 조합 없음 → 패스
  - 게이트 off → 픽 없음

### P8 대시보드
- 아티팩트를 만들기 전에 `artifact-design` 스킬을 불러온다(`artifact-capabilities`는 계획 단계에서 확인함: `db`, `assets`, `user` 사용 가능).
- `index.html`: 5개 탭(설계 §11.1). 시뮬레이션은 Web Worker에서 돌리고, `engine/*.js`를 게시 파일로 함께 올린다.
- 픽 기록: 아티팩트 DB `picks`, `results`, `runs`. 쓰기 권한은 소유자만.
- 데이터: `data/*_latest.json`을 게시 파일로, 큰 파일은 assets로
- 완료 기준
  - 브라우저(Playwright + Chromium)에서 변수 변경 후 1만 회 5초 이내 실측
  - 픽 기록 저장·조회를 `ArtifactData list`로 확인

### P9 일일 작업·예약
- `jobs/daily.js`: 설계 §12 순서. 데이터 실패 시 마지막 저장본으로 돌리고 "데이터 지연"을 표시한다.
- `engine/report.js`: 빌드 프롬프트의 "리포트에 꼭 넣을 것" 전부
- 예약 작업은 `create_trigger`로 만들고, 매 실행마다 새 세션을 띄운다(`create_new_session_on_fire`).
  - 실행 내용: 저장소 받기 → `node jobs/daily.js` → 커밋·푸시 → 아티팩트 재게시 → `runs` 기록
  - 일정 ①: `CRON_TZ=Asia/Seoul` 매일 07:00
  - 일정 ②: 10:00 KST 조건부. 매일 10:00에 돌고, 10:00 이후 시작 경기가 없으면 즉시 종료한다.
  - 정각 회피를 위해 분을 앞당길지는 결정 항목이다(§4).
- 완료 기준: 예약 작업 1회를 수동 실행(`fire_trigger`)해서 리포트 생성과 아티팩트 갱신을 확인한다.

### P10 운영 문서
- `README.md`: 실행 방법, 배당 입력 3가지 경로, 지표 읽는 법, 장애 대응(도메인 차단·데이터 지연·이름 매칭 실패)

---

## 4. 결정해 주실 것

1. **네트워크 허용**: `cdn.nba.com`, `ak-static.cms.nba.com`, `site.api.espn.com` (선택: `stats.nba.com`)
2. **D1~D3 승인 여부**: 저장 위치(Git과 아티팩트 병행), 원본 캐시 정책, 네트워크 무관 모듈 선행
3. **베트맨 농구 규정 확인**: 승패·핸디캡·언더오버·승5패에 연장이 포함되는지. 웹 검색으로는 공식 규정을 찾지 못했고, 베트맨은 수집 금지라 직접 볼 수 없다. 규정 화면 캡처를 주시거나 직접 확인해 주세요. 그전까지는 설계 기본 가정(연장 포함)으로 구현한다.
4. **예약 시각**: 정확히 07:00·10:00으로 할지, 서버 혼잡을 피해 06:5x·09:5x로 할지
