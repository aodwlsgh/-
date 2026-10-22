# 진행 상황 (이어받기용)

> 새 세션은 이 파일부터 읽는다. `main`에 합칠 때마다 갱신한다.

- 마지막 갱신: 2026-10-22
- 현재 단계: **P1 수집기·파서 진행 중**
- 문서
  - 설계: `docs/design/2026-10-22-nba-sim-design.md`
  - 계획과 결정 기록: `docs/plans/2026-10-22-nba-sim-plan.md`
  - P0 결과: `docs/schemas/p0-results.md`
- 테스트: `node --test`
- 이 클라우드에서 네트워크를 쓰는 Node 실행 시 `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt`가 필요하다.

## 다음 할 일
- P1: `engine/collect.js`, `engine/parse.js`, `engine/injury.js`와 20경기 검증 리포트

## 미해결
- 사용자: GitHub 기본 브랜치를 `main`으로 변경
