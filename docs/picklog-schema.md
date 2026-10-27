# 픽 로그 레코드 스키마

- 대상: 픽 로그(`engine/pick-log.js`, `engine/log-records.js`)
- 저장 위치
  - 대시보드 DB: `meta/head`, `blocks/b*`
  - git 사본: `data/picklog/log.jsonl`
- 레코드는 해시 체인으로 이어진다. 추가만 하고, 고치거나 지우지 않는다.

## 버전
| 스키마 | 적용 | 대상 | 내용 |
|---|---|---|---|
| 1(필드 없음) | 2026-10-23~ | 모든 레코드 | 처음 형식이다. `predictionRun`이 없고, 경로는 A·B로 센다. |
| 2 | 2026-10-27 (c6cab06) | 평가·픽 레코드 | `schema: 2`. `predictionRun`("A"/"B"/"C")이 없으면 기록을 거부한다. |
| 2(필드 추가) | 2026-10-28 (82a5e01) | 평가 레코드 | `oddsInputAt`(배당 레코드의 `createdAt.utc`)과 `inputToEvalMin`(배당 입력부터 평가까지 분)을 더했다. |

- **스키마 2 평가 레코드가 0건일 때 필드를 추가했다.**
  - 추가 시점의 체인은 odds 12건뿐이었다(seq 0~11, 2026-10-27 15:38 KST 확정).
  - 그래서 번호를 올리지 않았다(2026-10-28 사용자 승인 7).
  - 같은 스키마 2 안에 두 필드가 없는 평가 레코드는 없다.
- 일일 리포트는 `inputToEvalMin`이 없는 평가 레코드를 "간격 기록 없음"으로 따로 센다.

## 레코드 종류
| type | 언제 쓰나 | 주요 필드 |
|---|---|---|
| odds | 배당 확정 | round, betmanNo, market, line, odds, deadline, capturedAt(+capturedAtBasis), createdAt |
| evaluation | 자기 경로의 최종 예측으로 마켓을 평가 | p, pCons, ev, noVig, predictionRef, predictionRun, oddsInputAt, inputToEvalMin, evaluatedAt, createdAt |
| pick | EV ≥ 3% 후보 | odds, pCons, ev, deadline, predictionRun, recordOnly, gateReasons |
| combo | 2폴더 후보 | legs, oddsProduct, pCons, ev |
| unevaluated | 마감까지 평가 못 한 마켓 | reason, note |
| purchase | 구매 여부(사용자) | pickId, purchased, stake |
| result | 경기 결과 | gameId, margin, total |

- 해제 조건 집계(200개·8주·보정·시장 Brier·ROI)는 evaluation과 pick만 센다. odds와 unevaluated는 세지 않는다.
- 경로(A·B, C)마다 따로 센다.
