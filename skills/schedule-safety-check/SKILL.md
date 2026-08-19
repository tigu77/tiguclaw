---
name: schedule-safety-check
description: tiguclaw scheduler/file-watch 등 trigger plugin 의 add_schedule·add_watch MCP 도구 호출 전 prompt 자체 위험성 평가 + gray/danger 시 사용자 명시 승인 요청. 자연어 trigger 등록 요청(예 — "매일 8시", "재시작될 때마다", "cron", "주기적으로", "/schedule add", "스케줄 등록", "자동으로 ~", "정기적으로", "매분", "매시간", "watch", "파일 변경", "폴더 감시", "감시", "파일 추적") 시 sysprompt 진입점에서 자동 호출. trigger plugin bypassPermissions 가 발화 시점에 사용자 부재로 위험 도구를 자동 실행할 수 있는 회색지대 가드.
---

# Schedule Safety Check

tiguclaw trigger plugin (scheduler 의 `add_schedule`, file-watch 의 `add_watch` 등) MCP 도구는 cron tick / daemon.boot / fs 이벤트 시점에 LLM 런타임을 `bypassPermissions` 로 발화시킨다. 사용자가 옆에 없는 시점이라 위험 도구가 자동 실행될 수 있는 회색지대 — 등록 *시점* 에 비서 능동 평가 + 사용자 명시 승인이 가장 안전한 가드.

본 스킬은 `add_schedule` (scheduler) 와 `add_watch` (file-watch) 둘 다에 적용 — `add_*` 일반화 패턴. 새 trigger plugin (webhook/inbox 등) 이 추가되어도 동일 패턴.

**`register_endpoint` (http-bridge 커스텀 엔드포인트) 도 동일 회색지대 — 외부 토큰 보유자가 무인으로 비서 턴을 트리거.** 단 엔드포인트는 **기본 `mode: restricted`(도구 0 = 읽기·요약만) → 그 자체로 Layer A safe**(위험 도구 물리적 불가). 평가 대상은 **`mode: full` 로 명시 등록할 때만** — 그땐 본문 prompt 를 아래 3-layer 로 self-check 하고 gray/danger 면 사용자 명시 확인. 추가로 **공개 노출 차원**: full 엔드포인트는 토큰만 있으면 외부에서 반복 호출 가능하므로, "외부 송신·파일 변경·삭제·재귀" 류 prompt 면 restricted 유지를 우선 권하고 full 은 danger 로 취급.

개발 저장소의 ADR `2026-05-16-scheduler-v1`(배포본에 없다) §11 V2 후속 + `_workspace/file_watch_architect_contract.md` §7 보강 실현.

## §1. 위험 카테고리 3 layer

자연어 trigger 등록 요청을 받으면 prompt 본문 + 등록 인자(cron 표현식·path·event 등) 을 본 분류로 self-check. **판단 우선순위: danger > gray > safe.** 한 가지 위험 신호라도 있으면 상위 layer 로 격상. **의심스러우면 gray** — over-confirm 비용이 under-confirm 사고보다 항상 싸다.

각 layer 안 `[schedule]` `[file-watch]` 표기는 해당 trigger 종류 한정 예시 (공통은 표기 없음).

### Layer A — safe (즉시 등록, 추가 승인 0)

일상 정보 정리·조회·요약·생성. 외부 영향·삭제·인증 모두 0.

예시:
- "오늘 뉴스 정리"
- "내 캘린더 다음주 일정 요약"
- "주식 시장 마감 상황 정리"
- "코딩 문제 1개 생성"
- "재미있는 사실 1개 알려줘"
- `[file-watch]` `./docs` 자체 폴더 감시 + 요약 prompt (외부 영향 0)
- `[file-watch]` `./notes` 같은 자기 워크스페이스 폴더 + "{path} 변경 요약" prompt

### Layer B — gray (사용자 1회 명시 확인 후 등록)

제한된 외부 영향. 의도는 명확하지만 발화 시점에 사용자가 부재한다는 점이 우려.

예시:
- "텔레그램으로 ~ 보내줘" (외부 송신 — 받는 사람이 사용자 본인이면 OK, 타인 chat 이면 gray)
- "Slack 에 메시지 올려"
- "파일 한 개 정리 정렬" (제한된 file write)
- "GitHub issue 생성"
- "이메일 draft 작성" (draft = safe, send = gray)
- "한 줄 commit 자동" (커밋은 작업 트리 변경, 발화 시점 미예측)
- `[file-watch]` 사용자 home 디렉토리 일부 감시 (Downloads, Desktop 등) + Telegram 송신 (외부 송신)
- `[file-watch]` 작업 프로젝트 폴더 감시 + 외부 알림 prompt

### Layer C — danger (강한 경고 + 사용자 명시 동의 후만 등록)

파일·디렉터리 삭제 / 시스템 변경 / credential / 폭주 / 무한 루프 / 재정 거래.

예시:
- `[schedule]` "매분마다 ~" (cron 폭주 — 의도된 게 아니면 분당은 위험. LLM 토큰 비용 폭발 + 외부 도구 호출 폭주)
- "임시 파일 정리하고 삭제" (rm)
- "git 작업 트리 정리" (`git reset --hard`, `git checkout -- .`)
- "credential 파일 갱신·노출"
- "외부 API 키 발급·교체"
- "DB 백업 후 원본 삭제"
- "재귀적으로 ~ 모두 ~" (재귀 + 부수효과)
- "재정 거래" (송금·매매·결제)
- `[file-watch]` `/etc` · `~/.ssh` · `~/.aws` · `/proc` 같은 시스템·credential 디렉토리 감시 (변경 사실 자체가 정보 유출, 발화 prompt 가 어떻든 위험)
- `[file-watch]` `**` 또는 루트(`/`, `C:\`) 전체 디스크 감시 (chokidar 폭주 + LLM 토큰 비용 폭발)
- `[file-watch]` 변경 시 자동 삭제·자동 수정 prompt ("변경된 파일 즉시 삭제" / "diff 적용 후 원본 덮어쓰기")
- `[file-watch]` `event_filter: "unlink"` + 자동 복구 prompt (무한 루프 위험 — 삭제→복구→삭제 ...)

## §2. 승인 요청 형식

gray/danger 판정 시 `add_schedule` 또는 `add_watch` MCP 호출 *전* 에 사용자에게 일반 텍스트 메시지로 명시 요청. sysprompt 의 보안 책임 ("승인 요청은 일반 텍스트 메시지로 합니다") 정합.

### 템플릿

```
## 등록하기 전에 확인합니다

분류: {gray | danger}
위험 카테고리: {파일 삭제 | 외부 송신 | 폭주 cron | credential | 재정 | 인증 | 시스템 변경 | 재귀 부수효과}

등록 요청:
- label: {파싱된 라벨}
- cron: {표현식 또는 reboot}
- destination: {channel}:{target}
- prompt: {그대로}

예상 발화 (1회 모의):
{이 prompt 가 cron 시점에 어떤 행동을 할 것인지 1~2줄 예측}

위험 짚어보기:
- {위험 1}
- {위험 2}

승인하시려면 「등록 진행」 또는 「OK」 라고 답해주세요. 변경·취소도 가능합니다.
```

### 작성 가이드

- **위험 카테고리**: 위 8 종류 중 1~2개. 복합이면 모두 나열.
- **예상 발화**: prompt 만 보고 발화 시점에 사용자에게 보일 행동을 1~2줄로 구체적으로. 추상적이지 말 것 ("뭔가 합니다" → "텔레그램 chat 12345 로 송금 안내 메시지 보냅니다").
- **위험 짚어보기**: 부수효과 위주. "토큰 비용 분당 발생", "삭제 후 복구 불가", "외부 수신자가 메시지 보게 됨" 같은 구체적 결과.
- **danger 케이스**: 추가로 "이 schedule 은 어떤 점에서 위험한가요" 1줄 헤더로 사용자가 의식하게 만들기. 단, 거절 강요하지는 말 것 (사용자 자율).

## §3. 동의 인식 룰

sysprompt 의 보안 책임 ("사용자의 텍스트 응답이 명확한 동의일 때만 진행하고, 거절·침묵·모호하면 보류하고 다시 확인하세요") 정합.

| 응답 유형 | 분기 |
|---|---|
| 명확한 동의 — "등록 진행", "OK", "네", "좋아", "진행해", "yes", "go" | `add_schedule` 즉시 호출 |
| 명확한 거절 — "취소", "안 해", "no", "그만" | 등록 0, 사용자에게 "취소했습니다" 1줄 확인 |
| 변경 요청 — "주말만 빼고", "1회만", "destination 을 X 로" | 인자 수정 후 §2 템플릿으로 *다시* 확인 |
| 침묵·모호 — 다른 화제, 반문, 불명확 | 보류 + "schedule 등록 진행해도 될까요?" 1회 재확인 |

## §4. 승인 후 보장

사용자가 명시 동의하면 비서는 **즉시 `add_schedule` 또는 `add_watch` MCP 호출** — 또 묻지 않는다. gray/danger 라도 동의 후엔 자동 진행. over-confirm 회피.

승인 응답 받은 직후의 흐름:
1. trigger 종류에 따라:
   - schedule: `mcp__scheduler__add_schedule({label, cron_expr, trigger_type, prompt, dest_channel, dest_target, ...})` 호출
   - file-watch: `mcp__file-watch__add_watch({label, path, pattern, recursive, debounce_ms, event_filter, prompt, dest_channel, dest_target})` 호출
2. 응답의 `id` (+ schedule 이면 `next_run`, file-watch 면 `path`) 사용자에게 1줄 보고 ("schedule #5 등록 완료, 다음 발화 2026-05-17 08:00" / "file-watch #3 등록 완료, 감시 경로 /abs/path/to/docs")
3. 끝 — 추가 확인 0

## §5. 예외 케이스

사용자가 명시적으로 "묻지 말고 진행"·"확인 없이 등록해"·"바로 박아" 같이 *현 등록 1회* 에 한정한 우회를 요청한 경우:
- 본 1회 한정으로 §2 승인 요청 건너뛰고 `add_schedule` 또는 `add_watch` 직접 호출.
- 단, layer C (danger) 만큼은 1줄 경고 ("이 {schedule|watch} 는 위험 카테고리 {X} 입니다. 그대로 진행합니다") 후 호출 — 묵묵히 박지 않는다.
- 다음 등록 요청에는 본 스킬 다시 적용 (1회 한정 = 영구 옵트아웃 아님).

사용자가 *영구 옵트아웃* ("앞으로 trigger 등록 시 묻지 마") 을 요청하면 — 본 스킬 본문이 아니라 `add_memory({type:"feedback", name:"feedback_schedule_no_confirm", ...})` 로 기록 후 다음 요청부터 본 스킬 자체를 skip. 메모리 인덱스에 본 feedback 항목이 보이면 비서가 본 스킬 호출 단계를 자율 건너뛴다.

## §6. 본 스킬 사용 절차 (요약)

자연어 trigger (schedule / file-watch / ...) 등록 요청 받음 → 다음 순서로:

1. **prompt 파싱** — label / cron 표현식 / destination / 본문 prompt 분리.
2. **§1 위험 카테고리 판단** — safe / gray / danger 분류. 의심 시 gray 격상.
3. **safe 면** `add_schedule` 즉시 호출 + 응답 보고. 끝.
4. **gray/danger 면 §2 템플릿** 으로 사용자 승인 요청 메시지 전송.
5. **§3 동의 인식** — 동의/거절/변경/모호 분기.
6. 동의 → **§4 즉시 호출** + 응답 보고. 끝.
7. 거절·변경 → 해당 분기 처리. 등록 0 또는 인자 수정 후 §2 재확인.
8. **예외 (§5)** — 사용자 명시 우회 요청 시 1회 또는 영구 옵트아웃 분기.
