# scheduler

tiguclaw 트리거 첫 시민 — cron 기반 가상 발화 plugin.

## 무엇이 가능한가

- 비서한테 자연어로 "**매일 아침 8시에 뉴스 정리해서 텔레그램 chat 12345 로 보내줘**" 라고 부탁하면 비서가 `add_schedule` MCP 도구를 호출해 등록합니다.
- 데몬은 cron tick 마다 영역 A 를 발화 (`runClaude({ text: prompt, threadKey: "scheduler:<id>", channel: "scheduler" })`) 시키고, 그 결과를 지정된 채널로 push 합니다.
- 사용자는 `/schedule list` 슬래시로 등록된 schedule 을 직접 조회·삭제·토글할 수 있습니다.
- **한 번 울리는 타이머**(`trigger_type: "once"`, 2026-10-20): "10분 뒤 빌드 확인해 줘" → `in_minutes`(1 이상) 또는 `run_at`(지금부터 1분 이상 뒤). 울려서 끝나면 지워지고(실패하면 꺼 둔 채 남아 자가 진단·패널에 보입니다), 인벤토리에 쌓이지 않습니다.
  간격 반복은 없습니다 — "5분마다 확인하다 끝나면 알려 줘" 는 울린 턴에서 아직이면 비서가 다음 한 번을 다시 겁니다(잊으면 멈추는 쪽으로 실패).
- **만든 대화에서 처리**(2026-10-20): 대화에서 만든 스케줄·타이머는 울리면 그 대화에 차례가 들어옵니다(맥락·줄·소유가 그 대화 — 파일 감시와 같은 문 `runTriggerInSession`).
  사람 대화가 아닌 자리에서 만든 것·이미 있는 스케줄은 전용 세션(`scheduler:<id>`). `update_schedule({ id, move_here: true })` 로 옮깁니다. 대화 스케줄엔 `keep_runs` 를 줄 수 없습니다.
- **놓친 실행 보충**(2026-10-20): 데몬이 꺼져 있던 동안(스케줄러의 직전 생존 시각 뒤) 지난 cron 실행은 켜진 뒤 **24시간 안 마지막 한 번만** 늦게 돕니다. 지난 타이머도 같은 규칙(24시간보다 오래면 울리지 않고 지웁니다).

## V1 범위

- cron 엔진: `croner@^10` (Vixie-style 5/6 필드 + `@daily`/`@hourly` 매크로, IANA timezone).
- destination 3종 hardcoded: `telegram` (chatId) / `cli` (console.log) / `http-bridge` (EventBus publish).
- 발화 결과는 `messages` 테이블에 자동 적재 — 새 channel `"scheduler"` 가 1종 추가됩니다 (`src/channels/types.ts` 의 `ChannelName` 은 string 으로 완화되어 코드 변경 0).
- overlap = **합침** — 직전 발화가 아직 줄에 있거나 도는 중이면 다음 tick 은 그 실행이 맡는다(로그 한 줄, 실패 아님), `last_*` 컬럼 무변.

## MCP 도구 4종

비서가 자연어 요청을 받으면 내부적으로 호출합니다.

```
add_schedule({
  label: "morning-news",
  cron_expr: "0 8 * * *",
  timezone: "Asia/Seoul",          // optional, default Asia/Seoul
  prompt: "오늘 아침 뉴스 3건 정리해줘",
  dest_channel: "telegram",        // "telegram" | "cli" | "http-bridge"
  dest_target: "12345"             // telegram chatId, http-bridge threadKey, cli=null
})
→ { ok: true, id: 7, next_run: "2026-05-17T08:00:00+09:00" }

list_schedules({ only_enabled: true })
→ { ok: true, items: [...] }       // 각 row 에 next_run ISO 포함

update_schedule({ id: 7, cron_expr: "30 9 * * *", enabled: false })
→ { ok: true, id: 7, trigger_type: "cron", enabled: false, next_run: "..." }
// 부분 패치 — 준 필드만 바뀜. enabled 로 잠깐 끄기/켜기(enable/disable 토글).
// cron_expr 변경 시 재검증 + cron 재등록. trigger_type 전환도 지원
// (cron↔reboot). 없는 id 면 { ok:false, error:"not_found" }.

delete_schedule({ id: 7 })
→ { ok: true, deleted: true }
```

잘못된 cron 표현식은 `add_schedule`·`update_schedule` 시점에 `new Cron(expr, {paused:true})` dryrun 검증 — 실패 시 `{ ok:false, error:"invalid_cron_expr" }` 반환.

## 슬래시 명령

```
/schedule list                     # 등록된 schedule 전체 (id, label, next_run, last_status)
/schedule delete <id>              # 삭제
/schedule enable <id>              # cron 객체 활성 + DB enabled=1
/schedule disable <id>             # cron 객체 중단 + DB enabled=0
```

`/schedule add` 는 의도적으로 슬래시에서 빠져있습니다 — 인용 처리가 복잡한 다인자 입력은 비서한테 자연어로 부탁하면 비서가 `add_schedule` MCP 도구로 안전하게 등록합니다.

## cron 표현식 예시

| expression | 의미 |
|------------|------|
| `0 8 * * *` | 매일 8시 정각 |
| `*/10 * * * *` | 10 분마다 |
| `0 9 * * MON` | 매주 월요일 9시 |
| `0 0 1 * *` | 매월 1일 0시 |
| `@daily` | 매일 0시 (= `0 0 * * *`) |
| `@hourly` | 매시 0분 (= `0 * * * *`) |
| `* * * * * *` | 매 초 (테스트용 — production 사용 비추천) |

자세한 문법은 [croner README](https://github.com/Hexagon/croner) 참고.

## 권한

- 발화는 `runClaude` 의 단일 권한 정책 (bypass + `disallowedTools`) 그대로 — Phase 4 단일 정책 정합. scheduler 가 별도 권한 게이트 안 가집니다.
- 등록 시점의 prompt 위험성 (예: "모든 파일 삭제하고 끝") 은 비서가 능동 평가해 사용자 승인을 받은 후 `add_schedule` 호출합니다 (sysprompt 의 보안 책임 정합).
- 사용자가 직접 슬래시 `/schedule add` 로 등록하면 의도 인증 — 별 평가 없이 즉시 등록 (V1 한정 — `/schedule add` 슬래시 자체는 V2).

## 한계 (V2 후속)

- 외부 process 격리 — V1 은 in-tree (데몬 죽으면 cron 도 죽음).
- run history — `last_*` 3 컬럼 → 별 history 테이블 N건 보관.
- 외부 trigger plugin (webhook/file-watch 등) 첫 시민.
- 자연어 cron parsing ("매일 8시" → `"0 8 * * *"`) — V1 은 비서 LLM 이 변환.
