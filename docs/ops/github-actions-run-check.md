# GitHub Actions 실행 점검 — 사용자가 웹에서 추가하는 워크플로 (2026-11-13)

- 근거: 2026-11-13 사용자 결정 "[11-12 ET 보고 검토 / 결정]" 7 (구현 승인)
- 이 워크플로는 **저장소 파일(`data/runs`)만** 읽는다. 읽기 전용 토큰을 쓰고, 비밀값과 외부 호출이 없다. Claude 구독이 멈춰도 GitHub에서 돈다.
- `.github/`는 일일 커밋 허용 목록(`jobs/lib/commit-guard.js` ALLOWED_PATHS)에 넣지 않는다. 동결 목록(`engine`, `jobs`, `package.json`, `data/model/*`)과도 겹치지 않는다. 일일 커밋 가드는 일일 실행이 올리는 파일만 검사하므로, 사용자가 main에 올린 이 파일에는 걸리지 않는다.
- 이 파일은 저장소에 커밋하지 않았다. 사용자가 웹에서 직접 추가한다.
  - 사용자 계정으로 추가해야 실패 알림이 사용자에게 간다. GitHub는 예약 워크플로의 알림을 cron을 마지막으로 바꾼 사용자에게 보낸다.
  - 세션의 푸시 권한으로 `.github/workflows/`를 올리려면 `workflow` 권한이 필요한데, 이 세션에 그 권한이 있는지는 확인하지 않았다.

## 점검 시각 (KST 고정, 서머타임 영향 없음)
| 점검 KST | cron (UTC) | 그때 보는 실행 3개 (KST 예약 슬롯 기준) |
|---|---|---|
| 08:20 | `20 23 * * *` (전날 23:20 UTC) | 당일 07:50 A, 전날 21:50 C, 전날 10:50 B |
| 11:20 | `20 2 * * *` (02:20 UTC) | 당일 10:50 B, 당일 07:50 A, 전날 21:50 C |
| 22:20 | `20 13 * * *` (13:20 UTC) | 당일 21:50 C, 당일 10:50 B, 당일 07:50 A |

- 실행 기록의 ET 날짜: A·B는 KST 날짜 − 1, C는 KST 날짜와 같다. 서머타임 중 예약이 06:50·09:50 KST로 바뀌어도 같다.
- 예약 시각이 25분 넘게 지난 슬롯 중 가장 최근 3개를 본다. GitHub 예약 실행이 늦게 돌아도(수십 분~몇 시간) 같은 3개를 본다.
- 실행 하나가 빠지면 그 실행을 보는 점검 3번(약 하루)이 연달아 실패한다.

## 실패 조건 (빨간 X, 알림)
| 조건 | 문구 |
|---|---|
| `data/runs/<시즌>/<ET 날짜>-<실행>-*.json`이 없음 | 실행 기록 없음 |
| 시작이 기준 시각(A 17:50, B 20:50, C 07:50 ET)보다 5분 이상 이름 | 기준 시각보다 N분 일찍 시작 — Claude 쪽 runEarly와 따로 본다 |
| 실행 기록에 `publishedAt`이 없음 | 게시 기록 없음 |
| 실행 기록에 성공한 `git` 기록이 없음 | 커밋 성공 기록 없음 |

- 실행 기록의 `runEarly`·`missedRun`·`finalZero`·`evalZero` 경고는 노란 경고로만 옮겨 적는다(실패로 치지 않음).
- **게시 점검의 한계:** Actions는 Claude 대시보드를 볼 수 없다. 그래서 게시 자체는 확인하지 않는다.
  - 대체안: 세션이 게시에 성공하고 남기는 `publishedAt`(`mark published`)을 본다. 세션의 자기 기록이라 독립 확인은 아니다.
  - 실행 기록 자체가 없으면 게시도 없었다고 본다.

## 저장소 사본으로 한 시험 (2026-11-13, 스크립트 그대로, `CHECK_NOW`·`CHECK_ROOT`로 시각과 위치만 바꿈)
| 시나리오 | 시각(KST) | 자료 | 결과 |
|---|---|---|---|
| 정상 | 11-13 08:20 | 현재 main | 통과(A 11-12, C 11-12, B 11-11) |
| 정상 | 11-12 22:20 | 현재 main | 통과 |
| 누락 | 11-10 08:20 | 현재 main(운영 중단 구간) | 실패 3건(A 11-09, C 11-09, B 11-08 기록 없음) |
| 이른 실행 | 11-03 08:20 | 현재 main(예약 06:50 그대로) | 실패 2건(A 60분, B 59분 일찍), C는 통과 |
| 지연(실행이 점검 뒤에 끝남) | 11-13 08:20 | 사본에서 11-12 A 기록을 뺌 | 실패 1건(A 기록 없음) |
| 지연(실행이 08:30에 늦게 돎) | 11-13 11:20 | 사본에 08:30 시작 A 기록을 넣음 | 통과(늦은 시작은 실패 아님) |
| Actions 자체 지연 | 11-13 10:00 (08:20 점검이 100분 늦음) | 현재 main | 통과, 같은 3개 실행을 봄 |
| 게시 기록 없음 | 11-12 22:20 | 사본에서 11-12 C의 `publishedAt`을 지움 | 실패 1건 |

- 워크플로의 `run:` 블록을 YAML에서 꺼내 bash로 그대로 돌려도 같은 결과였다(11-13 08:20 정상, exit 0).

## 사용량
- 저장소는 public이다. 표준 러너의 Actions 시간은 무료다(private이면 실행마다 1분 올림, 월 약 90분).
- public 저장소에서는 60일 동안 저장소 활동이 없으면 GitHub가 예약 워크플로를 끈다. 일일 커밋이 있는 동안에는 해당하지 않는다.
- 비시즌에 일일 실행을 멈추면 이 점검도 계속 실패한다. 그때는 Actions 화면에서 워크플로를 끈다(Disable workflow).

## 추가 방법 (사용자, 웹)
1. github.com의 저장소 → **Add file → Create new file**
2. 파일 이름: `.github/workflows/nba-run-check.yml`
3. 아래 블록을 그대로 붙여 넣고 **Commit changes** → "Commit directly to the main branch"
   - 07:40~08:00, 10:40~11:00, 21:40~22:00 KST는 피한다(일일 실행이 main에 푸시하는 시간).
4. **Actions** 탭 → "NBA run check" → **Run workflow**로 한 번 돌려 초록 체크를 확인한다.

## 알림 설정 (사용자)
- github.com 오른쪽 위 프로필 → **Settings → Notifications → System → Actions**
  - "Notify me" 에서 Email(과 원하면 On GitHub)을 켠다.
  - **"Only notify for failed workflows"** 를 켠다.
- 휴대폰: GitHub 앱 → 설정 → 알림에서 Actions(워크플로 실행) 알림을 켠다.
- 알림은 cron을 마지막으로 바꾼 사용자에게 간다. 그래서 파일을 사용자 계정으로 추가해야 한다.

## 복사용 블록
```yaml
name: NBA run check
# Reads data/runs only: read-only token, no secrets, no network calls besides the checkout.
on:
  schedule:
    - cron: '20 23 * * *'  # 08:20 KST
    - cron: '20 2 * * *'   # 11:20 KST
    - cron: '20 13 * * *'  # 22:20 KST
  workflow_dispatch:
permissions:
  contents: read
jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 1
          persist-credentials: false
          sparse-checkout: data/runs
      - name: Check the last three scheduled runs
        run: |
          cat > "$RUNNER_TEMP/check.mjs" <<'SCRIPT'
          // Run-log check for GitHub Actions: reads data/runs only (no secrets, no network, read-only checkout).
          import { readdirSync, readFileSync, existsSync } from 'node:fs';
          const now = new Date(process.env.CHECK_NOW || Date.now());
          const ROOT = process.env.CHECK_ROOT || '.';
          const GRACE_MIN = 25; // a run is expected once its scheduled time is this far behind
          // scheduled runs in KST (fixed): A 07:50, B 10:50, C 21:50; ET date of the run log: A/B the KST date - 1, C the KST date
          const SLOTS = [{ run: 'A', h: 7, m: 50, back: 1 }, { run: 'B', h: 10, m: 50, back: 1 }, { run: 'C', h: 21, m: 50, back: 0 }];
          const day = 864e5, kstMs = now.getTime() + 9 * 3600e3;
          const due = [];
          for (let d = 0; d < 3; d++) for (const s of SLOTS) {
            const base = new Date(Math.floor(kstMs / day) * day - d * day); // KST midnight (as UTC-shifted date)
            const at = new Date(base.getTime() + (s.h * 60 + s.m) * 60e3 - 9 * 3600e3);
            if (now - at >= GRACE_MIN * 60e3) due.push({ ...s, at, etDate: new Date(base.getTime() - s.back * day).toISOString().slice(0, 10) });
          }
          due.sort((a, b) => b.at - a.at);
          const check = due.slice(0, 3);
          // ET wall time of an instant
          const etParts = t => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(t).map(p => [p.type, p.value]));
          const RUN_ET = { A: 17 * 60 + 50, B: 20 * 60 + 50, C: 7 * 60 + 50 };
          const season = d => { const [y, mo] = d.split('-').map(Number); return mo >= 8 ? `${y}-${String((y + 1) % 100).padStart(2, '0')}` : `${y - 1}-${String(y % 100).padStart(2, '0')}`; };
          let bad = 0;
          const fail = msg => { bad++; console.log(`::error::${msg}`); };
          for (const c of check) {
            const dir = `${ROOT}/data/runs/${season(c.etDate)}`;
            const files = existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith(`${c.etDate}-${c.run}-`) && f.endsWith('.json')).sort() : [];
            const label = `실행 ${c.run} (ET ${c.etDate}, KST 슬롯 ${new Date(c.at.getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')} KST)`;
            if (!files.length) { fail(`${label}: 실행 기록 없음 (data/runs)`); continue; }
            const logs = files.map(f => ({ f, l: JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) })).filter(x => !x.l.manual);
            const x = logs.at(-1) ?? { f: files.at(-1), l: JSON.parse(readFileSync(`${dir}/${files.at(-1)}`, 'utf8')) };
            const l = x.l, problems = [];
            const e = etParts(new Date(l.startedAt.utc)), startMin = (+e.hour) * 60 + (+e.minute);
            if (`${e.year}-${e.month}-${e.day}` === c.etDate && RUN_ET[c.run] - startMin >= 5) problems.push(`기준 시각보다 ${RUN_ET[c.run] - startMin}분 일찍 시작(${e.hour}:${e.minute} ET)`);
            if (!l.publishedAt) problems.push('게시 기록(publishedAt) 없음 — 세션이 남기는 기록이며 게시 자체는 확인 못 함');
            if (!(l.git ?? []).some(g => g.ok)) problems.push('커밋 성공 기록(mark git) 없음');
            for (const a of l.alerts ?? []) if (['runEarly', 'missedRun', 'finalZero', 'evalZero'].includes(a.code)) console.log(`::warning::${label}: ${a.text}`);
            if (problems.length) fail(`${label} ${x.f}: ${problems.join('; ')}`); else console.log(`정상 ${label}: ${x.f}`);
          }
          if (!check.length) console.log('점검할 실행 없음');
          process.exit(bad ? 1 : 0);
          SCRIPT
          node "$RUNNER_TEMP/check.mjs"
```
