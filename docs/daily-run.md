# 일일 실행 (P9)

- 예약 작업 두 개가 매일 새 세션을 띄워 아래 "예약 작업 프롬프트"를 그대로 실행한다(2026-10-23 P9 승인).
  - 실행 A: `CRON_TZ=America/New_York 50 17 * * *`
  - 실행 B: `CRON_TZ=America/New_York 50 20 * * *`
- 실행 시각은 승인 없이 바꾸지 않는다(P9 승인 2).
- 대시보드: https://claude.ai/artifact/3MxrPFuYDFrzphT71ZKAfX

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
