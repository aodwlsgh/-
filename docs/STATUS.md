# 진행 상황 (이어받기용)

> 새 세션은 이 파일부터 읽는다. `main`에 합칠 때마다 갱신한다.

- 마지막 갱신: 2026-10-22
- 현재 단계: **P1 완료 → 다음 P2(데이터 구축)**
- 문서
  - 설계: `docs/design/2026-10-22-nba-sim-design.md`
  - 계획과 결정 기록: `docs/plans/2026-10-22-nba-sim-plan.md`
  - 보고: `docs/schemas/p0-results.md`, `docs/reports/p1-report.md`
- 테스트: `npm test` (75개)
- P1 재검증: `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node scripts/p1/validate.mjs`
  - 이 클라우드에서 네트워크를 쓰는 Node 실행에는 위 두 환경변수가 필요하다.
- 원본 응답 캐시는 `.cache/raw/`다(git 제외, 세션이 끝나면 사라짐. 다시 받으면 된다).

## 다음 할 일 (P2)
- `jobs/build-data.js`: 2024-25, 2025-26 정규시즌 전체와 2026-27 현재까지 수집
- 가공 데이터를 `data/`에 저장한다. 품질 경고를 포함한다.
- 2025-26 경기일별 경기 전 PDF 스냅샷을 수집해 존재율을 보고한다(백테스트 (B)용).
- `docs/data-report.md`

## 미해결
- 사용자: GitHub 기본 브랜치를 `main`으로 변경(`main`은 2026-10-22 생성됨)
