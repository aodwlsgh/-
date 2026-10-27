# 일일 실행 (P9)

- 예약 작업 두 개가 매일 새 세션을 띄워 아래 "예약 작업 프롬프트"를 그대로 실행한다(2026-10-23 P9 승인).
  - 실행 A: `CRON_TZ=America/New_York 50 17 * * *`
  - 실행 B: `CRON_TZ=America/New_York 50 20 * * *`
- 실행 시각은 승인 없이 바꾸지 않는다(P9 승인 2).
- 대시보드: https://claude.ai/artifact/3MxrPFuYDFrzphT71ZKAfX
- 현황(2026-10-23)
  - 사용자가 저장소를 고른 작업을 만들었다: A `trig_01ATZgLgwB6vjQY61XNHeNoK`(`CRON_TZ=Asia/Seoul 50 6 * * *`), B `trig_01HB4E5mvxkWzNYAkA1DYTHy`(`CRON_TZ=Asia/Seoul 50 9 * * *`).
  - **KST 고정이다.** 예약 화면에 시간대 선택 칸이 없다(2026-10-23 사용자 확인). 설계(ET 고정)와 다르므로 서머타임이 바뀔 때 **사용자가 직접** 바꾼다. 무인 세션은 예약 설정을 바꾸지 않는다.
    - 2026-11-01 09:50 KST 실행 뒤 ~ 11-02 06:50 KST 전: A 07:50, B 10:50 KST
    - 2027-03-14 10:50 KST 실행 뒤 ~ 03-15 06:50 KST 전: A 06:50, B 09:50 KST
    - 날짜와 알림은 `docs/STATUS.md` 맨 위에 있다. 예약 화면에는 시간대 칸도 cron 입력 칸도 없다(2026-10-23 사용자 확정).
  - 이 세션에서 만든 옛 작업 `trig_013Q7D49FUybeHSndtL8X9vR`·`trig_01BKh8VqVmjn6nJvtESsL9Ej`는 저장소 없이 실행되어 0단계에서 멈췄다. 사용자가 지웠다.
- 수동 실행 규칙
  - 06:50 KST 앞뒤 10분에는 하지 않는다.
  - A와 B를 동시에 하지 않는다. 같은 파일(부상 리포트 스냅샷, 기준점)을 쓰므로 git 커밋이 충돌하고, 게시가 거부된다.

## 일일 커밋 허용 경로
무인 실행은 아래 경로만 커밋한다. 이 목록은 2026-10-23 P9 승인 3·6에 따른 것이고, `jobs/lib/commit-guard.js`의 `ALLOWED_PATHS`와 같아야 한다(테스트로 확인한다).
- `data/games/2026-27/`
- `data/schedule/2026-27.json`
- `data/checks/2026-27.json`
- `data/checks/unknown-play-types-2026-27.json`
- `data/excluded_games.json`
- `data/injury-pdf/2026-27/`
- `data/predictions/2026-27/`
- `data/runs/2026-27/`
- `data/picklog/log.jsonl`
- `data/live/anchor.json`
- `docs/daily/2026-27/`

커밋 가드(`jobs/commit-daily.js`)가 지키는 것:
- 위 목록 밖의 경로가 바뀌어 있으면 커밋하지 않고 멈춰 보고한다.
- 53c88f5 시점에 동결 경로(`engine`, `jobs`, `package.json`, `data/model/params.json`, `latent.json`, `calibration.json`)에 있던 파일이 하나라도 다르면 커밋하지 않는다.
- 푸시는 `main` fast-forward만 하고, 강제 푸시는 하지 않는다.
- 푸시가 거부되면 `main`을 다시 받아 이 실행의 커밋을 그 위에 다시 얹고 재시도한다(3번). 그래도 실패하면 보고한다.

## 실행 순서와 마감
- **실행 A:** 예측 → 게시 → 픽 로그(전날 결과, 대기 배당 평가, 마감 지난 마켓의 "평가 못 함") → 민감도 → 사본 → 리포트 → 커밋 → 기준점 → 재게시 → 실행 기록
- **실행 B:** 마감을 먼저 맞춘다.
  - 순서: B그룹 예측 → 픽 로그(대기 배당 평가) → 게시 → 사본 → 리포트 → 커밋 → 기준점 → 재게시 → 실행 기록
  - 21:00 ET 이후 시작 경기가 없으면 실행 기록만 남긴다.
- **기록 시점:** 픽 로그 레코드는 쓰는 순간의 시각으로 매번 다시 만든다.
  - 마감 2분 안쪽의 대기 배당은 다음 실행으로 넘긴다.
  - 마감이 지난 마켓은 사유와 함께 `unevaluated` 레코드로 남긴다.
- **입력 정규화(2026-10-26 사용자 결정, 동결 파일은 그대로):**
  - 실행 A의 경기 수집은 `build-data schedule` → `jobs/normalize-raw.js` → `build-data games` 순서다. normalize-raw는 경기 파일이 없거나 모자란 날짜의 끝난 경기만 보고, `engine/schema/play-type-aliases.js`의 별칭(지금은 "17" "Short Timeout" → "16" "Full Timeout")을 원본 캐시에 적용한다. 바꾼 플레이는 `data/games/<season>/play-type-aliases.json`과 실행 기록 단계 `normalize play types`에 남는다. 별칭이 없는 새 유형은 전처럼 "데이터 지연"이 된다
  - 부상 PDF 이름의 쪼개진 악센트("L ó pez, Karim")는 `engine/pdf-names.js`가 매칭 전에 합친다. 고친 이름은 스냅숏의 `nameFixes`와 실행 기록 `pdfNameFixes`에 남는다
- **경고 승격:** "데이터 지연"(직전 실행 A와 비교)과 "PDF 선수 못 찾음"(직전 실행과 비교)이 2회 연속이면 경고에 `escalated`·`streak`이 붙고, 대시보드 머리글에 "연속 경고" 칩이 뜨고, `prepare` 출력 JSON의 `push`에 문장이 들어간다
- **ESPN 부상 피드 원본:** 실행마다 `data/injury-pdf/<season>/espn-feed/<runId>.json.gz`(약 45KB). 병행 기록 전용이고 예측은 읽지 않는다

## 2026-11-01 시각 변경 때 사용자가 지시문에 넣을 줄
예약 작업 A·B의 지시문은 사용자가 고친다(2026-10-23·10-24 결정). 아래 두 줄은 아직 지시문에 없다.
- 7단계 끝: `node jobs/commit-daily.js "daily <runId>: run log final"` (마지막 `mark git` 뒤 남는 실행 기록 파일 커밋)
- 1단계 끝: `prepare` 출력 JSON의 `push`가 비어 있지 않으면 그 문장마다 PushNotification(status "proactive")을 보낸다. 도구가 보이지 않으면 ToolSearch "select:PushNotification"으로 불러온다

## 예약 작업 만들기 (claude.ai 화면, 사용자가 만든다)
이 세션에서 `create_trigger`로 만든 작업은 저장소 없이 실행되어 멈췄다. 그래서 claude.ai의 예약 작업 화면에서 저장소를 골라 만든다. 두 작업의 값은 아래와 같다.

| 항목 | 실행 A | 실행 B |
|---|---|---|
| 이름 | NBA 일일 실행 A (17:50 ET) | NBA 일일 실행 B (20:50 ET) |
| 반복 | 매일 17:50 | 매일 20:50 |
| 시간대 | America/New_York(화면에 칸이 없으면 KST로 06:50·09:50, 서머타임 해제 기간에는 07:50·10:50) | 같음 |
| cron(시간대 포함 형식) | `CRON_TZ=America/New_York 50 17 * * *` | `CRON_TZ=America/New_York 50 20 * * *` |
| cron(시간대를 따로 고르는 형식) | `50 17 * * *` | `50 20 * * *` |
| 저장소 | `aodwlsgh/-`, 브랜치 `main` | 같음 |
| 환경 | 이 작업 세션과 같은 `env_019T2r6q4JMYeNxu8FaFcNVU`("Default", 설명 없음. ESPN·NBA 접속 확인됨) | 같음 |
| 실행 방식 | 실행마다 새 세션 | 같음 |
| 승인 모드 | 자동(auto) | 같음 |
| 알림 | 휴대폰 푸시만(이메일 끔) | 같음 |
| 프롬프트 | 아래 템플릿에서 `{RUN}`을 `A`로 | `{RUN}`을 `B`로 |

- 같은 이름의 환경이 둘이다("Default"). 다른 하나는 `env_01RAEj6CsHEyCw3FpnrT5yAx`("Default - trusted network access")다.
- 만든 뒤 할 일
  - 이 세션이 수동 1회 실행으로 무인 git 푸시, DB 쓰기(runs), 재게시, 승인 모드를 확인해 보고한다.
  - 꺼 둔 옛 작업 `trig_013Q7D49FUybeHSndtL8X9vR`·`trig_01BKh8VqVmjn6nJvtESsL9Ej`는 지운다(2026-10-23 사용자가 지웠다).

## 예약 작업 프롬프트
아래 글에서 `{RUN}`만 `A` 또는 `B`로 바꿔 `create_trigger`의 prompt로 쓴다.

```text
[NBA 일일 실행 {RUN}] 이 세션은 예약 작업이 띄운 무인 실행이다. 지켜보는 사람이 없다. 승인을 기다려야 하는 단계가 나오면 기다리지 말고 그 단계를 실패로 기록하고 다음 단계로 넘어간다.

규칙
- 코드·파라미터·동결 경로 변경 금지. engine/, jobs/, scripts/, dashboard/, tools/, test/, package.json, data/model/ 그리고 docs/daily/ 밖의 문서를 고치지 않는다. 고칠 것이 보이면 고치지 말고 마지막 메시지에 보고한다.
- 허용 경로만 커밋. 커밋과 푸시는 node jobs/commit-daily.js 로만 한다(허용 경로 확인, 동결 파일 53c88f5 확인, main fast-forward). git commit·git push를 직접 하지 않는다. 강제 푸시 금지.
- 배당·픽 레코드를 만들거나 지어내지 않는다. 픽 로그에는 node jobs/picklog.js plan 이 만든 batch만 보낸다.
- betman.co.kr에 접속하지 않는다. 네트워크가 막히면 우회하지 말고 막힌 도메인을 기록한다.

절차 (이후 모든 node 명령 앞에 NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt 를 붙인다)
0. 준비
   - 저장소 aodwlsgh/- 가 작업 디렉터리에 없으면 add_repo(owner "aodwlsgh", repo "-")로 붙이고 안내대로 클론한다.
   - docs/STATUS.md를 먼저 읽는다.
   - git fetch origin main && git checkout -B daily-run origin/main && npm ci
   - ArtifactData 도구가 보이지 않으면 ToolSearch "select:ArtifactData"로 불러온다.
1. 예측: node jobs/daily.js prepare {RUN}
   - 출력 JSON의 runId를 기억한다.
   - exit 2면 3, 5~9단계만 한다(게시 건너뜀).
   - 실행 B에서 출력의 note가 "대상 없음"이면 7~9단계만 한다.
2. 게시(실행 B는 3단계를 먼저 끝낸 뒤 한다)
   - Artifact action "read", url https://claude.ai/artifact/3MxrPFuYDFrzphT71ZKAfX
   - Artifact action "list", scope "files", 같은 url
   - node jobs/daily.js files 의 JSON을 files로 넘겨 Artifact publish 한다. url은 같은 url, file_path는 dashboard/index.html 이다. capabilities·icon은 넣지 않는다.
   - 성공하면 node jobs/daily.js mark published 를 한다.
   - 실패하면 node jobs/daily.js mark publish '{"ok":false,"reason":"<사유>"}' 를 한다.
3. 픽 로그(D=/tmp/picklog-<runId>)
   a. 읽기
      - ArtifactData get, url 같은 url, collection "meta", doc_id "head", out_dir D. 없다는 결과면 그대로 진행한다.
      - ArtifactData list, collection "blocks", query {"limit":1000}, out_dir D
      - ArtifactData list, collection "failures", query {"limit":1000}, out_dir D
   b. node jobs/picklog.js plan --dir D
      - 저장된 head 파일에 version이 없으면 get 결과의 version을 --head-version 으로 넘긴다.
      - action "none": c로 간다.
      - action "commit" 또는 "adopt": D/plan.json의 batch를 그대로 ArtifactData batch의 writes로 보낸다. 성공이든 버전 충돌이든 a부터 다시 한다(최대 6번).
      - exit 3: a부터 다시 한다.
      - exit 4, 도구 오류, 거부, 승인 대기, 6번 초과: node jobs/daily.js mark db '{"ok":false,"reason":"<사유>"}' 를 하고 c로 간다.
   c. 쓴 레코드가 있으면 node jobs/daily.js mark db '{"ok":true,"records":<개수>}' 를 한다.
   d. a를 다시 한 뒤 node jobs/picklog.js check --dir D 결과(레코드 수, 종류별 개수, 마지막 seq·해시)를 기억한다.
4. 실행 A만: node jobs/daily.js sensitivity 를 한 뒤, 2단계의 publish만 다시 한다(mark published는 하지 않음).
5. 사본: node jobs/picklog.js export --dir D
   - exit 5면 node jobs/daily.js mark copy '{"ok":false,"reason":"<출력의 reason>"}' 를 하고, 7단계의 기준점은 건너뛴다.
6. 리포트: node jobs/daily.js report --chain D (3단계 읽기가 실패했으면 --chain 없이)
7. 커밋
   - node jobs/commit-daily.js "daily <runId>: data, predictions, run log, report, pick-log copy"
   - 결과 JSON을 node jobs/daily.js mark git '<결과 JSON>' 로 남긴다.
   - 사본과 커밋이 성공했으면 아래 셋을 한다.
     - node jobs/picklog.js anchor
     - node jobs/commit-daily.js "daily <runId>: anchor"
     - mark git
   - 2단계의 publish만 다시 한다(기준점과 경고 반영).
8. 실행 기록: ArtifactData set, collection "runs", doc_id <runId>, file_path data/runs/2026-27/<runId>.json
9. 마지막 메시지(요약)
   - runId, 경기 수(최종·예비), 경고 전부
   - 픽 로그: 쓴 레코드 수와 check 결과
   - 커밋·푸시 결과(커밋 해시)
   - 게시 결과
   - 실패한 단계와 사유
   - 이 세션에서 승인을 요구받은 도구가 있었는지
```

## 예약 작업 C (아침 리포트) — 사용자가 만든다
2026-10-27 사용자 승인(검증 `docs/reports/c-validation.md`, 계획 `docs/plans/2026-10-27-early-run-plan.md`). A·B와 같은 화면에서 만든다.

| 항목 | 실행 C |
|---|---|
| 이름 | NBA 일일 실행 C (아침 리포트) |
| 반복 | 매일 21:50 KST (화면이 KST 고정) |
| 저장소·환경·실행 방식·승인 모드·알림 | 실행 A·B와 같음 |
| 프롬프트 | 아래 블록 그대로 |

- 21:50 KST는 서머타임 중 08:50 ET다. 2026-11-01부터는 07:50 EST가 되어 C의 기준 시각(08:50 ET)보다 이르다. 그때 C는 그 시각까지 나온 리포트를 읽고, 예측을 "예비"로 표시한다(평가 안 함, 오류로 막지 않음). 11-01 이후 처리는 계획 문서 5절에서 사용자가 정한다.
- A·B 지시문에 아직 없는 두 줄(실행 기록 커밋, 푸시 알림)은 C 지시문에는 처음부터 넣었다.

```text
[NBA 일일 실행 C — 아침 리포트] 이 세션은 예약 작업이 띄운 무인 실행이다. 지켜보는 사람이 없다. 승인을 기다려야 하는 단계가 나오면 기다리지 말고 그 단계를 실패로 기록하고 다음 단계로 넘어간다.

규칙
- 코드·파라미터·동결 경로 변경 금지. engine/, jobs/, scripts/, dashboard/, tools/, test/, package.json, data/model/ 그리고 docs/daily/ 밖의 문서를 고치지 않는다. 고칠 것이 보이면 고치지 말고 마지막 메시지에 보고한다.
- 허용 경로만 커밋. 커밋과 푸시는 node jobs/commit-daily.js 로만 한다(허용 경로 확인, 동결 파일 53c88f5 확인, main fast-forward). git commit·git push를 직접 하지 않는다. 강제 푸시 금지.
- 배당·픽 레코드를 만들거나 지어내지 않는다. 픽 로그에는 node jobs/picklog.js plan 이 만든 batch만 보낸다.
- betman.co.kr에 접속하지 않는다. 네트워크가 막히면 우회하지 말고 막힌 도메인을 기록한다.

절차 (이후 모든 node 명령 앞에 NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/root/.ccr/ca-bundle.crt 를 붙인다)
0. 준비
   - 저장소 aodwlsgh/- 가 작업 디렉터리에 없으면 add_repo(owner "aodwlsgh", repo "-")로 붙이고 안내대로 클론한다.
   - docs/STATUS.md를 먼저 읽는다.
   - git fetch origin main && git checkout -B daily-run origin/main && npm ci
   - ArtifactData 도구가 보이지 않으면 ToolSearch "select:ArtifactData"로 불러온다.
1. 예측: node jobs/daily.js prepare C
   - 출력 JSON의 runId를 기억한다.
   - 출력 JSON의 push가 비어 있지 않으면 그 문장마다 PushNotification(status "proactive")을 보낸다. 도구가 보이지 않으면 ToolSearch "select:PushNotification"으로 불러온다.
   - exit 2면 3, 5~9단계만 한다(게시 건너뜀).
2. 게시(3단계를 먼저 끝낸 뒤 한다. 마감 23:00 KST 전에 평가를 맞춘다)
   - Artifact action "read", url https://claude.ai/artifact/3MxrPFuYDFrzphT71ZKAfX
   - Artifact action "list", scope "files", 같은 url
   - node jobs/daily.js files 의 JSON을 files로 넘겨 Artifact publish 한다. url은 같은 url, file_path는 dashboard/index.html 이다. capabilities·icon은 넣지 않는다.
   - 성공하면 node jobs/daily.js mark published 를 한다.
   - 실패하면 node jobs/daily.js mark publish '{"ok":false,"reason":"<사유>"}' 를 한다.
3. 픽 로그(D=/tmp/picklog-<runId>)
   a. 읽기
      - ArtifactData get, url 같은 url, collection "meta", doc_id "head", out_dir D. 없다는 결과면 그대로 진행한다.
      - ArtifactData list, collection "blocks", query {"limit":1000}, out_dir D
      - ArtifactData list, collection "failures", query {"limit":1000}, out_dir D
   b. node jobs/picklog.js plan --dir D
      - 저장된 head 파일에 version이 없으면 get 결과의 version을 --head-version 으로 넘긴다.
      - action "none": c로 간다.
      - action "commit" 또는 "adopt": D/plan.json의 batch를 그대로 ArtifactData batch의 writes로 보낸다. 성공이든 버전 충돌이든 a부터 다시 한다(최대 6번).
      - exit 3: a부터 다시 한다.
      - exit 4, 도구 오류, 거부, 승인 대기, 6번 초과: node jobs/daily.js mark db '{"ok":false,"reason":"<사유>"}' 를 하고 c로 간다.
   c. 쓴 레코드가 있으면 node jobs/daily.js mark db '{"ok":true,"records":<개수>}' 를 한다.
   d. a를 다시 한 뒤 node jobs/picklog.js check --dir D 결과(레코드 수, 종류별 개수, 마지막 seq·해시)를 기억한다.
4. (실행 C는 민감도를 하지 않는다)
5. 사본: node jobs/picklog.js export --dir D
   - exit 5면 node jobs/daily.js mark copy '{"ok":false,"reason":"<출력의 reason>"}' 를 하고, 7단계의 기준점은 건너뛴다.
6. 리포트: node jobs/daily.js report --chain D (3단계 읽기가 실패했으면 --chain 없이)
7. 커밋
   - node jobs/commit-daily.js "daily <runId>: data, predictions, run log, report, pick-log copy"
   - 결과 JSON을 node jobs/daily.js mark git '<결과 JSON>' 로 남긴다.
   - 사본과 커밋이 성공했으면 아래 셋을 한다.
     - node jobs/picklog.js anchor
     - node jobs/commit-daily.js "daily <runId>: anchor"
     - mark git
   - 2단계의 publish만 다시 한다(기준점과 경고 반영).
   - 마지막 mark git 뒤 남은 실행 기록: node jobs/commit-daily.js "daily <runId>: run log final"
8. 실행 기록: ArtifactData set, collection "runs", doc_id <runId>, file_path data/runs/2026-27/<runId>.json
9. 마지막 메시지(요약)
   - runId, 경기 수(최종·예비), 경고 전부
   - 픽 로그: 쓴 레코드 수와 check 결과
   - 커밋·푸시 결과(커밋 해시)
   - 게시 결과
   - 실패한 단계와 사유
   - 이 세션에서 승인을 요구받은 도구가 있었는지
```

