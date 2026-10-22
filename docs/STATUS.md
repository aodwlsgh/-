# 진행 상황 (이어받기용)

> 새 세션은 이 파일부터 읽는다. `main`에 합칠 때마다 갱신한다.

- 마지막 갱신: 2026-10-22
- 현재 단계: **P3 완료(사용자 결정 대기) → 다음 P4(시뮬레이터)**
- 문서
  - 설계: `docs/design/2026-10-22-nba-sim-design.md` (§9.4 기록 전용 기간, §14.2 데이터 분할·그룹·구간)
  - 계획과 결정 기록: `docs/plans/2026-10-22-nba-sim-plan.md`
  - 보고: `docs/reports/p1-report.md`, `p2-report.md`, `p3-report.md`
- 테스트: `npm test` (134개)
- 모델
  - `engine/model.js`(asOf·레이팅), `engine/minutes.js`, `engine/predict.js`, `engine/evaluate.js`
  - 튜닝값: `data/model/params.json` (2024-25 전용)
- **2025-26은 봉인된 시험 시즌이다.** `jobs/p3.js test --open-test`로만 열리고 열람이 기록된다(`data/model/test-openings.json`). 아직 열지 않았다.
- 데이터: `data/`(커밋됨). 원본 캐시는 `.cache/raw/`(git 제외). 재가공은 `node jobs/build-data.js games <season> --rebuild`.
- 네트워크를 쓰는 Node 실행에는 `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`가 필요하다.

## 사용자 결정 대기 (P3 보고 §6)
1. 2023-24 수집 여부(지난 시즌 반영 비율 튜닝용)
2. 2025-26 시험 시즌 개봉 시점(제안: P5에서 한 번)
3. 기록 전용 기간 종료 조건(설계 §9.4 기본값 승인 여부)

## 다음 할 일 (P4)
- `engine/sim.js`: 공격권 몬테카를로. 레이팅·출전 시간 계획을 입력으로 받는다. 해석 모델(`predict.js`)의 사용률 정규화와 같은 원칙을 쓴다.
