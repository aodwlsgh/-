# P5 데이터 누출 점검 (사용자 요청 6, 2026-10-22)

## 진행 방식
- 이 대화의 맥락이 없는 새 에이전트에게 설계 §14.2·§14.4·§14.4.1과 코드만 주고, "예측 시점에 몰랐을 정보가 들어갈 경로"를 찾게 했다.
- 점검 대상: asOf 경계, 부상 PDF 스냅샷 시각, 예측 대상 경기 박스스코어, 시즌 간 반영, 튜닝 장부
- 에이전트는 읽기 전용으로 일했고 2025-26은 평가하지 않았다(git 상태 깨끗, `test-openings.json` 없음 확인).
- 아래 "에이전트 보고"는 에이전트가 낸 영문 보고의 핵심 문장을 발췌해 줄인 것이다(수치·파일 위치는 원문 그대로). "대응"은 그 뒤 내가 검증하고 고친 내용이다.

## 대응 요약

| # | 판정 | 내용 | 검증 | 조치 (커밋 `04b12ae`, `ae8e069`) |
|---|---|---|---|---|
| F1 | **누출(참고 행)** | 2025-12-21 이전 파일명 "_03PM"은 실제로는 15:30 보고서다. 15:30 시작 경기(`pre_job_start`)가 시작 이후 보고서를 썼다. | 확인. `Last-Modified` 실측: 03PM 파일 게시 15:30:03, 05PM 파일 게시 17:30:04 | 읽을 수 있던 시각 = max(제목 시각, Last-Modified). 이 시각이 컷오프 이후면 그 앞 보고서를 쓴다. 3개 시즌 스냅샷을 모두 다시 만들었다. |
| F2 | **누출 가능성(판정 대상)** | 15분 단위 시기의 17:45 보고서가 17:50 전에 게시됐는지는 가정이었다. | 실측: 17:45 보고서 게시 17:45:05~09, 20:45 보고서 게시 20:45:05~06. 가정은 맞았지만 검사가 없었다. | F1과 같은 규칙으로 모든 스냅샷에서 게시 시각을 검사한다. |
| F3 | 누출 아님(취약) | 레이팅 객체의 `raAllowedOn`이 누적기 배열을 직접 가리켰다. | 확인(예측에는 쓰이지 않음) | 배열을 복사한다. |
| F4 | 누출 아님(취약) | 레이팅을 읽을 때 날짜 경계를 검사하지 않았다. | 확인 | 이미 더한 경기보다 이른 컷오프로 읽으면 오류를 낸다(테스트 추가). |
| F5 | 누출 아님(취약) | 스냅샷 파일 날짜 키(일정 US 날짜)와 백테스트 조회 키(ET 날짜)의 출처가 달랐다. | 현재 3,704경기 모두 일치 | 키를 ET 시작 날짜로 통일했다. 백테스트가 읽을 때 컷오프를 다시 확인하고, 어긋나면 중단한다. |
| F6 | 누출 아님(절차) | 시뮬레이션·보정이 현재 파라미터로 만들어졌는지 확인하지 않았다. 개봉 기록에 커밋도 없었다. | 확인 | 입력 파일 sha256을 남기고, 다르면 거부한다. 개봉은 `preregistration.json`의 커밋·해시와 일치하고 작업 트리가 깨끗할 때만 된다. |
| F7 | 누출 아님(절차) | 2025-26을 여는 경로가 둘이었다(`p3.js test`, `backtest.js test`). | 확인 | `p3.js test`는 거부한다. |
| F8 | 주의 | 보정층·앙상블을 A판으로 적합했다. A판 출전자 명단에는 결과 정보가 조금 섞인다(대승 경기일수록 출전자가 많다). | 효과 작음(잔차 SD 14.23 대 14.27) | 보정층과 앙상블을 **2024-25 B판**으로 적합하도록 바꿨다(판정 대상과 같은 조건). 이를 위해 2024-25 부상 PDF를 수집했다(1,230경기, 100%). |
| F9 | 절차 메모 | 2026-27 전진 평가 실행이 장부에 없음 / 출전 확률 미보정 / 설계 §6.5의 "2025-26으로 홈 이점 추정" 문구 | 확인 | 장부에 메모를 남겼다. 출전 확률을 2024-25로 보정했다(Doubtful 0.02, Questionable 0.53, Probable 0.97). 설계 문구를 고쳤다(구현은 원래 워크포워드). |

- 다섯 영역 판정(에이전트)
  - asOf 경계: 누출 없음. 대상 날짜 이후 경기를 무작위로 바꿔도 예측 변화 0
  - PDF 시각: F1·F2
  - 박스스코어: B판은 대상 경기 정보 0, A판은 출전자 명단만 쓴다.
  - 시즌 간 반영: 누출 없음
  - 장부: 2025-26 경로 없음

## 에이전트 보고 (영문 발췌)

```
## Information-leakage review of the NBA backtest (read-only; 2025-26 never evaluated)

Bottom line: I found no path from 2025-26 results into any fitted parameter. Ratings, environment, home
advantage, pace and baseline only use games from before date D. Variant B never reads the predicted game's box
score. There is one real leak, limited to the pre_job_start reference rows. There is one possible leak in the
judged B set: run-time injury PDF availability is assumed, not checked. The rest are fragile spots that don't
leak today.

F1 — LEAK, pre_job_start reference rows only (not S1–S3). engine/collect.js:101-105, used by
jobs/build-data.js:147,176. Before 2025-12-22 the PDF file name _03PM is treated as 15:00, but its content is a
later report (title 15:30, sometimes 15:45). A game tipping at 15:30 has cutoff 15:29 → latestInjuryPdf picks
_03PM → report as of tip-off or later → rec.early → jobs/backtest.js → snapshotInjuries → projectMinutes →
variant B prediction → preJobStartReference. Measured: title time after the cutoff for 34 of 87 games in 2023-24
and 8 of 97 games in 2025-26. index.json ok/lagMin are computed from the file name, so the P2 checks miss it.
Fix: parse reportTime and require it at or before the cutoff, stepping back one more file if not; re-check at
load; compute lagMin/ok from reportTime.

F2 — POSSIBLE LEAK, judged B set. collect.js:101-108, build-data.js:173,181. The run A/B snapshot is the newest
PDF by nominal time at or before 17:50 / 20:50; from 2025-12-22 that is the 17:45 / 20:45 report (5-minute
margin). Posting time is never checked; Last-Modified is not recorded. Affected: 511 group-A and 222 group-B
games in 2025-26, plus 19 hourly-era games whose file held the :45 report. Fix: record Last-Modified and use it
as the availability time, or require a nominal time at or before cutoff minus 15 minutes.

F3 — not a leak, fragile: engine/model.js:364,367 raAllowedOn aliases the live P.rimOn array; a kept ratings
object sees later games. No current impact (team.rim is not read by predict.js or sim.js). Fix: copy.

F4 — not a leak, fragile: Accumulator.ratings() never checks that no game at or after asOf was added; asOf()
keeps games that started (not finished) before an ISO cutoff. Fix: throw if lastStart >= cutoff.

F5 — not a leak, fragile: build-data keys snapshots by the schedule usDate and groups by schedule start;
jobs/backtest.js looks them up by the ET date of the record's start. They match for all 3,704 games today.
Fix: key by the ET date of the start and validate PDF time against snapshotCutoff at load.

F6 — not a leak, fragile: fit/test don't check that sims and calibration were made with the current
params/latent; openTestSeason logs paths but no commit or hashes. Fix: store sha256 + git HEAD + clean-tree check.

F7 — not a leak, process: jobs/p3.js test and jobs/backtest.js test share one opening log; whichever runs first
uses up the single opening. Fix: make p3.js test refuse or delegate.

F8 — not a leak, caveat for B: params, sigma, latent, ensemble w and the calibration layer are all fitted on
variant A rows, but B is judged. The A participant list carries outcome information (games with >= 23
participants average |margin| 21.3). Measured effect small: residual SD 14.23 (A) vs 14.27 (roster-only);
A shifts predictions toward the winner by 0.20-0.28 points. Optional fix: fit w and calibration on a
roster-only 2024-25 run, or report sensitivity.

F9 — minor process notes: the 2026-27 forward run (14 games) was generated before and after re-tunes, not in the
ledger; PLAY_PROB "to be calibrated by backtest" (§6.5) was not done (no 2024-25 PDFs); notSubmitted entries are
not filtered by date (flag only, never used in a prediction); §6.5 "estimate home advantage with 2025-26 data"
is not implemented (walk-forward in code).

Five areas:
1. asOf boundary — no leak. Scrambling every game on or after D (D = 2024-10-22 and 2025-01-15) changed model
   margin/total, baseline margin, home advantage and environment by exactly 0, for both A and B.
2. Injury PDF timing — leak in F1 (reference rows only); possible leak in F2. Groups come only from the
   scheduled start; 0 rows from another date out of 67,404.
3. Target box score — none in B (fully scrambling the target day's records changed B by 0); only the
   participant set in A (scrambling minutes/starters/stats with the same set changed A by 0).
4. Season carry-over — no leak; 2023-24 gets no prior, 2025-26 only 2024-25; no fitting path loads 2025-26.
5. Ledger and fitted files — no 2025-26 path; params.json, sigma, latent.json and calibration.json read only
   2023-24/2024-25; every ledger window is 2024-25 and the 438-run total adds up; no test-openings.json,
   p3/p5 test report or 2025-26 sims file has ever existed (git history).
```
