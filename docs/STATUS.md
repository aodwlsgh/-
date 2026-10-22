# 진행 상황 (이어받기용)

> 새 세션은 이 파일부터 읽는다. `main`에 합칠 때마다 갱신한다.

- 마지막 갱신: 2026-10-22
- 현재 단계: **P3 승인 완료 → P4(시뮬레이터) 진행 중**
- 문서
  - 설계: `docs/design/2026-10-22-nba-sim-design.md` (§9.4 기록 전용 기간 종료 조건, §9.5 주당 예상 픽 수, §14.2 데이터 분할·그룹·구간, §14.4 시험 시즌 개봉 규칙)
  - 계획과 결정 기록: `docs/plans/2026-10-22-nba-sim-plan.md`
  - 보고: `docs/reports/p1-report.md`, `p2-report.md`, `p3-report.md`
- 테스트: `npm test` (150개)
- 모델
  - `engine/model.js`(asOf·레이팅), `engine/minutes.js`, `engine/predict.js`, `engine/evaluate.js`
  - 튜닝값: `data/model/params.json` (2024-25 전용, 2023-24는 사전값). **튜닝 실행 누적 횟수는 `docs/reports/tuning-ledger.json`에 기록**한다(매 튜닝마다 더한다).
  - 시뮬레이터: `engine/sim.js`, 점검 `jobs/p4.js mean|calibrate|var`. 분산 잠재 변수: `data/model/latent.json`
- **2025-26은 봉인된 시험 시즌이다.** `jobs/p3.js test --open-test`로만 열리고 열람이 기록된다(`data/model/test-openings.json`). 아직 열지 않았다.
- 데이터: `data/`(커밋됨). 원본 캐시는 `.cache/raw/`(git 제외). 재가공은 `node jobs/build-data.js games <season> --rebuild`.
- 네트워크를 쓰는 Node 실행에는 `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`가 필요하다.

## 다음 할 일
- P4 점검 결과를 `docs/reports/p4-report.md`에 정리한다.
- P5: 2025-26 백테스트. 개봉은 한 번만 하고 기준은 설계 §14.4를 따른다.
