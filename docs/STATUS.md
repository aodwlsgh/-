# 진행 상황 (이어받기용)

> 새 세션은 이 파일부터 읽는다. `main`에 합칠 때마다 갱신한다.

- 마지막 갱신: 2026-10-22
- 현재 단계: **P5 완료 — 2025-26 한 번 개봉(2026-10-23), §14.4.1 판정 전부 통과(S1 우위 미확정), 네 시장 기록 전용 모드 픽 대상. 다음 P6** (보고 `docs/reports/p5-open.md`)
- 문서
  - 설계: `docs/design/2026-10-22-nba-sim-design.md` (§8.4 시나리오·앙상블, §9.2 보수 확률, §9.4 기록 전용 기간 종료 조건, §9.5 주당 예상 픽 수, §14.2 데이터 분할·그룹·구간, §14.4·§14.4.1 시험 시즌 개봉 규칙과 사전 등록)
  - 계획과 결정 기록: `docs/plans/2026-10-22-nba-sim-plan.md`
  - 보고: `docs/reports/p1-report.md`, `p2-report.md`, `p3-report.md`, `p4-report.md`, `p5-report.md`, `p5-leak-review.md`
- 테스트: `npm test` (184개)
- 모델
  - `engine/model.js`(asOf·레이팅), `engine/minutes.js`, `engine/predict.js`, `engine/evaluate.js`
  - 튜닝값: `data/model/params.json` (2024-25 전용, 2023-24는 사전값. 2022-23은 2023-24 리허설의 사전값 전용), 보정층·앙상블 `data/model/calibration.json`(2024-25 B판), 출전 확률 `data/model/play-prob.json`. **튜닝 실행 누적 횟수는 `docs/reports/tuning-ledger.json`에 기록**한다(매 튜닝마다 더한다).
  - 시뮬레이터: `engine/sim.js`, 점검 `jobs/p4.js mean|calibrate|var`. 분산 잠재 변수: `data/model/latent.json`(= `DEFAULT_LATENT`, 테스트로 일치 확인). 튜닝 누적 489회
- **2025-26은 2026-10-23에 한 번 열었다**(`data/model/test-openings.json`, 등록 커밋 `53c88f5`). 다시 열지 않고, 이 시즌으로 어떤 값도 새로 맞추지 않는다(§14.4).
- 데이터: `data/`(커밋됨). 원본 캐시는 `.cache/raw/`(git 제외). 재가공은 `node jobs/build-data.js games <season> --rebuild`.
- 네트워크를 쓰는 Node 실행에는 `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`가 필요하다.

## 다음 할 일
- P6 변수 엔진(§8): 기본 예측을 건드리지 않는 추가 방식, 시나리오 변화량은 앙상블 위에 더한다(§8.4).
  - 첫 커밋에 회귀 테스트: 변수 엔진을 끈 2024-25·2025-26 예측 해시가 등록 시점(53c88f5, `docs/reports/p5-hashes-after-2022-23.json`)과 같을 것
  - 이 테스트를 깨는 변경은 먼저 보고한다.
- 2026-27 시즌 초 픽은 기록 전용으로만 둔다(개봉 승인 8).
