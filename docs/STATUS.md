# 진행 상황 (이어받기용)

> 새 세션은 이 파일부터 읽는다. `main`에 합칠 때마다 갱신한다.

- 마지막 갱신: 2026-10-22
- 현재 단계: **P5 재리허설·재등록 완료 — 2025-26 미개봉, 사용자 개봉 승인 대기** (보고 `docs/reports/p5-report.md` §0)
- 문서
  - 설계: `docs/design/2026-10-22-nba-sim-design.md` (§8.4 시나리오·앙상블, §9.2 보수 확률, §9.4 기록 전용 기간 종료 조건, §9.5 주당 예상 픽 수, §14.2 데이터 분할·그룹·구간, §14.4·§14.4.1 시험 시즌 개봉 규칙과 사전 등록)
  - 계획과 결정 기록: `docs/plans/2026-10-22-nba-sim-plan.md`
  - 보고: `docs/reports/p1-report.md`, `p2-report.md`, `p3-report.md`, `p4-report.md`, `p5-report.md`, `p5-leak-review.md`
- 테스트: `npm test` (184개)
- 모델
  - `engine/model.js`(asOf·레이팅), `engine/minutes.js`, `engine/predict.js`, `engine/evaluate.js`
  - 튜닝값: `data/model/params.json` (2024-25 전용, 2023-24는 사전값. 2022-23은 2023-24 리허설의 사전값 전용), 보정층·앙상블 `data/model/calibration.json`(2024-25 B판), 출전 확률 `data/model/play-prob.json`. **튜닝 실행 누적 횟수는 `docs/reports/tuning-ledger.json`에 기록**한다(매 튜닝마다 더한다).
  - 시뮬레이터: `engine/sim.js`, 점검 `jobs/p4.js mean|calibrate|var`. 분산 잠재 변수: `data/model/latent.json`(= `DEFAULT_LATENT`, 테스트로 일치 확인). 튜닝 누적 489회
- **2025-26은 봉인된 시험 시즌이다.** 여는 경로는 `node jobs/backtest.js test --open-test` 하나뿐이다(`jobs/p3.js test`는 거부). 사전 등록 커밋(`data/model/preregistration.json`, 설계 §14.4.1)의 후손이고 코드·파라미터가 그대로이며 작업 트리가 깨끗해야 열린다. 열람은 `data/model/test-openings.json`에 기록된다. **아직 열지 않았다.**
- 데이터: `data/`(커밋됨). 원본 캐시는 `.cache/raw/`(git 제외). 재가공은 `node jobs/build-data.js games <season> --rebuild`.
- 네트워크를 쓰는 Node 실행에는 `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`가 필요하다.

## 사용자 결정 대기
1. **2025-26 개봉 승인** — 사전 등록 커밋 `53c88f5`(설계 §14.4.1). 승인 전에는 열지 않는다.
   - 개봉 명령: `node jobs/backtest.js test --open-test` (작업 트리 깨끗, `engine/`·`jobs/`·파라미터 무변경일 때만 실행됨)
   - 결과 표: `node scripts/p5/summarize.mjs docs/reports/p5-test.json`
2. 개봉 전까지 `engine/`·`jobs/`를 바꾸지 않는다(바꾸면 재등록 필요). P6 이후 코드는 개봉 뒤에 시작한다.

## 다음 할 일
- 개봉(승인 시) → P5 결과 보고 → P6 변수 엔진(§8, 앙상블 결합 §8.4) → P7 픽 엔진(p_cons 교체, 시장별 게이트)
