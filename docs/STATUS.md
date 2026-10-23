# 진행 상황 (이어받기용)

> 새 세션은 이 파일부터 읽는다. `main`에 합칠 때마다 갱신한다.

- 마지막 갱신: 2026-10-22
- 현재 단계: **P6 완료(2026-10-23) — 변수 엔진 추가, 기본 예측 불변(회귀 테스트 통과). 다음 P7(마켓·픽 엔진)**
- 문서
  - 설계: `docs/design/2026-10-22-nba-sim-design.md` (§8.4 시나리오·앙상블, §9.2 보수 확률, §9.4 기록 전용 기간 종료 조건, §9.5 주당 예상 픽 수, §14.2 데이터 분할·그룹·구간, §14.4·§14.4.1 시험 시즌 개봉 규칙과 사전 등록)
  - 계획과 결정 기록: `docs/plans/2026-10-22-nba-sim-plan.md`
  - 보고: `docs/reports/p1-report.md`, `p2-report.md`, `p3-report.md`, `p4-report.md`, `p5-report.md`, `p5-leak-review.md`
- 테스트: `npm test` (201개, 예측 불변 회귀 테스트 포함 약 50초)
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

## 다음 할 일
- P7 마켓·픽 엔진
  - `p_cons` 새 공식(기존 값도 기록)
  - 시장별 게이트: 네 시장 기록 전용, 2026-27 첫 한 달 기록 전용
  - 픽은 기본 예측만 쓴다.
- P9 일일 작업: 실행 A에서 기본 예측·픽 리포트를 먼저 끝내고 민감도는 그 뒤에 돈다(18:00 ET 경기 대비). 언더오버 총점 편향은 모니터링 항목으로 넣는다.
