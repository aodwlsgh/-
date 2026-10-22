# 데이터 저장 방식 (P2 확정, 2026-10-22)

## 수집 대상 (일정 스캔 결과, `data/schedule/{season}.json`)
| 시즌 | 포함 경기 | 경기일 | 팀별 경기 수 | 일정 단계에서 뺀 경기 |
|---|---|---|---|---|
| 2024-25 | 1,230 | 163 | 30팀 모두 82 | NBA컵 결승 1, 연기 원일정 5, 올스타 3 |
| 2025-26 | 1,230 | 164 | 30팀 모두 82 | NBA컵 결승 1, 연기 원일정 4, 올스타 4 |
| 2026-27 | 14 (2026-10-21 US까지) | 2 | — | — |

- 포함 규칙(`jobs/build-data.js` `scheduleExclusion`): `season.slug == "regular-season"`, 해당 시즌 연도, 양 팀이 NBA 30개 팀, 대회 유형 `CC`(NBA컵 결승) 아님, 상태 `STATUS_FINAL`.
- ESPN은 올스타 경기와 NBA컵 결승도 `regular-season`으로 표시한다. 둘 다 정규시즌 82경기에 포함되지 않으므로 뺀다. 연기된 경기는 원래 일정이 `STATUS_POSTPONED`로 남고, 재경기는 별도 ID로 들어온다.

## 실제 용량 (P2 완료 시점)
- `data/` 합계 **9.2MB**: 경기 레코드 7.1MB(329개 날짜 파일), 검사표 0.9MB, 부상 PDF 스냅샷 0.7MB, 일정 0.5MB
- 원본 캐시 `.cache/raw/` 약 100MB (커밋 안 함)

## 예상 용량 (수집 전, 캐시된 실제 21경기로 측정)
| 구분 | 경기당 | 2,474경기 합계 | 위치 | 커밋 |
|---|---|---|---|---|
| 원본 경기 요약(JSON) | 407KB (gzip 39KB) | 약 1GB (gzip 약 94MB) | `.cache/raw/espn/` | **안 함** (세션 캐시) |
| 가공 레코드 | 14KB (gzip 3.2KB) | gzip 약 7.8MB | `data/games/{season}/{usDate}.json.gz` | **함** |
| 일정 | — | 약 0.55MB | `data/schedule/{season}.json` | 함 |
| 경기별 검사표 | — | 시즌당 수백 KB | `data/checks/{season}.json` | 함 |
| 제외 목록 | — | 수 KB | `data/excluded_games.json` | 함 |
| 부상 PDF 스냅샷(파싱 결과) | 날짜당 수 KB | 약 1~2MB | `data/injury-pdf/{season}/{etDate}.json.gz` | 함 (원본 PDF는 캐시만) |

- 요청 수: 일정 약 560회(완료) + 경기 2,474회 + PDF 수백 회. 초당 2회면 경기 단계는 약 21분이다.

## 저장 원칙
1. **원본은 캐시, 가공 결과는 저장소.**
   - 원본 응답은 `.cache/raw/`에 gzip으로 둔다(`.gitignore`). 세션이 끝나면 사라진다.
   - 모델·백테스트에 필요한 것은 전부 가공 레코드에 있다: 선수 박스 라인과 슛 구역별 시도·성공, 공격권, 스틴트, 검사 결과, 품질 이슈.
2. **날짜 단위 파일은 한 번 쓰면 바뀌지 않는다.**
   - 경기일 파일은 그날 경기가 모두 끝난 뒤 한 번만 쓴다. 매일 작업은 새 날짜 파일만 추가하므로 git 이력이 불어나지 않는다.
3. **영속성**: `main`에 커밋·푸시한다. 클라우드 세션이 끝나도 GitHub에 남고, 회사·집 어느 PC에서 연 세션도 같은 데이터로 시작한다.

## 가공 레코드 형식 (`engine/extract.js`)
```
{ id, season, start, home:{id,abbr}, away:{id,abbr}, final:[h,a], periods,
  checks:{ poss:[h,a], est2:[h,a], errPct2, errPct1, haDiff, heaves:[h,a], heaveRule,
           fga:{pbp,box}, tpa:{pbp,box}, teamMinutes:[h,a], expectedMinutes,
           pbpComplete, fgaMatch, teamMinutesOk },
  failed:[검사 이름...], excluded:bool,
  quality:{ issues, usable:{pbp,stints,box}, notes },
  players:[{ id, t(0 홈/1 원정), n, st, dnp, min(박스), sec(스틴트), pts, ast, stl, blk, pf, orb, drb, tov, ftm, fta,
             z:{ra,paint,mid,c3,ab3:[성공,시도]}, hv(heave성 시도), zx(위치 없음) }],
  poss:[[쿼터, 시작초, 끝초, 0홈/1원정, 득점, 종료코드 0성공 1수비리바 2턴오버 3자유투 4쿼터끝 5교대]],
  stints:[[쿼터, 시작초, 끝초, 홈5, 원정5, 완전여부]] }
```

## 원본 재수집 방법
- 전체 재구축: `NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt node jobs/build-data.js games 2024-25 2025-26 2026-27`
  - 캐시가 비어 있으면 ESPN에서 다시 받는다. 초당 2회, 약 21분.
  - 이미 있는 날짜 파일은 건너뛴다. 다시 만들려면 `--rebuild`를 붙인다.
- 한 경기 원본만 필요할 때: `summary?event={id}`. 경기 ID는 `data/schedule/{season}.json`에 있다.
- 위험: ESPN이 과거 경기 요약을 내리면 원본을 다시 받을 수 없다(설계 §16). 그 경우에도 가공 레코드는 저장소에 남는다. 파서를 바꿔 재가공해야 하면 그 시점에 원본 보관 여부를 다시 결정한다.
