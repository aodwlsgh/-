# 진행 상황 (이어받기용)

> 새 세션은 이 파일부터 읽는다. `main`에 합칠 때마다 갱신한다.

- 마지막 갱신: 2026-10-22
- 현재 단계: **P2 완료 → 다음 P3(선수·팀 모델)**
- 문서
  - 설계: `docs/design/2026-10-22-nba-sim-design.md`
  - 계획과 결정 기록: `docs/plans/2026-10-22-nba-sim-plan.md`
  - 데이터 저장 방식: `docs/data-storage.md`
  - 보고: `docs/schemas/p0-results.md`, `docs/reports/p1-report.md`, `docs/reports/p2-report.md`(+ `p2-summary.json`)
- 테스트: `npm test` (99개)
- 데이터(커밋됨, 9.2MB)
  - `data/schedule/{season}.json`
  - `data/games/{season}/{usDate}.json.gz`
  - `data/checks/`
  - `data/excluded_games.json`
  - `data/injury-pdf/2025-26/`
- 원본 캐시는 `.cache/raw/`다(git 제외). 새 세션에서 재가공이 필요하면 `node jobs/build-data.js games <season> --rebuild`를 돌린다. 캐시가 없으면 ESPN에서 다시 받는다(약 21분).
- 이 클라우드에서 네트워크를 쓰는 Node 실행에는 `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`가 필요하다.

## 다음 할 일 (P3)
- `engine/model.js`: 선수 능력치(구역별 성공률, usage 등)와 축소 추정, 팀 수비
- `engine/minutes.js`: 출전 시간 모델
- 입력은 `data/games/**`의 `players`·`poss`·`stints`다. heave 성격 슛은 `hv`로 이미 빠져 있다.
- 스틴트를 쓸 때는 `quality.usable.stints`와 각 스틴트의 완전 여부 플래그를 지킨다(`docs/reports/p1-report.md` §4).

## 미해결
- 사용자: GitHub 기본 브랜치를 `main`으로 변경(`main`은 2026-10-22 생성됨)
- 선택: 홈·원정 공격권 차 3인 정규시간 경기 7개(`docs/reports/p2-report.md` §8)
