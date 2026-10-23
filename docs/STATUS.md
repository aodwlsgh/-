# 진행 상황 (이어받기용)

> 새 세션은 이 파일부터 읽는다. `main`에 합칠 때마다 갱신한다.

- 마지막 갱신: 2026-10-23
- 현재 단계: **P8(대시보드) 계획 보고 — 구현 전 승인 대기.** P7 완료·승인(2026-10-23). 계획은 `docs/plans/2026-10-22-nba-sim-plan.md` P8·P9 절
- 문서
  - 설계: `docs/design/2026-10-22-nba-sim-design.md` (§8.4 시나리오·앙상블, §9.2 보수 확률, §9.4 기록 전용 기간 종료 조건, §9.5 주당 예상 픽 수, §14.2 데이터 분할·그룹·구간, §14.4·§14.4.1 시험 시즌 개봉 규칙과 사전 등록)
  - 계획과 결정 기록: `docs/plans/2026-10-22-nba-sim-plan.md`
  - 보고: `docs/reports/p1-report.md`, `p2-report.md`, `p3-report.md`, `p4-report.md`, `p5-report.md`, `p5-leak-review.md`
- 테스트: `npm test` (225개, 예측 불변 회귀 테스트와 SHA-256 표준 시험 벡터 포함 약 50초)
- 모델
  - `engine/model.js`(asOf·레이팅), `engine/minutes.js`, `engine/predict.js`, `engine/evaluate.js`
  - 튜닝값: `data/model/params.json` (2024-25 전용, 2023-24는 사전값. 2022-23은 2023-24 리허설의 사전값 전용), 보정층·앙상블 `data/model/calibration.json`(2024-25 B판), 출전 확률 `data/model/play-prob.json`. **튜닝 실행 누적 횟수는 `docs/reports/tuning-ledger.json`에 기록**한다(매 튜닝마다 더한다).
  - 시뮬레이터: `engine/sim.js`, 점검 `jobs/p4.js mean|calibrate|var`. 분산 잠재 변수: `data/model/latent.json`(= `DEFAULT_LATENT`, 테스트로 일치 확인). 튜닝 누적 489회
- **2025-26은 2026-10-23에 한 번 열었다**(`data/model/test-openings.json`, 등록 커밋 `53c88f5`). 다시 열지 않고, 이 시즌으로 어떤 값도 새로 맞추지 않는다(§14.4).
- 데이터: `data/`(커밋됨). 원본 캐시는 `.cache/raw/`(git 제외). 재가공은 `node jobs/build-data.js games <season> --rebuild`.
- 네트워크를 쓰는 Node 실행에는 `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`가 필요하다.

## 운영 규칙 (2026-10-23 사용자 결정)
- 네 시장 모두 픽 대상이지만 **기록 전용 모드**(설계 §9.4·§9.5)로만 운영한다. 2026-27 시즌 첫 한 달은 시장과 관계없이 기록 전용이다.
- 2025-26 데이터로는 어떤 값도 새로 맞추지 않는다(시나리오 효과 크기 포함).
- "시즌 초 손발 미숙" 시나리오는 기본 꺼짐이다. 대시보드 사용자 선택과 민감도 표시에만 쓴다.
- 언더오버 총점 편향(+1.77점)은 P7 이후 일일 리포트에 모니터링 항목으로만 넣는다. 예측은 조정하지 않는다.

## P6 결과 (변수 엔진)
- `engine/scenario.js`(§8.1 시나리오, §8.4 앙상블 결합), `engine/sensitivity.js`(§8.3, 28개 변형), `engine/auto-scenario.js`(손발 미숙 감지만, 기본 꺼짐)
- 예측 코드(model, evaluate, minutes, predict, sim, snapshot, injury, calibrate)와 파라미터 파일은 등록 커밋 `53c88f5`과 같다.
- `test/p6-invariance.test.js`: 2024-25·2025-26 예측 해시와 시뮬레이터 표본 해시가 등록 시점과 같아야 한다. **이 테스트가 깨지는 변경은 먼저 보고한다.**
- 시나리오·민감도 결과는 "미검증"이고 픽·EV에 쓰지 않는다.

## P7 결과 (마켓·픽 엔진)
- `engine/markets.js`: 베트맨 기준선에서 직접 확률 계산, 기본 예측만 허용(시나리오는 오류)
- `engine/odds.js`: 배당 입력 검증, 기준선·배당·입력 시각(UTC·KST)·마진 제거 내재확률(비례 방식 고정) 저장
- `engine/picks.js`: p_cons 등록 공식, EV ≥ +3% 다리, 2폴더(다른 경기·같은 회차·원배당 곱 ≥ 2.0), "오늘은 패스", 손익분기표, 게이트(전부 기록 전용, 2026-27 첫 한 달 2026-10-20~11-19)
- `engine/pick-log.js`: 해시 체인 추가 전용 로그, 마감 전 확정, 모든 후보 기록·구매 별도 레코드, 단일 픽 집계(경기 군집 부트스트랩), 2폴더 별도, 시장 대비 Brier(모든 기록 마켓), 언더오버 편향 모니터링
- `engine/clock.js`(UTC·KST), `engine/betman-teams.js`(베트맨 한글 팀명, 첫 캡처 전 "미확인")
- `engine/teams.js`는 동결 경로(`jobs/lib/provenance.js` FROZEN의 `engine`)이고 예측 경로(`engine/snapshot.js`)가 읽는다. 그래서 53c88f5 상태 그대로 둔다(2026-10-23 P8 승인 조건 1).
- `test/sha256.test.js`: 자체 SHA-256을 표준 벡터(빈 문자열, "abc", 55·56·64·112바이트, 100만 개 "a", 한글)와 길이 0~300 전부 `node:crypto` 대조로 검사

## 다음 할 일
- **P8 구현은 계획 승인 뒤에 시작한다.** 계획 요점
  - 새 파일: `engine/dashboard-data.js`(today.json 형식·검사), `engine/log-records.js`(배당·평가·픽·2폴더 레코드), `engine/log-store.js`(DB 블록 저장 순서), `dashboard/`(페이지·워커), `tools/browser/`(Chromium 테스트, 별도 package.json)
  - 픽 로그는 해시 체인 그대로, DB에 블록 문서(`blocks/`)와 머리 문서(`meta/head`)로 저장. 쓰기는 owner만. 대시보드는 잠금(acquire) + 버전 갱신, 일일 작업은 `if_version` 원자적 일괄 쓰기
  - 화면: 체인 검증 상시 표시, 픽·EV "기록 전용 — 구매 비권장", 시나리오 "미검증", 백투백 "근사", 시나리오·민감도는 픽·EV 칸 금지, 해제 조건 진행도("해제 가능" 류 문구 금지), 한글 팀명 "미확인", 정수 기준선 "미지원"
  - P8 게시 시점에는 2024-25 과거 하루를 "예시" 표시로 싣는다. 실제 2026-27 데이터는 P9 첫 실행부터
- P9 일일 작업: 실행 A 순서(기본 예측 → 픽·리포트 → 픽 로그 확정 → 민감도), 매일 픽 로그 git 커밋(체인 검증 + 앞부분 일치 확인 후), 언더오버 편향 모니터링. 완료 기준에 2026-10-31·11-01(ET) 실제 실행 시각 점검 포함
- 첫 실제 베트맨 캡처 때 확인할 것: 한글 팀명, 정수 기준선 규정
