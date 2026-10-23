# 일일 실행 (P9)

## 일일 커밋 허용 경로
무인 실행은 아래 경로만 커밋한다(2026-10-23 P9 승인 3·6, `jobs/lib/commit-guard.js`의 `ALLOWED_PATHS`와 같아야 한다 — 테스트로 확인).
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

그 밖의 경로가 바뀌어 있으면 커밋하지 않고 멈춰 보고한다. 53c88f5 시점에 동결 경로(`engine`, `jobs`, `package.json`, `data/model/params.json`, `latent.json`, `calibration.json`)에 있던 파일이 하나라도 다르면 커밋하지 않는다. 푸시는 `main` fast-forward만 하고, 강제 푸시는 하지 않는다.
